import { expect, it, vi } from 'vitest';
import { config, issue, MemoryGitHub } from './helpers.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { prepareCoding, publishCoding, validateChanges, type CodingArtifact } from '../src/workers/coding.js';
import { decodeEvent } from '../src/state/events.js';

const base = { sha: 'c'.repeat(40), branch: 'main' };
async function fixture() {
  const cfg = config(); cfg.workers.test.enabled = false;
  cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null };
  const gh = new MemoryGitHub(); gh.state.issues = [issue()];
  await new Manager(gh, cfg, new MockPlanner(), { correlationId: 'test' }).run();
  const intent = (await gh.comments(1)).map(c => decodeEvent(c, cfg.manager.trustedActors)).find(e => e?.data.type === 'intent')!;
  if (intent.data.type !== 'intent') throw new Error('No delegation');
  const id = intent.data.input.executionId;
  const repo = { base: vi.fn(async () => base), publish: vi.fn(async () => 'https://github.com/owner/target/pull/2') };
  const prepared = await prepareCoding(gh, cfg, repo, 1, id, 'test');
  if (!prepared) throw new Error('Not ready');
  const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: base.sha,
    result: { contractVersion: '2.0', executionId: id, taskId: prepared.request.task.id, taskVersion: prepared.request.task.version,
      status: 'success', summary: 'Fixed and tested', artifacts: [], error: null },
    changes: [{ path: 'docs/example.md', content: Buffer.from('implemented').toString('base64'), mode: '100644' }] };
  return { cfg, gh, id, repo, prepared, artifact };
}
it('dispatches Codex when selected and supplies only a generic single-run request', async () => {
  const { prepared, gh } = await fixture();
  expect(gh.dispatches).toBe(1);
  expect(prepared.request.worker).toBe('codex');
  expect(prepared.request).not.toHaveProperty('repository');
  expect(prepared.request.model).toBe('gpt-6.1-sol');
});
it('publishes a correlated PR and persists the result once across repeated callbacks', async () => {
  const f = await fixture();
  const first = await publishCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test', base, f.artifact);
  expect(first.status).toBe('success'); expect(first.artifacts).toContain('https://github.com/owner/target/pull/2');
  expect(await publishCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test', base, f.artifact)).toEqual(first);
  expect(f.repo.publish).toHaveBeenCalledTimes(1);
  expect(await prepareCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test')).toBeNull();
});
it.each(['policy', 'task', 'block', 'closed'])('reauthorizes before publication after a %s change', async change => {
  const f = await fixture();
  if (change === 'policy') f.cfg.autonomy.overrides.start_worker = 'deny';
  if (change === 'task') f.gh.state.issues[0]!.body += 'Changed';
  if (change === 'block') f.gh.labelBlock(1, true);
  if (change === 'closed') f.gh.state.issues[0]!.state = 'closed';
  expect((await publishCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test', base, f.artifact)).status).toBe('cancelled');
  expect(f.repo.publish).not.toHaveBeenCalled();
});
it('stops stale preparation before giving the worker a request', async () => {
  const f = await fixture(); f.gh.labelBlock(1, true);
  expect(await prepareCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test')).toBeNull();
});
it.each(['missing', 'identity', 'base', 'protected', 'publish-failed'])('journals failed %s output without publishing unsafe changes', async failure => {
  const f = await fixture();
  let artifact: unknown = f.artifact;
  if (failure === 'missing') artifact = null;
  if (failure === 'identity') f.artifact.result.executionId = 'f'.repeat(32);
  if (failure === 'base') f.artifact.baseSha = 'f'.repeat(40);
  if (failure === 'protected') f.artifact.changes[0]!.path = '.github/workflows/backdoor.yml';
  if (failure === 'publish-failed') f.repo.publish.mockRejectedValue(new Error('private details'));
  const result = await publishCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test', base, artifact);
  expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain('private details');
  if (failure !== 'publish-failed') expect(f.repo.publish).not.toHaveBeenCalled();
});
it('reports no-change success as blocked and never publishes failed or timed-out runs', async () => {
  for (const status of ['success', 'blocked', 'failed', 'timed_out'] as const) {
    const f = await fixture(); f.artifact.changes = []; f.artifact.result.status = status;
    const result = await publishCoding(f.gh, f.cfg, f.repo, 1, f.id, 'test', base, f.artifact);
    expect(result.status).toBe(status === 'success' ? 'blocked' : status === 'timed_out' ? 'failed' : status);
    expect(f.repo.publish).not.toHaveBeenCalled();
  }
});
it.each(['../escape', '/absolute', 'a//b', 'a\\b', 'a/./b', 'a/../b', 'a:stream', 'AGENTS.md', 'docs/AGENTS.md',
  '.GITHUB/workflows/a.yml', '.git/config', '.codex/config.toml', 'CODEOWNERS', 'a. ', 'a\nname'])('rejects path %j', async path => {
  const f = await fixture(); f.artifact.changes[0]!.path = path;
  expect(() => validateChanges(f.artifact)).toThrow('path');
});
it('rejects duplicate/case-colliding paths, invalid base64 and excessive byte count', async () => {
  const f = await fixture();
  f.artifact.changes.push({ ...f.artifact.changes[0]!, path: 'DOCS/EXAMPLE.MD' });
  expect(() => validateChanges(f.artifact)).toThrow('Duplicate'); f.artifact.changes.pop();
  f.artifact.changes[0]!.content = '*'; expect(() => validateChanges(f.artifact)).toThrow('encoding');
  f.artifact.changes[0]!.content = Buffer.alloc(5000001).toString('base64');
  expect(() => validateChanges(f.artifact)).toThrow('limit');
  f.artifact.changes[0]!.content = null; expect(() => validateChanges(f.artifact)).not.toThrow();
});
