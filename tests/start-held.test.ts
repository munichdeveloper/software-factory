import { describe, expect, it, vi } from 'vitest';
import { Manager } from '../src/manager/index.js';
import { PlanningError, StaticPlanner, type Planner } from '../src/llm/provider.js';
import { RuntimeAdmissionRejected, type RuntimeObservation, type WorkerRuntimePort } from '../src/runtime/contract.js';
import { heldAlertAfterMs, RuntimeEvents, type RuntimeEvent } from '../src/runtime/events.js';
import { queueEntries } from '../src/runtime/queue.js';
import { decodeEvent } from '../src/state/events.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';

// software-factory#313: a ready task that is not started must say why, and a refusal after a new grant must be journaled.
function fixture(planner: Planner = new StaticPlanner()) {
  const github = new MemoryGitHub(), cfg = config(); cfg.execution.engine = 'temporal';
  github.state.issues.push({ ...issue(), readyAt: clock.toISOString() });
  const observations: RuntimeObservation[] = [];
  const start = vi.fn<WorkerRuntimePort['start']>(async admission => {
    const observation: RuntimeObservation = { issueNumber: 1, executionId: admission.input.executionId, workflowId: `sf-42-${admission.input.executionId}`,
      runId: '00000000-0000-4000-8000-000000000001', status: 'running', phase: 'running', binding: 'a'.repeat(64), createdAt: clock.toISOString(), result: null };
    observations.push(observation); return observation;
  });
  const runtime: WorkerRuntimePort = { start, readyIsGrant: true, observations: async ids => observations.filter(r => ids.includes(r.executionId)), cancel: vi.fn(async () => {}) };
  const manager = (now = clock) => new Manager(github, cfg, planner, { correlationId: 'held-test', workerRuntime: runtime, now: () => now });
  return { github, cfg, runtime, start, manager };
}
const decisions = (f: ReturnType<typeof fixture>) => (f.github.state.comments.get(1) ?? []).map(c => decodeEvent(c, f.cfg.manager.trustedActors)?.data)
  .filter(d => d?.type === 'decision' && JSON.parse(d.action).kind === 'start_worker').map(d => d?.type === 'decision' ? [d.outcome, d.reason] : []);

