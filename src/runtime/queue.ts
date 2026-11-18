import type { Config } from '../config/index.js';
import type { RunReport } from '../manager/report.js';
import { statusView, type QueueStage } from '../manager/status.js';
import { reconstruct, type Task } from '../state/reconstruct.js';
import { dependencies, priorityLabels } from '../state/lifecycle.js';
import type { Snapshot, Status } from '../types.js';

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
export interface QueueView { generatedAt: string; reconcileIntervalSeconds: number | null; repositories: QueueRepository[] }
interface Target { repositoryId: number; repository: string }

/** The order of the queue: what runs first, then what the Factory will most likely start next. */
const stageOrder: Record<QueueStage, number> = { starting: 0, running: 1, 'awaiting-approval': 2, retry: 3, queued: 4, 'awaiting-grant': 5,
  refused: 6, blocked: 7, 'awaiting-pr': 8, failed: 9, closed: 10 };
const priorityOrder = { high: 0, normal: 1, low: 2 } as const;
const fixedCode = (value: string | null | undefined) => value && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : null;

function entry(task: Task, config: Config, snapshot: Snapshot, repository: string, rejection: string | undefined, waitsForSlot: boolean): QueueEntry {
  const { stage } = statusView(task, config, { repository, readyIsGrant: !!snapshot.readyIsGrant, rejection, queued: waitsForSlot });
  const active = task.executions.find(e => e.active), result = task.latest?.result;
  const label = task.issue.labels.find(l => priorityLabels.includes(l));
  const startedAt = active ? active.runtime?.createdAt ?? active.run?.createdAt ?? active.at : null;
  const reason = stage === 'blocked' && task.blockReason ? task.blockReason
    : stage === 'refused' || stage === 'awaiting-grant' ? fixedCode(rejection ?? (task.refusal?.waiting ? task.refusal.code : null))
    : ['retry', 'failed', 'blocked'].includes(stage) ? fixedCode(task.latest?.runtime?.validation?.reason) ?? fixedCode(result?.error) ?? (result ? result.status.toUpperCase() : null)
    : null;
  return {
    issueNumber: task.issue.number, title: task.issue.title, url: `https://github.com/${repository}/issues/${task.issue.number}`, stage,
    status: task.desiredStatus, priority: label ? label.replace('harness:priority-', '') as QueueEntry['priority'] : null,
    attempts: { used: task.attemptsUsed, max: config.execution.maxRetries + 1 },
    since: startedAt ?? (stage === 'queued' || stage === 'awaiting-grant' ? task.issue.readyAt ?? task.issue.updatedAt : task.latest?.at ?? task.issue.updatedAt),
    run: active && startedAt ? { executionId: active.input.executionId, phase: active.runtime?.phase ?? null, startedAt } : null,
    reason, retryAt: stage === 'refused' && task.refusal?.waiting ? task.refusal.until : null, waitsForSlot: stage === 'queued' && waitsForSlot,
    dependsOn: dependencies(task.issue.body),
    pullRequests: (result?.artifacts ?? []).filter(a => /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(a)),
  };
}

/** The open managed tasks of one reconciliation, in queue order. */
export function queueEntries(snapshot: Snapshot, config: Config, report: RunReport, repository: string, rejections: ReadonlyMap<number, string> = new Map(), now = new Date()): QueueEntry[] {
  const slotWaits = new Set(report.decisions.filter(d => d.decision.reason === 'Maximum parallel workers reached').map(d => d.action.issueNumber));
  return reconstruct(snapshot, config, now).filter(t => t.issue.state === 'open')
    .map(t => entry(t, config, snapshot, repository, rejections.get(t.issue.number), slotWaits.has(t.issue.number)))
    .sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || (priorityOrder[a.priority ?? 'normal'] - priorityOrder[b.priority ?? 'normal'])
      || a.since.localeCompare(b.since) || a.issueNumber - b.issueNumber);
}

/** Keeps the last queue view of every repository in memory. */
export class QueueBoard {
  private repositories = new Map<number, QueueRepository>();
  constructor(private now: () => Date = () => new Date(), private reconcileIntervalSeconds: number | null = null) {}
  private current(target: Target): QueueRepository {
    return this.repositories.get(target.repositoryId) ?? { repositoryId: target.repositoryId, repository: target.repository, observedAt: null,
      outcome: null, failure: null, slots: null, entries: [] };
  }
  /** After a reconciliation that completed. Never throws: the queue view must not fail a reconciliation. */
  observed(target: Target, config: Config, snapshot: Snapshot | undefined, report: RunReport, rejections?: ReadonlyMap<number, string>) {
    try {
      const now = this.now();
      const entries = snapshot ? queueEntries(snapshot, config, report, target.repository, rejections, now) : [];
      const active = snapshot ? reconstruct(snapshot, config, now).reduce((n, t) => n + t.executions.filter(e => e.active).length, 0) : 0;
      this.repositories.set(target.repositoryId, { repositoryId: target.repositoryId, repository: target.repository, observedAt: now.toISOString(),
        outcome: report.outcome, failure: null, slots: snapshot ? { active, max: config.execution.maxParallelWorkers } : null, entries });
    } catch { this.failed(target, 'QUEUE_VIEW_FAILED'); }
  }
  /** After a reconciliation that failed: the last view stays, marked with the fixed reason. */
  failed(target: Target, reason: string) {
    this.repositories.set(target.repositoryId, { ...this.current(target), failure: { reason: fixedCode(reason) ?? 'OPERATION_FAILED', at: this.now().toISOString() } });
  }
  /** Every bound repository, also those not reconciled since the broker started. */
  view(targets: Target[]): QueueView {
    return { generatedAt: this.now().toISOString(), reconcileIntervalSeconds: this.reconcileIntervalSeconds,
      repositories: targets.map(t => ({ ...this.current(t), repository: t.repository })).sort((a, b) => a.repository.localeCompare(b.repository)) };
  }
}
