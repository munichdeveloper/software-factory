import type { Config } from '../config/index.js';
import type { Task } from '../state/reconstruct.js';
import { lifecycleLabels } from '../state/lifecycle.js';
import { proposal } from '../llm/provider.js';
import type { Action } from '../types.js';

export function reconciliationPlan(tasks: Task[], config: Config): Action[] {
  return tasks.flatMap(t => {
    const actions: Action[] = [];
    if (t.executions.some(e => e.active && e.timedOut && e.run)) actions.push(proposal(t, 'cancel_worker', 'Worker exceeded its configured time limit'));
    if (t.issue.state === 'open' && t.hasClosingMerge && !t.executions.some(e => e.active)) {
      actions.push(proposal(t, 'close_issue', 'Verified native closing reference to a merged pull request'));
    } else if (!t.issue.labels.includes(`harness:${t.desiredStatus}`) || t.issue.labels.filter(l => lifecycleLabels.includes(l)).length !== 1 ||
      t.executions.some(e => e.result && !t.events.some(event => event.data.type === 'result' && event.data.result.executionId === e.input.executionId))) {
      actions.push(proposal(t, 'transition', 'Reconcile lifecycle with GitHub facts', { status: t.desiredStatus }));
    }
    if (t.issue.state === 'open' && !t.blocked && !t.hasClosingMerge && !t.hasOpenPR && t.latest?.result &&
      ['failed', 'cancelled'].includes(t.latest.result.status) && !t.executions.some(e => e.active) && t.latest.attempt < config.execution.maxRetries) {
      actions.push(proposal(t, 'retry_worker', 'Retry failed execution within configured limit'));
    }
    return actions;
  });
}
