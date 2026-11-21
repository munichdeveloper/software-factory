import { describe, expect, it, vi } from 'vitest';
import { attention, deriveEvents, pendingRefusals, preflightEvents, RuntimeEvents, type RuntimeEvent } from '../src/runtime/events.js';
import type { Execution, Task } from '../src/state/reconstruct.js';
import { clock, config, issue } from './helpers.js';

const version = 'a'.repeat(64);
const id = (attempt: number) => `${attempt}`.padStart(32, '0');
const execution = (attempt: number, over: Partial<Execution> = {}, at = clock.toISOString()): Execution => ({
  input: { executionId: id(attempt), taskVersion: version, contextReferences: [], limits: { timeoutMinutes: 30, maxOutputBytes: 16000 } } as Execution['input'],
  attempt, actionId: 'b'.repeat(64), at, active: false, ambiguous: false, timedOut: false, orphaned: false,
  runtime: { status: 'completed', phase: 'completed', createdAt: at } as Execution['runtime'], ...over });
const result = (attempt: number, status: 'failed' | 'blocked' | 'success' | 'cancelled', error: string | null) =>
  ({ contractVersion: '1.0', executionId: id(attempt), issueNumber: 1, status, summary: 'secret worker text', artifacts: [], error, proposedActions: [] }) as Execution['result'];
const task = (executions: Execution[], over: Partial<Task> = {}): Task => {
  const real = executions.filter(e => !e.rejected);
  return { issue: issue(1), version, status: 'running', desiredStatus: 'running', events: [], executions, latest: real.at(-1),
    attemptsUsed: real.length, nextAttempt: executions.length, attemptLimit: 3, blocked: false, hasOpenPR: false, hasClosingMerge: false, criteria: ['x'], reworkable: false, ...over };
};
const types = (events: RuntimeEvent[]) => events.map(e => `${e.type}:${e.executionId?.slice(-1) ?? '-'}`);

it('reports a failed validation with its steps and the next automatic step, without worker text', () => {
  const failedValidation = execution(0, { result: result(0, 'blocked', null), runtime: { status: 'completed', phase: 'completed', createdAt: clock.toISOString(),
    validation: { status: 'failed', reason: 'CHECK_FAILED', failed: [{ name: 'browser', exitCode: 1 }], runId: 77 } } as Execution['runtime'] });
  const t = task([failedValidation], { reworkable: true });
  const [event] = deriveEvents([t]);
  expect(event).toMatchObject({ type: 'validation_failed', key: `validation_failed:${id(0)}`, issueNumber: 1,
    data: { reason: 'CHECK_FAILED', steps: [{ name: 'browser', exitCode: 1 }], validationRunId: 77, next: 'rework' } });
  expect(JSON.stringify(deriveEvents([t]))).not.toContain('secret worker text');
  expect(deriveEvents([{ ...t, reworkable: false }])[0]!.data.next).toBe('none');
});

it('reports refused starts with their code and backoff, marks repository-wide refusals, and the resumed start', () => {
  const at = (minutes: number) => new Date(clock.getTime() + minutes * 60000).toISOString();
  const refused = (attempt: number, code: string, minutes: number) => execution(attempt, { rejected: code }, at(minutes));
  const events = deriveEvents([task([refused(0, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', 0), refused(1, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', 16),
    execution(2, { result: result(2, 'success', null) }, at(20))])]);
  expect(types(events)).toEqual(['start_refused:0', 'start_refused:1', 'start_resumed:2']);
  expect(events[1]!.data).toMatchObject({ code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 2, repositoryWide: true, retryAt: at(46) });
  expect(events[2]!.data).toEqual({ code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 2, trigger: 'cause_cleared' });
  const afterBackoff = deriveEvents([task([refused(0, 'APPROVAL_REQUIRED', 0), execution(1, {}, at(20))])]);
  expect(afterBackoff.map(e => [e.type, e.data.repositoryWide ?? e.data.trigger])).toEqual([['start_refused', false], ['start_resumed', 'backoff']]);
});

it('reports failed runs with fixed codes only and the remaining attempts', () => {
  const events = deriveEvents([task([execution(0, { result: result(0, 'failed', 'EXECUTOR_INFRASTRUCTURE_FAILURE') }),
    execution(1, { result: result(1, 'failed', 'free text from upstream') })])]);
  expect(events.map(e => e.data)).toEqual([
    { status: 'failed', error: 'EXECUTOR_INFRASTRUCTURE_FAILURE', infrastructure: true, attempt: 0, remainingAttempts: 1 },
    { status: 'failed', error: null, infrastructure: false, attempt: 1, remainingAttempts: 1 }]);
});

