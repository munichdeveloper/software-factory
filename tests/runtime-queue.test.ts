import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { QueueBoard } from '../src/runtime/queue.js';
import type { MergeObserver, MergeProgress } from '../src/runtime/merge.js';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import { World } from './scenario-world.js';

/** One reconciliation like the broker's, recorded on the queue board. */
async function reconcile(w: World, board: QueueBoard) {
  const manager = new Manager(w.github, w.cfg, new MockPlanner(), { correlationId: 'temporal:42', now: () => w.now, workerRuntime: w.controller });
  const report = await manager.run();
  board.observed(w.repo, w.cfg, manager.settledSnapshot, report, manager.lastRejections);
}
const repository = (board: QueueBoard, w: World) => board.view([w.repo]).repositories[0]!;

describe('queue view', () => {
  it('lists running, slot-waiting and grant-waiting tasks in queue order with their slots', async () => {
    const w = new World({ readyLabel: true, maxParallelWorkers: 1 }), board = new QueueBoard(() => w.now, 360);
    w.open(1); w.open(2); w.open(3); w.issue(3).labels.push('harness:priority-high');
    w.grant(1); w.grant(2);
    await reconcile(w, board); await reconcile(w, board);
    const view = board.view([w.repo]);
    expect(view.reconcileIntervalSeconds).toBe(360);
    const repo = view.repositories[0]!;
    expect(repo.slots).toEqual({ active: 1, max: 1 });
    expect(repo.observedAt).toBe(w.now.toISOString());
    expect(repo.entries.map(e => [e.issueNumber, e.stage])).toEqual([[1, 'running'], [2, 'queued'], [3, 'awaiting-grant']]);
    const [running, queued, grant] = repo.entries;
    expect(running!.run).toMatchObject({ executionId: expect.any(String), startedAt: expect.any(String) });
    expect(running!.attempts).toEqual({ used: 1, max: 3 });
    expect(queued!.waitsForSlot).toBe(true);
    expect(queued!.run).toBeNull();
    expect(grant!.priority).toBe('high');
    expect(grant!.url).toBe(`https://github.com/${w.repo.repository}/issues/3`);
  });

  it('shows a retried attempt as running again, a failed task with its fixed code and a block with its reason', async () => {
    const w = new World({ readyLabel: true, maxRetries: 1 }), board = new QueueBoard(() => w.now);
    w.open(1); w.grant(1); await reconcile(w, board);
    const id = w.running()[0]!.snapshot.admission.input.executionId;
    await w.finish(id, 'failed', 'WORKER_TIMEOUT'); await reconcile(w, board);
    expect(repository(board, w).entries[0]).toMatchObject({ issueNumber: 1, stage: 'running', attempts: { used: 2, max: 2 } });
    const second = w.running()[0]!.snapshot.admission.input.executionId;
    await w.finish(second, 'failed', 'WORKER_TIMEOUT'); await reconcile(w, board);
    expect(repository(board, w).entries[0]).toMatchObject({ issueNumber: 1, stage: 'failed', reason: 'WORKER_TIMEOUT', run: null });
    w.open(2); w.issue(2).body = 'No criteria here'; await reconcile(w, board);
    const blocked = repository(board, w).entries.find(e => e.issueNumber === 2)!;
    expect(blocked.stage).toBe('blocked');
    expect(blocked.reason).toMatch(/^Missing Acceptance/);
  });

  it('shows each attempt with its purpose and validation, the merge step of its pull request and the merged task for a day', async () => {
    const w = new World({ merging: true, rework: true }), board = new QueueBoard(() => w.now);
    const progress = new Map<number, MergeProgress>();
    const observe: MergeObserver = (pullRequest, step, detail = null, risk = null) => { progress.set(pullRequest, { pullRequest, step, detail, risk, at: w.now.toISOString() }); };
    const observed = async () => {
      const manager = new Manager(w.github, w.cfg, new MockPlanner(), { correlationId: 'temporal:42', now: () => w.now, workerRuntime: w.controller });
      const report = await manager.run();
      board.observed(w.repo, w.cfg, manager.settledSnapshot, report, manager.lastRejections, progress);
      return repository(board, w).entries.find(e => e.issueNumber === 1)!;
    };
    w.open(1); await w.tick();
    expect((await observed()).runs).toEqual([expect.objectContaining({ kind: 'first', active: true, outcome: null, validation: null })]);
    const first = w.running()[0]!.snapshot.admission.input.executionId;
    await w.finishCoding(first, 'passed'); await w.tick(); await w.tick();
    const pr = w.github.state.prs[0]!.number; w.refusedHeads.add(w.pulls.get(pr)!.head);
    await w.mergePass(observe); expect(progress.get(pr)).toMatchObject({ step: 'checks' });
    await w.mergePass(observe); expect(progress.get(pr)).toMatchObject({ step: 'review-rejected', detail: 'KI-Entscheidung: request_changes.' });
    await w.tick(); await w.tick();
    const reworking = await observed();
    expect(reworking.runs.map(r => [r.kind, r.outcome, r.validation])).toEqual([['first', 'success', 'passed'], ['review', null, null]]);
    const second = w.running()[0]!.snapshot.admission.input.executionId;
    await w.finishCoding(second, 'passed'); await w.tick(); await w.tick();
    const next = w.github.state.prs[1]!.number;
    await w.mergePass(observe); await w.mergePass(observe);
    expect(progress.get(next)).toMatchObject({ step: 'merged' });
    w.issue(1).updatedAt = w.now.toISOString(); // GitHub closed the issue with the merge
    const done = await observed();
    expect(done).toMatchObject({ stage: 'closed', mergedAt: w.now.toISOString(), merge: { pullRequest: next, step: 'merged' } });
    expect(done.runs.map(r => [r.kind, r.outcome, r.validation])).toEqual([['first', 'success', 'passed'], ['review', 'success', 'passed']]);
    w.advance(25 * 60); expect((await observed())).toBeUndefined();
  });

  it('keeps the last view when a reconciliation fails and lists repositories never reconciled', async () => {
    const w = new World({ readyLabel: true }), board = new QueueBoard(() => w.now);
    w.open(1); await reconcile(w, board);
    board.failed(w.repo, 'GITHUB_HTTP_403');
    const repo = repository(board, w);
    expect(repo.failure).toEqual({ reason: 'GITHUB_HTTP_403', at: w.now.toISOString() });
    expect(repo.entries).toHaveLength(1);
    board.failed(w.repo, 'some external text');
    expect(repository(board, w).failure!.reason).toBe('OPERATION_FAILED');
    const other = board.view([{ repositoryId: 7, repository: 'owner/new' }]).repositories[0]!;
    expect(other).toMatchObject({ repository: 'owner/new', observedAt: null, entries: [], slots: null });
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
describe('GET /v1/queue', () => {
  const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32), monitorToken = 'q'.repeat(32);
  async function serve(options: { monitorToken?: string; queue?: QueueBoard }) {
    const bindings = [{ repository: { repositoryId: 42, repository: 'owner/target' } }] as unknown as RuntimeBinding[];
    const server = runtimeServer({ managerToken, workerToken, bindings, store: {} as RuntimeStore, ...options });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    return (path: string, token: string, method = 'GET') => fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  }
  it('serves the view to the monitor and manager tokens only, and the monitor token opens nothing else', async () => {
    const call = await serve({ monitorToken, queue: new QueueBoard(() => new Date('2026-11-18T12:00:00Z'), 180) });
    const ok = await call('/v1/queue', monitorToken);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ generatedAt: '2026-11-18T12:00:00.000Z', reconcileIntervalSeconds: 180,
      repositories: [{ repositoryId: 42, repository: 'owner/target', observedAt: null, outcome: null, failure: null, slots: null, entries: [] }] });
    expect((await call('/v1/queue', managerToken)).status).toBe(200);
    expect((await call('/v1/queue', workerToken)).status).toBe(401);
    expect((await call('/v1/queue', 'x'.repeat(32))).status).toBe(401);
    expect((await call('/v1/queue', monitorToken, 'POST')).status).toBe(409);
    expect((await call('/v1/repositories/42/runs', monitorToken)).status).toBe(401);
    expect((await call('/v1/repositories/42/findings', monitorToken)).status).toBe(401);
  });
  it('without a configured monitor token an empty bearer opens nothing', async () => {
    const call = await serve({ queue: new QueueBoard() });
    expect((await call('/v1/queue', '')).status).toBe(401);
    expect((await call('/v1/queue', managerToken)).status).toBe(200);
  });
  it('refuses a monitor token that is short or equals another credential', () => {
    const bindings: RuntimeBinding[] = [];
    expect(() => runtimeServer({ managerToken, workerToken, bindings, store: {} as RuntimeStore, monitorToken: 'short' })).toThrow('SEPARATE_RUNTIME_TOKENS_REQUIRED');
    expect(() => runtimeServer({ managerToken, workerToken, bindings, store: {} as RuntimeStore, monitorToken: managerToken })).toThrow('SEPARATE_RUNTIME_TOKENS_REQUIRED');
  });
});
