import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import type { Planner } from '../llm/provider.js';
import { actionSchema, planSchema, type Action, type Snapshot } from '../types.js';
import { actionId, executionId, hash, taskVersion } from '../state/identity.js';
import { decodeEvent, type HarnessEvent } from '../state/events.js';
import { reconstruct, type Task } from '../state/reconstruct.js';
import { lastBlockLabelEventId } from '../state/blocks.js';
import { managedLabel, priorityLabels, withStatus } from '../state/lifecycle.js';
import { evaluate, policyVersion, type Budget } from '../policies/engine.js';
import { workerInputSchema, type WorkerInput } from '../workers/contract.js';
import { reconciliationPlan } from './plan.js';
import type { RunReport } from './report.js';
import { deliverNotifications, type NotificationSink } from '../notifications/slack.js';
import { statusComment, statusMarker } from './status.js';
import { admissionCode, RuntimeAdmissionRejected, type WorkerRuntimePort } from '../runtime/contract.js';

export interface ManagerOptions { correlationId: string; now?: () => Date; notifications?: NotificationSink; workerRuntime?: WorkerRuntimePort }
export class Manager {
  private now: () => Date;
  /** Definite runtime admission rejections of the current run; reported as blockers, never as uncertain dispatches. */
  private rejections: { issueNumber: number; code: string; recorded: boolean }[] = [];
  private async snapshot(): Promise<Snapshot> {
    const snapshot = await this.github.snapshot(this.config.execution.engine === 'temporal' ? null : this.config.manager.workflow);
    if (this.config.execution.engine === 'temporal') {
      if (!this.options.workerRuntime) throw new Error('Temporal runtime is required; legacy dispatch is forbidden');
      const ids = [...new Set([...snapshot.comments.values()].flatMap(comments => comments.flatMap(comment => {
        const event = decodeEvent(comment, this.config.manager.trustedActors);
        return event?.data.type === 'intent' ? [event.data.input.executionId] : [];
      })))];
      snapshot.runtimeExecutions = await this.options.workerRuntime.observations(ids);
      snapshot.readyIsGrant = !!this.options.workerRuntime.readyIsGrant;
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
        status: 'cancelled', summary: `Runtime admission rejected before start: ${error.code}`, artifacts: [], error: error.code, proposedActions: [] } });
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
  /** Keeps the one readable status comment of each managed task current. Never fails a reconciliation. */
  private async publishStatus(report: RunReport): Promise<void> {
    if (!this.github.writeComment || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return;
    let snapshot: Snapshot;
    // Without a current view (GitHub or the runtime unavailable) there is nothing reliable to say; the run already reports that.
    try { snapshot = await this.snapshot(); } catch { return; }
    try {
      for (const task of reconstruct(snapshot, this.config, this.now())) {
        const existing = (snapshot.comments.get(task.issue.number) ?? []).filter(c => c.body.startsWith(statusMarker) && this.config.manager.trustedActors.includes(c.author));
        // A closed task that never had a status comment does not get one after the fact.
        if (task.issue.state === 'closed' && !existing.length) continue;
        const body = statusComment(task, this.config, { repository: this.github.repository, readyIsGrant: !!snapshot.readyIsGrant,
          rejection: this.rejections.find(r => r.issueNumber === task.issue.number)?.code,
          queued: report.decisions.some(d => d.action.issueNumber === task.issue.number && d.decision.reason === 'Maximum parallel workers reached') });
        if (existing[0]?.body !== body) await this.github.writeComment(task.issue.number, body, existing[0]?.id);
      }
    } catch { report.errors.push('Status comments could not be updated; the lifecycle itself is unaffected'); }
  }
  private async audit(action: Action, outcome: 'allow' | 'deny' | 'approval' | 'executed', reason: string): Promise<void> {
    if (!this.config.reporting.persistDecisions || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return;
    const id = actionId(action, policyVersion(this.config));
    await this.event(action.issueNumber, `decision:${id}:${outcome}`, { type: 'decision', action: JSON.stringify(action), outcome, reason });
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
        await this.github.createIssue(f.title, body, [managedLabel, 'harness:backlog']); return true;
      }
      case 'start_worker':
      case 'retry_worker': {
        const attempt = action.attempt!;
        const id = executionId(this.github.repository, live, attempt);
        // A missing grant is known before anything durable exists: do not leave an intent that can never start.
        if (this.config.execution.engine === 'temporal' && this.options.workerRuntime?.preflight) {
          try { await this.options.workerRuntime.preflight(live.number); }
          catch (error) {
            if (!(error instanceof RuntimeAdmissionRejected)) throw error;
            this.rejections.push({ issueNumber: live.number, code: error.code, recorded: false }); return false;
          }
        }
        // Intent first. If dispatch or subsequent writes fail, a future run observes this intent AND actual runs.
        const input = workerInputSchema.parse({ contractVersion: '1.0', repository: this.github.repository,
          issueNumber: live.number, taskVersion: action.taskVersion, description: live.body, acceptanceCriteria: task.criteria,
          contextReferences: [`https://github.com/${this.github.repository}/issues/${live.number}`], executionId: id,
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
  async run(): Promise<RunReport> {
    const started = this.now();
    this.rejections = [];
    const report: RunReport = { correlationId: this.options.correlationId, startedAt: started.toISOString(), durationMs: 0,
      outcome: 'success', tasks: 0, decisions: [], errors: [], blockers: [], nextSteps: [] };
    if (!this.config.factory.enabled) { report.outcome = 'disabled'; return report; }
    let snapshot = await this.snapshot();
    let tasks = reconstruct(snapshot, this.config, this.now());
    if (await this.recover(tasks, report)) { snapshot = await this.snapshot(); tasks = reconstruct(snapshot, this.config, this.now()); }
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
      if (t.latest?.result && ['blocked', 'needs_approval'].includes(t.latest.result.status)) report.blockers.push(`#${t.issue.number}: worker reports ${t.latest.result.status}; revise task or provide missing input`);
      if (t.latest?.result && ['failed', 'cancelled'].includes(t.latest.result.status) && t.latest.attempt >= this.config.execution.maxRetries) report.blockers.push(`#${t.issue.number}: retry budget exhausted`);
    }
    const entries: { action: Action; source: 'reconcile' | 'planner' | 'worker' }[] = reconciliationPlan(tasks, this.config).map(action => ({ action, source: 'reconcile' }));
    const eligible = tasks.filter(t => t.issue.state === 'open' && !t.blocked && !t.hasClosingMerge && !t.executions.some(e => e.active));
    if (eligible.length && this.config.llm.maxCalls > 0) {
      try { entries.push(...planSchema.parse(await this.planner.plan(eligible, this.config)).actions.map(action => ({ action, source: 'planner' as const }))); }
      catch { report.errors.push('LLM planning failed; deterministic reconciliation remains available (no unvalidated actions executed)'); }
    }
    for (const t of tasks) {
      if (t.latest?.result) entries.push(...t.latest.result.proposedActions.map(action => ({ action, source: 'worker' as const })));
    }
    const budget: Budget = { actions: 0, newIssues: 0, activeWorkers: tasks.reduce((n, t) => n + t.executions.filter(e => e.active).length, 0) };
    const seen = new Set<string>();
    for (const entry of entries) {
      const parsed = actionSchema.safeParse(entry.action);
      if (!parsed.success) { report.errors.push('Rejected malformed action proposal'); continue; }
      const action = parsed.data;
      const id = actionId(action, policyVersion(this.config));
      if (seen.has(id)) continue;
      seen.add(id);
      if (this.now().getTime() - started.getTime() > this.config.manager.timeoutMinutes * 60000) { report.errors.push('Manager time budget exhausted'); break; }
      try {
        // Refresh every proposal: concurrent human changes, dependency closure and new PRs invalidate stale facts.
        snapshot = await this.snapshot();
        tasks = reconstruct(snapshot, this.config, this.now());
        const task = tasks.find(t => t.issue.number === action.issueNumber);
        if (!task) { report.errors.push(`Proposal references unmanaged issue #${action.issueNumber}`); continue; }
        budget.activeWorkers = tasks.reduce((n, t) => n + t.executions.filter(e => e.active).length, 0);
        const decision = evaluate(action, { config: this.config, task, budget, source: entry.source, approved: await this.hasApproval(action.issueNumber, id) });
        const record = { action, decision, executed: false };
        report.decisions.push(record);
        await this.audit(action, decision.outcome, decision.reason);
        if (decision.outcome === 'approval') report.nextSteps.push(`Approve #${action.issueNumber} by commenting: /harness approve ${id}`);
        if (decision.outcome !== 'allow' || this.config.execution.dryRun) continue;
        record.executed = await this.execute(action, task, snapshot);
        if (record.executed) {
          budget.actions++;
          if (action.kind === 'create_followup') budget.newIssues++;
          await this.audit(action, 'executed', 'Action executed successfully');
        }
      } catch (error) {
        const status = error instanceof Error && 'status' in error ? String(error.status) : 'unknown';
        // Only fixed policy codes are disclosed; external API or database messages never reach the report.
        const code = admissionCode(error);
        report.errors.push(`Action ${action.kind} on #${action.issueNumber} failed (HTTP ${status}${code ? `, ${code}` : ''}); durable intents preserved for recovery`);
        // Fail closed for the rest of this run: a mutation may have succeeded before an API error.
        break;
      }
    }
    await this.publishStatus(report);
    for (const r of this.rejections) {
      report.blockers.push(`#${r.issueNumber}: runtime admission rejected (${r.code}); ${r.recorded ? 'the execution was closed as cancelled' : 'no execution was created'}`);
      report.nextSteps.push(r.code.startsWith('READY_')
        ? `#${r.issueNumber}: an authorized human must apply harness:ready, then run the manager again`
        : `#${r.issueNumber}: resolve ${r.code} in the runtime registry or task, then run the manager again`);
    }
    if (this.config.notifications.slack.enabled && !this.config.execution.dryRun && this.config.autonomy.profile !== 'advisory') {
      try { report.errors.push(...await deliverNotifications(this.github, this.config,
        await this.github.snapshot(this.config.manager.workflow), this.options.notifications, this.options.correlationId, this.now())); }
      catch { report.errors.push('Slack notification reconciliation failed; repository actions remain committed'); }
    }
    if (report.errors.length) report.outcome = 'partial';
    report.durationMs = this.now().getTime() - started.getTime();
    return report;
  }
}
