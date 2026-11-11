import type { Config } from '../config/index.js';
import type { Task } from '../state/reconstruct.js';

export const statusMarker = '<!-- software-factory:status -->';

/**
 * The one readable comment of a managed task: what the Factory is doing with it and what it needs from a person.
 * Built only from lifecycle facts, fixed codes and links the Factory itself recorded; never from task text,
 * worker summaries or external error messages. It is not part of the journal and is never read back as state.
 */
export function statusComment(task: Task, config: Config, context: { readyIsGrant: boolean; rejection?: string; queued?: boolean }): string {
  const running = task.executions.find(e => e.active && e.runtime?.status === 'running' && e.runtime.phase !== 'awaiting-approval') ?? task.executions.find(e => e.active && e.run);
  const waiting = task.executions.some(e => e.active && e.runtime?.phase === 'awaiting-approval');
  const result = task.latest?.result;
  const links = (result?.artifacts ?? []).filter(a => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(a));
  let state: string, needs = 'Nothing.';
  if (task.issue.state === 'closed') state = 'The task is closed.';
  else if (task.executions.some(e => e.ambiguous)) state = 'A start was sent and its outcome is not known yet. The Factory keeps resolving it and starts nothing else for this task meanwhile.';
  else if (waiting) { state = 'A run is waiting at the approval gate.'; needs = 'Approve or cancel the run in the SF Manager.'; }
  else if (running) state = 'A worker is running.';
  else if (task.blockReason) { state = `Blocked: ${task.blockReason}.`; needs = 'Resolve this block; the Factory continues on its next run.'; }
  else if (context.rejection) {
    const grant = context.rejection.startsWith('READY_');
    state = grant ? 'Ready to run, waiting for the grant.' : `The runtime refused to start this task (\`${context.rejection}\`).`;
    needs = grant ? 'An authorized person applies the label `harness:ready`.' : 'Check the runtime registry and the repository configuration.';
  } else if (result?.status === 'success') { state = 'Implemented.'; needs = 'Review the pull request.'; }
  else if (result?.status === 'blocked') { state = 'The last run ended blocked.'; needs = 'Review the result and its draft pull request, then revise the task or remove `harness:blocked`.'; }
  else if (result?.status === 'needs_approval') { state = 'The last run asks for an approval.'; needs = 'Review the result.'; }
  else if (result) {
    const left = task.latest!.attempt < config.execution.maxRetries;
    state = `The last run ${result.status === 'cancelled' ? 'was cancelled' : 'failed'} (attempt ${task.latest!.attempt + 1} of ${config.execution.maxRetries + 1}).`;
    needs = left ? 'Nothing; the Factory retries.' : 'Revise the task; the retry limit is reached.';
  } else if (task.hasOpenPR) { state = 'A pull request for this task is open.'; needs = 'Review the pull request.'; }
  else if (context.readyIsGrant && !task.issue.labels.includes('harness:ready')) { state = 'Ready to run, waiting for the grant.'; needs = 'An authorized person applies the label `harness:ready`.'; }
  else state = context.queued ? 'Queued: all worker slots are in use.' : 'Queued; starts on the next run.';
  return [statusMarker, `**Software Factory** · \`${task.desiredStatus}\``, '', state, '', `**Needs from a person:** ${needs}`,
    ...(links.length ? ['', `**Pull request:** ${links.join(', ')}`] : []),
    '', '_Kept up to date by the Factory. Editing or deleting this comment changes nothing._'].join('\n');
}
