import { afterEach, expect, it, vi } from 'vitest';
import { startReconcileSchedule } from '../src/runtime/schedule.js';
import type { RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import { config, MemoryGitHub } from './helpers.js';
import { MockPlanner } from '../src/llm/provider.js';

const stops: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())); vi.useRealTimers(); vi.restoreAllMocks(); });
function binding(repositoryId: number, engine: 'temporal' | 'actions' = 'temporal') {
  const cfg = config(); cfg.execution.engine = engine;
  const controller = { observations: vi.fn(async () => []) };
  return { repository: { repositoryId, github: new MemoryGitHub(), config: async () => cfg }, controller, planner: new MockPlanner() } as unknown as RuntimeBinding;
}
const store = () => ({ tryLocked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) });

it('reconciles every bound repository each interval without an external caller, including later registrations', async () => {
  vi.useFakeTimers();
  const s = store(), bindings = [binding(1)];
  stops.push(startReconcileSchedule(bindings, { store: s as unknown as RuntimeStore }, 30000));
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
  stops.push(startReconcileSchedule([binding(1), binding(2), binding(3, 'actions'), binding(4)], { store: s as unknown as RuntimeStore }, 1000));
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
  const stop = startReconcileSchedule([binding(1)], { store: s as unknown as RuntimeStore }, 1000);
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
  stops.push(startReconcileSchedule([binding(1), binding(2), binding(3, 'actions')], { store: s as unknown as RuntimeStore, monitor: monitor as never }, 1000));
  await vi.advanceTimersByTimeAsync(1000);
  expect(monitor.failed.mock.calls.map(c => [(c as unknown[])[0] as { repositoryId: number }, (c as unknown[])[1]]).map(([r, code]) => [r.repositoryId, code])).toEqual([[2, 'ACTOR_NOT_AUTHORIZED']]);
});
