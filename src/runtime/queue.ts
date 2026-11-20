import type { Config } from '../config/index.js';
import type { RunReport } from '../manager/report.js';
import { statusView, type QueueStage } from '../manager/status.js';
import { reconstruct, type Task } from '../state/reconstruct.js';
import { dependencies, priorityLabels } from '../state/lifecycle.js';
import type { Snapshot, Status } from '../types.js';
import type { Execution } from '../state/reconstruct.js';
import { reworkOf, retryOf } from './coding-context.js';
import type { MergeProgress } from './merge.js';

/**
 * The Factory's job queue as the broker last saw it: every open managed task of every bound repository, with where it
 * stands, why it waits and what it waits for. It is read from the state each reconciliation already fetched, so serving
 * it costs no GitHub request. A broker restart starts empty; each repository appears again after its next pass.
 *
 * Unlike the sanity check's findings, entries carry the issue title: the view is for authenticated operators only
 * (the monitor token or the manager token), never for Slack or logs.
 */
export interface QueueEntry {
  issueNumber: number; title: string; url: string; stage: QueueStage;
  /** The lifecycle label the Factory keeps on the issue. */
  status: Status;
  priority: 'high' | 'normal' | 'low' | null;
  attempts: { used: number; max: number };
  /** Since when the task is in its current position: the active run's start, the grant, or the last issue change. */
  since: string;
  /** The active run, where one exists. */
  run: { executionId: string; phase: string | null; startedAt: string } | null;
  /** A fixed code or the Factory's own block reason (never worker or issue text). */
  reason: string | null;
  /** A refused start is offered again at the latest at this time. */
  retryAt: string | null;
  /** Queued only because all worker slots of the repository are taken. */
  waitsForSlot: boolean;
  dependsOn: number[];
  pullRequests: string[];
  /**
   * The coding attempts of the current task version, oldest first (at most 10): what each one was for, how far it got
   * and how its independent validation ended. Refused starts are no attempt and are left out.
   */
  runs: QueueRun[];
  /** Where the broker's merge pass last left the task's pull request; null without a pull request or merge pass. */
  merge: MergeProgress | null;
  /** When the task's pull request was merged, from the reconciliation's own pull request list. */
  mergedAt: string | null;
}
/**
 * One coding attempt. kind: first, retry (after a failed run), rework (after a failed validation), review (after the
 * merge review asked for changes) or conflict (after the branch conflicted with its base).
 */
export interface QueueRun {
  executionId: string; kind: 'first' | 'retry' | 'rework' | 'review' | 'conflict'; startedAt: string;
  /** The runtime phase while it runs, else null. */
  phase: string | null; active: boolean;
  outcome: 'success' | 'blocked' | 'failed' | 'cancelled' | 'needs_approval' | null;
  /** The independent validation: passed for a published success, else the broker's bound report of a blocked run. */
  validation: 'passed' | 'failed' | 'unsupported' | 'invalid' | null;
  /** A fixed error code of a failed run. */
  error: string | null;
  /** Failed while setting up the runner, before any agent started (costs no attempt). */
  infrastructure: boolean;
  /** The agent model the run used, where the broker recorded it. */
  model: string | null;
}
export interface QueueRepository {
  repositoryId: number; repository: string;
  /** End of the last reconciliation that completed, or null before the first one. */
  observedAt: string | null;
  outcome: RunReport['outcome'] | null;
  /** The fixed code of the last reconciliation that failed, cleared by the next one that completes. */
  failure: { reason: string; at: string } | null;
  slots: { active: number; max: number } | null;
  entries: QueueEntry[];
}
/**
 * When the schedule reconciles next (software-factory#197). A pass reconciles the repositories one after another and the
 * next pass starts an interval after the last one ended, so `observedAt + interval` of one repository is not its next
 * reconciliation. While a pass runs `passStartedAt` is set and `nextPassAt` is null; webhooks reconcile in between.
 */
export interface QueueSchedule { passStartedAt: string | null; nextPassAt: string | null }
export interface QueueView extends QueueSchedule { generatedAt: string; reconcileIntervalSeconds: number | null; repositories: QueueRepository[] }
interface Target { repositoryId: number; repository: string }

