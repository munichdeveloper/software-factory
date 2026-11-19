import type { Config } from '../config/index.js';
import type { Task } from '../state/reconstruct.js';
import { routeNoteEn } from '../llm/router.js';

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
function blocked(task: Task, repository: string, readyIsGrant: boolean, config: Config): { state: string[]; needs: string } {
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
    if (validation) state.push(`Validation run: https://github.com/${repository}/actions/runs/${validation.runId}`,
      // The job log only carries the verdict; the output of each check is uploaded as a separate artifact of that run.
      `Output of the checks: download the artifact \`coding-validation-logs-${task.latest!.input.executionId}\` in the "Artifacts" section at the bottom of that run page (one log file per check, kept for 7 days).`);
    state.push(model === 'success' ? 'The worker itself reported success; it could not run these checks in its isolated environment.' : `The worker itself reported \`${model ?? 'blocked'}\`.`);
    needs = `${task.reworkable ? '' : config.execution.rework && task.attemptsUsed > 1 ? `The automatic rework attempts are used up (${task.attemptsUsed} of ${config.execution.maxRetries + 1} attempts). ` : 'The Factory does not repair a failed validation on its own in this installation. '}Either fix the failing checks in the draft pull request and merge it yourself, or ${again}.`;
  } else {
    state.push(`**Blocked because the worker itself stopped**${verdict === 'passed' ? ', although the independent validation passed' : ''}. It did not consider the task complete.`);
    needs = `Read the worker's explanation below. If its changes are acceptable, continue in the draft pull request yourself; if the task has to change, ${again}.`;
  }
  if (own) state.push('', 'The worker\'s own explanation (unverified, repeated as plain text):', `> ${own}`);
  return { state, needs };
}

/**
 * Where a managed task stands in the Factory's queue, the same fact the status comment states in words
 * (the queue view of the broker, software-factory-monitor).
 */
export const queueStages = ['starting', 'running', 'awaiting-approval', 'queued', 'awaiting-grant', 'retry', 'refused', 'blocked', 'awaiting-pr', 'failed', 'closed'] as const;
export type QueueStage = typeof queueStages[number];
export type StatusContext = { repository: string; readyIsGrant: boolean; rejection?: string; queued?: boolean };
/**
 * The one readable comment of a managed task: what the Factory is doing with it, why it is not progressing and what
 * exactly it needs from a person. Lifecycle facts, fixed codes and links come from the Factory's own records. Worker
 * text appears only as an inert, marked quotation. The comment is not part of the journal and is never read back as state.
 */
export function statusComment(task: Task, config: Config, context: StatusContext): string {
  return statusView(task, config, context).body;
}
/**
 * The status comment together with whether the task waits for nothing but a person's `harness:ready` grant. That flag
 * is the same fact the comment states, so a notice about the wait (software-factory#127) can never contradict it.
 */
