import { afterEach, expect, it, vi } from 'vitest';
import { startReconcileSchedule } from '../src/runtime/schedule.js';
import type { RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import { config, MemoryGitHub } from './helpers.js';
import { StaticPlanner } from '../src/llm/provider.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); vi.useRealTimers(); vi.restoreAllMocks(); });
function binding(repositoryId: number, engine: 'temporal' | 'actions' = 'temporal') {
  const cfg = config(); cfg.execution.engine = engine;
  const controller = { observations: vi.fn(async () => []) };
  return { repository: { repositoryId, github: new MemoryGitHub(), config: async () => cfg }, controller, planner: new StaticPlanner() } as unknown as RuntimeBinding;
}
const start = (...args: Parameters<typeof startReconcileSchedule>) => { const schedule = startReconcileSchedule(...args); stops.push(() => schedule.stop()); return schedule; };
const store = () => ({ tryLocked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) });

it('reconciles every bound repository each interval without an external caller, including later registrations', async () => {
  vi.useFakeTimers();
  const s = store(), bindings = [binding(1)];
  start(bindings, { store: s as unknown as RuntimeStore }, 30000);
  expect(s.tryLocked).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30000);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1]);
  bindings.push(binding(2));
  await vi.advanceTimersByTimeAsync(30000);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 1, 2]);
  expect(s.tryLocked.mock.calls.every(c => c[1] === 'manager')).toBe(true);
});

it('keeps going after a failing repository and logs only fixed codes, staying quiet for BUSY and non-Temporal repositories', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = store();
  s.tryLocked.mockImplementationOnce(async () => { throw new Error('BUSY'); })
    .mockImplementationOnce(async () => { throw Object.assign(new Error('secret upstream text'), { status: 502 }); });
  start([binding(1), binding(2), binding(3, 'actions'), binding(4)], { store: s as unknown as RuntimeStore }, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 2, 4]);
  expect(warn.mock.calls.map(c => JSON.parse(c[0] as string))).toEqual([
    { event: 'factory-reconcile-failed', repositoryId: 2, reason: 'OPERATION_FAILED', httpStatus: 502 },
  ]);
});

it('never overlaps passes and stops cleanly', async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const s = store();
  s.tryLocked.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ decisions: [], errors: [], blockers: [], outcome: 'noop' }); }));
  const { stop } = startReconcileSchedule([binding(1)], { store: s as unknown as RuntimeStore }, 1000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.tryLocked).toHaveBeenCalledTimes(1);
  release(); await vi.advanceTimersByTimeAsync(1000);
  expect(s.tryLocked).toHaveBeenCalledTimes(2);
  await stop(); await vi.advanceTimersByTimeAsync(5000);
  expect(s.tryLocked).toHaveBeenCalledTimes(2);
});

it('tells the sanity check about failed reconciliations, but not about BUSY or non-Temporal repositories', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const s = store(), monitor = { observed: vi.fn(async () => {}), failed: vi.fn(async () => {}) };
  s.tryLocked.mockImplementationOnce(async () => { throw new Error('BUSY'); })
    .mockImplementationOnce(async () => { throw new Error('ACTOR_NOT_AUTHORIZED'); });
  start([binding(1), binding(2), binding(3, 'actions')], { store: s as unknown as RuntimeStore, monitor: monitor as never }, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(monitor.failed.mock.calls.map(c => [(c as unknown[])[0] as { repositoryId: number }, (c as unknown[])[1]]).map(([r, code]) => [r.repositoryId, code])).toEqual([[2, 'ACTOR_NOT_AUTHORIZED']]);
});

const pending = () => { let release!: () => void; const done = new Promise<unknown>(resolve => { release = () => resolve({ decisions: [], errors: [], blockers: [], outcome: 'noop' }); }); return { done, release }; };

it('reconciles a nudged repository at once and merges nudges during a reconciliation into exactly one more (#197)', async () => {
  vi.useFakeTimers();
  const s = store(), first = pending();
  s.tryLocked.mockImplementationOnce(() => first.done);
  const schedule = start([binding(1), binding(2)], { store: s as unknown as RuntimeStore }, 900000);
  expect(schedule.nudge(1)).toBe(true);
  expect(schedule.nudge(3)).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1]);
  // Three webhooks while the first reconciliation runs: one more reconciliation after it, not three.
  schedule.nudge(1); schedule.nudge(1); schedule.nudge(1);
  first.release(); await vi.advanceTimersByTimeAsync(0);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 1]);
  await vi.advanceTimersByTimeAsync(60000);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 1]);
});

it('lets a pass join a running nudge instead of reconciling the repository twice, and limits parallel reconciliations', async () => {
  vi.useFakeTimers();
  const s = store(), slow = pending();
  s.tryLocked.mockImplementationOnce(() => slow.done);
  const schedule = start([binding(1), binding(2), binding(3)], { store: s as unknown as RuntimeStore }, 1000, { parallel: 2 });
  schedule.nudge(1); schedule.nudge(2); schedule.nudge(3);
  await vi.advanceTimersByTimeAsync(0);
  // Repository 1 still runs; 2 finished; 3 waited for a free slot and ran then.
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  await vi.advanceTimersByTimeAsync(1000);
  // The pass reaches repository 1 while its nudge still runs: it waits for it instead of starting another.
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 2, 3]);
  slow.release(); await vi.advanceTimersByTimeAsync(0);
  expect(s.tryLocked.mock.calls.map(c => c[0])).toEqual([1, 2, 3, 2, 3]);
});

it('retries a nudge that met the lock of another caller instead of dropping it', async () => {
  vi.useFakeTimers();
  const s = store();
  s.tryLocked.mockImplementationOnce(async () => { throw new Error('BUSY'); });
  const schedule = start([binding(1)], { store: s as unknown as RuntimeStore }, 0, { busyRetryMs: 5000 });
  schedule.nudge(1); await vi.advanceTimersByTimeAsync(0);
  expect(s.tryLocked).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(s.tryLocked).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(s.tryLocked).toHaveBeenCalledTimes(2);
});

it('tells the queue view when the next pass starts, counted from the end of the previous pass', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-20T16:00:00Z'));
  const s = store(), slow = pending(), queue = { schedule: vi.fn(), failed: vi.fn(), observed: vi.fn() };
  s.tryLocked.mockImplementationOnce(() => slow.done);
  start([binding(1)], { store: s as unknown as RuntimeStore, queue: queue as never }, 180000);
  expect(queue.schedule).toHaveBeenLastCalledWith({ passStartedAt: null, nextPassAt: '2026-11-20T16:03:00.000Z' });
  await vi.advanceTimersByTimeAsync(180000);
  expect(queue.schedule).toHaveBeenLastCalledWith({ passStartedAt: '2026-11-20T16:03:00.000Z', nextPassAt: null });
  await vi.advanceTimersByTimeAsync(120000); slow.release(); await vi.advanceTimersByTimeAsync(0);
  expect(queue.schedule).toHaveBeenLastCalledWith({ passStartedAt: null, nextPassAt: '2026-11-20T16:08:00.000Z' });
});
