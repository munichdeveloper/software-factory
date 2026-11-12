import type { Config } from '../config/index.js';
import type { Issue, Snapshot, Status, WorkflowRun } from '../types.js';
import type { WorkerInput, WorkerResult } from '../workers/contract.js';
import { decodeEvent, type BlockCause, type HarnessEvent } from './events.js';
import { currentAutomaticBlock } from './blocks.js';
import { acceptanceCriteria, dependencies, issueStatus } from './lifecycle.js';
import { taskVersion } from './identity.js';

export interface Execution { input: WorkerInput; attempt: number; actionId: string; at: string; run?: WorkflowRun; runtime?: import('../runtime/contract.js').RuntimeObservation; result?: WorkerResult; active: boolean; ambiguous: boolean; timedOut: boolean;
  /** A Temporal run whose task was closed or revised underneath it: its result can no longer be published. */
  orphaned: boolean }
export interface Task {
  issue: Issue; version: string; status: Status; desiredStatus: Status; events: HarnessEvent[];
  executions: Execution[]; latest?: Execution; blocked: boolean; blockReason?: string;
  hasOpenPR: boolean; hasClosingMerge: boolean; criteria: string[];
  /** The latest attempt failed only its independent validation and a further attempt is allowed to repair it. */
  reworkable: boolean;
  automaticBlockCause?: BlockCause;
}
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
      executions.push({ input, attempt, actionId, at: event.at, run, runtime, result, active,
        orphaned: active && !!runtime && (issue.state === 'closed' || input.taskVersion !== version),
        ambiguous: !runtime && !run && !result && elapsed > config.execution.dispatchGraceMinutes * 60000,
        timedOut: runtime?.phase !== 'awaiting-approval' && !!(run || runtime) && active && elapsed > input.limits.timeoutMinutes * 60000 });
    }
    const currentExecutions = executions.filter(e => e.input.taskVersion === version);
    const latest = currentExecutions.sort((a, b) => a.attempt - b.attempt).at(-1);
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
    const reworkable = config.execution.rework && issue.state === 'open' && !blockReason && !hasClosingMerge && ownPRsOnly && !executions.some(e => e.active) &&
      latest?.result?.status === 'blocked' && failedValidation?.status === 'failed' && failedValidation.reason === 'CHECK_FAILED' && latest.attempt < config.execution.maxRetries;
    let desiredStatus: Status = issueStatus(issue) ?? 'backlog';
    if (issue.state === 'closed') desiredStatus = 'done';
    else if (explicitBlock) desiredStatus = 'blocked';
    else if (issueStatus(issue) === 'done') desiredStatus = 'backlog';
    else if (executions.some(e => e.active)) desiredStatus = executions.some(e => e.ambiguous) ? 'blocked' : executions.some(e => e.runtime?.phase === 'awaiting-approval') ? 'awaiting-approval' : 'running';
    else if (hasClosingMerge) desiredStatus = 'done';
    else if (blockReason) desiredStatus = 'blocked';
    else if (reworkable) desiredStatus = 'failed';
    else if (latest?.result) desiredStatus = ({ success: 'awaiting-pr', failed: 'failed', cancelled: 'failed', blocked: 'blocked', needs_approval: 'awaiting-approval' } as const)[latest.result.status];
    else if (hasOpenPR) desiredStatus = 'awaiting-pr';
    // A runnable task rests in ready. Where ready is a person's grant, the Manager leaves the label to that
    // person: the task rests in backlog until the grant is there, and a grant that is present always wins.
    else if (snapshot.readyIsGrant) { if (['backlog', 'ready', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = issue.labels.includes('harness:ready') ? 'ready' : 'backlog'; }
    else if (['backlog', 'blocked', 'awaiting-pr'].includes(desiredStatus)) desiredStatus = 'ready';
    return { issue, version, status: issueStatus(issue) ?? 'backlog', desiredStatus, events, executions, latest,
      blocked: !!blockReason, blockReason, automaticBlockCause: reworkable && automaticBlockCause === 'worker' ? undefined : automaticBlockCause, hasOpenPR, hasClosingMerge, criteria, reworkable };
  });
}
