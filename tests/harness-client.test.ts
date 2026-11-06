import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { HarnessProcessClient } from '../src/workers/harness-client.js';
import type { WorkerInput } from '../src/workers/contract.js';
export const input = (description = 'abc'): WorkerInput => ({ contractVersion: '1.0', repository: 'owner/target', issueNumber: 1,
  taskVersion: 'a'.repeat(64), description, acceptanceCriteria: ['A digest'], contextReferences: [], executionId: 'b'.repeat(32),
  allowedActions: ['publish_result'], limits: { timeoutMinutes: 1, maxOutputBytes: 16000 }, operation: 'sha256' });
const client = () => new HarnessProcessClient(fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url)));
afterEach(() => vi.unstubAllEnvs());
it('keeps credentials out of the separate runtime and correlates its result', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'sentinel-github'); vi.stubEnv('OPENAI_API_KEY', 'sentinel-openai');
  const result = await client().execute(input()); expect(result.summary).toBe('credential-free'); expect(result.issueNumber).toBe(1);
});
it.each(['exit', 'large', 'invalid', 'wrong'])('rejects invalid or unrelated runtime output: %s', async description => {
  await expect(client().execute(input(description))).rejects.toThrow();
});
it('rejects unsupported inputs and missing runtime executables', async () => {
  await expect(client().execute({ ...input(), description: '' })).rejects.toThrow();
  await expect(new HarnessProcessClient(fileURLToPath(new URL('./missing.mjs', import.meta.url))).execute(input())).rejects.toThrow();
  expect(() => new HarnessProcessClient('relative.js')).toThrow();
});
