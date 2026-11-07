import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import type { Config } from '../config/index.js';
import type { DeployPort, DeploymentState } from './github.js';
import { activateScript, remoteValue, uploadScript } from './remote.js';
import { runProcess, type Transport } from './transport.js';

export type DeployEvent = { name: string; ref: string; payload: Record<string, unknown> };
export type DeployDecision =
  | { deploy: true; sha: string; source: string }
  | { deploy: false; reason: string; sha?: string };
export type DeployOutcome = 'deployed' | 'rolled-back' | 'failed';
export type DeployReport = { outcome: DeployOutcome; sha: string; previous: string | null; deploymentId: number | null; detail: string };

const SHA = /^[a-f0-9]{40}$/;

/** Reads the triggering Actions event (GITHUB_EVENT_NAME/GITHUB_EVENT_PATH/GITHUB_REF). */
export async function readEvent(env: NodeJS.ProcessEnv = process.env): Promise<DeployEvent> {
  let payload: Record<string, unknown> = {};
  if (env.GITHUB_EVENT_PATH) {
    try { payload = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')) as Record<string, unknown>; } catch { payload = {}; }
  }
  return { name: env.GITHUB_EVENT_NAME ?? '', ref: env.GITHUB_REF ?? '', payload };
}

/**
 * Decides whether this event deploys and which commit. Only the current head of
 * the default branch is ever deployed: an older commit is skipped because the
 * newer commit's own run deploys it. With trigger "checks", every configured
 * workflow must have succeeded for exactly that commit.
 */
export async function planDeploy(config: Config, event: DeployEvent, port: DeployPort): Promise<DeployDecision> {
  const deploy = config.deploy;
  if (!deploy.enabled) return { deploy: false, reason: 'disabled' };
  const branch = await port.defaultBranch();
  let sha: string;
  let source = event.name;
  if (event.name === 'workflow_dispatch') sha = branch.sha;
  else if (event.name === 'push') {
    if (deploy.trigger !== 'push') return { deploy: false, reason: 'waiting-for-checks' };
    if (event.ref !== `refs/heads/${branch.name}`) return { deploy: false, reason: 'not-default-branch' };
    sha = String(event.payload.after ?? '');
  } else if (event.name === 'workflow_run') {
    if (deploy.trigger !== 'checks') return { deploy: false, reason: 'push-trigger-configured' };
    const run = (event.payload.workflow_run ?? {}) as Record<string, unknown>;
    if (run.event !== 'push' || run.head_branch !== branch.name) return { deploy: false, reason: 'not-default-branch' };
    if (!deploy.workflows.includes(String(run.name))) return { deploy: false, reason: 'unrelated-workflow' };
    if (run.conclusion !== 'success') return { deploy: false, reason: 'checks-failed', sha: String(run.head_sha ?? '') };
    sha = String(run.head_sha ?? '');
    source = `workflow_run:${String(run.name)}`;
  } else return { deploy: false, reason: 'unsupported-event' };
  if (!SHA.test(sha)) return { deploy: false, reason: 'invalid-commit' };
  if (sha !== branch.sha) return { deploy: false, reason: 'superseded', sha };
  if (deploy.trigger === 'checks') {
    const runs = await port.workflowRuns(sha);
    for (const name of deploy.workflows) {
      const latest = runs.filter(r => r.name === name && r.event === 'push').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!latest || latest.status !== 'completed') return { deploy: false, reason: 'checks-pending', sha };
      if (latest.conclusion !== 'success') return { deploy: false, reason: 'checks-failed', sha };
    }
  }
  return { deploy: true, sha, source };
}

