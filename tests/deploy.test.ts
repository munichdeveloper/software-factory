import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { configSchema, loadConfig, type Config } from '../src/config/index.js';
import { executeDeploy, parseDeployEnvironment, planDeploy, readEvent, renderDeployEnvironment, deploySummary, type DeployEvent } from '../src/deploy/index.js';
import type { CheckRun, DeployPort, DeploymentState } from '../src/deploy/github.js';
import { bashCommand, remoteValue, shellQuote } from '../src/deploy/remote.js';
import { runProcess, SshTransport, type Transport } from '../src/deploy/transport.js';
import { resolveTarget } from '../src/deploy/target.js';

const HEAD = 'a'.repeat(40);
const config = (deploy: Record<string, unknown> = {}): Config => configSchema.parse({ version: 1, factory: { scope: 'deploy test' },
  deploy: { enabled: true, workflows: ['Application checks'], ...deploy } });

class FakePort implements DeployPort {
  runs: CheckRun[] = [];
  head = { name: 'main', sha: HEAD };
  statuses: { id: number; state: DeploymentState; description: string }[] = [];
  created: { sha: string; environment: string }[] = [];
  async defaultBranch() { return this.head; }
  async workflowRuns() { return this.runs; }
  async createDeployment(sha: string, environment: string) { this.created.push({ sha, environment }); return 7; }
  async setDeploymentStatus(id: number, state: DeploymentState, description: string) { this.statuses.push({ id, state, description }); }
}
const run = (name: string, conclusion: string | null, status = 'completed', createdAt = '2026-11-07T10:00:00Z'): CheckRun =>
  ({ name, event: 'push', status, conclusion, createdAt });
const workflowRun = (overrides: Record<string, unknown> = {}): DeployEvent => ({ name: 'workflow_run', ref: 'refs/heads/main',
  payload: { workflow_run: { name: 'Application checks', event: 'push', head_branch: 'main', conclusion: 'success', head_sha: HEAD, ...overrides } } });

describe('deployment planning', () => {
  it('deploys the default-branch head after all configured workflows succeeded', async () => {
    const port = new FakePort();
    port.runs = [run('Application checks', 'success'), run('Lint', 'failure')];
    expect(await planDeploy(config(), workflowRun(), port)).toEqual({ deploy: true, sha: HEAD, source: 'workflow_run:Application checks' });
  });
  it('waits until every listed workflow has completed successfully for the commit', async () => {
    const port = new FakePort();
    const cfg = config({ workflows: ['Application checks', 'Docker'] });
    port.runs = [run('Application checks', 'success'), run('Docker', null, 'in_progress')];
    expect(await planDeploy(cfg, workflowRun(), port)).toMatchObject({ deploy: false, reason: 'checks-pending' });
    port.runs = [run('Application checks', 'success'), run('Docker', 'failure', 'completed', '2026-11-07T11:00:00Z'), run('Docker', 'success')];
    expect(await planDeploy(cfg, workflowRun(), port)).toMatchObject({ deploy: false, reason: 'checks-failed' });
    port.runs = [run('Application checks', 'success')];
    expect(await planDeploy(cfg, workflowRun(), port)).toMatchObject({ deploy: false, reason: 'checks-pending' });
  });
  it('never deploys an older commit when the default branch moved on', async () => {
    const port = new FakePort();
    port.runs = [run('Application checks', 'success')];
    expect(await planDeploy(config(), workflowRun({ head_sha: 'b'.repeat(40) }), port)).toMatchObject({ deploy: false, reason: 'superseded' });
  });
  it.each([
    [{ conclusion: 'failure' }, 'checks-failed'],
    [{ name: 'Other' }, 'unrelated-workflow'],
    [{ head_branch: 'feature' }, 'not-default-branch'],
    [{ event: 'pull_request' }, 'not-default-branch'],
    [{ head_sha: 'not-a-sha' }, 'invalid-commit']
  ])('skips workflow runs that do not qualify: %j', async (overrides, reason) => {
    expect(await planDeploy(config(), workflowRun(overrides), new FakePort())).toMatchObject({ deploy: false, reason });
  });
  it('honours the configured trigger and default branch for pushes', async () => {
    const push = (ref = 'refs/heads/main'): DeployEvent => ({ name: 'push', ref, payload: { after: HEAD } });
    expect(await planDeploy(config(), push(), new FakePort())).toMatchObject({ deploy: false, reason: 'waiting-for-checks' });
    expect(await planDeploy(config({ trigger: 'push' }), push(), new FakePort())).toEqual({ deploy: true, sha: HEAD, source: 'push' });
    expect(await planDeploy(config({ trigger: 'push' }), push('refs/heads/dev'), new FakePort())).toMatchObject({ reason: 'not-default-branch' });
    expect(await planDeploy(config({ trigger: 'push' }), workflowRun(), new FakePort())).toMatchObject({ reason: 'push-trigger-configured' });
  });
  it('lets a manual dispatch redeploy the current head, still gated by checks', async () => {
    const port = new FakePort();
    const dispatch: DeployEvent = { name: 'workflow_dispatch', ref: 'refs/heads/main', payload: {} };
    expect(await planDeploy(config(), dispatch, port)).toMatchObject({ deploy: false, reason: 'checks-pending' });
    port.runs = [run('Application checks', 'success')];
    expect(await planDeploy(config(), dispatch, port)).toMatchObject({ deploy: true, sha: HEAD });
    expect(await planDeploy(config({ trigger: 'push' }), dispatch, new FakePort())).toMatchObject({ deploy: true });
  });
  it('is inert when disabled or for unsupported events', async () => {
    expect(await planDeploy(configSchema.parse({ version: 1, factory: { scope: 'x' } }), workflowRun(), new FakePort())).toEqual({ deploy: false, reason: 'disabled' });
    expect(await planDeploy(config(), { name: 'schedule', ref: '', payload: {} }, new FakePort())).toMatchObject({ reason: 'unsupported-event' });
  });
  it('reads the Actions event payload and tolerates a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-event-'));
    await writeFile(join(dir, 'event.json'), JSON.stringify({ after: HEAD }));
    expect(await readEvent({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: join(dir, 'event.json') }))
      .toEqual({ name: 'push', ref: 'refs/heads/main', payload: { after: HEAD } });
    expect((await readEvent({ GITHUB_EVENT_PATH: join(dir, 'missing.json') })).payload).toEqual({});
    await rm(dir, { recursive: true, force: true });
  });
});

