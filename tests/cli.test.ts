import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const github = vi.hoisted(() => ({ readConfig: vi.fn(), bootstrap: vi.fn() }));
vi.mock('../src/github/client.js', () => ({ GitHubClient: class {
  readConfig = github.readConfig;
  bootstrap = github.bootstrap;
} }));
import { main } from '../src/cli.js';
beforeEach(() => {
  vi.stubEnv('GITHUB_ACTIONS', 'false');
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  github.readConfig.mockReset(); github.bootstrap.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each([false, true])('advisory bootstrap never writes, even with local-write opt-in=%s', async optIn => {
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  scope: test\nautonomy:\n  profile: advisory');
  await main(['bootstrap', '--repository', 'owner/target', ...(optIn ? ['--allow-local-writes'] : [])]);
  expect(github.bootstrap).not.toHaveBeenCalled();
  expect(console.log).toHaveBeenCalledWith('Mutation-free mode: bootstrap skipped');
});
it('dry-run bootstrap never writes in a mutating profile', async () => {
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  scope: test');
  await main(['bootstrap', '--repository', 'owner/target', '--dry-run']);
  expect(github.bootstrap).not.toHaveBeenCalled();
});
it('normal local bootstrap requires the write opt-in', async () => {
  github.readConfig.mockResolvedValue('version: 1\nfactory:\n  scope: test');
  await expect(main(['bootstrap', '--repository', 'owner/target'])).rejects.toThrow('Local mutations require');
  expect(github.bootstrap).not.toHaveBeenCalled();
});
