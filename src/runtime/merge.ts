import type { Config } from '../config/index.js';
import type { Snapshot } from '../types.js';

export interface MergePassReport { reviewed: number; updated: number; merged: number; errors: string[] }

/**
 * The merge pass of one repository in the broker. It runs after a reconciliation, in the background: an AI review can
 * take longer than the Manager waits for a reconciliation. At most one pass runs at a time, and a new one starts only
 * after `intervalMs`, so pull requests whose checks are still running are not re-read on every reconciliation.
 */
export class RuntimeMerge {
  private running?: Promise<void>;
  private last = -Infinity;
  constructor(private repositoryId: number, private pass: (config: Config, snapshot: Snapshot) => Promise<MergePassReport>,
    private intervalMs = 180000, private now: () => number = Date.now) {}
  /** Starts a pass unless merging is off, one is running or the last started recently. Never rejects. */
  start(config: Config, snapshot: Snapshot): Promise<void> | null {
    if (!config.merge.enabled || this.running || this.now() - this.last < this.intervalMs) return null;
    this.last = this.now();
    this.running = this.pass(config, snapshot).then(report => {
      // Errors carry pull request numbers and HTTP status codes only.
      if (report.reviewed || report.updated || report.merged || report.errors.length) console.log(JSON.stringify({ event: 'factory-merge',
        repositoryId: this.repositoryId, reviewed: report.reviewed, updated: report.updated, merged: report.merged, errors: report.errors }));
    }, () => { console.warn(JSON.stringify({ event: 'factory-merge-failed', repositoryId: this.repositoryId })); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }
}