/** The order of the queue: what runs first, then what the Factory will most likely start next. */
const stageOrder: Record<QueueStage, number> = { starting: 0, running: 1, 'awaiting-approval': 2, retry: 3, queued: 4, 'awaiting-grant': 5,
  refused: 6, blocked: 7, 'awaiting-pr': 8, failed: 9, closed: 10 };
const priorityOrder = { high: 0, normal: 1, low: 2 } as const;
const fixedCode = (value: string | null | undefined) => value && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;
/** A closed task stays in the view this long, so a merged run can be seen at its end. */
const closedWindowMs = 24 * 3600000;
const pullNumber = (url: string) => Number(url.split('/').pop());

function runKind(task: Task, execution: Execution): QueueRun['kind'] {
  if (retryOf(execution.input)) return 'retry';
  const previous = reworkOf(execution.input);
  if (!previous) return 'first';
  const source = task.executions.find(e => e.input.executionId === previous);
  if (source?.result?.status !== 'success') return 'rework';
  const requested = task.events.flatMap(e => e.data.type === 'merge_changes_requested' && e.data.executionId === previous ? [e.data] : []).at(-1);
  return requested?.cause === 'conflict' ? 'conflict' : 'review';
}
function runs(task: Task): QueueRun[] {
  return task.executions.filter(e => e.input.taskVersion === task.version && !e.rejected).sort((a, b) => a.attempt - b.attempt).slice(-10).map(e => {
    const result = e.result, validated = result?.artifacts.some(a => a.startsWith('urn:sf-validation:'));
    return {
      executionId: e.input.executionId, kind: runKind(task, e), startedAt: e.runtime?.createdAt ?? e.run?.createdAt ?? e.at,
      phase: e.active ? e.runtime?.phase ?? null : null, active: e.active, outcome: result?.status ?? null,
      validation: e.runtime?.validation?.status ?? (result?.status === 'success' && validated ? 'passed' : null),
      error: result && ['failed', 'cancelled'].includes(result.status) ? fixedCode(result.error) : null,
      infrastructure: !!e.infrastructure, model: e.runtime?.usage?.model ?? e.runtime?.route?.agent?.model ?? null,
    };
  });
}

function entry(task: Task, config: Config, snapshot: Snapshot, repository: string, rejection: string | undefined, waitsForSlot: boolean,
  merges: ReadonlyMap<number, MergeProgress>): QueueEntry {
  const { stage } = statusView(task, config, { repository, readyIsGrant: !!snapshot.readyIsGrant, rejection, queued: waitsForSlot });
  const active = task.executions.find(e => e.active), result = task.latest?.result;
  const label = task.issue.labels.find(l => priorityLabels.includes(l));
  const startedAt = active ? active.runtime?.createdAt ?? active.run?.createdAt ?? active.at : null;
  const pullRequests = (result?.artifacts ?? []).filter(a => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(a));
  // The pull request of the latest attempt, else a merged one that closes the task (a person may have merged it).
  const prs = snapshot.prs.filter(p => pullRequests.some(u => pullNumber(u) === p.number) || (p.merged && p.closingIssues.includes(task.issue.number)));
  const merged = prs.filter(p => p.merged && p.mergedAt).sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
  const tracked = [...pullRequests.map(pullNumber), ...prs.map(p => p.number)].flatMap(n => merges.get(n) ?? [])
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
  const reason = stage === 'blocked' && task.blockReason ? task.blockReason
    : stage === 'refused' || stage === 'awaiting-grant' ? fixedCode(rejection ?? (task.refusal?.waiting ? task.refusal.code : null))
    : ['retry', 'failed', 'blocked'].includes(stage) ? fixedCode(task.latest?.runtime?.validation?.reason) ?? fixedCode(result?.error) ?? (result ? result.status.toUpperCase() : null)
    : null;
  return {
    issueNumber: task.issue.number, title: task.issue.title, url: `https://github.com/${repository}/issues/${task.issue.number}`, stage,
    status: task.desiredStatus, priority: label ? label.replace('harness:priority-', '') as QueueEntry['priority'] : null,
    attempts: { used: task.attemptsUsed, max: config.execution.maxRetries + 1 },
    since: startedAt ?? (stage === 'closed' ? merged?.mergedAt ?? task.issue.updatedAt : stage === 'queued' || stage === 'awaiting-grant' ? task.issue.readyAt ?? task.issue.updatedAt : task.latest?.at ?? task.issue.updatedAt),
    run: active && startedAt ? { executionId: active.input.executionId, phase: active.runtime?.phase ?? null, startedAt } : null,
    reason, retryAt: stage === 'refused' && task.refusal?.waiting ? task.refusal.until : null, waitsForSlot: stage === 'queued' && waitsForSlot,
    dependsOn: dependencies(task.issue.body),
    pullRequests, runs: runs(task), merge: tracked, mergedAt: merged?.mergedAt ?? null,
  };
}

