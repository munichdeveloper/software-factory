import { monitoringChannel, monitoringSettings, type Config, type MonitoringSettings } from '../config/index.js';
import { sanityText, type SanityAlertSink } from '../notifications/sanity-alerts.js';
import type { Snapshot } from '../types.js';
import type { RunReport } from '../manager/report.js';
import { reconstruct, type Task } from '../state/reconstruct.js';
import { dependencies } from '../state/lifecycle.js';

/**
 * What the broker's sanity check reports. Every finding names a fixed kind, at most an issue number and a detail built
 * from fixed codes and numbers only: never issue text, worker summaries or external error messages.
 */
export const findingKinds = ['run_stuck', 'approval_waiting', 'run_orphaned', 'dispatch_unresolved', 'retries_exhausted',
  'repeated_failure', 'blocked_without_pr', 'dependency_cycle', 'status_stalled', 'reconcile_failing'] as const;
export type FindingKind = typeof findingKinds[number];
export interface Finding { key: string; kind: FindingKind; issueNumber: number | null; detail: string }

const code = (value: string | null | undefined) => value && /^[A-Z][A-Z0-9_]{1,40}$/.test(value) ? value : null;
const minutes = (ms: number) => Math.floor(ms / 60000);
const finding = (kind: FindingKind, issueNumber: number | null, detail: string, discriminator = ''): Finding =>
  ({ key: `${kind}:${issueNumber ?? '-'}${discriminator ? `:${discriminator}` : ''}`, kind, issueNumber, detail });

