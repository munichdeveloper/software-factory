import { expect, it, vi } from 'vitest';
import { attention, deriveEvents, RuntimeEvents, type RuntimeEvent } from '../src/runtime/events.js';
import type { Execution, Task } from '../src/state/reconstruct.js';
import { clock, config, issue } from './helpers.js';

const version = 'a'.repeat(64);
const id = (attempt: number) => `${attempt}`.padStart(32, '0');
const execution = (attempt: number, over: Partial<Execution> = {}, at = clock.toISOString()): Execution => ({
  input: { executionId: id(attempt), taskVersion: version, limits: { timeoutMinutes: 30, maxOutputBytes: 16000 } } as Execution['input'],
  attempt, actionId: 'b'.repeat(64), at, active: false, ambiguous: false, timedOut: false, orphaned: false,
  runtime: { status: 'completed', phase: 'completed', createdAt: at } as Execution['runtime'], ...over });
const result = (attempt: number, status: 'failed' | 'blocked' | 'success' | 'cancelled', error: string | null) =>
  ({ contractVersion: '1.0', executionId: id(attempt), issueNumber: 1, status, summary: 'secret worker text', artifacts: [], error, proposedActions: [] }) as Execution['result'];
const task = (executions: Execution[], over: Partial<Task> = {}): Task => {
  const real = executions.filter(e => !e.rejected);
  return { issue: issue(1), version, status: 'running', desiredStatus: 'running', events: [], executions, latest: real.at(-1),
    attemptsUsed: real.length, nextAttempt: executions.length, blocked: false, hasOpenPR: false, hasClosingMerge: false, criteria: ['x'], reworkable: false, ...over };
};
const types = (events: RuntimeEvent[]) => events.map(e => `${e.type}:${e.executionId?.slice(-1) ?? '-'}`);

it('reports a failed validation with its steps and the next automatic step, without worker text', () => {
  const failedValidation = execution(0, { result: result(0, 'blocked', null), runtime: { status: 'completed', phase: 'completed', createdAt: clock.toISOString(),
    validation: { status: 'failed', reason: 'CHECK_FAILED', failed: [{ name: 'browser', exitCode: 1 }], runId: 77 } } as Execution['runtime'] });
  const t = task([failedValidation], { reworkable: true });
  const [event] = deriveEvents([t], config());
  expect(event).toMatchObject({ type: 'validation_failed', key: `validation_failed:${id(0)}`, issueNumber: 1,
    data: { reason: 'CHECK_FAILED', steps: [{ name: 'browser', exitCode: 1 }], validationRunId: 77, next: 'rework' } });
  expect(JSON.stringify(deriveEvents([t], config()))).not.toContain('secret worker text');
  expect(deriveEvents([{ ...t, reworkable: false }], config())[0]!.data.next).toBe('none');
});

it('reports refused starts with their code and backoff, marks repository-wide refusals, and the resumed start', () => {
  const at = (minutes: number) => new Date(clock.getTime() + minutes * 60000).toISOString();
  const refused = (attempt: number, code: string, minutes: number) => execution(attempt, { rejected: code }, at(minutes));
  const events = deriveEvents([task([refused(0, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', 0), refused(1, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', 16),
    execution(2, { result: result(2, 'success', null) }, at(20))])], config());
  expect(types(events)).toEqual(['start_refused:0', 'start_refused:1', 'start_resumed:2']);
  expect(events[1]!.data).toMatchObject({ code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 2, repositoryWide: true, retryAt: at(46) });
  expect(events[2]!.data).toEqual({ code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 2, trigger: 'manual' });
  const afterBackoff = deriveEvents([task([refused(0, 'APPROVAL_REQUIRED', 0), execution(1, {}, at(20))])], config());
  expect(afterBackoff.map(e => [e.type, e.data.repositoryWide ?? e.data.trigger])).toEqual([['start_refused', false], ['start_resumed', 'backoff']]);
});

it('reports failed runs with fixed codes only and the remaining attempts', () => {
  const cfg = config(); cfg.execution.maxRetries = 2;
  const events = deriveEvents([task([execution(0, { result: result(0, 'failed', 'EXECUTOR_INFRASTRUCTURE_FAILURE') }),
    execution(1, { result: result(1, 'failed', 'free text from upstream') })])], cfg);
  expect(events.map(e => e.data)).toEqual([
    { status: 'failed', error: 'EXECUTOR_INFRASTRUCTURE_FAILURE', infrastructure: true, attempt: 0, remainingAttempts: 1 },
    { status: 'failed', error: null, infrastructure: false, attempt: 1, remainingAttempts: 1 }]);
});

it('requires attention only when no automatic step is left', () => {
  const cfg = config(); cfg.execution.maxRetries = 1;
  const failing = [execution(0, { result: result(0, 'failed', 'X_FAILED') }), execution(1, { result: result(1, 'failed', 'X_FAILED') })];
  expect(attention(task(failing.slice(0, 1)), cfg)).toBeNull();
  expect(attention(task(failing), cfg)).toBe('retries_exhausted');
  const validation = { status: 'completed', phase: 'completed', createdAt: clock.toISOString(),
    validation: { status: 'failed', reason: 'CHECK_FAILED', failed: [], runId: 1 } } as Execution['runtime'];
  const reworked = [execution(0, { result: result(0, 'blocked', null), runtime: validation }), execution(1, { result: result(1, 'blocked', null), runtime: validation })];
  expect(attention(task(reworked), cfg)).toBe('rework_exhausted');
  expect(attention(task([], { status: 'blocked', desiredStatus: 'blocked', blockReason: 'Missing Acceptance criteria section' }), cfg)).toBe('blocked_without_pr');
  expect(attention(task([], { status: 'blocked', desiredStatus: 'blocked', blockReason: 'Unresolved dependencies: #2' }), cfg)).toBeNull();
  expect(attention(task([execution(0, { active: true })]), cfg)).toBeNull();
  const event = deriveEvents([task(failing)], cfg).find(e => e.type === 'attention_required')!;
  expect(event).toMatchObject({ key: `attention_required:${id(1)}:retries_exhausted`, data: { reason: 'retries_exhausted', attempts: 2, error: 'X_FAILED' } });
});

it('ignores closed issues and earlier task versions', () => {
  const old = execution(0, { result: result(0, 'failed', 'X_FAILED'), input: { executionId: id(0), taskVersion: 'b'.repeat(64) } as Execution['input'] });
  expect(deriveEvents([task([old])], config())).toEqual([]);
  expect(deriveEvents([task([execution(0, { result: result(0, 'failed', 'X') })], { issue: { ...issue(1), state: 'closed' } })], config())).toEqual([]);
});

it('records events idempotently through the store and never throws', async () => {
  const store = { recordEvents: vi.fn(async (_id: number, _repo: string, events: RuntimeEvent[]) => events) };
  const recorder = new RuntimeEvents(store, () => clock);
  expect(await recorder.observed({ repositoryId: 1, repository: 'owner/target' }, config(), undefined)).toEqual([]);
  store.recordEvents.mockRejectedValueOnce(new Error('db down'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { MemoryGitHub } = await import('./helpers.js');
  await expect(recorder.observed({ repositoryId: 1, repository: 'owner/target' }, config(), new MemoryGitHub().state)).resolves.toEqual([]);
});
