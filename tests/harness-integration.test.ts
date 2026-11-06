import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { HarnessProcessClient } from '../src/workers/harness-client.js';
import { executeDelegation } from '../src/workers/execute-delegation.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { config, issue, MemoryGitHub, clock } from './helpers.js';
import Ajv2020 from 'ajv/dist/2020.js';
import { codingArtifactSchema, prepareCoding, publishCoding } from '../src/workers/coding.js';
if (!process.env.HARNESS_ENTRYPOINT) throw new Error('Set HARNESS_ENTRYPOINT to the separately built pinned Harness CLI');
const runtime = new HarnessProcessClient(process.env.HARNESS_ENTRYPOINT);
it('uses exactly the pinned runtime JSON contracts', async () => {
  for (const name of ['request', 'result']) {
    const upstream = JSON.parse(await readFile(resolve(dirname(process.env.HARNESS_ENTRYPOINT!), `../schemas/${name}.schema.json`), 'utf8'));
    const consumer = JSON.parse(await readFile(`src/workers/contracts/${name}.schema.json`, 'utf8'));
    expect(consumer).toEqual(upstream);
  }
});
it('passes the pinned Harness coding schemas through SF authorization and publication', async () => {
  const github = new MemoryGitHub(), cfg = config(); github.state.issues.push(issue());
  cfg.workers.test.enabled = false;
  cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null };
  const repository = { async base() { return { sha: 'c'.repeat(40), branch: 'main' }; }, async publish() { return 'https://github.com/owner/target/pull/2'; } };
  await new Manager(github, cfg, new MockPlanner(), { correlationId: 'integration', now: () => clock }).run();
  const id = reconstruct(github.state, cfg, clock)[0]!.latest!.input.executionId;
  const prepared = (await prepareCoding(github, cfg, repository, 1, id, 'integration'))!;
  const ajv = new Ajv2020({ strict: false });
  const schema = async (name: string) => JSON.parse(await readFile(resolve(dirname(process.env.HARNESS_ENTRYPOINT!), `../schemas/coding-${name}.schema.json`), 'utf8'));
  expect(ajv.compile(await schema('request'))(prepared.request)).toBe(true);
  const artifact = { contractVersion: '3.0', baseSha: prepared.base.sha,
    result: { contractVersion: '2.0', executionId: id, taskId: prepared.request.task.id, taskVersion: prepared.request.task.version,
      status: 'success', summary: 'Implemented and tested', artifacts: [], error: null },
    changes: [{ path: 'docs/verified.md', content: 'eA==', mode: '100644' }] };
  expect(ajv.compile(await schema('artifact'))(artifact)).toBe(true);
  expect(codingArtifactSchema.safeParse(artifact).success).toBe(true);
  expect((await publishCoding(github, cfg, repository, 1, id, 'integration', prepared.base, artifact)).artifacts).toHaveLength(1);
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