describe('a refusal after a new grant', () => {
  it('is journaled again, while the same refusal under the same grant is journaled once', async () => {
    const f = fixture(); f.runtime.preflight = vi.fn(async () => { throw new RuntimeAdmissionRejected('READY_APPROVAL_REVOKED'); });
    await f.manager().run(); await f.manager(new Date(clock.getTime() + 60000)).run();
    expect(decisions(f)).toEqual([['allow', expect.any(String)], ['refused', 'READY_APPROVAL_REVOKED']]);
    // A person applies harness:ready again; the runtime refuses for the same reason.
    f.github.state.issues[0]!.readyAt = new Date(clock.getTime() + 120000).toISOString();
    await f.manager(new Date(clock.getTime() + 180000)).run();
    expect(decisions(f)).toEqual([['allow', expect.any(String)], ['refused', 'READY_APPROVAL_REVOKED'],
      ['allow', expect.any(String)], ['refused', 'READY_APPROVAL_REVOKED']]);
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe('a startable task that is not started', () => {
  it('names the planner that did not propose it in the run, the status comment and the queue', async () => {
    const f = fixture({ plan: async () => ({ version: 1, actions: [] }) });
    const manager = f.manager(), report = await manager.run();
    expect(manager.lastHolds).toEqual(new Map([[1, 'PLANNER_NOT_PROPOSED']]));
    expect(report.blockers).toContain('#1: startable but not started (PLANNER_NOT_PROPOSED)');
    const status = (f.github.state.comments.get(1) ?? []).find(c => c.body.startsWith('<!-- software-factory:status -->'))!.body;
    expect(status).toContain('not started in the last reconciliation** (`PLANNER_NOT_PROPOSED`');
    const [entry] = queueEntries(manager.settledSnapshot!, f.cfg, report, f.github.repository, manager.lastRejections, clock, new Map(), manager.lastHolds);
    expect(entry).toMatchObject({ stage: 'queued', reason: 'PLANNER_NOT_PROPOSED', waitsForSlot: false });
  });
  it('names a failed planning call by its fixed code', async () => {
    const f = fixture({ plan: async () => { throw new PlanningError('down', 'LLM_HTTP_429'); } });
    const manager = f.manager(); await manager.run();
    expect(manager.lastHolds.get(1)).toBe('PLANNING_LLM_HTTP_429');
  });
  it('names a planner hold-back', async () => {
    const f = fixture({ plan: async tasks => ({ version: 1, actions: [{ kind: 'transition', issueNumber: 1, taskVersion: tasks[0]!.version, status: 'blocked',
      priority: null, attempt: null, followup: null, reason: 'Jev planner: the task text is unclear (40 %).' }] }) });
    // The policy denies the planner's transition here, so the task stays startable and its hold must be visible.
    f.cfg.autonomy.overrides = { transition: 'deny' };
    const manager = f.manager(); await manager.run();
    expect(manager.lastHolds.get(1)).toBe('PLANNER_HELD');
  });
  it('is no hold while it waits for a slot, its grant or a refusal', async () => {
    const waiting = fixture({ plan: async () => ({ version: 1, actions: [] }) });
    waiting.github.state.issues[0]!.labels = ['harness:managed', 'harness:backlog'];
    const ungranted = waiting.manager(); await ungranted.run();
    expect(ungranted.lastHolds.size).toBe(0);
    const refused = fixture(); refused.runtime.preflight = vi.fn(async () => { throw new RuntimeAdmissionRejected('READY_APPROVAL_REQUIRED'); });
    const m = refused.manager(); await m.run();
    expect(m.lastHolds.size).toBe(0); expect(m.lastRejections.get(1)).toBe('READY_APPROVAL_REQUIRED');
    const busy = fixture(); busy.github.state.issues.push({ ...issue(2), readyAt: clock.toISOString() });
    const b = busy.manager(); await b.run();
    expect(busy.start).toHaveBeenCalledOnce(); expect(b.lastHolds.size).toBe(0);
  });
  it('does not stay blocked by an action that went stale while it was started', async () => {
    const f = fixture(), getIssue = f.github.getIssue.bind(f.github);
    // The text changes between the reconciliation's snapshot and the start: the start is deferred, not lost.
    const spy = vi.spyOn(f.github, 'getIssue').mockImplementationOnce(async n => ({ ...await getIssue(n), body: `${(await getIssue(n)).body}\nEdited.` }));
    const first = f.manager(); await first.run();
    expect(first.lastHolds.get(1)).toBe('TASK_CHANGED_DURING_START'); expect(f.start).not.toHaveBeenCalled();
    spy.mockRestore();
    const second = f.manager(new Date(clock.getTime() + 60000)); await second.run();
    expect(f.start).toHaveBeenCalledOnce(); expect(second.lastHolds.size).toBe(0);
  });
});

describe('start_held runtime events', () => {
  it('records a hold once per version and code and posts it to Slack once after 30 minutes', async () => {
    const f = fixture({ plan: async () => ({ version: 1, actions: [] }) });
    const manager = f.manager(); await manager.run();
    const cfg = f.cfg; cfg.notifications.slack.enabled = true; cfg.notifications.slack.events.attention_required = { enabled: true, channel: '#factory-todo' };
    const known = new Set<string>(), claimed = new Set<string>();
    const store = { recordEvents: vi.fn(async (_id: number, _repo: string, events: RuntimeEvent[]) => events.filter(e => !known.has(e.key) && !!known.add(e.key))),
      claimUsageAlert: vi.fn(async (key: string) => !claimed.has(key) && !!claimed.add(key)) };
    const alerts = { post: vi.fn(async () => {}) };
    let now = clock;
    const recorder = new RuntimeEvents(store, () => now, alerts);
    const target = { repositoryId: 42, repository: 'owner/target' };
    const added = await recorder.observed(target, cfg, manager.lastSnapshot, new Map(), manager.lastHolds);
    expect(added).toEqual([expect.objectContaining({ type: 'start_held', issueNumber: 1, data: { code: 'PLANNER_NOT_PROPOSED', since: clock.toISOString() } })]);
    expect(alerts.post).not.toHaveBeenCalled();
    now = new Date(clock.getTime() + heldAlertAfterMs);
    expect(await recorder.observed(target, cfg, manager.lastSnapshot, new Map(), manager.lastHolds)).toEqual([]);
    now = new Date(clock.getTime() + heldAlertAfterMs + 60000);
    await recorder.observed(target, cfg, manager.lastSnapshot, new Map(), manager.lastHolds);
    expect(alerts.post).toHaveBeenCalledOnce();
    expect(alerts.post).toHaveBeenCalledWith('#factory-todo', expect.stringContaining('Grund: PLANNER_NOT_PROPOSED'));
  });
});