export function statusView(task: Task, config: Config, context: StatusContext): { body: string; awaitsGrant: boolean; stage: QueueStage } {
  const running = task.executions.find(e => e.active && e.runtime?.status === 'running' && e.runtime.phase !== 'awaiting-approval') ?? task.executions.find(e => e.active && e.run);
  const waiting = task.executions.some(e => e.active && e.runtime?.phase === 'awaiting-approval');
  const result = task.latest?.result;
  const links = (result?.artifacts ?? []).filter(a => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(a));
  const grant = 'An authorized person applies the label `harness:ready`. Nothing else is missing; the run starts on the next reconciliation.';
  let state: string[], needs = 'Nothing.', awaitsGrant = false, stage: QueueStage = 'queued';
  // A refusal of this reconciliation, or one recorded earlier that still holds.
  const rejection = context.rejection ?? (task.refusal?.waiting ? task.refusal.code : undefined);
  if (task.issue.state === 'closed') { state = ['The task is closed.']; stage = 'closed'; }
  else if (task.executions.some(e => e.ambiguous)) { stage = 'starting'; state = ['A start was sent and its outcome is not known yet. The Factory keeps resolving it and starts nothing else for this task meanwhile.']; }
  else if (waiting) { stage = 'awaiting-approval'; state = ['A run is waiting at the approval gate.']; needs = 'Approve or cancel the run in the SF Manager.'; }
  else if (running) { state = ['A worker is running.']; stage = 'running'; }
  else if (task.blockReason && !(result?.status === 'blocked' && task.automaticBlockCause === 'worker')) {
    state = [`**Blocked: ${task.blockReason}.**`]; stage = 'blocked';
    needs = task.blockReason.startsWith('Unresolved dependencies') ? 'Close the issues this task depends on, or remove them from its `Depends on:` line.'
      : task.blockReason.startsWith('Missing Acceptance') ? 'Add a section `## Acceptance criteria` with at least one list item to the task text.'
      : 'Remove the label `harness:blocked` when the task may continue.';
  } else if (rejection) {
    const ready = rejection.startsWith('READY_');
    // A retry after a failed attempt says so; "ready to run" alone hid that the previous run had failed.
    const previous = result && ['failed', 'cancelled'].includes(result.status)
      ? `The last run ${result.status === 'cancelled' ? 'was cancelled' : 'failed'} (attempt ${task.attemptsUsed} of ${config.execution.maxRetries + 1}). ` : '';
    awaitsGrant = ready; stage = ready ? 'awaiting-grant' : 'refused';
    state = ready ? [previous ? `${previous}**A further attempt waits only for the grant.**` : 'Ready to run. **Waiting only for the grant.**'] : [`**The runtime refused to start this task (\`${rejection}\`).** Nothing ran, so this costs no attempt.`];
    // The label is there but was applied by an account that cannot grant, typically the Factory's own App (software-factory#109).
    if (rejection === 'READY_ACTOR_NOT_AUTHORIZED' && task.issue.labels.includes('harness:ready')) state.push('', 'The label `harness:ready` on this issue was applied by an account that cannot grant a run, for example the Factory\'s own App. It does not count as a grant.');
    if (rejection === 'MANAGED_ACTOR_NOT_AUTHORIZED') state.push('', 'In this repository a person\'s `harness:managed` is the grant; this one was applied by an account that cannot grant a run.');
    needs = rejection.startsWith('MANAGED_') && rejection !== 'MANAGED_GRANT_UNSUPPORTED'
      ? 'A person with write access removes the label `harness:managed` and applies it again. Nothing else is missing; the run starts on the next reconciliation.'
      : rejection === 'READY_ACTOR_NOT_AUTHORIZED' && task.issue.labels.includes('harness:ready')
      ? 'An authorized person removes the label `harness:ready` and applies it again. Nothing else is missing; the run starts on the next reconciliation.'
      : ready ? grant : rejection === 'EXECUTOR_WRAPPER_RELEASE_MISMATCH'
      ? 'Roll this repository out to the Factory release the runtime runs, through the SF Manager. The task starts on its own afterwards.'
      : 'Check the runtime registry entry and the Factory configuration of this repository; the code above names the failed check.';
    // A refusal that still holds is not offered again on every reconciliation (software-factory#53).
    if (task.refusal?.waiting) state.push('', `The next start waits for a new grant, a changed policy or configuration, or at the latest until ${task.refusal.until}.`);
  } else if (result?.status === 'success' && task.reworkReview) {
    stage = 'retry';
    state = ['Implemented and independently validated, but the independent merge review asked for changes.',
      '', `Attempt ${task.attemptsUsed} of ${config.execution.maxRetries + 1}. A further attempt starts on its own; it continues these changes and receives the review findings.`];
    needs = 'Nothing; the Factory reworks the review findings on its own.';
  } else if (result?.status === 'success') { stage = 'awaiting-pr'; state = ['Implemented and independently validated.']; needs = 'Review and merge the pull request. The Factory does not merge on its own in this installation.'; }
  else if (result?.status === 'blocked') {
    ({ state, needs } = blocked(task, context.repository, context.readyIsGrant, config)); stage = 'blocked';
    // Same facts, different consequence: the Factory repairs this itself and needs nobody yet.
    if (task.reworkable) {
      stage = 'retry';
      state.push('', `Attempt ${task.attemptsUsed} of ${config.execution.maxRetries + 1}. A further attempt starts on its own; it continues these changes and receives the failed checks and their output.`);
      needs = 'Nothing; the Factory reworks the failed checks on its own.';
    }
  }
  else if (result?.status === 'needs_approval') { stage = 'awaiting-approval'; state = ['The last run asks for an approval before it continues.']; needs = `Read the worker's request: ${quoted(result.summary)}`; }
  else if (result) {
    const left = task.attemptsUsed <= config.execution.maxRetries, code = result.error && /^[A-Z_]{1,60}$/.test(result.error) ? ` (\`${result.error}\`)` : '';
    state = [task.latest!.infrastructure
      ? `The last run failed before the agent started${code}, while setting up the runner or workspace. Nothing of the task ran, so this costs no attempt (${task.attemptsUsed} of ${config.execution.maxRetries + 1} used).`
      : `The last run ${result.status === 'cancelled' ? 'was cancelled' : 'failed'}${code} (attempt ${task.attemptsUsed} of ${config.execution.maxRetries + 1}).`];
    needs = left ? 'Nothing; the Factory retries on its own.' : 'The retry limit is reached. Revise the task text to start over.';
    stage = left ? 'retry' : 'failed';
  } else if (task.hasOpenPR) { stage = 'awaiting-pr'; state = ['A pull request for this task is open.']; needs = 'Review and merge the pull request.'; }
  else if (context.readyIsGrant && !task.issue.labels.includes('harness:ready')) { state = ['Ready to run. **Waiting only for the grant.**']; needs = grant; awaitsGrant = true; stage = 'awaiting-grant'; }
  else state = [context.queued ? 'Queued: all worker slots are in use. It starts when one is free.' : 'Queued; starts on the next reconciliation.'];
  // Which agent the running or latest coding execution uses, when the model router was asked (router.coding).
  const routed = (running ?? task.latest)?.runtime?.route;
  const model = routed && task.issue.state === 'open' ? ['', routeNoteEn(routed.record, routed.agent)] : [];
  return { awaitsGrant, stage, body: [statusMarker, `**Software Factory** · \`${task.desiredStatus}\``, '', ...state, ...model, '', `**Needed from you:** ${needs}`,
    ...(links.length ? ['', `**Pull request:** ${links.join(', ')}`] : []),
    '', '_Kept up to date by the Factory. Editing or deleting this comment changes nothing._'].join('\n') };
}
