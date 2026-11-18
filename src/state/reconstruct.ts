import type { Config } from '../config/index.js';
import type { Issue, Snapshot, Status, WorkflowRun } from '../types.js';
import type { WorkerInput, WorkerResult } from '../workers/contract.js';
import { decodeEvent, type BlockCause, type HarnessEvent } from './events.js';
import { currentAutomaticBlock } from './blocks.js';
import { acceptanceCriteria, dependencies, issueStatus } from './lifecycle.js';
import { taskVersion } from './identity.js';
import { policyVersion } from '../policies/engine.js';
import type { MergeReview } from '../merge/contract.js';

/** Summary of the cancelled result the Manager writes when the runtime definitely refused a start. */
export const admissionRejectedSummary = 'Runtime admission rejected before start';
/** A refused start is offered again at the latest after this wait, doubling per refusal in a row (software-factory#53). */
/** Error code and summary of a coding run that failed before any agent started (runner or workspace setup). */
export const infrastructureFailureCode = 'EXECUTOR_INFRASTRUCTURE_FAILURE';
export const infrastructureFailureSummary = 'The coding run failed before the agent started';
/**
 * Such failures cost no attempt, up to this many per task version: a setup step that fails every time (a broken
 * lockfile, say) must still reach the retry limit instead of retrying without end.
 */
export const freeInfrastructureFailures = 3;
export const admissionBackoffMinutes = (refusals: number) => Math.min(15 * 2 ** Math.max(0, refusals - 1), 360);

export interface Execution { input: WorkerInput; attempt: number; actionId: string; at: string; run?: WorkflowRun; runtime?: import('../runtime/contract.js').RuntimeObservation; result?: WorkerResult; active: boolean; ambiguous: boolean; timedOut: boolean;
  /** A Temporal run whose task was closed or revised underneath it: its result can no longer be published. */
  orphaned: boolean;
  /** The runtime refused to start this execution (its code). Nothing ran, so it is not an attempt. */
  rejected?: string;
  /** The policy version the refusal happened under, where the journal records it. */
  rejectedPolicy?: string;
  /** The run failed before any agent started and is within the free allowance: it is no attempt. */
  infrastructure?: boolean }
/** The last start of the current task version was refused by the runtime, and no real attempt followed. */
export interface AdmissionRefusal { code: string; at: string; refusals: number;
  /** The refusal still holds: neither grant, policy nor configuration changed and the backoff has not run out. */
  waiting: boolean; until: string }
