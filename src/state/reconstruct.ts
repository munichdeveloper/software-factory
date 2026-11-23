import type { Config } from '../config/index.js';
import type { Issue, Snapshot, Status, WorkflowRun } from '../types.js';
import type { WorkerInput, WorkerResult } from '../workers/contract.js';
import { decodeEvent, type BlockCause, type HarnessEvent } from './events.js';
import { currentAutomaticBlock } from './blocks.js';
import { acceptanceCriteria, dependencies, issueStatus } from './lifecycle.js';
import { taskVersion } from './identity.js';
import { protectedPathBlockReason } from './protected-paths.js';
import { policyVersion } from '../policies/engine.js';
import type { MergeReview } from '../merge/contract.js';

/** Summary of the cancelled result the Manager writes when the runtime definitely refused a start. */
export const admissionRejectedSummary = 'Runtime admission rejected before start';
/** A refused start is offered again at the latest after this wait, doubling per refusal in a row (software-factory#53). */
/** Error code and summary of a coding run that failed before any agent started (runner or workspace setup). */
export const infrastructureFailureCode = 'EXECUTOR_INFRASTRUCTURE_FAILURE';
export const infrastructureFailureSummary = 'The coding run failed before the agent started';
/** The workspace's locked npm dependencies could not be installed before the agent; costs an attempt (letterflow#34). */
export const dependenciesFailureCode = 'WORKSPACE_DEPENDENCIES_FAILED';
export const dependenciesFailureSummary = 'Installing the locked npm dependencies of the workspace failed before the agent started (package.json and package-lock.json do not match, or a package cannot be resolved)';
/**
 * Such failures cost no attempt, up to this many per task version: a setup step that fails every time (a broken
 * lockfile, say) must still reach the retry limit instead of retrying without end.
 */
