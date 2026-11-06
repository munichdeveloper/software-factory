import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { HarnessProcessClient } from '../src/workers/harness-client.js';
import { executeDelegation } from '../src/workers/execute-delegation.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { config, issue, MemoryGitHub, clock } from './helpers.js';
if (!process.env.HARNESS_ENTRYPOINT) throw new Error('Set HARNESS_ENTRYPOINT to the separately built pinned Harness CLI');
const runtime = new HarnessProcessClient(process.env.HARNESS_ENTRYPOINT);
it('uses exactly the pinned runtime JSON contracts', async () => {
  for (const name of ['request', 'result']) {
    const upstream = JSON.parse(await readFile(resolve(dirname(process.env.HARNESS_ENTRYPOINT!), `../schemas/${name}.schema.json`), 'utf8'));
    const consumer = JSON.parse(await readFile(`src/workers/contracts/${name}.schema.json`, 'utf8'));
    expect(consumer).toEqual(upstream);
  }
});
it('runs SF planning → separate Harness process → durable result → later SF reconciliation', async () => {
  const github = new MemoryGitHub(), cfg = config(); github.state.issues.push(issue());
  const manager = () => new Manager(github, cfg, new MockPlanner(), { correlationId: 'integration', now: () => clock }).run();
  await manager(); const id = reconstruct(github.state, cfg, clock)[0]!.latest!.input.executionId;
  const result = await executeDelegation(github, cfg, 1, id, 'worker', runtime);
  expect(result.status).toBe('success'); expect(result.artifacts[0]).toMatch(/^urn:sha256:[a-f0-9]{64}$/);
  github.state.runs[0]!.status = 'completed'; await manager();
  expect(github.state.issues[0]!.labels).toContain('harness:awaiting-pr');
  const mutations = github.mutations.length; await manager(); expect(github.mutations).toHaveLength(mutations);
});