/** Starts `git archive` for the checked-out commit and returns its tar stream. */
export function archive(sourceDir: string) {
  const child = spawn('git', ['-C', sourceDir, 'archive', '--format=tar', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
  // Consume immediately: Node discards unread child output once the process exits,
  // which would otherwise race with the asynchronous transport setup.
  const stream = new PassThrough({ highWaterMark: 1 << 20 });
  child.stdout.pipe(stream);
  const done = new Promise<number>(resolve => { child.on('close', code => resolve(code ?? 1)); child.on('error', () => { stream.destroy(); resolve(1); }); });
  return { stream, done };
}

export type DeployContext = { config: Config; sha: string; sourceDir: string; transport: Transport; port: DeployPort; logUrl?: string; log?: (line: string) => void };

/** Uploads the exact commit and activates it on the target, recording a GitHub deployment. */
export async function executeDeploy(context: DeployContext): Promise<DeployReport> {
  const { config, sha, sourceDir, transport, port, logUrl } = context;
  const deploy = config.deploy;
  const log = context.log ?? (() => {});
  const head = await runProcess('git', ['-C', sourceDir, 'rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== sha) throw new Error('Deployment source does not match the planned commit');
  let deploymentId: number | null = null;
  const status = async (state: DeploymentState, description: string) => {
    if (deploymentId !== null) await port.setDeploymentStatus(deploymentId, state, description, logUrl).catch(() => log('Deployment status could not be recorded'));
  };
  if (deploy.githubDeployment) {
    deploymentId = await port.createDeployment(sha, deploy.environment, `Software Factory docker-ssh deploy of ${sha.slice(0, 12)}`);
    await status('in_progress', 'Uploading release');
  }
  const timeoutMs = deploy.timeoutMinutes * 60000;
  try {
    const tar = archive(sourceDir);
    const upload = await transport.run(uploadScript, [deploy.path, sha], tar.stream, timeoutMs);
    if ((await tar.done) !== 0 || upload.code !== 0 || remoteValue(upload.stdout, 'SF_DEPLOY_UPLOADED') !== sha) {
      log(upload.stderr.trim());
      throw new Error(`Deployment upload failed (exit ${upload.code})`);
    }
    log(`Uploaded ${sha} to ${deploy.path}/releases/${sha}`);
    const project = deploy.project ?? deploy.path.split('/').at(-1)!.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    const result = await transport.run(activateScript, [deploy.path, sha, project, deploy.composeFile, deploy.envFile ?? '',
      String(deploy.keepReleases), deploy.healthcheck.url ?? '', String(deploy.healthcheck.timeoutSeconds), deploy.rollback ? '1' : '0'], undefined, timeoutMs);
    if (result.stderr.trim()) log(result.stderr.trim());
    const previousRelease = remoteValue(result.stdout, 'SF_DEPLOY_PREVIOUS');
    const previous = previousRelease && previousRelease !== 'none' ? previousRelease : null;
    const error = remoteValue(result.stdout, 'SF_DEPLOY_ERROR');
    const outcome = remoteValue(result.stdout, 'SF_DEPLOY_RESULT');
    if (result.code === 0 && outcome === 'deployed') {
      await status('success', `Deployed ${sha.slice(0, 12)}`);
      return { outcome: 'deployed', sha, previous, deploymentId, detail: 'Release started and verified' };
    }
    const detail = error ? `Precondition failed: ${error}`
      : outcome === 'rolled-back' ? `Release failed; previous release ${previous?.slice(0, 12)} restored`
      : outcome === 'rollback-failed' ? 'Release failed and the rollback also failed'
      : `Release failed (exit ${result.code})`;
    await status('failure', detail);
    return { outcome: outcome === 'rolled-back' ? 'rolled-back' : 'failed', sha, previous, deploymentId, detail };
  } catch (error) {
    await status('error', error instanceof Error ? error.message : 'Deployment failed');
    throw error;
  } finally {
    await transport.close();
  }
}

export function deploySummary(report: DeployReport | null, decision: DeployDecision, environment: string): string {
  if (!report) return `# Software Factory deploy\n\nNo deployment: ${decision.deploy ? 'dry run' : decision.reason}${decision.sha ? ` (${decision.sha.slice(0, 12)})` : ''}.\n`;
  return `# Software Factory deploy\n\n| | |\n|---|---|\n| Environment | ${environment.replace(/[|<>`]/g, '')} |\n| Commit | \`${report.sha}\` |\n` +
    `| Outcome | ${report.outcome} |\n| Previous release | ${report.previous ? `\`${report.previous}\`` : '–'} |\n| Detail | ${report.detail.replace(/[|<>`]/g, '')} |\n`;
}
