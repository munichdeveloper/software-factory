import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Self-hosted runner fallback (software-factory#110). GitHub-hosted runners stay the default; once the account's
 * Actions budget is used up, GitHub refuses every job of a private repository before it starts. The broker then sets
 * the repository variable SF_RUNNER of every private bound repository to the label of its own runner pool, re-runs
 * the refused jobs once, and removes the variable again when the next billing month (UTC) starts.
 */
export const runnerVariable = 'SF_RUNNER';
export const runnerLabel = 'sf-self-hosted';

export interface RunnerJob {
  id: number; runId: number; status: string; conclusion: string | null; labels: string[];
  runnerId: number | null; steps: number; startedAt: string | null; completedAt: string | null;
}
export interface RunnerRun { id: number; status: string; conclusion: string | null; createdAt: string }
/** What the fallback needs of one repository. Every call uses a token limited to that repository. */
export interface RunnerRepositoryPort {
  repositoryId: number; repository: string;
  isPrivate(): Promise<boolean>;
  /** The variable's value and when it last changed, or null when it is not set. */
  variable(): Promise<{ value: string; updatedAt: string } | null>;
  setVariable(value: string | null): Promise<void>;
  /** Runs created at or after the time, newest first, at most one page. */
  runs(since: Date, status?: 'completed' | 'queued' | 'in_progress'): Promise<RunnerRun[]>;
  jobs(runId: number): Promise<RunnerJob[]>;
  rerunFailedJobs(runId: number): Promise<void>;
  /** A just-in-time configuration of one ephemeral runner with the pool's label, registered to this repository. */
  jitConfig(name: string): Promise<string>;
}
export interface RunnerAlerts { post(text: string): Promise<void> }

/**
 * A job GitHub refused for billing: failed without a runner and without a single step, within seconds. A failure
 * of the job itself always has a runner and steps; a job waiting for a runner stays queued and never fails this way.
 */
export function refusedForBilling(job: RunnerJob): boolean {
  if (job.status !== 'completed' || job.conclusion !== 'failure' || job.runnerId || job.steps > 0) return false;
  if (job.labels.includes(runnerLabel)) return false;
  const started = Date.parse(job.startedAt ?? ''), completed = Date.parse(job.completedAt ?? '');
  return Number.isFinite(started) && Number.isFinite(completed) && completed - started <= 30000;
}
const month = (date: Date) => date.toISOString().slice(0, 7);
const reason = (error: unknown) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message
  : error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? `HTTP_${error.status}` : 'OPERATION_FAILED';

export interface RunnerFallbackOptions {
  now?: () => Date; alerts?: RunnerAlerts;
  /** How far back a pass looks for refused jobs. */
  lookbackMs?: number;
  log?: (line: Record<string, unknown>) => void;
}

export class RunnerFallback {
  private checkedRuns = new Set<number>(); private rerun = new Set<number>();
  private privateRepos = new Map<number, boolean>(); private lastScan = new Map<number, Date>();
  private now: () => Date; private log: (line: Record<string, unknown>) => void;
  constructor(private repositories: RunnerRepositoryPort[], private options: RunnerFallbackOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (line => console.log(JSON.stringify(line)));
  }
  private async privateOnly(): Promise<RunnerRepositoryPort[]> {
    const result: RunnerRepositoryPort[] = [];
    for (const repo of this.repositories) {
      try {
        // Public repositories have free standard runners and must never run their (fork) jobs on the host.
        if (!this.privateRepos.has(repo.repositoryId)) this.privateRepos.set(repo.repositoryId, await repo.isPrivate());
        if (this.privateRepos.get(repo.repositoryId)) result.push(repo);
      } catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'visibility', reason: reason(error) }); }
    }
    return result;
  }
  /** The repositories currently switched to the pool. */
  async switched(): Promise<RunnerRepositoryPort[]> {
    const result: RunnerRepositoryPort[] = [];
    for (const repo of await this.privateOnly()) {
      try { if ((await repo.variable())?.value === runnerLabel) result.push(repo); }
      catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'variable', reason: reason(error) }); }
    }
    return result;
  }
  /** Refused runs of one repository since its last scan; each run is inspected once. */
  private async refusedRuns(repo: RunnerRepositoryPort, now: Date): Promise<number[]> {
    const since = this.lastScan.get(repo.repositoryId) ?? new Date(now.getTime() - (this.options.lookbackMs ?? 2 * 3600000));
    const refused: number[] = [];
    for (const run of await repo.runs(new Date(since.getTime() - 120000), 'completed')) {
      if (run.conclusion !== 'failure' || this.checkedRuns.has(run.id)) continue;
      this.checkedRuns.add(run.id);
      if ((await repo.jobs(run.id)).some(refusedForBilling)) refused.push(run.id);
    }
    this.lastScan.set(repo.repositoryId, now);
    return refused;
  }
  /**
   * One pass: switches back at the start of a new billing month, otherwise looks for refused jobs. The budget is the
   * account's, so a refusal in one private repository switches all of them.
   */
  async pass(): Promise<'switched' | 'restored' | 'unchanged'> {
    const now = this.now(), repos = await this.privateOnly();
    const state = new Map<number, { value: string; updatedAt: string } | null>();
    for (const repo of repos) {
      try { state.set(repo.repositoryId, await repo.variable()); }
      catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'variable', reason: reason(error) }); }
    }
    const onPool = repos.filter(r => state.get(r.repositoryId)?.value === runnerLabel);
    // A new month brings new included minutes and a new budget period: back to GitHub-hosted runners.
    const stale = onPool.filter(r => month(new Date(state.get(r.repositoryId)!.updatedAt)) !== month(now));
    if (stale.length) {
      for (const repo of stale) {
        try { await repo.setVariable(null); }
        catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'restore', reason: reason(error) }); }
      }
      this.log({ event: 'runner-fallback-restored', repositories: stale.map(r => r.repositoryId) });
      await this.alert(`SF Runner: Neuer Abrechnungsmonat, Jobs laufen wieder auf GitHub-hosted Runnern (${stale.map(r => r.repository).join(', ')}).`);
      return 'restored';
    }
    const refused = new Map<RunnerRepositoryPort, number[]>();
    for (const repo of repos) {
      if (!state.has(repo.repositoryId)) continue;
      try { const runs = await this.refusedRuns(repo, now); if (runs.length) refused.set(repo, runs); }
      catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'scan', reason: reason(error) }); }
    }
    if (!refused.size) return 'unchanged';
    // Already on the pool: a refusal there comes from a workflow that ignores SF_RUNNER; re-running would not help.
    const hosted = repos.filter(r => state.has(r.repositoryId) && state.get(r.repositoryId)?.value !== runnerLabel);
    if (!hosted.length) {
      this.log({ event: 'runner-fallback-refused-on-pool', repositories: [...refused.keys()].map(r => r.repositoryId) });
      return 'unchanged';
    }
    const moved: RunnerRepositoryPort[] = [];
    for (const repo of hosted) {
      try { await repo.setVariable(runnerLabel); moved.push(repo); }
      catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'switch', reason: reason(error) }); }
    }
    let rerun = 0;
    for (const [repo, runs] of refused) {
      if (!moved.includes(repo)) continue;
      for (const runId of runs) {
        if (this.rerun.has(runId)) continue;
        this.rerun.add(runId);
        try { await repo.rerunFailedJobs(runId); rerun++; }
        catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'rerun', runId, reason: reason(error) }); }
      }
    }
    this.log({ event: 'runner-fallback-switched', repositories: moved.map(r => r.repositoryId), rerunRuns: rerun });
    if (moved.length) await this.alert(`SF Runner: Das Actions-Budget ist erschöpft, GitHub startet keine Jobs privater Repos mehr. `
      + `Umgeschaltet auf die eigenen Runner: ${moved.map(r => r.repository).join(', ')}. ${rerun} abgelehnte Läufe neu gestartet. `
      + `Zurück auf GitHub-hosted zum Monatsanfang.`);
    return moved.length ? 'switched' : 'unchanged';
  }
  /** Queued jobs waiting for the pool, per switched repository. */
  async demand(): Promise<{ repo: RunnerRepositoryPort; jobs: number }[]> {
    const now = this.now(), result: { repo: RunnerRepositoryPort; jobs: number }[] = [];
    for (const repo of await this.switched()) {
      let jobs = 0;
      try {
        for (const status of ['queued', 'in_progress'] as const) {
          for (const run of await repo.runs(new Date(now.getTime() - 24 * 3600000), status)) {
            jobs += (await repo.jobs(run.id)).filter(j => j.status === 'queued' && j.labels.includes(runnerLabel)).length;
          }
        }
      } catch (error) { this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'demand', reason: reason(error) }); }
      if (jobs) result.push({ repo, jobs });
    }
    return result;
  }
  private async alert(text: string) {
    try { await this.options.alerts?.post(text); } catch { /* an alert never stops the switch */ }
  }
}

