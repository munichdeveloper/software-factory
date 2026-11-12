import type { Config } from '../config/index.js';
import type { Task } from '../state/reconstruct.js';

export const statusMarker = '<!-- software-factory:status -->';

/** The worker's own words, reduced to inert plain text: no markup, links, mentions or references that GitHub would act on. */
function quoted(text: string): string {
  const plain = text.replace(/[<>`*_~|[\]()!]/g, ' ').replace(/https?:\/\/\S+/gi, ' ').replace(/[@#]/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 700 ? `${plain.slice(0, 700)} …` : plain;
}
const validationReasons: Record<string, string> = {
  CHECK_FAILED: 'at least one check failed', NO_PUBLISHABLE_CHANGES: 'the worker produced no changes', UNSUPPORTED_PROJECT: 'this project type is not supported by the validation',
  VALIDATION_SETUP_FAILED: 'the validation environment could not be set up', SOURCE_CHANGED: 'the checks modified the source files', CHECKS_COMPLETED: 'all checks completed',
};

/**
 * Why the last run ended blocked, and what exactly a person has to do about it.
 * Facts come from the broker (its bound validation report and the status line it appends to the summary).
 * The worker's own explanation is repeated as inert, clearly marked text, never as fact.
 */
function blocked(task: Task, repository: string, readyIsGrant: boolean): { state: string[]; needs: string } {
  const result = task.latest!.result!, validation = task.latest!.runtime?.validation;
  // The broker appends this line only together with a validation reference it created itself.
  const brokerLine = result.artifacts.some(a => a.startsWith('urn:sf-validation:'))
    ? result.summary.match(/\nOriginal model status: ([a-z_]+)\. Independent automated validation: ([a-z]+)\. Manual acceptance is not implied\.$/) : null;
  const model = brokerLine?.[1], verdict = validation?.status ?? brokerLine?.[2];
  const own = quoted(brokerLine ? result.summary.slice(0, brokerLine.index) : result.summary);
  const state: string[] = [];
  const again = `revise the task text and remove \`harness:blocked\`${readyIsGrant ? ', then apply `harness:ready`' : ''} to start a new run`;
  let needs: string;
  if (verdict && verdict !== 'passed') {
    const failed = validation?.failed.map(c => `\`${c.name}\`${c.exitCode === null ? '' : ` (exit code ${c.exitCode})`}`) ?? [];
    state.push(`**Blocked because the independent validation ${verdict === 'failed' ? 'failed' : `ended as \`${verdict}\``}**${validation ? `: ${validationReasons[validation.reason] ?? validation.reason}` : ''}.`);
    if (failed.length) state.push(`Failed checks: ${failed.join(', ')}.`);
    if (validation) state.push(`Validation run: https://github.com/${repository}/actions/runs/${validation.runId}`);
    state.push(model === 'success' ? 'The worker itself reported success; it could not run these checks in its isolated environment.' : `The worker itself reported \`${model ?? 'blocked'}\`.`);
    needs = `The Factory does not repair a failed validation on its own yet. Either fix the failing checks in the draft pull request and merge it yourself, or ${again}.`;
  } else {
    state.push(`**Blocked because the worker itself stopped**${verdict === 'passed' ? ', although the independent validation passed' : ''}. It did not consider the task complete.`);
    needs = `Read the worker's explanation below. If its changes are acceptable, continue in the draft pull request yourself; if the task has to change, ${again}.`;
  }
  if (own) state.push('', 'The worker\'s own explanation (unverified, repeated as plain text):', `> ${own}`);
  return { state, needs };
}

/**
 * The one readable comment of a managed task: what the Factory is doing with it, why it is not progressing and what
 * exactly it needs from a person. Lifecycle facts, fixed codes and links come from the Factory's own records. Worker
 * text appears only as an inert, marked quotation. The comment is not part of the journal and is never read back as state.
 */
export function statusComment(task: Task, config: Config, context: { repository: string; readyIsGrant: boolean; rejection?: string; queued?: boolean }): string {
  const running = task.executions.find(e => e.active && e.runtime?.status === 'running' && e.runtime.phase !== 'awaiting-approval') ?? task.executions.find(e => e.active && e.run);
  const waiting = task.executions.some(e => e.active && e.runtime?.phase === 'awaiting-approval');
  const result = task.latest?.result;
  const links = (result?.artifacts ?? []).filter(a => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(a));
  const grant = 'An authorized person applies the label `harness:ready`. Nothing else is missing; the run starts on the next reconciliation.';
  let state: string[], needs = 'Nothing.';
  if (task.issue.state === 'closed') state = ['The task is closed.'];
  else if (task.executions.some(e => e.ambiguous)) state = ['A start was sent and its outcome is not known yet. The Factory keeps resolving it and starts nothing else for this task meanwhile.'];
  else if (waiting) { state = ['A run is waiting at the approval gate.']; needs = 'Approve or cancel the run in the SF Manager.'; }
  else if (running) state = ['A worker is running.'];
  else if (task.blockReason && !(result?.status === 'blocked' && task.automaticBlockCause === 'worker')) {
    state = [`**Blocked: ${task.blockReason}.**`];
    needs = task.blockReason.startsWith('Unresolved dependencies') ? 'Close the issues this task depends on, or remove them from its `Depends on:` line.'
      : task.blockReason.startsWith('Missing Acceptance') ? 'Add a section `## Acceptance criteria` with at least one list item to the task text.'
      : 'Remove the label `harness:blocked` when the task may continue.';
  } else if (context.rejection) {
    const ready = context.rejection.startsWith('READY_');
    state = ready ? ['Ready to run. **Waiting only for the grant.**'] : [`**The runtime refused to start this task (\`${context.rejection}\`).**`];
    needs = ready ? grant : 'Check the runtime registry entry and the Factory configuration of this repository; the code above names the failed check.';
  } else if (result?.status === 'success') { state = ['Implemented and independently validated.']; needs = 'Review and merge the pull request. The Factory does not merge on its own in this installation.'; }
  else if (result?.status === 'blocked') ({ state, needs } = blocked(task, context.repository, context.readyIsGrant));
  else if (result?.status === 'needs_approval') { state = ['The last run asks for an approval before it continues.']; needs = `Read the worker's request: ${quoted(result.summary)}`; }
  else if (result) {
    const left = task.latest!.attempt < config.execution.maxRetries, code = result.error && /^[A-Z_]{1,60}$/.test(result.error) ? ` (\`${result.error}\`)` : '';
    state = [`The last run ${result.status === 'cancelled' ? 'was cancelled' : 'failed'}${code} (attempt ${task.latest!.attempt + 1} of ${config.execution.maxRetries + 1}).`];
    needs = left ? 'Nothing; the Factory retries on its own.' : 'The retry limit is reached. Revise the task text to start over.';
  } else if (task.hasOpenPR) { state = ['A pull request for this task is open.']; needs = 'Review and merge the pull request.'; }
  else if (context.readyIsGrant && !task.issue.labels.includes('harness:ready')) { state = ['Ready to run. **Waiting only for the grant.**']; needs = grant; }
  else state = [context.queued ? 'Queued: all worker slots are in use. It starts when one is free.' : 'Queued; starts on the next reconciliation.'];
  return [statusMarker, `**Software Factory** · \`${task.desiredStatus}\``, '', ...state, '', `**Needed from you:** ${needs}`,
    ...(links.length ? ['', `**Pull request:** ${links.join(', ')}`] : []),
    '', '_Kept up to date by the Factory. Editing or deleting this comment changes nothing._'].join('\n');
}
