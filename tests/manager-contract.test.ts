import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const config = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/github/client.js', () => ({ GitHubClient: class { readConfig = config.read; } }));
vi.mock('../src/manager/index.js', () => ({ Manager: class { async run() { return { outcome: 'success', tasks: 0, errors: [], decisions: [] }; } } }));
import { main } from '../src/cli.js';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it.each([true, false])('writes an explicit dry-run result for enabled=%s', async enabled => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-report-'));
  try {
    config.read.mockResolvedValue(`version: 1\nfactory:\n  scope: test\n  enabled: ${enabled}`);
    vi.stubEnv('SF_SANITY_REPORT', join(dir, 'result.json'));
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['manager', '--repository', 'owner/target', '--dry-run']);
    expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toMatchObject({ formatVersion: 1, mutationFree: true, passed: enabled });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