it('requires attention only when no automatic step is left', () => {
  // maxRetries 1: two real attempts.
  const limit = { attemptLimit: 2 };
  const failing = [execution(0, { result: result(0, 'failed', 'X_FAILED') }), execution(1, { result: result(1, 'failed', 'X_FAILED') })];
  expect(attention(task(failing.slice(0, 1), limit))).toBeNull();
  expect(attention(task(failing, limit))).toBe('retries_exhausted');
  const validation = { status: 'completed', phase: 'completed', createdAt: clock.toISOString(),
    validation: { status: 'failed', reason: 'CHECK_FAILED', failed: [], runId: 1 } } as Execution['runtime'];
  const reworked = [execution(0, { result: result(0, 'blocked', null), runtime: validation }), execution(1, { result: result(1, 'blocked', null), runtime: validation })];
  expect(attention(task(reworked, limit))).toBe('rework_exhausted');
  expect(attention(task([], { status: 'blocked', desiredStatus: 'blocked', blockReason: 'Missing Acceptance criteria section' }))).toBe('blocked_without_pr');
  expect(attention(task([], { status: 'blocked', desiredStatus: 'blocked', blockReason: 'Unresolved dependencies: #2' }))).toBeNull();
  expect(attention(task([execution(0, { active: true })]))).toBeNull();
  const event = deriveEvents([task(failing, limit)]).find(e => e.type === 'attention_required')!;
  expect(event).toMatchObject({ key: `attention_required:${id(1)}:retries_exhausted`, data: { reason: 'retries_exhausted', attempts: 2, error: 'X_FAILED' } });
});

