import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const github = vi.hoisted(() => ({ readConfig: vi.fn() }));
const port = vi.hoisted(() => ({ defaultBranch: vi.fn(), workflowRuns: vi.fn(), createDeployment: vi.fn(), setDeploymentStatus: vi.fn() }));
const deploy = vi.hoisted(() => ({ executeDeploy: vi.fn() }));
vi.mock('../src/github/client.js', () => ({ GitHubClient: class { readConfig = github.readConfig; } }));
vi.mock('../src/deploy/github.js', () => ({ GitHubDeployPort: class {
  defaultBranch = port.defaultBranch; workflowRuns = port.workflowRuns; createDeployment = port.createDeployment; setDeploymentStatus = port.setDeploymentStatus;
} }));
vi.mock('../src/deploy/index.js', async original => ({ ...(await original<typeof import('../src/deploy/index.js')>()), executeDeploy: deploy.executeDeploy }));
import { main } from '../src/cli.js';

const head = 'a'.repeat(40);
const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sf-cli-deploy-'));
  await writeFile(join(dir, 'event.json'), JSON.stringify({ after: head }));
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/target', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    DEPLOY_HOST: 'vps.example.com', DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY: key, DEPLOY_KNOWN_HOSTS: 'vps.example.com ssh-ed25519 AAAA' })) vi.stubEnv(name, value);
  await writeFile(join(dir, 'output'), ''); await writeFile(join(dir, 'summary'), '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  scope: test\ndeploy:\n  enabled: true\n  trigger: push\n');
  port.defaultBranch.mockResolvedValue({ name: 'main', sha: head });
  deploy.executeDeploy.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('plans a deployment and exposes the commit to the checkout step', async () => {
  await main(['deploy-plan']);
  expect(await readFile(join(dir, 'output'), 'utf8')).toBe(`deploy=true\nsha=${head}\n`);
});
it('skips with a warning instead of failing while connection secrets are missing', async () => {
  vi.stubEnv('DEPLOY_SSH_KEY', '');
  await main(['deploy-plan']);
  expect(await readFile(join(dir, 'output'), 'utf8')).toBe(`deploy=false\nsha=${head}\n`);
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('::warning title=Software Factory deploy::Deployment skipped: missing DEPLOY_SSH_KEY'));
  expect(await readFile(join(dir, 'summary'), 'utf8')).toContain('not-configured');
});
it('stays mutation-free in dry-run and advisory mode', async () => {
  await main(['deploy-plan', '--dry-run']);
  expect(await readFile(join(dir, 'output'), 'utf8')).toBe(`deploy=false\nsha=${head}\n`);
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  scope: test\nautonomy:\n  profile: advisory\ndeploy:\n  enabled: true\n  trigger: push\n');
  await main(['deploy', '--sha', head]);
  expect(deploy.executeDeploy).not.toHaveBeenCalled();
});
it('deploys only the planned commit and fails the job on a failed rollout', async () => {
  await main(['deploy', '--sha', 'b'.repeat(40)]);
  expect(deploy.executeDeploy).not.toHaveBeenCalled();
  deploy.executeDeploy.mockResolvedValue({ outcome: 'rolled-back', sha: head, previous: 'c'.repeat(40), deploymentId: null, detail: 'Release failed; previous release restored' });
  await main(['deploy', '--sha', head, '--source', dir]);
  expect(deploy.executeDeploy).toHaveBeenCalledWith(expect.objectContaining({ sha: head, sourceDir: dir }));
  expect(process.exitCode).toBe(1);
  expect(await readFile(join(dir, 'summary'), 'utf8')).toContain('rolled-back');
  process.exitCode = 0;
});
it('respects the global kill switch', async () => {
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  enabled: false\n  scope: test\ndeploy:\n  enabled: true\n  trigger: push\n');
  await main(['deploy-plan']);
  expect(await readFile(join(dir, 'output'), 'utf8')).toBe('');
});
