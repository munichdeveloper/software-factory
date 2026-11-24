import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import { planningCode, type Planner } from '../llm/provider.js';
import { actionSchema, planSchema, riskSplitKeyPrefix, riskSplitPartMarker, type Action, type Snapshot } from '../types.js';
import { actionId, executionId, hash, taskVersion } from '../state/identity.js';
import { decodeEvent, type HarnessEvent } from '../state/events.js';
import { admissionRejectedSummary, clearableRefusals, rescueMarker, infrastructureFailureCode, reconstruct, type Task } from '../state/reconstruct.js';
import { lastBlockLabelEventId } from '../state/blocks.js';
import { managedLabel, priorityLabels, withStatus } from '../state/lifecycle.js';
import { evaluate, policyVersion, type Budget } from '../policies/engine.js';
import { workerInputSchema, type WorkerInput } from '../workers/contract.js';
import { escalationMarker, retryMarker, reviewEntries, reworkMarker } from '../runtime/coding-context.js';
import { untrustedEdit, untrustedEditReason } from '../state/content-trust.js';
import { reconciliationPlan } from './plan.js';
import type { RunReport } from './report.js';
import { deliverNotifications, type GrantWait, type NotificationSink } from '../notifications/slack.js';
import { statusMarker, statusView } from './status.js';
import { admissionCode, RuntimeAdmissionRejected, type WorkerRuntimePort } from '../runtime/contract.js';

export interface ManagerOptions { correlationId: string; now?: () => Date; notifications?: NotificationSink; workerRuntime?: WorkerRuntimePort;
  /**
   * Told once per run, after the decisions of the observed state are made and before any action runs: the snapshot and
   * the issues whose worker start the policy allows. A failure here never affects the run.
   */
  planned?: (snapshot: Snapshot, starts: number[]) => void | Promise<void> }
/**
 * A planner proposal keeps only the fields of its own operation. The model often fills `status` on a start_worker;
 * the policy denies any action with foreign fields, so the proposal was lost although its intent was clear.
 */
