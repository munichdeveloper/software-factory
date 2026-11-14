import { describe, expect, it } from 'vitest';
import { evaluate, permission, policyVersion } from '../src/policies/engine.js';
import { actionKinds, configSchema } from '../src/config/index.js';
import { reconstruct, type Task } from '../src/state/reconstruct.js';
import type { Action } from '../src/types.js';
import { proposal } from '../src/llm/provider.js';
import { config, issue, MemoryGitHub, clock } from './helpers.js';
import { actionId } from '../src/state/identity.js';

function fixture() {
  const cfg = config(); const api = new MemoryGitHub(); api.state.issues.push(issue());
  return { cfg, task: reconstruct(api.state, cfg, clock)[0]!, budget: { actions: 0, newIssues: 0, activeWorkers: 0 } };
}
const blockedTask = (task: Task, status: 'blocked' | 'success' | 'failed' = 'blocked'): Task =>
  ({ ...task, latest: { ...task.latest, attempt: 0, result: { status } } as Task['latest'] });
const followup = (task: Task): Action => proposal(task, 'create_followup', 'Split', { followup: { key: 'part', title: 'Part', context: 'Context', goal: 'Goal',
  acceptanceCriteria: ['Observable'], dependencies: [], expandsScope: false } });
describe('follow-ups only answer a finished attempt (software-factory#93)', () => {
  it('denies follow-ups of a task that has not run or failed for reasons outside it', () => {
    const f = fixture(), ctx = { config: f.cfg, budget: f.budget, source: 'planner' as const, approved: true };
    expect(evaluate(followup(f.task), { ...ctx, task: f.task }).reason).toContain('finished attempt');
    expect(evaluate(followup(f.task), { ...ctx, task: blockedTask(f.task, 'failed') }).reason).toContain('finished attempt');
    expect(evaluate(followup(f.task), { ...ctx, task: blockedTask(f.task) }).outcome).toBe('allow');
    expect(evaluate(followup(f.task), { ...ctx, task: blockedTask(f.task, 'success') }).outcome).toBe('allow');
  });
  it('allows one split per run but no further copies while follow-ups are open', () => {
    const f = fixture(), task = { ...blockedTask(f.task), openFollowups: [91] };
    const ctx = { config: f.cfg, task, source: 'planner' as const, approved: true };
    expect(evaluate(followup(task), { ...ctx, budget: f.budget }).reason).toBe('Task already has open follow-ups: #91');
    expect(evaluate(followup(task), { ...ctx, budget: { ...f.budget, newIssues: 1, followupOrigins: [1] } }).outcome).toBe('allow');
  });
});
describe('independent autonomy policy engine', () => {
  for (const profile of ['advisory', 'supervised', 'autonomous'] as const) {
    for (const kind of actionKinds) {
      it(`resolves an explicit override for ${profile}/${kind}`, () => {
        const cfg = config(profile); cfg.autonomy.overrides[kind] = 'deny'; expect(permission(cfg, kind)).toBe('deny');
        cfg.autonomy.overrides[kind] = 'approval'; expect(permission(cfg, kind)).toBe('approval');
      });
    }
  }
  it('binds approval IDs to concrete payload, task version and policy configuration', () => {
    const { cfg, task } = fixture(); const a = proposal(task, 'start_worker', 'First reason');
    const id = actionId(a, policyVersion(cfg)); expect(actionId({ ...a, reason: 'Different wording' }, policyVersion(cfg))).toBe(id);
    expect(actionId({ ...a, taskVersion: 'a'.repeat(64) }, policyVersion(cfg))).not.toBe(id);
    cfg.execution.maxRetries++; expect(actionId(a, policyVersion(cfg))).not.toBe(id);
  });
  it('routes merges only through the dedicated PR review workflow and denies standalone scope changes', () => {
    const f = fixture();
    for (const kind of ['merge_pr', 'expand_scope'] as const) expect(evaluate(proposal(f.task, kind, 'request'), {
      config: f.cfg, ...f, source: 'planner', approved: true }).outcome).toBe('deny');
  });
  it('scope expansion requires its separate permission', () => {
    const f = { ...fixture() }; f.task = blockedTask(f.task); const action = proposal(f.task, 'create_followup', 'New area', { followup: { key: 'new-area', title: 'New scope',
      context: 'Context', goal: 'Expand', acceptanceCriteria: ['Observable'], dependencies: [], expandsScope: true } });
    const ctx = { config: f.cfg, ...f, source: 'planner' as const, approved: false };
    expect(evaluate(action, ctx).outcome).toBe('deny'); f.cfg.autonomy.overrides.expand_scope = 'approval';
    expect(evaluate(action, ctx).outcome).toBe('approval'); expect(evaluate(action, { ...ctx, approved: true }).outcome).toBe('allow');
  });
  it('enforces new-issue, worker and action limits independently', () => {
    const f = fixture(); f.budget.activeWorkers = 1;
    const ctx = { config: f.cfg, ...f, source: 'planner' as const, approved: true };
    expect(evaluate(proposal(f.task, 'start_worker', 'start'), ctx).reason).toContain('parallel');
    f.budget.actions = f.cfg.manager.maxActions;
    expect(evaluate(proposal(f.task, 'prioritize', 'priority', { priority: 'high' }), ctx).reason).toContain('actions');
    f.budget.actions = 0; f.budget.newIssues = f.cfg.execution.maxNewIssues;
    expect(evaluate(proposal(f.task, 'create_followup', 'followup', { followup: { key: 'existing-scope', title: 'More work', context: 'Context', goal: 'Goal',
      acceptanceCriteria: ['Pass'], dependencies: [], expandsScope: false } }), ctx).reason).toContain('new issues');
  });
  it('does not share mutable nested defaults across configuration loads', () => {
    const first = configSchema.parse({ version: 1, factory: { scope: 'one' } }); first.workers.test.operation = 'fail';
    expect(configSchema.parse({ version: 1, factory: { scope: 'two' } }).workers.test.operation).toBe('sha256');
  });
  it('rejects inapplicable fields instead of silently altering concrete action identity', () => {
    const f = fixture(); const action = proposal(f.task, 'start_worker', 'start', { status: 'ready' });
    expect(evaluate(action, { config: f.cfg, ...f, source: 'planner', approved: true }).outcome).toBe('deny');
  });
});
