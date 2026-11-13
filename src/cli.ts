import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { configSchema, loadConfig } from './config/index.js';
import { GitHubClient } from './github/client.js';
import { Manager } from './manager/index.js';
import { MockPlanner, OpenAIPlanner } from './llm/provider.js';
import { summary } from './manager/report.js';
import { executeDelegation } from './workers/execute-delegation.js';
import { HarnessProcessClient } from './workers/harness-client.js';
import { SlackSink, deliverNotifications } from './notifications/slack.js';
import { CodingRepository } from './github/coding.js';
import { prepareCoding, publishCoding } from './workers/coding.js';
import { GitHubMergePort } from './merge/github.js';
import { OpenAIMergeReviewer } from './merge/reviewer.js';
import { MergeManager } from './merge/manager.js';
import { GitHubDeployPort } from './deploy/github.js';
import { deploySummary, executeDeploy, parseDeployEnvironment, planDeploy, readEvent } from './deploy/index.js';
import { resolveTarget } from './deploy/target.js';
import { SshTransport } from './deploy/transport.js';
import { RuntimeHttpClient } from './runtime/client.js';
import { codingExecutionSchema } from './runtime/coding-contract.js';
import { validationPlanSchema } from './runtime/validation-contract.js';
import { hostedValidationCommand, materializeCodingArtifact, runCodingValidation } from './runtime/validation.js';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repository: { type: 'string' }, 'config-path': { type: 'string', default: '.github/software-factory.yml' },
    file: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
    'allow-local-writes': { type: 'boolean', default: false }, issue: { type: 'string' }, execution: { type: 'string' },
    sha: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' }
  } });
  const command = positionals[0] ?? 'manager';
  if (command === 'validate-coding-execution') {
    const request = codingExecutionSchema.parse(JSON.parse(process.env.SF_CODING_REQUEST ?? ''));
    const text = JSON.stringify(request);
    if (Buffer.byteLength(text) > 60000 || !process.env.GITHUB_OUTPUT) throw new Error('Invalid coding executor request');
    const validation = validationPlanSchema.parse(JSON.parse(process.env.SF_VALIDATION_PLAN || '{}'));
    await appendFile(process.env.GITHUB_OUTPUT, `request=${text}\nexecution-id=${request.executionId}\nbase-sha=${request.baseSha}\nvalidation=${JSON.stringify(validation)}\n`); return;
  }
  if (command === 'validate-coding-artifact') {
    if (process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_RUN_ATTEMPT !== '1') throw new Error('Validation requires a fresh hosted job');
    if (!/^[1-9][0-9]{0,15}$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^[1-9][0-9]{0,15}$/.test(process.env.SF_SOURCE_RUN_ID ?? '')) throw new Error('Invalid validation run identity');
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_API_KEY', 'GITHUB_APP_PRIVATE_KEY', 'FACTORY_MANAGER_TOKEN']) if (process.env[key]) throw new Error('Validation secret boundary violation');
    if (!values.file || !values.source || !values.output || (await stat(values.file)).size > 7000000) throw new Error('Invalid validation files');
    const request = codingExecutionSchema.parse(JSON.parse(process.env.SF_CODING_REQUEST ?? ''));
    const plan = validationPlanSchema.parse(JSON.parse(process.env.SF_VALIDATION_PLAN ?? '{}'));
    const artifact = await materializeCodingArtifact(values.source, JSON.parse(await readFile(values.file, 'utf8')), request);
    execFileSync('sudo', ['-n', 'chown', '-R', 'sf-validator:sf-validator', resolve(values.source)]);
    const output = resolve(values.output); await mkdir(dirname(output), { recursive: true });
    const report = await runCodingValidation({ target: resolve(values.source), artifact, plan, workflowRunId: Number(process.env.GITHUB_RUN_ID),
      sourceRunId: Number(process.env.SF_SOURCE_RUN_ID), hosted: true, command: hostedValidationCommand(resolve(values.source), resolve(dirname(output), 'logs')) });
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ validation: report.status, executionId: report.executionId, originalModelStatus: artifact.result.status })); return;
  }
  if (command === 'validate') {
    if (!values.file) throw new Error('validate requires --file');
    loadConfig(await readFile(values.file, 'utf8'));
    console.log('Configuration valid'); return;
  }
  if (!['manager', 'merge', 'notify', 'check-slack', 'worker', 'bootstrap', 'prepare-coding', 'publish-coding', 'deploy-plan', 'deploy'].includes(command)) throw new Error('Supported commands: manager, merge, notify, check-slack, worker, bootstrap, validate, prepare-coding, publish-coding, deploy-plan, deploy');
  const repository = values.repository ?? process.env.GITHUB_REPOSITORY ?? '';
  const github = new GitHubClient(repository, process.env.GITHUB_TOKEN ?? '');
  let config = loadConfig(await github.readConfig(values['config-path']!));
  if (values['dry-run']) config = configSchema.parse({ ...config, execution: { ...config.execution, dryRun: true } });
  if (!config.factory.enabled) {
    if (values['dry-run'] && process.env.SF_SANITY_REPORT) await writeFile(process.env.SF_SANITY_REPORT,
      JSON.stringify({ formatVersion: 1, mutationFree: true, passed: false, reason: 'factory-disabled',
        runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1', productionVerified: false }));
    console.log(JSON.stringify({ outcome: 'disabled' }));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, '# Software Factory\n\nGlobally disabled. No repository changes.\n');
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true' && !values['allow-local-writes'] && !config.execution.dryRun && config.autonomy.profile !== 'advisory') {
    throw new Error('Local mutations require --allow-local-writes and an exclusive operator session; prefer the serialized GitHub workflow');
  }
  const correlationId = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}` : randomUUID();
  const timer = setTimeout(() => { console.error(JSON.stringify({ correlationId, error: 'Hard execution time limit reached; next run will recover durable state' })); process.exit(1); }, (command === 'worker' ? config.execution.workerTimeoutMinutes : command === 'deploy' ? config.deploy.timeoutMinutes * 2 + 2 : config.manager.timeoutMinutes) * 60000);
  timer.unref();
  try {
    if (command === 'deploy-plan' || command === 'deploy') {
      const port = new GitHubDeployPort(repository, process.env.GITHUB_TOKEN ?? '');
      const decision = await planDeploy(config, await readEvent(), port);
      const mutationFree = config.execution.dryRun || config.autonomy.profile === 'advisory';
      const target = decision.deploy ? resolveTarget(config) : null;
      const writeSummary = async (text: string) => { if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text); };
      if (command === 'deploy-plan') {
        let reason = decision.deploy ? (mutationFree ? 'mutation-free' : null) : decision.reason;
        if (!reason && target && 'missing' in target) {
          reason = 'not-configured';
          console.log(`::warning title=Software Factory deploy::Deployment skipped: missing ${target.missing.join(', ')} (Actions secrets or deploy.* configuration).`);
        }
        const ready = decision.deploy && !reason;
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `deploy=${ready}\nsha=${decision.deploy ? decision.sha : ''}\n`);
        if (!ready) await writeSummary(deploySummary(null, decision.deploy ? { deploy: false, reason: reason!, sha: decision.sha } : decision, config.deploy.environment));
        console.log(JSON.stringify({ correlationId, deploy: ready, reason, sha: decision.sha ?? null })); return;
      }
      if (!decision.deploy || decision.sha !== values.sha || mutationFree || !target || 'missing' in target) {
        console.log(JSON.stringify({ correlationId, outcome: 'skipped', reason: decision.deploy ? 'stale-or-unconfigured' : decision.reason })); return;
      }
      const environment = parseDeployEnvironment(process.env.DEPLOY_ENV ?? '');
      if (environment.empty.length) console.log(`::warning title=Software Factory deploy::deploy-env without value (secret not set?): ${environment.empty.join(', ')}`);
      const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
      const report = await executeDeploy({ config, sha: decision.sha, sourceDir: values.source ?? '.', transport: new SshTransport(target),
        port, logUrl: runUrl, environment, log: line => console.log(line) });
      await writeSummary(deploySummary(report, decision, config.deploy.environment));
      console.log(JSON.stringify({ correlationId, ...report }));
      if (report.outcome !== 'deployed') process.exitCode = 1;
      return;
    }
    if (command === 'merge') {
      if (!config.merge.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log(JSON.stringify({ outcome: 'merge-disabled' })); return;
      }
      const report = await new MergeManager(new GitHubMergePort(repository, process.env.GITHUB_TOKEN ?? '', config.factory.scope, config.merge.adoptLabel),
        config, new OpenAIMergeReviewer(process.env.OPENAI_API_KEY ?? '', config), correlationId, github).run(await github.snapshot(config.manager.workflow));
      console.log(JSON.stringify({ correlationId, ...report }));
      if (report.errors.length) process.exitCode = 1;
      return;
    }
    if (command === 'check-slack') {
      if (!config.notifications.slack.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log('Slack connection check skipped in mutation-free or disabled mode'); return;
      }
      await new SlackSink(process.env.SLACK_BOT_TOKEN ?? '').checkConnection();
      console.log(JSON.stringify({ correlationId, slackConnection: 'verified', configuredChannel: config.notifications.slack.channel })); return;
    }
    if (command === 'notify') {
      const errors = await deliverNotifications(github, config, await github.snapshot(config.manager.workflow),
        new SlackSink(process.env.SLACK_BOT_TOKEN ?? ''), correlationId, new Date());
      console.log(JSON.stringify({ correlationId, outcome: errors.length ? 'partial' : 'success', errors }));
      if (errors.length) process.exitCode = 1;
      return;
    }
    if (command === 'bootstrap') {
      if (config.execution.dryRun || config.autonomy.profile === 'advisory') {
        console.log('Mutation-free mode: bootstrap skipped'); return;
      }
      console.log(JSON.stringify({ correlationId, createdLabels: await github.bootstrap() })); return;
    }
    if (['worker', 'prepare-coding', 'publish-coding'].includes(command)) {
      const issue = values.issue ?? process.env.HARNESS_ISSUE_NUMBER ?? '';
      const id = values.execution ?? process.env.HARNESS_EXECUTION_ID ?? '';
      if (!/^[1-9]\d*$/.test(issue) || !/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid worker issue or execution ID');
      if (command === 'prepare-coding') {
        const prepared = await prepareCoding(github, config, new CodingRepository(repository, process.env.GITHUB_TOKEN ?? ''), Number(issue), id, correlationId);
        if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, prepared
          ? `ready=true\nrequest=${JSON.stringify(prepared.request)}\nbase-sha=${prepared.base.sha}\nbase-branch=${prepared.base.branch}\n`
          : 'ready=false\n');
        console.log(JSON.stringify({ executionId: id, ready: !!prepared })); return;
      }
      if (command === 'publish-coding') {
        let artifact: unknown = null;
        if (process.env.SF_ARTIFACT) {
          const source = await readFile(process.env.SF_ARTIFACT, 'utf8').catch(() => 'null');
          if (Buffer.byteLength(source) <= 7000000) { try { artifact = JSON.parse(source); } catch { /* Persist failed result below. */ } }
        }
        const result = await publishCoding(github, config, new CodingRepository(repository, process.env.GITHUB_TOKEN ?? ''),
          Number(issue), id, correlationId, { sha: process.env.SF_BASE_SHA ?? '', branch: process.env.SF_BASE_BRANCH ?? '' }, artifact);
        console.log(JSON.stringify({ executionId: id, status: result.status, artifacts: result.artifacts }));
        if (result.status === 'failed') process.exitCode = 1;
        return;
      }
      const result = await executeDelegation(github, config, Number(issue), id, correlationId,
        new HarnessProcessClient(process.env.HARNESS_ENTRYPOINT ?? ''));
      console.log(JSON.stringify({ correlationId, executionId: result.executionId, status: result.status })); return;
    }
    const planner = config.llm.provider === 'mock' ? new MockPlanner() : new OpenAIPlanner(process.env.OPENAI_API_KEY ?? '');
    const report = await new Manager(github, config, planner, { correlationId,
      workerRuntime: config.execution.engine === 'temporal' ? new RuntimeHttpClient(process.env.FACTORY_RUNTIME_URL ?? '',
        process.env.FACTORY_RUNTIME_TOKEN ?? '', Number(process.env.GITHUB_REPOSITORY_ID)) : undefined,
      notifications: new SlackSink(process.env.SLACK_BOT_TOKEN ?? '') }).run();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary(report));
    console.log(JSON.stringify({ correlationId, outcome: report.outcome, tasks: report.tasks,
      executed: report.decisions.filter(d => d.executed).length, errors: report.errors, nextSteps: report.nextSteps }));
    if (config.execution.dryRun && process.env.SF_SANITY_REPORT) await writeFile(process.env.SF_SANITY_REPORT, JSON.stringify({
      formatVersion: 1, mutationFree: true, passed: report.errors.length === 0,
      correlationId, runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
      outcome: report.outcome, errors: report.errors, evaluated: report.decisions.length,
      productionVerified: false
    }));
    if (report.errors.length) process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
export async function handleError(error: unknown): Promise<void> {
  // Config errors are safe; API/request objects are deliberately never printed.
  const message = error instanceof Error ? error.message : '';
  const safe = /^(Deployment|Slack connection failed: check SLACK_BOT_TOKEN and Slack app installation$|Invalid factory configuration|Invalid YAML|Supported commands|validate requires|Local mutations|Invalid worker|OPENAI_API_KEY|GITHUB_TOKEN|Repository must|Configuration must)/.test(message)
    ? message : 'Harness failed. Check repository access, contents:read, issues:write, pull-requests:read and actions:write permissions and installed default-branch workflow.';
  const httpStatus = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : null;
  const category = error instanceof Error ? error.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) : 'UnknownError';
  console.error(JSON.stringify({ error: safe, category, httpStatus }));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `# Software Factory failed\n\n${safe.replace(/[<>`]/g, '')}\n\nCategory: ${category}; HTTP: ${httpStatus ?? 'n/a'}\n`).catch(() => {});
  process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(handleError);