export function ownFields(action: Action): Action {
  return { ...action, status: action.kind === 'transition' ? action.status : null, priority: action.kind === 'prioritize' ? action.priority : null,
    followup: action.kind === 'create_followup' ? action.followup : null, attempt: ['start_worker', 'retry_worker'].includes(action.kind) ? action.attempt : null };
}
export class Manager {
  private now: () => Date;
  /** Definite runtime admission rejections of the current run; reported as blockers, never as uncertain dispatches. */
  private rejections: { issueNumber: number; code: string; recorded: boolean }[] = [];
  /** Open tasks whose status comment of this run says they wait for nothing but a person's grant. */
  private grantWaits: GrantWait[] = [];
  /** What this run saw before it acted. */
  private observed?: Snapshot;
  /** The repository state the last run reconciled, for work that follows it (the broker's merge pass). */
  get lastSnapshot(): Snapshot | undefined { return this.observed; }
  /** The state after the last run acted, as its status comments describe it; the observed state where it took no second look. */
  private settled?: Snapshot;
  get settledSnapshot(): Snapshot | undefined { return this.settled ?? this.observed; }
  /** Definite admission refusals of the last run, by issue: their codes. */
  get lastRejections(): ReadonlyMap<number, string> { return new Map(this.rejections.map(r => [r.issueNumber, r.code])); }
  /**
   * Startable tasks the last run did not start, with the fixed reason (software-factory#313): the task is open, unblocked,
   * has not run in its current version, carries its grant and a worker slot is free, yet no start happened. A refusal of the
   * runtime is not repeated here (it has its own report); everything else that kept the task back is, so it is never silent.
   */
  private holds = new Map<number, string>();
  get lastHolds(): ReadonlyMap<number, string> { return new Map(this.holds); }
  /** Refusals of the runtime's preflight in the last run: before any intent, so the journal does not know them. */
  get lastPreflightRefusals(): ReadonlyMap<number, string> { return new Map(this.rejections.filter(r => !r.recorded).map(r => [r.issueNumber, r.code])); }
  private async snapshot(): Promise<Snapshot> {
    const snapshot = await this.github.snapshot(this.config.execution.engine === 'temporal' ? null : this.config.manager.workflow);
    if (this.config.execution.engine === 'temporal') {
      if (!this.options.workerRuntime) throw new Error('Temporal runtime is required; legacy dispatch is forbidden');
      const ids = [...new Set([...snapshot.comments.values()].flatMap(comments => comments.flatMap(comment => {
        const event = decodeEvent(comment, this.config.manager.trustedActors);
        return event?.data.type === 'intent' ? [event.data.input.executionId] : [];
      })))];
      snapshot.runtimeExecutions = await this.options.workerRuntime.observations(ids);
      snapshot.readyIsGrant = !!this.options.workerRuntime.readyIsGrant && this.config.autonomy.startGrant === 'ready-label';
      // A refusal waits for its backoff; one whose cause is provably gone (a release skew, an unknown worker deployment)
      // is lifted at once. Asked only for codes some journal holds, at most once per code.
      const codes = new Set([...snapshot.comments.values()].flatMap(comments => comments.flatMap(comment => {
        const event = decodeEvent(comment, this.config.manager.trustedActors);
        return event?.data.type === 'admission_rejected' && clearableRefusals.includes(event.data.code) ? [event.data.code] : [];
      })));
      const runtime = this.options.workerRuntime;
      if (codes.size && runtime.refusalCleared) {
        snapshot.clearedRefusals = [];
        for (const code of codes) {
          try { if (await runtime.refusalCleared(code)) snapshot.clearedRefusals.push(code); } catch { /* the backoff still applies */ }
        }
      }
    }
    return snapshot;
  }
  constructor(private github: GitHubPort, private config: Config, private planner: Planner, private options: ManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }
  private async hasApproval(issue: number, id: string): Promise<boolean> {
    let approved = false;
    for (const comment of await this.github.comments(issue)) {
      const match = comment.body.trim().match(/^\/harness (approve|revoke) ([a-f0-9]{64})$/);
      if (match?.[2] === id && await this.github.canApprove(comment.author)) approved = match[1] === 'approve';
    }
    return approved;
  }
  private async event(issue: number, key: string, data: HarnessEvent['data']): Promise<void> {
    const comments = await this.github.comments(issue);
    if (comments.some(c => decodeEvent(c, this.config.manager.trustedActors)?.key === key)) return;
    await this.github.writeEvent(issue, { version: 1, key, at: this.now().toISOString(), correlationId: this.options.correlationId, data });
  }
  /**
   * Presents a durable intent to the runtime. The call is idempotent per execution ID: an existing run is
   * returned, never duplicated. A definite rejection closes the intent with a cancelled result so it is
   * not later mistaken for a dispatch whose outcome is unknown. Any other failure propagates.
   */
  private async admit(input: WorkerInput, intentActionId: string) {
    const id = input.executionId;
    let receipt;
    try { receipt = await this.options.workerRuntime!.start({ input, actionId: intentActionId, policyHash: policyVersion(this.config) }); }
    catch (error) {
      if (!(error instanceof RuntimeAdmissionRejected)) throw error;
      await this.event(input.issueNumber, `result:${id}`, { type: 'result', result: { contractVersion: '1.0', executionId: id, issueNumber: input.issueNumber,
        status: 'cancelled', summary: `${admissionRejectedSummary}: ${error.code}`, artifacts: [], error: error.code, proposedActions: [] } });
      // The policy it was refused under: a changed policy or configuration admits the next start without waiting.
      if (/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)) await this.event(input.issueNumber, `admission-rejected:${id}`, { type: 'admission_rejected', executionId: id, code: error.code, policyHash: policyVersion(this.config) });
      this.rejections.push({ issueNumber: input.issueNumber, code: error.code, recorded: true }); return null;
    }
    await this.event(input.issueNumber, `temporal-receipt:${id}`, { type: 'temporal_receipt', executionId: id,
      workflowId: receipt.workflowId, runId: receipt.runId, binding: receipt.binding });
    return receipt;
  }
  /**
   * An intent the runtime has no record of (the start was refused, failed or never reached it) is presented
   * again with its original execution ID. It either starts, or is closed with the runtime's definite reason.
   */
  private async recover(tasks: Task[], report: RunReport): Promise<boolean> {
    if (this.config.execution.engine !== 'temporal' || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return false;
    let changed = false;
    // Closed tasks are included: their unresolved intent would otherwise occupy a worker slot forever.
    // The runtime never admits a closed task, so presenting it can only close the intent.
    for (const task of tasks) {
      for (const execution of task.executions.filter(e => !e.runtime && !e.run && !e.result)) {
        try { await this.admit(execution.input, execution.actionId); changed = true; }
        catch (error) {
          const code = admissionCode(error);
          report.errors.push(`Recovery of execution ${execution.input.executionId} on #${task.issue.number} failed${code ? ` (${code})` : ''}; the intent remains unresolved`);
        }
      }
    }
    return changed;
  }
  /**
   * A task whose text someone without write access changed after its approval is no longer approved work. The Manager
   * removes `harness:managed` (and a `harness:ready` grant) so the issue leaves the Factory until a maintainer has read
   * the new text and applies the label again. The policy denies such a task regardless, also where nothing is removed.
   */
  private async withdrawEdited(tasks: Task[], report: RunReport): Promise<boolean> {
    let changed = false;
    for (const task of tasks.filter(t => t.issue.state === 'open')) {
      const edit = untrustedEdit(task.issue);
      if (!edit) continue;
      const reason = untrustedEditReason(edit);
      report.blockers.push(`#${task.issue.number}: ${reason}`);
      report.nextSteps.push(`#${task.issue.number}: review the changed text, then apply ${managedLabel} again to approve it`);
      if (this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') continue;
      await this.github.updateIssue(task.issue.number, { labels: task.issue.labels.filter(l => l !== managedLabel && l !== 'harness:ready') });
      await this.github.writeComment?.(task.issue.number, `**Software Factory: approval withdrawn.** ${reason} (${edit.at}). ` +
        `The Factory no longer works on this issue. A maintainer reviews the current title and description and applies \`${managedLabel}\` again to approve them.`);
      changed = true;
    }
    return changed;
  }
  /** Keeps the one readable status comment of each managed task current. Never fails a reconciliation. */
  private async publishStatus(report: RunReport): Promise<void> {
    if (!this.github.writeComment || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return;
    let snapshot: Snapshot;
    // Without a current view (GitHub or the runtime unavailable) there is nothing reliable to say; the run already reports that.
    // A run that changed nothing saw the state the comments describe; only a run that acted needs a second look.
    const unchanged = this.observed && !report.decisions.some(d => d.executed) && !this.rejections.length;
    try { snapshot = unchanged ? this.observed! : await this.snapshot(); } catch { return; }
    this.settled = snapshot;
    try {
      for (const task of reconstruct(snapshot, this.config, this.now())) {
        const existing = (snapshot.comments.get(task.issue.number) ?? []).filter(c => c.body.startsWith(statusMarker) && this.config.manager.trustedActors.includes(c.author));
        // A closed task that never had a status comment does not get one after the fact.
        if (task.issue.state === 'closed' && !existing.length) continue;
        const { body, awaitsGrant } = statusView(task, this.config, { repository: this.github.repository, readyIsGrant: !!snapshot.readyIsGrant,
          rejection: this.rejections.find(r => r.issueNumber === task.issue.number)?.code, hold: this.holds.get(task.issue.number),
          queued: report.decisions.some(d => d.action.issueNumber === task.issue.number && d.decision.reason === 'Maximum parallel workers reached') });
        if (awaitsGrant && task.issue.state === 'open') this.grantWaits.push({ number: task.issue.number, title: task.issue.title,
          after: task.latest?.input.executionId });
        if (existing[0]?.body !== body) await this.github.writeComment(task.issue.number, body, existing[0]?.id);
      }
    } catch { report.errors.push('Status comments could not be updated; the lifecycle itself is unaffected'); }
  }
  /**
   * `refused` closes an `allow` the runtime turned down before any intent existed; its reason is the runtime's fixed
   * code and its key names the code, so each action and code is journaled once, not on every reconciliation (#128).
   * A start's `allow` and `refused` also name the grant they were decided under (software-factory#313): the action ID
   * leaves the planner's reason out, so after a refusal every later start of the same task version had the same key,
   * and a person's new grant that the runtime refused again left no trace on the issue.
   */
  private async audit(action: Action, outcome: 'allow' | 'deny' | 'approval' | 'executed' | 'refused', reason: string, grant?: string): Promise<void> {
    if (!this.config.reporting.persistDecisions || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return;
    const id = actionId(action, policyVersion(this.config));
    const granted = grant && ['allow', 'refused'].includes(outcome) && ['start_worker', 'retry_worker'].includes(action.kind) ? `:grant-${grant}` : '';
    await this.event(action.issueNumber, `decision:${id}:${outcome}${outcome === 'refused' ? `:${reason}` : ''}${granted}`, { type: 'decision', action: JSON.stringify(action), outcome, reason });
  }
  /** The grant a start is decided under, as digits of its time: the person's `harness:ready`, else `harness:managed`. */
  private grantMark(task: Task, snapshot: Snapshot): string | undefined {
    const at = snapshot.readyIsGrant ? task.issue.readyAt : task.issue.managedAt;
    return at?.replace(/\D/g, '').slice(0, 17) || undefined;
  }
  private async execute(action: Action, task: Task, snapshot: Snapshot): Promise<boolean> {
    const live = await this.github.getIssue(task.issue.number);
    if (taskVersion(live) !== action.taskVersion || !live.labels.includes(managedLabel)) throw new Error('Task changed during execution; deferred to next run');
    if (live.labels.includes('harness:blocked') && (!task.issue.labels.includes('harness:blocked') ||
      lastBlockLabelEventId(live) !== lastBlockLabelEventId(task.issue))) throw new Error('Block changed during execution; deferred to next run');
    switch (action.kind) {
      case 'transition': {
        let journaled = false;
        for (const execution of task.executions) {
          if (execution.result && !task.events.some(e => e.data.type === 'result' && e.data.result.executionId === execution.input.executionId)) {
            await this.event(live.number, `result:${execution.input.executionId}`, { type: 'result', result: execution.result });
            journaled = true;
          }
        }
        // Where the label is a person's grant, the Factory never applies it itself (software-factory#109).
        if (action.status === 'ready' && snapshot.readyIsGrant && !live.labels.includes('harness:ready')) return journaled;
        const labels = withStatus(live, action.status!);
        if ([...live.labels].sort().join('\0') === [...labels].sort().join('\0')) return journaled;
        if (action.status === 'blocked' && !live.labels.includes('harness:blocked')) {
          const floor = lastBlockLabelEventId(live);
          const id = hash({ actionId: actionId(action, policyVersion(this.config)), floor });
          // Mandatory recovery state, separate from optional decision/audit logging.
          // Persist before labeling so a crash after the API update remains recoverable.
          await this.event(live.number, `block:${id}`, { type: 'block_intent', taskVersion: task.version,
            cause: task.automaticBlockCause ?? 'planner', afterLabelEventId: floor });
        }
        await this.github.updateIssue(live.number, { labels }); return true;
      }
      case 'close_issue':
        await this.github.updateIssue(live.number, { state: 'closed', labels: withStatus(live, 'done') }); return true;
      case 'approve_task': {
        // Where the label is a person's grant, no planner or Manager action may stand in for it.
        if (snapshot.readyIsGrant) return false;
        const labels = withStatus(live, 'ready');
        if ([...live.labels].sort().join('\0') === [...labels].sort().join('\0')) return false;
        await this.github.updateIssue(live.number, { labels }); return true;
      }
      case 'prioritize': {
        const label = `harness:priority-${action.priority}`;
        if (live.labels.includes(label) && live.labels.filter(l => priorityLabels.includes(l)).length === 1) return false;
        await this.github.updateIssue(live.number, { labels: [...live.labels.filter(l => !priorityLabels.includes(l)), label] }); return true;
      }
      case 'create_followup': {
        const f = action.followup!;
        const key = hash({ repository: this.github.repository.toLowerCase(), key: f.key });
        const marker = `<!-- harness:followup:${key} -->`;
        if (snapshot.issues.some(i => i.body.includes(marker))) return false;
        await this.event(live.number, `issue-creation:${key}:${actionId(action, policyVersion(this.config))}`, { type: 'issue_creation_intent', followupKey: key,
          actionId: actionId(action, policyVersion(this.config)) });
        const body = `${f.context}\n\n## Goal\n${f.goal}\n\n## Acceptance criteria\n${f.acceptanceCriteria.map(c => `- ${c}`).join('\n')}\n\nDepends on: ${f.dependencies.map(n => `#${n}`).join(', ') || 'none'}\n\nOrigin: #${task.issue.number}\nDecision: ${actionId(action, policyVersion(this.config))}\n\n${marker}`;
        // Under the ready-label grant the parts of a risk split start like their origin did: the Factory labels them ready
        // and the runtime admits them only on the origin's grant by a person (SF #210, Johannes 2026-11-21).
        const inherits = !!snapshot.readyIsGrant && f.key.startsWith(riskSplitKeyPrefix) && f.context.includes(riskSplitPartMarker);
        await this.github.createIssue(f.title, body, [managedLabel, inherits ? 'harness:ready' : 'harness:backlog']); return true;
      }
      case 'start_worker':
      case 'retry_worker': {
        const attempt = action.attempt!;
        const id = executionId(this.github.repository, live, attempt);
        // A rework names the attempt it continues, so the runtime can hand its changes and validation outcome to the worker.
        const rework = action.kind === 'retry_worker' && task.reworkable && this.config.execution.engine === 'temporal';
        // A retry after a failed run names it too, so the grant that admitted it carries over (software-factory#93).
        const retry = action.kind === 'retry_worker' && !rework && task.latest?.result?.status === 'failed' && this.config.execution.engine === 'temporal';
        const previous = rework ? (task.reworkFrom ?? task.latest)!.input.executionId : retry ? task.latest!.input.executionId : undefined;
        // Escalate to workers.coding.retryAgents only when an earlier attempt failed for a reason the agent owns: a
        // rework, or a failed, blocked or cancelled result other than a runner failure before the agent started.
        // A conflict with the base is mechanical work and stays on the first-attempt agents (Johannes, 2026-11-19).
        // The rescue attempt (issue #188 step 7) always runs on retryAgents and says so in its context.
        const rescue = !!previous && !!task.rescueDue;
        const escalate = !!previous && !!this.config.workers.coding && !!this.config.workers.coding.retryAgents && (rescue || rework && task.reworkCause !== 'conflict' ||
          task.executions.some(e => e.input.taskVersion === task.version && !e.rejected && !!e.result && e.result.status !== 'success' &&
            e.result.error !== infrastructureFailureCode));
        // A missing grant is known before anything durable exists: do not leave an intent that can never start.
        if (this.config.execution.engine === 'temporal' && this.options.workerRuntime?.preflight) {
          try { await this.options.workerRuntime.preflight(live.number, previous); }
          catch (error) {
            if (!(error instanceof RuntimeAdmissionRejected)) throw error;
            this.rejections.push({ issueNumber: live.number, code: error.code, recorded: false }); return false;
          }
        }
        // Intent first. If dispatch or subsequent writes fail, a future run observes this intent AND actual runs.
        const input = workerInputSchema.parse({ contractVersion: '1.0', repository: this.github.repository,
          issueNumber: live.number, taskVersion: action.taskVersion, description: live.body, acceptanceCriteria: task.criteria,
          contextReferences: [`https://github.com/${this.github.repository}/issues/${live.number}`, ...(previous ? [rework ? reworkMarker(previous) : retryMarker(previous)] : []), ...(escalate ? [escalationMarker] : []), ...(rescue ? [rescueMarker] : []),
            // A rework after a merge review hands the worker what the review asked to change.
            ...(rework && task.reworkReview ? reviewEntries(task.reworkReview) : [])], executionId: id,
          allowedActions: ['publish_result'], limits: { timeoutMinutes: this.config.execution.workerTimeoutMinutes, maxOutputBytes: 16000 },
          operation: this.config.workers.test.operation,
          worker: this.config.workers.coding && this.config.workers.coding.enabled ? 'codex' : 'test' });
        await this.event(live.number, `intent:${id}`, { type: 'intent', input, actionId: actionId(action, policyVersion(this.config)), attempt });
        if (this.config.execution.engine === 'temporal') {
          if (!this.options.workerRuntime) throw new Error('Temporal runtime is required; legacy dispatch is forbidden');
          const receipt = await this.admit(input, actionId(action, policyVersion(this.config)));
          if (!receipt) return false;
          const fresh = await this.github.getIssue(live.number);
          if (taskVersion(fresh) === action.taskVersion && fresh.state === 'open' && !fresh.labels.includes('harness:blocked')) {
            await this.github.updateIssue(live.number, { labels: withStatus(fresh, receipt.phase === 'awaiting-approval' ? 'awaiting-approval' : 'running') });
          }
          return true;
        }
        // Recheck actual workflow state immediately before dispatch; never retry the dispatch call itself.
        const existing = (await this.github.runs(this.config.manager.workflow)).find(r => r.title === `Factory worker ${id}`);
        if (!existing) await this.github.dispatch(this.config.manager.workflow, snapshot.defaultBranch, id, live.number);
        const run = existing ?? (await this.github.runs(this.config.manager.workflow)).find(r => r.title === `Factory worker ${id}`);
        if (run) await this.event(live.number, `receipt:${id}`, { type: 'receipt', executionId: id, runId: run.id });
        const fresh = await this.github.getIssue(live.number);
        if (taskVersion(fresh) === action.taskVersion && fresh.state === 'open' && !fresh.labels.includes('harness:blocked')) await this.github.updateIssue(live.number, { labels: withStatus(fresh, 'running') });
        return true;
      }
      case 'cancel_worker': {
        for (const execution of task.executions.filter(e => (e.timedOut || e.orphaned) && e.runtime)) {
          if (!this.options.workerRuntime) throw new Error('Temporal cancellation requires the runtime');
          await this.options.workerRuntime.cancel(execution.input.executionId);
        }
        const runs = await this.github.runs(this.config.manager.workflow);
        for (const e of task.executions.filter(e => e.timedOut && e.run)) {
          if (runs.some(r => r.id === e.run!.id && r.status !== 'completed')) await this.github.cancelRun(e.run!.id);
        }
        return true;
      }
      default: throw new Error(`Unsupported action: ${action.kind}`);
    }
  }
  /**
   * Why each startable task did not start in this run (software-factory#313). Before, only an executed or refused start
   * left a trace: a planner that did not propose the task, a failed planning call, a denied or failed start and a run that
   * stopped early were silent, and the decision journal writes each action once, so a ready task could wait for hours with
   * nothing on the issue, in the queue or in Slack. Tasks that wait for a slot, a grant, a refusal's backoff or anything
   * the status comment already names are not holds.
   */
  private heldStarts(tasks: Task[], snapshot: Snapshot, proposals: Action[],
    run: { outcomes: ReadonlyMap<number, string>; started: ReadonlySet<number>; planningFailure?: string; aborted: boolean }): Map<number, string> {
    const holds = new Map<number, string>();
    if (this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return holds;
    const busy = tasks.filter(t => t.executions.some(e => e.active) || run.started.has(t.issue.number)).length;
    if (busy >= this.config.execution.maxParallelWorkers) return holds;
    const refused = new Set(this.rejections.map(r => r.issueNumber));
    for (const t of tasks) {
      const n = t.issue.number;
      if (run.started.has(n) || refused.has(n) || !startable(t, !!snapshot.readyIsGrant)) continue;
      const proposed = proposals.filter(a => a.issueNumber === n);
      const code = run.outcomes.get(n)
        ?? (proposed.some(a => a.kind === 'transition' && a.status === 'blocked') ? 'PLANNER_HELD'
        : proposed.some(a => ['start_worker', 'retry_worker'].includes(a.kind)) ? (run.aborted ? 'RECONCILIATION_ABORTED' : 'START_NOT_EXECUTED')
        : run.planningFailure ? `PLANNING_${run.planningFailure}`.slice(0, 64) : run.aborted ? 'RECONCILIATION_ABORTED' : 'PLANNER_NOT_PROPOSED');
      if (code !== 'WAITS_FOR_SLOT') holds.set(n, code);
    }
    return holds;
  }
  async run(): Promise<RunReport> {
    const began = this.now();
    this.rejections = []; this.grantWaits = []; this.settled = undefined; this.holds = new Map();
    const report: RunReport = { correlationId: this.options.correlationId, startedAt: began.toISOString(), durationMs: 0,
      outcome: 'success', tasks: 0, decisions: [], errors: [], blockers: [], nextSteps: [] };
    if (!this.config.factory.enabled) { report.outcome = 'disabled'; return report; }
    let snapshot = await this.snapshot();
    let tasks = reconstruct(snapshot, this.config, this.now());
    if (await this.recover(tasks, report)) { snapshot = await this.snapshot(); tasks = reconstruct(snapshot, this.config, this.now()); }
    if (await this.withdrawEdited(tasks, report)) { snapshot = await this.snapshot(); tasks = reconstruct(snapshot, this.config, this.now()); }
    this.observed = snapshot;
    report.tasks = tasks.length;
    for (const t of tasks) {
      if (t.blockReason) {
        report.blockers.push(`#${t.issue.number}: ${t.blockReason}`);
        report.nextSteps.push(`#${t.issue.number}: ${t.blockReason}; resolve this block and run the manager again`);
      }
      if (t.executions.some(e => e.ambiguous)) {
        report.blockers.push(`#${t.issue.number}: dispatch outcome uncertain; inspect workflow runs and resolve explicitly`);
        report.nextSteps.push(`#${t.issue.number}: inspect actual Actions runs before manually resolving the original execution`);
      }
      if (t.issue.state === 'open' && t.latest?.result && ['blocked', 'needs_approval'].includes(t.latest.result.status)) report.blockers.push(`#${t.issue.number}: worker reports ${t.latest.result.status}; revise task or provide missing input`);
      if (t.issue.state === 'open' && t.latest?.result && ['failed', 'cancelled'].includes(t.latest.result.status) && t.attemptsUsed >= t.attemptLimit) report.blockers.push(`#${t.issue.number}: retry budget exhausted`);
    }
    const entries: { action: Action; source: 'reconcile' | 'planner' | 'worker' }[] = reconciliationPlan(tasks).map(action => ({ action, source: 'reconcile' }));
    const eligible = tasks.filter(t => t.issue.state === 'open' && !t.blocked && !t.hasClosingMerge && !t.executions.some(e => e.active));
    // What kept a startable task back in this run, by issue (software-factory#313); see heldStarts.
    const outcomes = new Map<number, string>(), started = new Set<number>();
    let planningFailure: string | undefined, aborted = false;
    if (eligible.length && this.config.llm.maxCalls > 0) {
      try { entries.push(...planSchema.parse(await this.planner.plan(eligible, this.config)).actions.map(action => ({ action: ownFields(action), source: 'planner' as const }))); }
      catch (error) {
        planningFailure = planningCode(error);
        report.errors.push(`LLM planning failed (${planningFailure}); deterministic reconciliation remains available (no unvalidated actions executed)`);
      }
    }
    for (const t of tasks) {
      if (t.latest?.result) entries.push(...t.latest.result.proposedActions.map(action => ({ action, source: 'worker' as const })));
    }
    const budget: Budget = { actions: 0, newIssues: 0, activeWorkers: tasks.reduce((n, t) => n + t.executions.filter(e => e.active).length, 0) };
    if (this.options.planned) {
      try {
        // A preview on the observed state: the policy decides again per action once it is executed.
        const preview: Budget = { ...budget }, starts: number[] = [];
        for (const entry of entries) {
          const parsed = actionSchema.safeParse(entry.action);
          if (!parsed.success || !['start_worker', 'retry_worker'].includes(parsed.data.kind) || this.config.execution.dryRun) continue;
          const action = parsed.data, task = tasks.find(t => t.issue.number === action.issueNumber);
          if (!task || starts.includes(action.issueNumber)) continue;
          const decision = evaluate(action, { config: this.config, task, budget: preview, source: entry.source, readyIsGrant: !!snapshot.readyIsGrant, approved: false });
          if (decision.outcome === 'allow') { starts.push(action.issueNumber); preview.actions++; preview.activeWorkers++; }
        }
        await this.options.planned(snapshot, starts);
      } catch { /* the view must not fail a reconciliation */ }
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = actionSchema.safeParse(entry.action);
      if (!parsed.success) { report.errors.push('Rejected malformed action proposal'); continue; }
      const action = parsed.data;
      const id = actionId(action, policyVersion(this.config));
      if (seen.has(id)) continue;
      seen.add(id);
      const starting = ['start_worker', 'retry_worker'].includes(action.kind);
      if (this.now().getTime() - began.getTime() > this.config.manager.timeoutMinutes * 60000) { report.errors.push('Manager time budget exhausted'); aborted = true; break; }
      try {
        // Refresh every proposal: concurrent human changes, dependency closure and new PRs invalidate stale facts.
        snapshot = await this.snapshot();
        tasks = reconstruct(snapshot, this.config, this.now());
        const task = tasks.find(t => t.issue.number === action.issueNumber);
        if (!task) { report.errors.push(`Proposal references unmanaged issue #${action.issueNumber}`); continue; }
        budget.activeWorkers = tasks.reduce((n, t) => n + t.executions.filter(e => e.active).length, 0);
        const decision = evaluate(action, { config: this.config, task, budget, source: entry.source, readyIsGrant: !!snapshot.readyIsGrant,
          approved: await this.hasApproval(action.issueNumber, id) });
        const record = { action, decision, executed: false };
        report.decisions.push(record);
        const grant = this.grantMark(task, snapshot);
        await this.audit(action, decision.outcome, decision.reason, grant);
        if (starting && decision.outcome !== 'allow') outcomes.set(action.issueNumber, deniedCode(decision.reason));
        if (decision.outcome === 'approval') report.nextSteps.push(`Approve #${action.issueNumber} by commenting: /harness approve ${id}`);
        if (decision.outcome !== 'allow' || this.config.execution.dryRun) continue;
        const rejectionsBefore = this.rejections.length;
        if (starting) outcomes.set(action.issueNumber, 'START_NOT_EXECUTED');
        record.executed = await this.execute(action, task, snapshot);
        const refused = this.rejections.slice(rejectionsBefore).find(r => !r.recorded && r.issueNumber === action.issueNumber);
        if (refused && /^[A-Z][A-Z0-9_]{0,79}$/.test(refused.code)) await this.audit(action, 'refused', refused.code, grant);
        if (starting && record.executed) { started.add(action.issueNumber); outcomes.delete(action.issueNumber); }
        if (record.executed) {
          budget.actions++;
          if (action.kind === 'create_followup') { budget.newIssues++; (budget.followupOrigins ??= []).push(action.issueNumber); }
          await this.audit(action, 'executed', 'Action executed successfully');
        }
      } catch (error) {
        const status = error instanceof Error && 'status' in error ? String(error.status) : 'unknown';
        // Only fixed policy codes are disclosed; external API or database messages never reach the report.
        const code = admissionCode(error);
        report.errors.push(`Action ${action.kind} on #${action.issueNumber} failed (HTTP ${status}${code ? `, ${code}` : ''}); durable intents preserved for recovery`);
        if (starting) outcomes.set(action.issueNumber, error instanceof Error && /^(Task|Block) changed during execution/.test(error.message) ? 'TASK_CHANGED_DURING_START' : 'START_FAILED');
        // Fail closed for the rest of this run: a mutation may have succeeded before an API error.
        aborted = true;
        break;
      }
    }
    this.holds = this.heldStarts(tasks, snapshot, entries.map(e => e.action), { outcomes, started, planningFailure, aborted });
    for (const [n, code] of this.holds) report.blockers.push(`#${n}: startable but not started (${code})`);
    await this.publishStatus(report);
    for (const r of this.rejections) {
      report.blockers.push(`#${r.issueNumber}: runtime admission rejected (${r.code}); ${r.recorded ? 'the execution was closed as cancelled' : 'no execution was created'}`);
      report.nextSteps.push(r.code.startsWith('READY_')
        ? `#${r.issueNumber}: an authorized human must apply harness:ready, then run the manager again`
        : `#${r.issueNumber}: resolve ${r.code} in the runtime registry or task, then run the manager again`);
    }
    if (this.config.notifications.slack.enabled && !this.config.execution.dryRun && this.config.autonomy.profile !== 'advisory') {
      try { report.errors.push(...await deliverNotifications(this.github, this.config,
        await this.github.snapshot(this.config.manager.workflow), this.options.notifications, this.options.correlationId, this.now(), this.grantWaits)); }
      catch { report.errors.push('Slack notification reconciliation failed; repository actions remain committed'); }
    }
    if (report.errors.length) report.outcome = 'partial';
    report.durationMs = this.now().getTime() - began.getTime();
    return report;
  }
}

/** A first start the Factory would make now: open, unblocked, not run in this version, nothing pending, grant present. */
function startable(t: Task, readyIsGrant: boolean): boolean {
  return t.issue.state === 'open' && !t.blocked && !t.latest && !t.hasOpenPR && !t.hasClosingMerge && !t.executions.some(e => e.active) &&
    !t.refusal?.waiting && t.issue.labels.includes(managedLabel) && (!readyIsGrant || t.issue.labels.includes('harness:ready'));
}
/** The fixed code of a start the policy did not allow; a full slot is a normal wait, not a hold. */
function deniedCode(reason: string): string {
  if (reason === 'Maximum parallel workers reached') return 'WAITS_FOR_SLOT';
  if (reason === 'Maximum actions per run reached') return 'ACTION_LIMIT_REACHED';
  if (reason === 'Task changed since proposal or approval' || reason.startsWith('Initial execution must use') || reason.startsWith('Retry proposal is not bound')) return 'STALE_PROPOSAL';
  if (reason.startsWith('Maintainer approval required')) return 'APPROVAL_REQUIRED';
  return 'POLICY_DENIED';
}