describe('configuration', () => {
  it('is disabled by default and requires workflows for the checks trigger', () => {
    const parsed = loadConfig('version: 1\nfactory:\n  scope: test\n');
    expect(parsed.deploy).toMatchObject({ enabled: false, provider: 'docker-ssh', trigger: 'checks', path: '/opt/app', envFile: '.env', githubDeployment: false });
    expect(() => loadConfig('version: 1\nfactory:\n  scope: test\ndeploy:\n  enabled: true\n')).toThrow('deploy.workflows');
    expect(loadConfig('version: 1\nfactory:\n  scope: test\ndeploy:\n  enabled: true\n  trigger: push\n').deploy.enabled).toBe(true);
  });
  it.each([
    ['path', '/opt/../etc'], ['path', 'relative'], ['path', '/opt/app;rm -rf /'], ['composeFile', '../compose.yaml'],
    ['composeFile', 'compose.txt'], ['project', 'Upper'], ['user', 'root;id'], ['host', 'host name'], ['envFile', '../.env']
  ])('rejects unsafe %s %j', (key, value) => {
    expect(configSchema.safeParse({ version: 1, factory: { scope: 'x' }, deploy: { trigger: 'push', [key]: value } }).success).toBe(false);
  });
});

describe('connection settings', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  it('reports missing secrets instead of failing', () => {
    expect(resolveTarget(config(), {})).toEqual({ missing: ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_SSH_KEY', 'DEPLOY_KNOWN_HOSTS'] });
  });
  it('prefers configuration over secrets and validates them', () => {
    const env = { DEPLOY_HOST: 'ignored.example', DEPLOY_USER: 'deploy', DEPLOY_PORT: '2222', DEPLOY_SSH_KEY: key, DEPLOY_KNOWN_HOSTS: 'vps ssh-ed25519 AAAA' };
    expect(resolveTarget(config({ host: 'vps.example.com' }), env)).toEqual({ host: 'vps.example.com', user: 'deploy', port: 2222, privateKey: key, knownHosts: env.DEPLOY_KNOWN_HOSTS });
    expect(() => resolveTarget(config(), { ...env, DEPLOY_HOST: 'bad host' })).toThrow('Deployment host is invalid');
    expect(() => resolveTarget(config(), { ...env, DEPLOY_USER: 'Root' })).toThrow('Deployment user is invalid');
    expect(() => resolveTarget(config(), { ...env, DEPLOY_PORT: '70000' })).toThrow('Deployment port is invalid');
    expect(() => resolveTarget(config(), { ...env, DEPLOY_SSH_KEY: 'ssh-ed25519 AAAA public' })).toThrow('private key');
    expect(resolveTarget(config({ port: 22 }), env)).toMatchObject({ port: 22, host: 'ignored.example' });
  });
});

describe('deployment environment', () => {
  it('parses NAME=value lines, leaves out empty values and renders literal values', () => {
    const parsed = parseDeployEnvironment('# merge review\r\nOPENAI_API_KEY=sk-a$b=c\n\n  EMPTY=  \nOTHER = x y \n');
    expect(parsed).toEqual({ values: [['OPENAI_API_KEY', 'sk-a$b=c'], ['OTHER', 'x y']], empty: ['EMPTY'] });
    expect(renderDeployEnvironment(parsed)).toBe("OPENAI_API_KEY='sk-a$b=c'\nOTHER='x y'\n");
    expect(parseDeployEnvironment('')).toEqual({ values: [], empty: [] });
  });
  it.each([
    ['no-equals-sign', 'line 1 is not NAME=value'],
    ['=value', 'line 1 is not NAME=value'],
    ['1A=x', 'line 1 is not NAME=value'],
    ['A=x\nA=y', 'names A twice'],
    ["A=it's", 'value of A contains a single quote']
  ])('rejects %j without echoing the value', (text, message) => {
    expect(() => parseDeployEnvironment(text)).toThrow(message);
    try { parseDeployEnvironment(text); } catch (error) { expect(String(error)).not.toContain('value=x'); }
  });
});

describe('shell quoting', () => {
  it('passes arbitrary values unchanged through a remote shell', () => {
    const values = ["it's", '$(id)', '`x`', 'a b', ''];
    const out = execFileSync('sh', ['-c', bashCommand('printf "%s\\n" "$@"', values)], { encoding: 'utf8' });
    expect(out).toBe(values.map(v => `${v}\n`).join(''));
    expect(shellQuote("a'b")).toBe(`'a'"'"'b'`);
    expect(remoteValue('X=1\nSF_DEPLOY_RESULT=failed\nSF_DEPLOY_RESULT=deployed\n', 'SF_DEPLOY_RESULT')).toBe('deployed');
  });
});

/** Runs the remote command through `sh -c`, exactly as sshd does, but on this machine. */
class LocalTransport implements Transport {
  closed = false;
  constructor(private env: NodeJS.ProcessEnv) {}
  run(script: string, args: string[], stdin?: Readable, timeoutMs?: number) {
    return runProcess('sh', ['-c', bashCommand(script, args)], stdin, timeoutMs, this.env);
  }
  async close() { this.closed = true; }
}

const fakeDocker = `#!/usr/bin/env bash
log="$FAKE_DOCKER_LOG"
[ "$1 $2" = "compose version" ] && exit 0
[ "$1 $2" = "image prune" ] && { echo "prune $*" >> "$log"; exit 0; }
dir=""; prev=""
for arg in "$@"; do [ "$prev" = "--project-directory" ] && dir="$arg"; prev="$arg"; done
case " $* " in
  *" up "*) echo "up $(basename "$dir") project=$3 env=$(cat "$dir/.env" 2>/dev/null) release=$SF_RELEASE_SHA" >> "$log"; [ -f "$dir/FAIL" ] && exit 1; exit 0 ;;
  *" logs "*) echo "service log output"; exit 0 ;;
esac
exit 0
`;

describe('docker-ssh deployment', () => {
  let root: string, repo: string, bin: string, log: string, env: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = async (files: Record<string, string>) => {
    for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
    git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'c', '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  const deploy = (sha: string, deployConfig: Record<string, unknown> = {}, port = new FakePort(), environment?: string) =>
    executeDeploy({ config: config({ path: join(root, 'srv', 'app'), project: 'app', healthcheck: { timeoutSeconds: 10 }, ...deployConfig }),
      sha, sourceDir: repo, transport: new LocalTransport(env), port, environment: environment === undefined ? undefined : parseDeployEnvironment(environment) });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sf-deploy-test-'));
    repo = join(root, 'repo'); bin = join(root, 'bin'); log = join(root, 'docker.log');
    await mkdir(repo); await mkdir(bin);
    execFileSync('git', ['init', '-q', repo]);
    await writeFile(join(bin, 'docker'), fakeDocker); await chmod(join(bin, 'docker'), 0o755);
    await mkdir(join(root, 'srv', 'app'), { recursive: true });
    await writeFile(join(root, 'srv', 'app', '.env'), 'SECRET=1');
    env = { PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, HOME: root };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('uploads the exact commit, links the host env file, switches current and records the deployment', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n', 'app.txt': 'v1' });
    const port = new FakePort();
    const report = await deploy(sha, { githubDeployment: true }, port);
    expect(report).toMatchObject({ outcome: 'deployed', sha, previous: null, deploymentId: 7 });
    const app = join(root, 'srv', 'app');
    expect(await readlink(join(app, 'current'))).toBe(join(app, 'releases', sha));
    expect(await readFile(join(app, 'releases', sha, 'app.txt'), 'utf8')).toBe('v1');
    expect(await readFile(log, 'utf8')).toContain(`up ${sha} project=app env=SECRET=1 release=${sha}`);
    expect(port.created).toEqual([{ sha, environment: 'production' }]);
    expect(port.statuses.map(s => s.state)).toEqual(['in_progress', 'success']);
  });

  it('writes the deployment environment privately into the release before starting it', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n' });
    const lines: string[] = [];
    const report = await executeDeploy({ config: config({ path: join(root, 'srv', 'app'), project: 'app', healthcheck: { timeoutSeconds: 10 } }),
      sha, sourceDir: repo, transport: new LocalTransport(env), port: new FakePort(), log: line => lines.push(line),
      environment: parseDeployEnvironment('OPENAI_API_KEY=sk-test\nMISSING=') });
    expect(report.outcome).toBe('deployed');
    const file = join(root, 'srv', 'app', 'releases', sha, '.sf-deploy.env');
    expect(await readFile(file, 'utf8')).toBe("OPENAI_API_KEY='sk-test'\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(lines).toContain('Deployment environment: OPENAI_API_KEY');
    expect(lines).toContain('Deployment environment left out (empty): MISSING');
    expect(lines.join('\n')).not.toContain('sk-test');
    const next = await commit({ 'app.txt': 'v2' });
    expect((await deploy(next)).outcome).toBe('deployed');
    expect(await readFile(join(root, 'srv', 'app', 'releases', next, '.sf-deploy.env'), 'utf8')).toBe('');
  });

  it('keeps only the configured number of releases', async () => {
    const shas = [];
    for (let i = 0; i < 4; i++) {
      shas.push(await commit({ 'compose.yaml': 'services: {}\n', 'app.txt': `v${i}` }));
      expect((await deploy(shas[i]!, { keepReleases: 2 })).outcome).toBe('deployed');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect((await readdir(join(root, 'srv', 'app', 'releases'))).sort()).toEqual(shas.slice(-2).sort());
    expect(await readFile(log, 'utf8')).toContain('prune image prune --force --filter label=com.docker.compose.project=app');
  });

  it('restores the previous release when the new one fails to start', async () => {
    const good = await commit({ 'compose.yaml': 'services: {}\n' });
    await deploy(good);
    const bad = await commit({ FAIL: '1' });
    const port = new FakePort();
    const report = await deploy(bad, { githubDeployment: true }, port);
    expect(report).toMatchObject({ outcome: 'rolled-back', sha: bad, previous: good });
    expect(report.detail).toContain('restored');
    expect(await readlink(join(root, 'srv', 'app', 'current'))).toContain(good);
    expect((await readFile(log, 'utf8')).trim().split('\n').at(-1)).toContain(`up ${good}`);
    expect((await readFile(log, 'utf8')).trim().split('\n').at(-1)).toContain(`release=${good}`);
    expect(port.statuses.at(-1)?.state).toBe('failure');
  });

  it('reports a failure without rollback when disabled or no previous release exists', async () => {
    const bad = await commit({ 'compose.yaml': 'services: {}\n', FAIL: '1' });
    expect(await deploy(bad)).toMatchObject({ outcome: 'failed', previous: null });
    const good = await commit({ FAIL: '' });
    execFileSync('git', ['-C', repo, 'rm', '-q', 'FAIL']);
    const fixed = await commit({});
    void good;
    await deploy(fixed);
    const broken = await commit({ FAIL: '1' });
    expect(await deploy(broken, { rollback: false })).toMatchObject({ outcome: 'failed', detail: 'Release failed (exit 2)' });
  });

  it('checks preconditions on the host before touching containers', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n' });
    expect(await deploy(sha, { envFile: 'missing.env' })).toMatchObject({ outcome: 'failed', detail: 'Precondition failed: env-file-missing' });
    expect(await deploy(sha, { composeFile: 'docker-compose.yml' })).toMatchObject({ detail: 'Precondition failed: compose-file-missing' });
    expect(await deploy(sha, { envFile: null })).toMatchObject({ outcome: 'deployed' });
  });

  it('runs the configured HTTP health check on the host', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n' });
    await writeFile(join(bin, 'curl'), '#!/bin/sh\necho "$@" >> "$FAKE_DOCKER_LOG"\nexit "${FAKE_CURL_EXIT:-0}"\n'); await chmod(join(bin, 'curl'), 0o755);
    expect(await deploy(sha, { healthcheck: { url: 'http://127.0.0.1:3000/', timeoutSeconds: 10 } })).toMatchObject({ outcome: 'deployed' });
    expect(await readFile(log, 'utf8')).toContain('http://127.0.0.1:3000/');
    env.FAKE_CURL_EXIT = '7';
    expect(await deploy(sha, { healthcheck: { url: 'http://127.0.0.1:3000/', timeoutSeconds: 10 } })).toMatchObject({ outcome: 'failed' });
  }, 30000);

  it('refuses a source checkout that does not match the planned commit', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n' });
    await expect(deploy('b'.repeat(40))).rejects.toThrow('does not match');
    const port = new FakePort();
    const failing: Transport = { run: async () => ({ code: 255, stdout: '', stderr: 'Permission denied (publickey)' }), close: async () => {} };
    await expect(executeDeploy({ config: config({ githubDeployment: true }), sha, sourceDir: repo, transport: failing, port })).rejects.toThrow('Deployment upload failed (exit 255)');
    expect(port.statuses.map(s => s.state)).toEqual(['in_progress', 'error']);
  });

  it('invokes OpenSSH with a pinned host key and a private key file only', async () => {
    const sha = await commit({ 'compose.yaml': 'services: {}\n' });
    // Fake ssh: records its arguments, checks the key file permissions and runs the remote command locally.
    await writeFile(join(bin, 'ssh'), `#!/usr/bin/env bash
# The transport passes only PATH/HOME, so the log location is fixed here.
export FAKE_DOCKER_LOG=${JSON.stringify(log)}
echo "$@" > "$FAKE_DOCKER_LOG.ssh"
key=""; prev=""; for a in "$@"; do [ "$prev" = "-i" ] && key="$a"; prev="$a"; done
stat -c %a "$key" >> "$FAKE_DOCKER_LOG.ssh"
exec sh -c "\${@: -1}"
`);
    await chmod(join(bin, 'ssh'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = env.PATH;
    try {
      const transport = new SshTransport({ host: 'vps.example.com', port: 2222, user: 'deploy', privateKey: 'KEY', knownHosts: 'vps.example.com ssh-ed25519 AAAA' });
      const report = await executeDeploy({ config: config({ path: join(root, 'srv', 'app'), project: 'app' }), sha, sourceDir: repo, transport, port: new FakePort(), log: line => console.error(line) });
      expect(report.outcome).toBe('deployed');
      const args = await readFile(`${log}.ssh`, 'utf8');
      expect(args).toContain('-o StrictHostKeyChecking=yes');
      expect(args).toContain('-o IdentitiesOnly=yes');
      expect(args).toContain('-p 2222 -l deploy -- vps.example.com');
      expect(args.trim().split('\n').at(-1)).toBe('600');
      const keyFile = /-i (\S+)/.exec(args)![1]!;
      await expect(readFile(keyFile)).rejects.toThrow('ENOENT');
    } finally { process.env.PATH = previousPath; }
  });

  it('summarises deployments and skips', () => {
    expect(deploySummary(null, { deploy: false, reason: 'checks-pending', sha: HEAD }, 'production')).toContain('checks-pending (aaaaaaaaaaaa)');
    expect(deploySummary({ outcome: 'deployed', sha: HEAD, previous: null, deploymentId: null, detail: 'ok' }, { deploy: true, sha: HEAD, source: 'push' }, 'prod|x'))
      .toContain('| Environment | prodx |');
  });
});