/**
 * Hands just-in-time runner configurations to the pool through one directory per runner slot (a volume shared with
 * exactly one runner container). The runner reads and deletes the file and runs one job. The runners hold no broker
 * token and have no network path to the broker, so a job cannot ask for registrations itself.
 */
export class RunnerDispenser {
  private assigned = new Map<string, number>();
  constructor(private fallback: RunnerFallback, private slotsDir: string, private log: (line: Record<string, unknown>) => void = line => console.log(JSON.stringify(line))) {}
  async slots(): Promise<string[]> {
    try { return (await readdir(this.slotsDir, { withFileTypes: true })).filter(d => d.isDirectory() && /^[a-z0-9-]{1,40}$/.test(d.name)).map(d => d.name).sort(); }
    catch { return []; }
  }
  private async idle(slot: string): Promise<boolean> {
    const file = join(this.slotsDir, slot, 'jitconfig');
    try { await stat(file); return false; } catch { /* no pending configuration */ }
    // The runner leaves 'busy' while a job runs and removes it when the job ended.
    try { await stat(join(this.slotsDir, slot, 'busy')); return false; } catch { return true; }
  }
  /** Fills idle slots with configurations for queued jobs. Returns the number of configurations handed out. */
  async pass(): Promise<number> {
    const slots = await this.slots(), idle: string[] = [], pending = new Map<number, number>();
    for (const slot of slots) {
      if (await this.idle(slot)) { idle.push(slot); continue; }
      // A configuration not yet picked up already covers one waiting job of its repository.
      const repositoryId = this.assigned.get(slot);
      try { await stat(join(this.slotsDir, slot, 'jitconfig')); if (repositoryId) pending.set(repositoryId, (pending.get(repositoryId) ?? 0) + 1); } catch { /* running */ }
    }
    if (!idle.length) return 0;
    const demand = await this.fallback.demand();
    let handed = 0;
    for (const { repo, jobs } of demand) {
      let left = jobs - (pending.get(repo.repositoryId) ?? 0);
      while (left > 0 && idle.length) {
        const slot = idle.shift()!, name = `sf-${slot}-${Date.now().toString(36)}`;
        try {
          const config = await repo.jitConfig(name);
          const dir = join(this.slotsDir, slot), tmp = join(dir, '.jitconfig.tmp');
          await mkdir(dir, { recursive: true });
          await writeFile(tmp, config, { mode: 0o666 });
          await rename(tmp, join(dir, 'jitconfig'));
          this.assigned.set(slot, repo.repositoryId);
          this.log({ event: 'runner-dispensed', slot, repositoryId: repo.repositoryId });
          handed++; left--;
        } catch (error) {
          this.log({ event: 'runner-fallback-failed', repositoryId: repo.repositoryId, stage: 'jit', reason: reason(error) });
          break;
        }
      }
    }
    return handed;
  }
}

/** Runs the fallback check every interval and the dispenser more often while any repository is switched. */
export function startRunnerFallback(fallback: RunnerFallback, dispenser: RunnerDispenser | null, intervalMs: number, dispenseMs = 20000) {
  let stopped = false, checkTimer: NodeJS.Timeout | undefined, dispenseTimer: NodeJS.Timeout | undefined, active = false;
  const check = async () => {
    try { const outcome = await fallback.pass(); if (outcome !== 'unchanged') active = outcome === 'switched'; if (!active) active = (await fallback.switched()).length > 0; }
    catch { /* logged inside */ }
    if (!stopped) checkTimer = setTimeout(() => void check(), intervalMs);
  };
  const dispense = async () => {
    if (active && dispenser) { try { await dispenser.pass(); } catch { /* logged inside */ } }
    if (!stopped) dispenseTimer = setTimeout(() => void dispense(), dispenseMs);
  };
  checkTimer = setTimeout(() => void check(), 5000);
  dispenseTimer = setTimeout(() => void dispense(), dispenseMs);
  return () => { stopped = true; if (checkTimer) clearTimeout(checkTimer); if (dispenseTimer) clearTimeout(dispenseTimer); };
}