export interface Task {
  issue: Issue; version: string; status: Status; desiredStatus: Status; events: HarnessEvent[];
  executions: Execution[];
  /** The latest real attempt of the current task version; a start the runtime refused is none. */
  latest?: Execution;
  /** Real attempts of the current task version (refused starts and free infrastructure failures excluded): what counts against execution.maxRetries. */
  attemptsUsed: number;
  /** The attempt number of the next intent; refused starts keep their numbers, so execution IDs stay unique. */
  nextAttempt: number;
  refusal?: AdmissionRefusal;
  blocked: boolean; blockReason?: string;
  hasOpenPR: boolean; hasClosingMerge: boolean; criteria: string[];
  /**
   * The latest attempt failed only its independent validation, or the independent merge review asked for changes to its
   * pull request, and a further attempt is allowed to repair it.
   */
  reworkable: boolean;
  /** The merge review a rework answers, when the review (not the validation) is what it repairs. */
  reworkReview?: MergeReview;
  automaticBlockCause?: BlockCause;
  /** Open follow-up issues the Factory created from this task (`Origin: #n`). */
  openFollowups: number[];
}
/** A Factory follow-up names its origin task and carries the follow-up marker. */
export const followupOrigin = (body: string): number | null =>
  body.includes('<!-- harness:followup:') ? Number(body.match(/^Origin: #(\d+)$/m)?.[1] ?? NaN) || null : null;
export function reconstruct(snapshot: Snapshot, config: Config, now = new Date()): Task[] {
  return snapshot.issues.map(issue => {
    const version = taskVersion(issue);
    const events = (snapshot.comments.get(issue.number) ?? []).flatMap(c => {
      const event = decodeEvent(c, config.manager.trustedActors);
      return event ? [event] : [];
    });
    const executions: Execution[] = [];
    for (const event of events) {
      if (event.data.type !== 'intent' || executions.some(e => e.input.executionId === (event.data.type === 'intent' ? event.data.input.executionId : ''))) continue;
      const { input, attempt, actionId } = event.data;
      if (input.issueNumber !== issue.number) continue;
      const matching = snapshot.runs.filter(r => [`Factory worker ${input.executionId}`, `Harness worker ${input.executionId}`].includes(r.title));
      const run = matching.find(r => r.status !== 'completed') ?? matching[0];
      const runtime = snapshot.runtimeExecutions?.find(r => r.executionId === input.executionId);
      const found = events.find(e => e.data.type === 'result' && e.data.result.executionId === input.executionId && e.data.result.issueNumber === issue.number);
      let result = runtime?.result ?? (found?.data.type === 'result' ? found.data.result : undefined);
      if (!result && runtime && !['running'].includes(runtime.status)) result = { contractVersion: '1.0', executionId: input.executionId, issueNumber: issue.number,
        status: runtime.status === 'cancelled' ? 'cancelled' : 'failed', summary: 'Temporal execution ended without a committed worker result', artifacts: [], error: runtime.status, proposedActions: [] };
      if (!result && run?.status === 'completed') {
        result = { contractVersion: '1.0', executionId: input.executionId, issueNumber: issue.number,
          status: run.conclusion === 'cancelled' ? 'cancelled' : 'failed', summary: 'Workflow ended without a valid durable worker result',
          artifacts: [run.url], error: `Workflow conclusion: ${run.conclusion}`, proposedActions: [] };
      }
      const elapsed = now.getTime() - new Date(runtime?.createdAt ?? run?.createdAt ?? event.at).getTime();
      // A result cannot release a slot while the corresponding workflow is still running.
      const active = runtime ? runtime.status === 'running' : run ? run.status !== 'completed' : !result;
      const rejection = events.find(e => e.data.type === 'admission_rejected' && e.data.executionId === input.executionId);
      const rejected = result?.status === 'cancelled' && !runtime && !run && result.summary.startsWith(admissionRejectedSummary) ? result.error ?? 'UNKNOWN' : undefined;
      executions.push({ input, attempt, actionId, at: event.at, run, runtime, result, active,
        ...(rejected ? { rejected, ...(rejection?.data.type === 'admission_rejected' ? { rejectedPolicy: rejection.data.policyHash } : {}) } : {}),
        orphaned: active && !!runtime && (issue.state === 'closed' || input.taskVersion !== version),
        ambiguous: !runtime && !run && !result && elapsed > config.execution.dispatchGraceMinutes * 60000,
        timedOut: runtime?.phase !== 'awaiting-approval' && !!(run || runtime) && active && elapsed > input.limits.timeoutMinutes * 60000 });
    }
    const currentExecutions = executions.filter(e => e.input.taskVersion === version);
    currentExecutions.sort((a, b) => a.attempt - b.attempt);
    currentExecutions.filter(e => !e.rejected && e.result?.status === 'failed' && e.result.error === infrastructureFailureCode)
      .slice(0, freeInfrastructureFailures).forEach(e => { e.infrastructure = true; });
    const real = currentExecutions.filter(e => !e.rejected);
    const latest = real.at(-1);
    const attemptsUsed = real.filter(e => !e.infrastructure).length;
    const nextAttempt = (currentExecutions.at(-1)?.attempt ?? -1) + 1;
    // Refused starts after the latest real attempt: the next start waits for a changed condition or the backoff.
    const refused = currentExecutions.filter(e => e.rejected && (!latest || e.attempt > latest.attempt));
    const lastRefused = refused.at(-1);
    let refusal: AdmissionRefusal | undefined;
    if (lastRefused) {
      const at = (events.find(e => e.data.type === 'result' && e.data.result.executionId === lastRefused.input.executionId) ?? { at: lastRefused.at }).at;
      const until = new Date(new Date(at).getTime() + admissionBackoffMinutes(refused.length) * 60000).toISOString();
      const changed = (!!lastRefused.rejectedPolicy && lastRefused.rejectedPolicy !== policyVersion(config)) || (!!issue.readyAt && issue.readyAt > at) || (!!issue.managedAt && issue.managedAt > at);
      refusal = { code: lastRefused.rejected!, at, refusals: refused.length, until, waiting: !changed && now.toISOString() < until };
    }
    const criteria = acceptanceCriteria(issue.body);
    const deps = dependencies(issue.body);
    const unresolved = deps.filter(n => snapshot.dependencyStates.get(n) !== true);
    const automaticBlock = currentAutomaticBlock(issue, events, config.manager.trustedActors);
    const explicitBlock = issue.labels.includes('harness:blocked') && !automaticBlock;
    const semanticBlock = automaticBlock?.cause === 'planner' && automaticBlock.taskVersion === version;
    const blockReason = unresolved.length ? `Unresolved dependencies: ${unresolved.map(n => `#${n}`).join(', ')}`
      : !criteria.length ? 'Missing Acceptance criteria section'
      : explicitBlock ? 'Issue explicitly marked blocked; clear the blocked label to resume'
      : semanticBlock ? 'Planner marked task blocked; revise the task or clear the blocked label' : undefined;
    const automaticBlockCause: BlockCause | undefined = executions.some(e => e.ambiguous) ? 'dispatch'
      : unresolved.length ? 'dependencies' : !criteria.length ? 'specification'
      : semanticBlock ? 'planner' : latest?.result?.status === 'blocked' ? 'worker' : undefined;
    const linked = snapshot.prs.filter(p => p.closingIssues.includes(issue.number) || p.referencedIssues.includes(issue.number));
    const hasOpenPR = linked.some(p => p.state === 'open');
    const hasClosingMerge = linked.some(p => p.merged && p.closingIssues.includes(issue.number) &&
      (!issue.reopenedAt || (!!p.mergedAt && p.mergedAt > issue.reopenedAt)));
    // The only open pull requests are the ones the Factory published for this task's own attempts: a rework replaces them.
    const ownPRsOnly = linked.filter(p => p.state === 'open').every(p => executions.some(e => p.headRefName === `sf/issue-${issue.number}/${e.input.executionId}`));
    const failedValidation = latest?.runtime?.validation;
    // The broker's merge review asked for changes to the pull request this very attempt published (and it is still open).
    const requested = latest?.result?.status === 'success' && hasOpenPR ? events.flatMap(e => e.data.type === 'merge_changes_requested' &&
      e.data.executionId === latest.input.executionId ? [e.data.review] : []).at(-1) : undefined;
    const repairable = latest?.result?.status === 'blocked' && failedValidation?.status === 'failed' && failedValidation.reason === 'CHECK_FAILED' || !!requested;
    const reworkable = config.execution.rework && issue.state === 'open' && !blockReason && !hasClosingMerge && ownPRsOnly && !executions.some(e => e.active) &&
      repairable && attemptsUsed <= config.execution.maxRetries;
    const reworkReview = reworkable && latest?.result?.status === 'success' ? requested : undefined;
    let desiredStatus: Status = issueStatus(issue) ?? 'backlog';
    if (issue.state === 'closed') desiredStatus = 'done';
    else if (explicitBlock) desiredStatus = 'blocked';
    else if (issueStatus(issue) === 'done') desiredStatus = 'backlog';
    else if (executions.some(e => e.active)) desiredStatus = executions.some(e => e.ambiguous) ? 'blocked' : executions.some(e => e.runtime?.phase === 'awaiting-approval') ? 'awaiting-approval' : 'running';
    else if (hasClosingMerge) desiredStatus = 'done';
    else if (blockReason) desiredStatus = 'blocked';
    else if (reworkable) desiredStatus = 'failed';
    // Where ready is a person's grant, a fresh grant on a task whose last attempt failed is what admits the retry.
    // The Manager must leave that label alone until the retry has started; replacing it with `failed` would
    // consume the grant it is waiting for.
    else if (snapshot.readyIsGrant && issue.labels.includes('harness:ready') && !hasOpenPR && latest?.result &&
      ['failed', 'cancelled'].includes(latest.result.status) && attemptsUsed <= config.execution.maxRetries) desiredStatus = 'ready';
    else if (latest?.result) desiredStatus = ({ success: 'awaiting-pr', failed: 'failed', cancelled: 'failed', blocked: 'blocked', needs_approval: 'awaiting-approval' } as const)[latest.result.status];
    else if (hasOpenPR) desiredStatus = 'awaiting-pr';
    // A runnable task rests in ready. Where ready is a person's grant, the Manager leaves the label to that
    // person: the task rests in backlog until the grant is there, and a grant that is present always wins.
    else if (snapshot.readyIsGrant) { if (['backlog', 'ready', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = issue.labels.includes('harness:ready') ? 'ready' : 'backlog'; }
    else if (['backlog', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = 'ready';
    const openFollowups = snapshot.issues.filter(i => i.state === 'open' && followupOrigin(i.body) === issue.number).map(i => i.number);
    return { issue, version, status: issueStatus(issue) ?? 'backlog', desiredStatus, events, executions, latest, attemptsUsed, nextAttempt,
      ...(refusal ? { refusal } : {}), openFollowups,
      blocked: !!blockReason, blockReason, automaticBlockCause: reworkable && automaticBlockCause === 'worker' ? undefined : automaticBlockCause, hasOpenPR, hasClosingMerge, criteria, reworkable,
      ...(reworkReview ? { reworkReview } : {}) };
  });
}