/** Findings that follow from one reconciliation's view of the repository alone. */
export function inspect(tasks: Task[], config: Config, settings: MonitoringSettings, now: Date): Finding[] {
  const found: Finding[] = [];
  const open = tasks.filter(t => t.issue.state === 'open');
  for (const task of tasks) {
    const n = task.issue.number;
    for (const execution of task.executions.filter(e => e.active)) {
      const id = execution.input.executionId, since = Date.parse(execution.runtime?.createdAt ?? execution.run?.createdAt ?? execution.at);
      const age = now.getTime() - since;
      if (execution.orphaned) found.push(finding('run_orphaned', n, `Run ${id} still active although its task was closed or revised`, id));
      if (execution.ambiguous) found.push(finding('dispatch_unresolved', n, `Start of run ${id} unconfirmed for ${minutes(age)} min`, id));
      if (execution.runtime?.phase === 'awaiting-approval') {
        if (age > settings.approvalWaitHours * 3600000) found.push(finding('approval_waiting', n, `Run ${id} waits for approval for ${Math.floor(age / 3600000)} h`, id));
      } else if (age > (execution.input.limits.timeoutMinutes + settings.stuckRunMinutes) * 60000) {
        found.push(finding('run_stuck', n, `Run ${id} active for ${minutes(age)} min in phase ${execution.runtime?.phase ?? 'unknown'} (worker timeout ${execution.input.limits.timeoutMinutes} min)`, id));
      }
    }
  }
  for (const task of open) {
    const n = task.issue.number, active = task.executions.some(e => e.active), latest = task.latest;
    if (!active && latest?.result && ['failed', 'cancelled'].includes(latest.result.status) && task.attemptsUsed > config.execution.maxRetries) {
      found.push(finding('retries_exhausted', n, `Retry budget used up after ${task.attemptsUsed} attempts (${code(latest.result.error) ?? latest.result.status}); the task cannot progress without a person`));
    }
    // The same error code at the end of several attempts in a row: a retry would most likely end the same way.
    const ended = task.executions.filter(e => e.input.taskVersion === task.version && e.result && !e.active).sort((a, b) => a.attempt - b.attempt);
    const last = ended.slice(-settings.repeatedFailures), reason = code(last.at(-1)?.result?.error);
    if (reason && last.length === settings.repeatedFailures && last.every(e => e.result!.status !== 'success' && code(e.result!.error) === reason)) {
      found.push(finding('repeated_failure', n, `${last.length} attempts in a row ended with ${reason}`, reason));
    }
    // A Factory block without a pull request: no person was asked to block it and nothing waits for review.
    // Waiting for a dependency and a block a person set are not dead ends.
    const waiting = task.blockReason?.startsWith('Unresolved dependencies') || task.blockReason?.startsWith('Issue explicitly marked blocked');
    // A label this reconciliation is about to change (for example once a dependency closed) is not a dead end either.
    if (task.status === 'blocked' && task.desiredStatus === 'blocked' && !active && !task.hasOpenPR && !waiting) {
      const cause = task.automaticBlockCause ?? (task.blockReason ? 'specification' : latest?.result?.status === 'blocked' ? 'worker' : 'unknown');
      found.push(finding('blocked_without_pr', n, `Blocked without a pull request (cause: ${cause}${latest?.result ? `, last attempt ${latest.attempt}` : ''})`));
    }
  }
  for (const cycle of dependencyCycles(open)) found.push(finding('dependency_cycle', cycle[0]!, `Dependency cycle ${cycle.map(i => `#${i}`).join(' -> ')} -> #${cycle[0]}`, cycle.join('-')));
  return found;
}

/** Cycles among the open tasks' "Depends on:" lines, each reported once starting at its smallest issue number. */
export function dependencyCycles(tasks: Task[]): number[][] {
  const edges = new Map(tasks.map(t => [t.issue.number, dependencies(t.issue.body)]));
  const cycles = new Map<string, number[]>();
  const visit = (node: number, path: number[]) => {
    for (const next of edges.get(node) ?? []) {
      const at = path.indexOf(next);
      if (at >= 0) {
        const cycle = path.slice(at), start = cycle.indexOf(Math.min(...cycle));
        const normalized = [...cycle.slice(start), ...cycle.slice(0, start)];
        cycles.set(normalized.join('-'), normalized);
      } else if (edges.has(next) && path.length < 50) visit(next, [...path, next]);
    }
  };
  for (const node of edges.keys()) visit(node, [node]);
  return [...cycles.values()];
}

interface Target { repositoryId: number; repository: string }
interface History { stalled: Map<number, { status: string; passes: number }>; failures: number; lastFailure: string | null; errorPasses: number; cleanPasses: number }

/**
 * The fixed codes behind a reconciliation's errors, at most three: what keeps failing, without any external text.
 * Each error line is built from a fixed template; anything unknown counts as OTHER.
 */
export function errorCodes(errors: string[]): string[] {
  const codes = errors.map(e => {
    if (e.startsWith('Merge: ')) return `MERGE_${e.match(/\((\d{3}|unavailable)\)/)?.[1]?.toUpperCase() ?? 'FAILED'}`;
    const llm = e.match(/^LLM planning failed \(([A-Z][A-Z0-9_]{1,40})\)/);
    if (llm) return llm[1]!;
    if (e.startsWith('LLM planning failed')) return 'LLM_FAILED';
    const action = e.match(/^Action ([a-z_]+) on #\d+ failed \(HTTP (\d{3}|unknown)/);
    if (action) return `ACTION_${action[1]!.toUpperCase()}_HTTP_${action[2]!.toUpperCase()}`;
    if (e.startsWith('Recovery of execution')) return `RECOVERY_${e.match(/\(([A-Z][A-Z0-9_]{1,40})\)/)?.[1] ?? 'FAILED'}`;
    if (e.startsWith('Slack notification')) return 'SLACK_FAILED';
    if (e.startsWith('Status comments')) return 'STATUS_COMMENTS_FAILED';
    if (e.startsWith('Manager time budget')) return 'TIME_BUDGET';
    if (e.startsWith('Rejected malformed') || e.startsWith('Proposal references')) return 'PLAN_REJECTED';
    return 'OTHER';
  });
  return [...new Set(codes)].sort().slice(0, 3);
}
export interface SanityStore {
  /** Records the current findings of the given kinds; returns what opened and what was resolved since the last call. */
  syncFindings(repositoryId: number, findings: Finding[], kinds: readonly FindingKind[], now: Date): Promise<{ opened: Finding[]; resolved: Finding[] }>;
}

/**
 * Watches every reconciliation of the broker. Findings that need more than one view (a status that never settles,
 * reconciliations that keep failing) count consecutive passes in memory; a broker restart starts them over.
 * The check reads only what the reconciliation already fetched: it costs no GitHub request.
 */
export class SanityMonitor {
  private history = new Map<number, History>();
  private settings = new Map<number, MonitoringSettings>();
  private channels = new Map<number, string | null>();
  constructor(private store: SanityStore, private now: () => Date = () => new Date(), private alerts?: SanityAlertSink) {}
  private state(repositoryId: number): History {
    let history = this.history.get(repositoryId);
    if (!history) this.history.set(repositoryId, history = { stalled: new Map(), failures: 0, lastFailure: null, errorPasses: 0, cleanPasses: 0 });
    return history;
  }
  /** After a reconciliation that completed (possibly with errors). Never throws. */
  async observed(target: Target, config: Config, snapshot: Snapshot | undefined, report: RunReport): Promise<void> {
    const { repositoryId } = target;
    await this.guard(repositoryId, async () => {
      const settings = monitoringSettings(config);
      this.settings.set(repositoryId, settings); this.channels.set(repositoryId, monitoringChannel(config));
      if (!settings.enabled || !snapshot) return;
      const now = this.now(), history = this.state(repositoryId);
      const tasks = reconstruct(snapshot, config, now);
      const found = inspect(tasks, config, settings, now);
      // A label that differs from the derived status over many passes: the Manager cannot apply it (denied, failing, deadlocked).
      const stalled = new Map<number, { status: string; passes: number }>();
      for (const task of tasks.filter(t => t.issue.state === 'open' && t.status !== t.desiredStatus)) {
        const key = `${task.status}->${task.desiredStatus}`, before = history.stalled.get(task.issue.number);
        const passes = before?.status === key ? before.passes + 1 : 1;
        stalled.set(task.issue.number, { status: key, passes });
        if (passes >= settings.stalledPasses) found.push(finding('status_stalled', task.issue.number, `Status ${task.status} should be ${task.desiredStatus} but has not changed for ${passes} reconciliations`));
      }
      history.stalled = stalled;
      history.failures = 0; history.lastFailure = null;
      history.errorPasses = report.errors.length ? history.errorPasses + 1 : 0;
      history.cleanPasses = report.errors.length ? 0 : history.cleanPasses + 1;
      if (history.errorPasses >= settings.stalledPasses) {
        found.push(finding('reconcile_failing', null, `${history.errorPasses} reconciliations in a row reported errors (${errorCodes(report.errors).join(', ')})`));
      }
      await this.record(target, found, this.decided(history, settings) ? findingKinds : findingKinds.filter(k => k !== 'reconcile_failing'), now);
    });
  }
  /** After a reconciliation that failed with a fixed code (BUSY and disabled repositories are not failures). Never throws. */
  async failed(target: Target, reason: string): Promise<void> {
    const { repositoryId } = target;
    await this.guard(repositoryId, async () => {
      const settings = this.settings.get(repositoryId) ?? monitoringSettings({} as Config);
      if (!settings.enabled) return;
      const history = this.state(repositoryId);
      history.failures++; history.lastFailure = code(reason) ?? 'OPERATION_FAILED'; history.cleanPasses = 0;
      // Without a view of the repository only this finding can change; the others stay as last seen.
      // Below the threshold the pass decides nothing: an open finding is not resolved by a further failure.
      if (history.failures < settings.stalledPasses) return;
      await this.record(target, [finding('reconcile_failing', null, `${history.failures} reconciliations in a row failed (${history.lastFailure})`)], ['reconcile_failing'], this.now());
    });
  }
  /**
   * Whether this pass opens or resolves `reconcile_failing`. It opens after `stalledPasses` passes with errors and resolves
   * only after as many clean passes in a row: a pass without errors in between (for example one where no task needed
   * planning) or a broker restart, which starts the counters over, must not report the problem as solved and new again.
   */
  private decided(history: History, settings: MonitoringSettings): boolean {
    return history.errorPasses >= settings.stalledPasses || history.cleanPasses >= settings.stalledPasses;
  }
  private async record({ repositoryId, repository }: Target, found: Finding[], kinds: readonly FindingKind[], now: Date) {
    const unique = [...new Map(found.map(f => [f.key, f])).values()];
    const { opened, resolved } = await this.store.syncFindings(repositoryId, unique, kinds, now);
    if (opened.length || resolved.length) console.log(JSON.stringify({ event: 'factory-sanity', repositoryId, active: unique.length,
      opened: opened.map(f => ({ kind: f.kind, issue: f.issueNumber, detail: f.detail })), resolved: resolved.map(f => ({ kind: f.kind, issue: f.issueNumber })) }));
    const channel = this.channels.get(repositoryId);
    if (!channel || !this.alerts || (!opened.length && !resolved.length)) return;
    // At most once: a message lost to Slack is not repeated, the finding stays visible in the store and the log.
    try { await this.alerts.post(channel, sanityText(repository, opened, resolved)); }
    catch { console.warn(JSON.stringify({ event: 'factory-sanity-alert-failed', repositoryId })); }
  }
  private async guard(repositoryId: number, work: () => Promise<void>) {
    try { await work(); }
    catch { console.warn(JSON.stringify({ event: 'factory-sanity-failed', repositoryId })); }
  }
}