it('ignores closed issues and earlier task versions', () => {
  const old = execution(0, { result: result(0, 'failed', 'X_FAILED'), input: { executionId: id(0), taskVersion: 'b'.repeat(64) } as Execution['input'] });
  expect(deriveEvents([task([old])])).toEqual([]);
  expect(deriveEvents([task([execution(0, { result: result(0, 'failed', 'X') })], { issue: { ...issue(1), state: 'closed' } })])).toEqual([]);
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

describe('Slack notifications of runtime events', () => {
  const at = (minutes: number) => new Date(clock.getTime() + minutes * 60000).toISOString();
  const event = (type: RuntimeEvent['type'], data: RuntimeEvent['data'], minutes = 0): RuntimeEvent =>
    ({ key: `${type}:${minutes}:${JSON.stringify(data)}`, type, issueNumber: 7, taskVersion: version, executionId: id(0), at: at(minutes), data });
  const setup = (events: RuntimeEvent[]) => {
    const cfg = config(); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = '#ki-notification';
    const claimed = new Set<string>();
    const store = { recordEvents: vi.fn(async () => events), claimUsageAlert: vi.fn(async (key: string) => !claimed.has(key) && !!claimed.add(key)) };
    const alerts = { post: vi.fn(async () => {}) };
    const recorder = new RuntimeEvents(store, () => new Date(at(10)), alerts);
    return { cfg, alerts, observe: () => recorder.notify({ repositoryId: 1, repository: 'owner/target' }, cfg, events) };
  };
  it('posts only subscribed events to the rule channel, repository-wide refusals once per day, and nothing old', async () => {
    const events = [event('attention_required', { reason: 'retries_exhausted', attempts: 3, error: 'X_FAILED' }),
      event('start_refused', { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 1, retryAt: at(15), repositoryWide: true }),
      event('start_refused', { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 1, retryAt: at(15), repositoryWide: true }, 1),
      event('start_refused', { code: 'APPROVAL_REQUIRED', refusals: 1, retryAt: at(15), repositoryWide: false }),
      event('validation_failed', { reason: 'CHECK_FAILED', steps: [{ name: 'browser', exitCode: 1 }], validationRunId: 5, attempt: 0, next: 'rework' }),
      event('attention_required', { reason: 'blocked_without_pr', attempts: 0, error: null }, -7 * 60)];
    const x = setup(events);
    x.cfg.notifications.slack.events.attention_required = { enabled: true, channel: '#factory-todo' };
    x.cfg.notifications.slack.events.start_refused = { enabled: true, channel: '#factory-todo' };
    await x.observe();
    expect(x.alerts.post.mock.calls.map(c => c[0])).toEqual(['#factory-todo', '#factory-todo']);
    const [attentionText, refusedText] = x.alerts.post.mock.calls.map(c => c[1] as string);
    expect(attentionText).toContain('SF braucht dich: owner/target#7'); expect(attentionText).toContain('alle Versuche sind aufgebraucht');
    expect(refusedText).toContain('über den SF Manager ausrollen');
  });
  it('stays silent without a rule or with Slack disabled; validation failures only when subscribed', async () => {
    const failed = event('validation_failed', { reason: 'CHECK_FAILED', steps: [{ name: 'browser', exitCode: 1 }], validationRunId: 5, attempt: 0, next: 'rework' });
    const x = setup([failed]);
    await x.observe(); expect(x.alerts.post).not.toHaveBeenCalled();
    x.cfg.notifications.slack.events.validation_failed = { enabled: true, channel: null };
    await x.observe();
    expect(x.alerts.post).toHaveBeenCalledWith('#ki-notification', expect.stringContaining('Schritt: browser (Exit 1). Nächster Schritt: Nachbesserung startet automatisch'));
    x.cfg.notifications.slack.enabled = false; await x.observe(); expect(x.alerts.post).toHaveBeenCalledTimes(1);
  });
});

it('reports preflight refusals, which no journal holds, and the start once the cause is gone', () => {
  const refused = preflightEvents([task([])], new Map([[1, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH']]), new Map(), clock);
  expect(refused).toEqual([expect.objectContaining({ type: 'start_refused', key: `start_refused:1:${version.slice(0, 16)}:EXECUTOR_WRAPPER_RELEASE_MISMATCH`,
    data: { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 1, retryAt: null, repositoryWide: true, stage: 'preflight' } })]);
  const before = new Map([[1, { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', version, at: clock.toISOString() }]]);
  expect(preflightEvents([task([])], new Map([[1, 'EXECUTOR_WRAPPER_RELEASE_MISMATCH']]), before, new Date(clock.getTime() + 60000))[0]!.at).toBe(clock.toISOString());
  const later = new Date(clock.getTime() + 180000).toISOString();
  const resumed = preflightEvents([task([execution(0, { active: true }, later)])], new Map(), before, new Date(later));
  expect(resumed).toEqual([expect.objectContaining({ type: 'start_resumed', key: `start_resumed:${id(0)}:cleared`,
    data: { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', refusals: 1, trigger: 'cause_cleared' } })]);
  expect(preflightEvents([task([])], new Map(), before, new Date(later))).toEqual([]);
});

it('keeps a cleared preflight refusal until a start resumes it (geschaeftsideen-web#54)', () => {
  const before = new Map([[1, { code: 'EXECUTOR_WRAPPER_RELEASE_MISMATCH', version, at: clock.toISOString() }]]);
  // The rollout clears the refusal while the task waits for its grant: nothing starts, nothing is refused.
  const waiting = new Date(clock.getTime() + 60000);
  const kept = pendingRefusals([task([])], preflightEvents([task([])], new Map(), before, waiting), before);
  expect(kept.get(1)).toEqual(before.get(1));
  // The grant comes later; the start then resumes the remembered refusal.
  const later = new Date(clock.getTime() + 3600000).toISOString();
  const started = [task([execution(0, { active: true }, later)])];
  const pre = preflightEvents(started, new Map(), kept, new Date(later));
  expect(pre).toEqual([expect.objectContaining({ type: 'start_resumed', data: expect.objectContaining({ trigger: 'cause_cleared' }) })]);
  expect(pendingRefusals(started, pre, kept).size).toBe(0);
  // A changed task version forgets the refusal.
  expect(pendingRefusals([task([])], [], new Map([[1, { ...before.get(1)!, version: 'other' }]])).size).toBe(0);
});

it('reports the rescue attempt as tier 3 of the reaction chain (issue #188 step 7)', () => {
  const rescue = execution(2, { input: { executionId: id(2), taskVersion: version, contextReferences: ['urn:sf-rework:x', 'urn:sf-escalate', 'urn:sf-rescue'],
    limits: { timeoutMinutes: 30, maxOutputBytes: 16000 } } as Execution['input'], active: true });
  const events = deriveEvents([task([execution(0, { result: result(0, 'failed', 'X') }), execution(1, { result: result(1, 'failed', 'X') }), rescue], { attemptLimit: 4 })]);
  expect(events.filter(e => e.type === 'rescue_started').map(e => e.data)).toEqual([{ tier: 3, attempt: 2 }]);
});
