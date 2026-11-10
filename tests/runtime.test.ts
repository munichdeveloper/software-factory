import { describe, expect, it, vi } from 'vitest';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { RuntimeHttpClient } from '../src/runtime/client.js';
import type { RuntimeObservation, WorkerRuntimePort } from '../src/runtime/contract.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';
import { decodeEvent } from '../src/state/events.js';

function fixture() {
  const github = new MemoryGitHub(), cfg = config(); cfg.execution.engine = 'temporal'; github.state.issues.push(issue());
  const observations: RuntimeObservation[] = [];
  const start = vi.fn<WorkerRuntimePort['start']>(async admission => {
    const observation: RuntimeObservation = { issueNumber: 1, executionId: admission.input.executionId, workflowId: `sf-42-${admission.input.executionId}`,
      runId: '00000000-0000-4000-8000-000000000001', status: 'running', phase: 'awaiting-approval', binding: 'a'.repeat(64), createdAt: clock.toISOString(), result: null };
    observations.push(observation); return observation;
  });
  const runtime: WorkerRuntimePort = { start, observations: async ids => observations.filter(r => ids.includes(r.executionId)), cancel: vi.fn(async () => {}) };
  const run = (now = clock) => new Manager(github, cfg, new MockPlanner(), { correlationId: 'runtime-test', workerRuntime: runtime, now: () => now }).run();
  return { github, cfg, runtime, start, observations, run };
}
describe('regular Factory manager on Temporal', () => {
  it('persists an intent and actual Temporal receipt; never dispatches GitHub Actions', async () => {
    const f = fixture(); expect((await f.run()).errors).toEqual([]);
    expect(f.start).toHaveBeenCalledOnce(); expect(f.github.dispatches).toBe(0);
    expect(f.github.state.issues[0]!.labels).toContain('harness:awaiting-approval');
    const events = (f.github.state.comments.get(1) ?? []).map(c => decodeEvent(c, f.cfg.manager.trustedActors));
    expect(events.map(e => e?.data.type)).toContain('temporal_receipt');
    expect(events.find(e => e?.data.type === 'temporal_receipt')?.data).toMatchObject({ runId: f.observations[0]!.runId });
  });
  it('keeps an open human gate across long pauses without worker timeout or redispatch', async () => {
    const f = fixture(); await f.run(); const report = await f.run(new Date(clock.getTime() + 7 * 86400000));
    expect(report.errors).toEqual([]); expect(f.start).toHaveBeenCalledOnce(); expect(f.runtime.cancel).not.toHaveBeenCalled();
    const task = reconstruct({ ...f.github.state, runtimeExecutions: f.observations }, f.cfg, new Date(clock.getTime() + 7 * 86400000))[0]!;
    expect(task.desiredStatus).toBe('awaiting-approval'); expect(task.latest).toMatchObject({ active: true, timedOut: false, ambiguous: false });
  });
  it('fails closed when a Temporal repository has no runtime client', async () => {
    const f = fixture(); await expect(new Manager(f.github, f.cfg, new MockPlanner(), { correlationId: 'missing' }).run()).rejects.toThrow('Temporal runtime is required');
    expect(f.github.dispatches).toBe(0); expect(f.github.mutations).toEqual([]);
  });
  it('fails closed on an unavailable observer before starting additional work', async () => {
    const f = fixture(); f.runtime.observations = async () => { throw new Error('unavailable'); };
    await expect(f.run()).rejects.toThrow('unavailable'); expect(f.start).not.toHaveBeenCalled(); expect(f.github.dispatches).toBe(0);
  });
  it('reconciles a completed runtime result through the original lifecycle and journal', async () => {
    const f = fixture(); await f.run(); const r = f.observations[0]!;
    r.status = 'completed'; r.phase = 'completed'; r.result = { contractVersion: '1.0', executionId: r.executionId, issueNumber: 1, status: 'success', summary: 'Completed by pinned runtime', artifacts: [], error: null, proposedActions: [] };
    await f.run(); expect(f.start).toHaveBeenCalledOnce(); expect(f.github.state.issues[0]!.labels).toContain('harness:awaiting-pr');
    expect((f.github.state.comments.get(1) ?? []).some(c => decodeEvent(c, f.cfg.manager.trustedActors)?.data.type === 'result')).toBe(true);
  });
  it('routes a real execution timeout back to Temporal cancellation', async () => {
    const f = fixture(); await f.run(); f.observations[0]!.phase = 'running';
    await f.run(new Date(clock.getTime() + 31 * 60000));
    expect(f.runtime.cancel).toHaveBeenCalledWith(f.observations[0]!.executionId); expect(f.github.mutations.some(m => m.startsWith('cancel:'))).toBe(false);
  });
});
describe('runtime transport boundary', () => {
  it('rejects plaintext remote endpoints, URL credentials and missing identity', () => {
    for (const url of ['http://example.com','https://user:password@example.com','https://example.com/?token=x']) expect(() => new RuntimeHttpClient(url, 'x'.repeat(32), 42)).toThrow();
    expect(() => new RuntimeHttpClient('http://localhost:8095', '', 42)).toThrow();
    expect(() => new RuntimeHttpClient('http://localhost:8095', 'x'.repeat(32), NaN)).toThrow();
  });
  it('uses the fixed numeric repository identity and rejects malformed runtime facts', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('[]'));
    const client = new RuntimeHttpClient('https://runtime.example', 'x'.repeat(32), 42, fetcher);
    expect(await client.observations(['a'.repeat(32)])).toEqual([]);
    expect(String(fetcher.mock.calls[0]![0])).toBe('https://runtime.example/v1/repositories/42/observations');
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
    fetcher.mockResolvedValueOnce(new Response('[{"executionId":"forged"}]'));
    await expect(client.observations([])).rejects.toThrow();
  });
  it('does not expose an upstream secret-bearing error body', async () => {
    const client = new RuntimeHttpClient('https://runtime.example','x'.repeat(32),42,async () => new Response('secret connection string', { status: 500 }));
    await expect(client.cancel('a'.repeat(32))).rejects.toThrow('Factory runtime request rejected or unavailable');
  });
});