/**
 * The open managed tasks of one reconciliation, in queue order, followed by the tasks closed within the last day that
 * ran at least once (so a finished run can be seen with its merge).
 */
export function queueEntries(snapshot: Snapshot, config: Config, report: RunReport, repository: string, rejections: ReadonlyMap<number, string> = new Map(), now = new Date(),
  merges: ReadonlyMap<number, MergeProgress> = new Map()): QueueEntry[] {
  const slotWaits = new Set(report.decisions.filter(d => d.decision.reason === 'Maximum parallel workers reached').map(d => d.action.issueNumber));
  const recent = (t: Task) => t.issue.state === 'open' || (now.getTime() - Date.parse(t.issue.updatedAt) < closedWindowMs && t.executions.some(e => !e.rejected));
  return reconstruct(snapshot, config, now).filter(recent)
    .map(t => entry(t, config, snapshot, repository, rejections.get(t.issue.number), slotWaits.has(t.issue.number), merges))
    .sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || (priorityOrder[a.priority ?? 'normal'] - priorityOrder[b.priority ?? 'normal'])
      || a.since.localeCompare(b.since) || a.issueNumber - b.issueNumber);
}

/** Keeps the last queue view of every repository in memory. */
export class QueueBoard {
  private repositories = new Map<number, QueueRepository>();
  private plan: QueueSchedule = { passStartedAt: null, nextPassAt: null };
  constructor(private now: () => Date = () => new Date(), private reconcileIntervalSeconds: number | null = null) {}
  private current(target: Target): QueueRepository {
    return this.repositories.get(target.repositoryId) ?? { repositoryId: target.repositoryId, repository: target.repository, observedAt: null,
      outcome: null, failure: null, slots: null, entries: [] };
  }
  /** After a reconciliation that completed. Never throws: the queue view must not fail a reconciliation. */
  observed(target: Target, config: Config, snapshot: Snapshot | undefined, report: RunReport, rejections?: ReadonlyMap<number, string>,
    merges?: ReadonlyMap<number, MergeProgress>) {
    try {
      const now = this.now();
      const entries = snapshot ? queueEntries(snapshot, config, report, target.repository, rejections, now, merges) : [];
      const active = snapshot ? reconstruct(snapshot, config, now).reduce((n, t) => n + t.executions.filter(e => e.active).length, 0) : 0;
      this.repositories.set(target.repositoryId, { repositoryId: target.repositoryId, repository: target.repository, observedAt: now.toISOString(),
        outcome: report.outcome, failure: null, slots: snapshot ? { active, max: config.execution.maxParallelWorkers } : null, entries });
    } catch { this.failed(target, 'QUEUE_VIEW_FAILED'); }
  }
  /** After a reconciliation that failed: the last view stays, marked with the fixed reason. */
  failed(target: Target, reason: string) {
    this.repositories.set(target.repositoryId, { ...this.current(target), failure: { reason: fixedCode(reason) ?? 'OPERATION_FAILED', at: this.now().toISOString() } });
  }
  /** Told by the schedule when a pass starts and when the next one is due. */
  schedule(plan: QueueSchedule) { this.plan = { ...plan }; }
  /** Every bound repository, also those not reconciled since the broker started. */
  view(targets: Target[]): QueueView {
    return { generatedAt: this.now().toISOString(), reconcileIntervalSeconds: this.reconcileIntervalSeconds, ...this.plan,
      repositories: targets.map(t => ({ ...this.current(t), repository: t.repository })).sort((a, b) => a.repository.localeCompare(b.repository)) };
  }
}
