import type { Config } from '../config/index.js';
import type { Snapshot } from '../types.js';

export interface MergePassReport { reviewed: number; updated: number; merged: number; errors: string[] }

/**
 * Where the merge pass last left a pull request, for the queue view (software-factory-monitor): the step it reached and,
 * where it stopped, the Factory's own reason. Never model or pull request text. Kept in memory; a broker restart starts empty.
 */
export const mergeSteps = ['checks', 'checks-failed', 'conflict', 'branch-update', 'review', 'review-rejected', 'approval-required', 'gate', 'merging',
  'merged', 'handover', 'stopped', 'error'] as const;
export type MergeStep = typeof mergeSteps[number];
export interface MergeProgress { pullRequest: number; step: MergeStep; detail: string | null; risk: string | null; at: string }
export type MergeObserver = (pullRequest: number, step: MergeStep, detail?: string | null, risk?: string | null) => void;
/** Progress older than this is dropped: the pull request left the merge pass (merged long ago, closed or no longer a candidate). */
const progressTtlMs = 48 * 3600000;

/**
 * The merge pass of one repository in the broker. It runs after a reconciliation, in the background: an AI review can
 * take longer than the Manager waits for a reconciliation. At most one pass runs at a time, and a new one starts only
 * after `intervalMs`, so pull requests whose checks are still running are not re-read on every reconciliation.
 */
export class RuntimeMerge {
  private running?: Promise<void>;
  private last = -Infinity;
  /** Errors of the last completed pass (pull request numbers and status codes only), reported with the next reconciliation. */
  errors: string[] = [];
  private progressByPr = new Map<number, MergeProgress>();
  constructor(private repositoryId: number, private pass: (config: Config, snapshot: Snapshot, observe: MergeObserver) => Promise<MergePassReport>,
    private intervalMs = 180000, private now: () => number = Date.now) {}
  /** Starts a pass unless merging is off, one is running or the last started recently. Never rejects. */
  start(config: Config, snapshot: Snapshot): Promise<void> | null {
    if (!config.merge.enabled || this.running || this.now() - this.last < this.intervalMs) return null;
    this.last = this.now();
    this.running = this.pass(config, snapshot, (pullRequest, step, detail = null, risk = null) => {
      const previous = this.progressByPr.get(pullRequest);
      this.progressByPr.set(pullRequest, { pullRequest, step, detail: detail ? detail.slice(0, 400) : null,
        risk: risk ?? previous?.risk ?? null, at: new Date(this.now()).toISOString() });
    }).then(report => {
      this.errors = report.errors.map(e => `Merge: ${e}`);
      // Errors carry pull request numbers and HTTP status codes only.
      if (report.reviewed || report.updated || report.merged || report.errors.length) console.log(JSON.stringify({ event: 'factory-merge',
        repositoryId: this.repositoryId, reviewed: report.reviewed, updated: report.updated, merged: report.merged, errors: report.errors }));
    }, (error: unknown) => {
      const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : 'unavailable';
      this.errors = [`Merge: pass failed before reading pull requests (${status})`];
      console.warn(JSON.stringify({ event: 'factory-merge-failed', repositoryId: this.repositoryId, status }));
    })
      .finally(() => { this.running = undefined; });
    return this.running;
  }
  /** The last step of every pull request the merge pass looked at recently. */
  progress(): ReadonlyMap<number, MergeProgress> {
    const cutoff = this.now() - progressTtlMs;
    for (const [n, p] of this.progressByPr) if (Date.parse(p.at) < cutoff) this.progressByPr.delete(n);
    return this.progressByPr;
  }
}