export const freeInfrastructureFailures = 3;
export const admissionBackoffMinutes = (refusals: number) => Math.min(15 * 2 ** Math.max(0, refusals - 1), 360);
/** Refusal codes whose cause the runtime can check again on its own (issue #188 step 3). */
export const clearableRefusals = ['EXECUTOR_WRAPPER_RELEASE_MISMATCH', 'UNKNOWN_WORKER_DEPLOYMENT_VERSION'];

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
  /**
   * The attempt a rework continues when it is not `latest`: the task text was revised while the open pull request of an
   * attempt at the earlier text still waited for its rework (issue #188 step 5, variant A).
   */
  reworkFrom?: Execution;
  /** Real attempts this task version may use: maxRetries + 1, plus a rescue attempt while one is due or used (issue #188 step 7). */
  attemptLimit: number;
  /** The next attempt is the rescue attempt: it runs on retryAgents and names rescueMarker. */
  rescueDue?: boolean;
  /** Why the merge side asked for that rework: review findings, or a conflict of the branch with the base. */
  reworkCause?: 'review' | 'conflict' | 'checks' | 'threads';
  automaticBlockCause?: BlockCause;
  /** Open follow-up issues the Factory created from this task (`Origin: #n`). */
  openFollowups: number[];
}
/** A Factory follow-up names its origin task and carries the follow-up marker. */
export const followupOrigin = (body: string): number | null =>
  body.includes('<!-- harness:followup:') ? Number(body.match(/^Origin: #(\d+)$/m)?.[1] ?? NaN) || null : null;
/** Context reference of a rescue attempt (issue #188 step 7). */
export const rescueMarker = 'urn:sf-rescue';
export function reconstruct(snapshot: Snapshot, config: Config, now = new Date()): Task[] {
  // Rescue attempts of the whole repository within the last 24 hours (execution.rescue.maxPerDay).
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  const rescuesToday = [...snapshot.comments.values()].reduce((n, comments) => n + comments.filter(c => {
    const event = c.body.includes(rescueMarker) ? decodeEvent(c, config.manager.trustedActors) : null;
    return event?.data.type === 'intent' && event.data.input.contextReferences.includes(rescueMarker) && new Date(event.at).getTime() >= dayAgo;
  }).length, 0);
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
      // The cause of the refusal is provably gone, e.g. the repository pins the runtime's release again (issue #188 step 3).
      const cleared = !!snapshot.clearedRefusals?.includes(lastRefused.rejected!);
      const changed = cleared || (!!lastRefused.rejectedPolicy && lastRefused.rejectedPolicy !== policyVersion(config)) || (!!issue.readyAt && issue.readyAt > at) || (!!issue.managedAt && issue.managedAt > at);
      refusal = { code: lastRefused.rejected!, at, refusals: refused.length, until, waiting: !changed && now.toISOString() < until };
    }
    const criteria = acceptanceCriteria(issue.body);
    const deps = dependencies(issue.body);
    const unresolved = deps.filter(n => snapshot.dependencyStates.get(n) !== true);
    const automaticBlock = currentAutomaticBlock(issue, events, config.manager.trustedActors);
    const explicitBlock = issue.labels.includes('harness:blocked') && !automaticBlock;
    const semanticBlock = automaticBlock?.cause === 'planner' && automaticBlock.taskVersion === version;
    // A task asking for changes the coding worker may not make (CI workflows, agent files) is never started.
    const protectedPaths = issue.state === 'open' ? protectedPathBlockReason(issue.title, issue.body) : undefined;
    const blockReason = unresolved.length ? `Unresolved dependencies: ${unresolved.map(n => `#${n}`).join(', ')}`
      : !criteria.length ? 'Missing Acceptance criteria section'
      : protectedPaths ? protectedPaths
      : explicitBlock ? 'Issue explicitly marked blocked; clear the blocked label to resume'
      : semanticBlock ? 'Planner marked task blocked; revise the task or clear the blocked label' : undefined;
    const automaticBlockCause: BlockCause | undefined = executions.some(e => e.ambiguous) ? 'dispatch'
      : unresolved.length ? 'dependencies' : !criteria.length || protectedPaths ? 'specification'
      : semanticBlock ? 'planner' : latest?.result?.status === 'blocked' ? 'worker' : undefined;
    const linked = snapshot.prs.filter(p => p.closingIssues.includes(issue.number) || p.referencedIssues.includes(issue.number));
    const hasOpenPR = linked.some(p => p.state === 'open');
    const hasClosingMerge = linked.some(p => p.merged && p.closingIssues.includes(issue.number) &&
      (!issue.reopenedAt || (!!p.mergedAt && p.mergedAt > issue.reopenedAt)));
    // The only open pull requests are the ones the Factory published for this task's own attempts: a rework replaces them.
    const ownPRsOnly = linked.filter(p => p.state === 'open').every(p => executions.some(e => p.headRefName === `sf/issue-${issue.number}/${e.input.executionId}`));
    // A revised task without an attempt of its own continues the open pull request of the last attempt at an earlier text
    // when that one waited for a rework (issue #188 step 5, variant A): editing the issue no longer drops the rework.
    // Where ready is a person's grant, the revised text needs its own grant first; until then the task waits on its pull request.
    const carried = !latest && hasOpenPR && (!snapshot.readyIsGrant || issue.labels.includes('harness:ready')) ? executions.filter(e => e.input.taskVersion !== version && !e.rejected && !!e.result &&
      linked.some(p => p.state === 'open' && p.headRefName === `sf/issue-${issue.number}/${e.input.executionId}`)).sort((a, b) => b.at.localeCompare(a.at))[0] : undefined;
    const source = latest ?? carried;
    const failedValidation = source?.runtime?.validation;
    // The broker's merge review asked for changes to the pull request this very attempt published (and it is still open).
    // Or its branch conflicts with the base (cause conflict): the same rework, which resolves the conflict on the current base.
    const requestedBy = source?.result?.status === 'success' && hasOpenPR ? events.flatMap(e => e.data.type === 'merge_changes_requested' &&
      e.data.executionId === source.input.executionId ? [e.data] : []).at(-1) : undefined;
    const requested = requestedBy?.review;
    const repairable = source?.result?.status === 'blocked' && failedValidation?.status === 'failed' && failedValidation.reason === 'CHECK_FAILED' || !!requested;
    // Tier 3 (issue #188 step 7): after maxRetries, one rescue attempt on retryAgents when the agent owns the failure.
    const rescue = config.execution.rescue, coding = config.workers.coding;
    const rescueUsed = real.some(e => e.input.contextReferences.includes(rescueMarker));
    const agentOwned = !!source?.result && (repairable || source.result.status === 'failed' && source.result.error !== infrastructureFailureCode);
    const rescueAvailable = !rescueUsed && !!rescue?.enabled && config.execution.engine === 'temporal' && !!coding && coding.enabled && !!coding.retryAgents &&
      agentOwned && attemptsUsed === config.execution.maxRetries + 1 && rescuesToday < rescue.maxPerDay;
    const attemptLimit = config.execution.maxRetries + 1 + (rescueUsed || rescueAvailable ? 1 : 0);
    const reworkable = config.execution.rework && issue.state === 'open' && !blockReason && !hasClosingMerge && ownPRsOnly && !executions.some(e => e.active) &&
      repairable && attemptsUsed < attemptLimit;
    const reworkReview = reworkable && source?.result?.status === 'success' ? requested : undefined;
    const reworkFrom = reworkable && !latest ? carried : undefined;
    let desiredStatus: Status = issueStatus(issue) ?? 'backlog';
    if (issue.state === 'closed') desiredStatus = 'done';
    else if (explicitBlock) desiredStatus = 'blocked';
    else if (issueStatus(issue) === 'done') desiredStatus = 'backlog';
    else if (executions.some(e => e.active)) desiredStatus = executions.some(e => e.ambiguous) ? 'blocked' : executions.some(e => e.runtime?.phase === 'awaiting-approval') ? 'awaiting-approval' : 'running';
    else if (hasClosingMerge) desiredStatus = 'done';
    else if (blockReason) desiredStatus = 'blocked';
    // A rework of revised text runs on a grant for that text (issue #188 step 5): the label stays until the rework started.
    else if (reworkable) desiredStatus = reworkFrom && snapshot.readyIsGrant ? 'ready' : 'failed';
    // Where ready is a person's grant, a fresh grant on a task whose last attempt failed is what admits the retry.
    // The Manager must leave that label alone until the retry has started; replacing it with `failed` would
    // consume the grant it is waiting for.
    else if (snapshot.readyIsGrant && issue.labels.includes('harness:ready') && !hasOpenPR && latest?.result &&
      ['failed', 'cancelled'].includes(latest.result.status) && attemptsUsed < attemptLimit) desiredStatus = 'ready';
    else if (latest?.result) desiredStatus = ({ success: 'awaiting-pr', failed: 'failed', cancelled: 'failed', blocked: 'blocked', needs_approval: 'awaiting-approval' } as const)[latest.result.status];
    else if (hasOpenPR) desiredStatus = 'awaiting-pr';
    // A runnable task rests in ready. Where ready is a person's grant, the Manager leaves the label to that
    // person: the task rests in backlog until the grant is there, and a grant that is present always wins.
    else if (snapshot.readyIsGrant) { if (['backlog', 'ready', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = issue.labels.includes('harness:ready') ? 'ready' : 'backlog'; }
    else if (['backlog', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = 'ready';
    const openFollowups = snapshot.issues.filter(i => i.state === 'open' && followupOrigin(i.body) === issue.number).map(i => i.number);
    return { issue, version, status: issueStatus(issue) ?? 'backlog', desiredStatus, events, executions, latest, attemptsUsed, nextAttempt, attemptLimit,
      ...(rescueAvailable ? { rescueDue: true } : {}),
      ...(refusal ? { refusal } : {}), openFollowups,
      blocked: !!blockReason, blockReason, automaticBlockCause: reworkable && automaticBlockCause === 'worker' ? undefined : automaticBlockCause, hasOpenPR, hasClosingMerge, criteria, reworkable,
      ...(reworkReview ? { reworkReview, reworkCause: requestedBy?.cause ?? 'review' } : {}), ...(reworkFrom ? { reworkFrom } : {}) };
  });
}
