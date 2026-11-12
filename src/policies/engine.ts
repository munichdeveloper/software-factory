import type { Config } from '../config/index.js';
import type { Action, Decision } from '../types.js';
import type { Task } from '../state/reconstruct.js';
import { actionId, hash } from '../state/identity.js';
import { canTransition } from '../state/lifecycle.js';

type Permission = 'allow' | 'deny' | 'approval';
const defaults: Record<Config['autonomy']['profile'], Record<Action['kind'], Permission>> = {
  advisory: { transition: 'deny', close_issue: 'deny', create_followup: 'deny', prioritize: 'deny', approve_task: 'deny', start_worker: 'deny', retry_worker: 'deny', cancel_worker: 'deny', expand_scope: 'deny', merge_pr: 'deny' },
  supervised: { transition: 'allow', close_issue: 'allow', create_followup: 'approval', prioritize: 'allow', approve_task: 'approval', start_worker: 'approval', retry_worker: 'approval', cancel_worker: 'allow', expand_scope: 'approval', merge_pr: 'deny' },
  autonomous: { transition: 'allow', close_issue: 'allow', create_followup: 'allow', prioritize: 'allow', approve_task: 'allow', start_worker: 'allow', retry_worker: 'allow', cancel_worker: 'allow', expand_scope: 'deny', merge_pr: 'deny' }
};
export const policyVersion = (config: Config): string => { const { notifications: _notifications, merge: _merge, ...policy } = config; void _notifications; void _merge; return hash(policy); };
export function permission(config: Config, kind: Action['kind']): Permission {
  return config.autonomy.overrides[kind] ?? defaults[config.autonomy.profile][kind];
}
export interface Budget { actions: number; newIssues: number; activeWorkers: number }
export interface PolicyContext { config: Config; task: Task; budget: Budget; approved: boolean; source: 'reconcile' | 'planner' | 'worker' }
export function evaluate(action: Action, ctx: PolicyContext): Decision {
  const { config, task, budget } = ctx;
  const id = actionId(action, policyVersion(config));
  const decide = (outcome: Decision['outcome'], reason: string): Decision => ({ outcome, reason, actionId: id });
  const deny = (reason: string) => decide('deny', reason);
  if (!config.factory.enabled) return deny('Harness globally disabled');
  if ((action.kind !== 'transition' && action.status !== null) ||
      (action.kind !== 'prioritize' && action.priority !== null) ||
      (action.kind !== 'create_followup' && action.followup !== null) ||
      (!['start_worker', 'retry_worker'].includes(action.kind) && action.attempt !== null)) return deny('Action contains fields belonging to a different operation');
  if (config.autonomy.profile === 'advisory') return deny('Advisory profile prohibits repository changes');
  if (action.kind === 'merge_pr') return deny('Merge requires the dedicated PR workflow with a commit-bound AI review');
  if (action.kind === 'expand_scope') return deny('Standalone scope changes are unsupported; permission applies to follow-ups');
  if (!task.issue.labels.includes('harness:managed')) return deny('Issue is not explicitly managed');
  if (action.taskVersion !== task.version) return deny('Task changed since proposal or approval');
  if (budget.actions >= config.manager.maxActions) return deny('Maximum actions per run reached');
  if (task.issue.state === 'closed' && !(action.kind === 'transition' && action.status === 'done') && action.kind !== 'cancel_worker') return deny('Issue is already closed');
  if (action.kind === 'transition') {
    if (!action.status || !canTransition(task.status, action.status)) return deny('Invalid lifecycle transition');
    if (ctx.source !== 'reconcile' && (['running', 'done', 'failed', 'awaiting-pr'].includes(action.status) || task.executions.some(e => e.active))) return deny('Planner cannot assert execution or completion facts');
    if (ctx.source === 'reconcile' && action.status !== task.desiredStatus) return deny('Transition does not match reconstructed facts');
    if (action.status === 'ready' && task.blocked) return deny('Task has unresolved dependencies or missing acceptance criteria');
  }
  if (action.kind === 'close_issue' && (ctx.source !== 'reconcile' || !task.hasClosingMerge || task.executions.some(e => e.active))) return deny('Closing requires a verified native closing link to a merged PR and no active execution');
  if (['start_worker', 'retry_worker'].includes(action.kind)) {
    if (!config.workers.test.enabled && !(config.workers.coding && config.workers.coding.enabled)) return deny('All workers disabled');
    if (task.blocked || task.issue.body.length > 20000) return deny('Task is blocked or exceeds worker input limit');
    if (task.executions.some(e => e.active)) return deny('Task already has an active or uncertain execution');
    // A rework continues the task's own published attempt; that pull request is replaced, not a competing implementation.
    const rework = action.kind === 'retry_worker' && task.reworkable;
    if (task.hasClosingMerge || task.hasOpenPR && !rework) return deny('Task already has implementation PRs');
    if (budget.activeWorkers >= config.execution.maxParallelWorkers) return deny('Maximum parallel workers reached');
    if (action.kind === 'retry_worker') {
      if (!task.latest?.result || !rework && !['failed', 'cancelled'].includes(task.latest.result.status)) return deny('No failed execution to retry');
      if (task.latest.attempt >= config.execution.maxRetries) return deny('Maximum retries reached');
      if (action.attempt !== task.latest.attempt + 1) return deny('Retry proposal is not bound to the next concrete attempt');
    } else {
      if (task.latest) return deny('Current task version already executed; use retry for failures or revise the task');
      if (action.attempt !== 0) return deny('Initial execution must use attempt zero');
    }
  }
  if (action.kind === 'cancel_worker' && !task.executions.some(e => e.orphaned || e.active && e.timedOut && (e.run || e.runtime))) return deny('No timed out or orphaned workflow to cancel');
  if (action.kind === 'create_followup') {
    if (!action.followup) return deny('Follow-up details are required');
    if (budget.newIssues >= config.execution.maxNewIssues) return deny('Maximum new issues per run reached');
    if (action.followup.expandsScope) {
      const scope = permission(config, 'expand_scope');
      if (scope === 'deny') return deny('Scope expansion forbidden');
      if (scope === 'approval' && !ctx.approved) return decide('approval', 'Scope expansion needs approval for this action');
    }
  }
  if (action.kind === 'prioritize' && !action.priority) return deny('Priority is required');
  if (action.kind === 'approve_task' && (task.blocked || task.hasOpenPR || task.hasClosingMerge || task.latest?.result?.status === 'success' || task.executions.some(e => e.active))) return deny('Task cannot be made ready');
  const rule = permission(config, action.kind);
  if (rule === 'deny') return deny(`Policy forbids ${action.kind}`);
  if (rule === 'approval' && !ctx.approved) return decide('approval', 'Maintainer approval required for this exact action and task version');
  return decide('allow', ctx.approved ? 'Concrete action approved by a repository maintainer' : 'Permitted by configured autonomy policy');
}
