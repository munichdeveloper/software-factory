import { Pool, type PoolClient } from 'pg';
import type { Client } from '@temporalio/client';
import { RuntimeController, type RuntimeRepository } from '../src/runtime/controller.js';
import { RuntimeStore, type StoredRun } from '../src/runtime/store.js';
import type { RuntimeRelease } from '../src/runtime/contract.js';
import { authorizeReadyLabel } from '../src/runtime/ready-approval.js';
import { Manager } from '../src/manager/index.js';
import type { RunReport } from '../src/manager/report.js';
import { MockPlanner } from '../src/llm/provider.js';
import { decodeEvent, type HarnessEvent } from '../src/state/events.js';
import { lifecycleLabels } from '../src/state/lifecycle.js';
import type { BlockLabelEvent, Issue } from '../src/types.js';
import type { WorkerResult } from '../src/workers/contract.js';
import { config, issue, MemoryGitHub } from './helpers.js';
import type { CodingArtifact } from '../src/workers/coding.js';
import { defaultValidationPlan, type ValidationReport } from '../src/runtime/validation-contract.js';
import { reworkOf } from '../src/runtime/coding-context.js';
import { hash } from '../src/state/identity.js';

export const bot = 'github-actions[bot]';
const transport = (what: string) => Object.assign(new Error(`${what} unavailable: connect ECONNREFUSED`), { status: 502 });

/**
 * GitHub as the Factory sees it: issues, journal comments and the native label timeline with the real actor
 * of every harness:ready change. Writes can be made to fail to place a crash between any two effects.
 */
export class TimelineGitHub extends MemoryGitHub {
  private readyBy = new Map<number, BlockLabelEvent[]>(); private nextReady = 1000;
  now = new Date('2026-11-10T08:00:00.000Z');
  /** Number of upcoming writes that fail with a transport error before reaching GitHub. */
  failWrites = 0;
  readyFor(number: number) { let events = this.readyBy.get(number); if (!events) this.readyBy.set(number, events = []); return events; }
  private task(number: number) { return this.state.issues.find(i => i.number === number)!; }
  private record(number: number, labels: string[], actor: string) {
    const before = this.task(number).labels.includes('harness:ready'), after = labels.includes('harness:ready');
    if (before !== after) this.readyFor(number).push({ id: this.nextReady++, event: after ? 'labeled' : 'unlabeled', actor, createdAt: this.now.toISOString() });
  }
  private write() { if (this.failWrites > 0) { this.failWrites--; throw transport('GitHub'); } }
  /** How often the readable status comment of any task was created or edited. */
  statusWrites = 0;
  override async writeComment(number: number, body: string, id?: number) { this.write(); this.statusWrites++; await super.writeComment(number, body, id); }
  override async writeEvent(number: number, event: HarnessEvent) { this.write(); await super.writeEvent(number, event); }
  override async updateIssue(number: number, update: { labels?: string[]; state?: 'open' | 'closed' }) {
    this.write();
    if (update.labels) this.record(number, update.labels, bot);
    await super.updateIssue(number, update);
  }
  /** A person changes labels in the GitHub UI. */
  human(number: number, labels: string[], actor = 'maintainer') { this.record(number, labels, actor); this.task(number).labels = labels; }
}

/** The broker database: runs and the effect claims of result publication. */
export class MapStore extends RuntimeStore {
  rows = new Map<string, StoredRun>(); private effects = new Map<string, { payload_hash: string; phase: string }>();
  constructor(private clock: () => Date) { super(new Pool()); }
  override async get(_repo: number, id: string) { return this.rows.get(id) ?? null; }
  override async insert(snapshot: StoredRun['snapshot'], binding: string, workflowId: string) {
    const id = snapshot.admission.input.executionId;
    const row = this.rows.get(id) ?? { snapshot, binding, workflowId, runId: null, createdAt: this.clock().toISOString(), approved: false, cancelled: false, terminal: false, result: null };
    this.rows.set(id, row); return row;
  }
  override async started(_repo: number, id: string, runId: string) { this.rows.get(id)!.runId = runId; }
  override async complete(_repo: number, id: string, result: WorkerResult) { Object.assign(this.rows.get(id)!, { result, terminal: true }); }
  override async terminal(_repo: number, id: string) { this.rows.get(id)!.terminal = true; }
  override async cancel(_repo: number, id: string) { Object.assign(this.rows.get(id)!, { cancelled: true, approved: false }); }
  artifacts = new Map<string, CodingArtifact>(); validations = new Map<string, ValidationReport>();
  override async artifact(_repo: number, id: string) { return this.artifacts.get(id) ?? null; }
  override async validation(_repo: number, id: string) { return this.validations.get(id) ?? null; }
  override async saveArtifact(_repo: number, id: string, value: CodingArtifact) { this.artifacts.set(id, value); }
  override async saveValidation(_repo: number, id: string, value: ValidationReport) { this.validations.set(id, value); }
  override async gate(_repo: number, id: string, binding: string, _actor: string, approved: boolean) {
    const row = this.rows.get(id);
    if (!row || row.binding !== binding || row.terminal || row.cancelled) throw new Error('STALE_APPROVAL');
    row.approved = approved;
  }
  override async locked<T>(_repo: number, id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return work({ query: async (sql: string, values: unknown[]) => {
      const key = `${id}:${String(values.at(sql.startsWith('UPDATE') ? 3 : 2))}`;
      if (sql.startsWith('SELECT')) return { rows: this.effects.has(key) ? [this.effects.get(key)] : [] };
      if (sql.startsWith('INSERT')) this.effects.set(key, { payload_hash: String(values[3]), phase: String(values[4]) });
      if (sql.startsWith('UPDATE')) this.effects.get(key)!.phase = String(values[2]);
      return { rows: [] };
    } } as unknown as PoolClient);
  }
}

const release: RuntimeRelease = { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'factory-runtime', buildId: 'v1', taskQueue: 'factory-runtime', schemaVersion: 1 };
export type WorldOptions = { readyLabel?: boolean; humanGate?: boolean; maxParallelWorkers?: number; maxRetries?: number;
  /** Successful results open a pull request that only references the task, or one that closes it when merged. */
  pullRequests?: 'referencing' | 'closing';
  /** The coding worker with independent validation: results are artifacts with a bound validation report and a draft pull request. */
  coding?: boolean;
  /** A failed validation starts a further attempt (implies coding). */
  rework?: boolean };
export type Tick = { report?: RunReport; thrown?: string };

/** One repository under Factory management with the real Manager and RuntimeController; only I/O is simulated. */
export class World {
  readonly cfg = config(); readonly github = new TimelineGitHub(); readonly store = new MapStore(() => this.github.now);
  readonly repo: RuntimeRepository; readonly controller: RuntimeController;
  /** The Temporal service cannot be reached: starts, descriptions and queries fail. */
  temporalDown = false;
  /** The native label timeline cannot be read. */
  timelineDown = false;
  private workflows = new Map<string, string>(); private runs = 0;
  private outcomes = new Map<string, { artifact: CodingArtifact; validation: ValidationReport }>();
  readonly log: string[] = [];
  constructor(readonly options: WorldOptions = {}) {
    this.cfg.execution.engine = 'temporal';
    this.cfg.execution.maxParallelWorkers = options.maxParallelWorkers ?? 1;
    this.cfg.execution.maxRetries = options.maxRetries ?? 2;
    const down = () => { if (this.temporalDown) throw transport('Temporal'); };
    const handle = (workflowId: string) => {
      const row = () => [...this.store.rows.values()].find(r => r.workflowId === workflowId)!;
      return { describe: async () => { down(); return { runId: row().runId, status: { name: this.workflows.get(workflowId) ?? 'RUNNING' } }; },
        query: async () => { down(); const r = row(); return { phase: r.snapshot.requireHumanGate && !r.approved ? 'awaiting-approval' : 'running', binding: r.binding, result: null }; },
        // Temporal delivers the cancellation; the workflow ends as cancelled.
        signal: async (name: string) => { down(); if (name === 'cancelRequested') this.workflows.set(workflowId, 'CANCELLED'); } };
    };
    const client = { options: { namespace: 'test' },
      workflowService: { describeWorkerDeploymentVersion: async () => { down(); return { workerDeploymentVersionInfo: { deploymentVersion: { deploymentName: release.deploymentName, buildId: release.buildId } } }; } },
      workflow: { start: async (_type: string, start: { workflowId: string }) => { down(); this.workflows.set(start.workflowId, 'RUNNING'); return { firstExecutionRunId: `00000000-0000-4000-8000-${String(++this.runs).padStart(12, '0')}` }; },
        getHandle: handle } } as unknown as Client;
    this.repo = { repositoryId: 42, repository: this.github.repository, release, github: this.github, requireHumanGate: !!options.humanGate,
      config: async () => this.cfg, baseSha: async () => 'd'.repeat(40) };
    if (options.readyLabel) this.repo.readyApproval = async (number, expected, rework) => {
      if (this.timelineDown) throw transport('GitHub timeline');
      return authorizeReadyLabel(await this.github.getIssue(number), this.github.readyFor(number), actor => this.github.canApprove(actor), this.cfg.manager.trustedActors, expected, rework);
    };
    if (options.coding || options.rework) {
      this.cfg.execution.rework = !!options.rework;
      this.cfg.workers.coding = { enabled: true, agent: 'codex', model: 'test-model', reasoningEffort: 'high', validationWorkflow: null, loopback: false };
      this.repo.validationPlan = async () => defaultValidationPlan();
      this.repo.coding = { executor: { poll: async snapshot => this.outcomes.get(snapshot.admission.input.executionId) ?? null, cancel: async () => {} },
        // The broker's publisher: one draft pull request per attempt; a rework replaces the one it continues.
        publish: async snapshot => {
          const input = snapshot.admission.input, number = 1000 + this.github.state.prs.length, previous = reworkOf(input);
          for (const pr of this.github.state.prs) if (previous && pr.state === 'open' && pr.headRefName === `sf/issue-${input.issueNumber}/${previous}`) pr.state = 'closed';
          this.github.state.prs.push({ number, state: 'open', merged: false, closingIssues: [input.issueNumber], referencedIssues: [input.issueNumber], headRefName: `sf/issue-${input.issueNumber}/${input.executionId}` });
          return { url: `https://github.com/${this.github.repository}/pull/${number}` };
        } };
    }
    this.controller = new RuntimeController(this.repo, this.store, client);
  }
  get now() { return this.github.now; }
  advance(minutes: number) { this.github.now = new Date(this.github.now.getTime() + minutes * 60000); }
  issue(number: number): Issue { return this.github.state.issues.find(i => i.number === number)!; }
  status(number: number) { return this.issue(number).labels.filter(l => lifecycleLabels.includes(l)).map(l => l.slice('harness:'.length)); }
  /** The readable status comments of a task (there must never be more than one). */
  statusComments(number: number) { return (this.github.state.comments.get(number) ?? []).filter(c => c.body.startsWith('<!-- software-factory:status -->')).map(c => c.body); }
  events(number: number) {
    return (this.github.state.comments.get(number) ?? []).flatMap(c => { const e = decodeEvent(c, this.cfg.manager.trustedActors); return e ? [e.data] : []; });
  }

  /** One Manager reconciliation. A run that cannot even take a snapshot rejects; that is recorded, not thrown. */
  async tick(): Promise<Tick> {
    try {
      const report = await new Manager(this.github, this.cfg, new MockPlanner(), { correlationId: 'temporal:42', now: () => this.now, workerRuntime: this.controller }).run();
      this.log.push(`tick ${JSON.stringify({ errors: report.errors, blockers: report.blockers })}`); return { report };
    } catch (error) { const thrown = error instanceof Error ? error.message : String(error); this.log.push(`tick threw ${thrown}`); return { thrown }; }
  }

  // People.
  open(number: number, labels = ['harness:managed']) { this.github.state.issues.push(issue(number, labels)); this.log.push(`open #${number}`); }
  /** The grant: an authorized person applies harness:ready (removing it first if it is already there). */
  grant(number: number, actor = 'maintainer') {
    const rest = this.issue(number).labels.filter(l => !lifecycleLabels.includes(l));
    if (this.issue(number).labels.includes('harness:ready')) this.github.human(number, rest, actor);
    this.github.human(number, [...rest, 'harness:ready'], actor); this.log.push(`grant #${number} by ${actor}`);
  }
  revise(number: number) { this.issue(number).body += `\nRevision ${this.now.toISOString()}\n`; this.log.push(`revise #${number}`); }
  unblock(number: number) { this.github.labelBlock(number, false); this.log.push(`unblock #${number}`); }
  close(number: number) { this.issue(number).state = 'closed'; this.log.push(`close #${number}`); }
  reopen(number: number) { Object.assign(this.issue(number), { state: 'open', reopenedAt: this.now.toISOString() }); this.log.push(`reopen #${number}`); }
  async approve(executionId: string, actor = 'maintainer') {
    const row = this.store.rows.get(executionId)!; this.log.push(`approve ${executionId}`);
    try { await this.controller.gate(executionId, row.binding, actor, true); return true; } catch { return false; }
  }

  /** A person merges or closes an open pull request. */
  resolvePr(number: number, merge: boolean) {
    const pr = this.github.state.prs.find(p => p.number === number)!;
    Object.assign(pr, { state: 'closed', merged: merge, ...(merge ? { mergedAt: this.now.toISOString() } : {}) }); this.log.push(`${merge ? 'merge' : 'close'} PR ${number}`);
  }

  // The worker.
  /** Executions Temporal is running right now. */
  running() { return [...this.store.rows.values()].filter(r => r.runId && !r.terminal && this.workflows.get(r.workflowId) === 'RUNNING'); }
  /**
   * The worker finishes and publishes through the broker. When the broker refuses the publication
   * (grant revoked, task changed, closed), the workflow ends without a committed result.
   */
  async finish(executionId: string, status: WorkerResult['status'] = 'success') {
    const row = this.store.rows.get(executionId)!, input = row.snapshot.admission.input;
    const result: WorkerResult = { contractVersion: '1.0', executionId, issueNumber: input.issueNumber, status, summary: `Worker ${status}`, artifacts: [], error: null, proposedActions: [] };
    this.log.push(`finish ${executionId} #${input.issueNumber} ${status}`);
    try {
      await this.controller.publish(row.snapshot, row.binding, result); this.workflows.set(row.workflowId, 'COMPLETED');
      // A successful coding result is published as a pull request for the task.
      if (status === 'success' && this.options.pullRequests) this.github.state.prs.push({ number: 1000 + this.github.state.prs.length, state: 'open', merged: false,
        closingIssues: this.options.pullRequests === 'closing' ? [input.issueNumber] : [], referencedIssues: [input.issueNumber] });
      return true;
    }
    catch (error) { this.workflows.set(row.workflowId, 'FAILED'); this.log.push(`publish refused: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  /**
   * The coding worker hands in its changes and the independent validation reports on them; the broker binds both,
   * publishes the draft pull request and journals the result. Runs through the real controller.
   */
  async finishCoding(executionId: string, verdict: 'passed' | 'failed', model: 'success' | 'blocked' = 'success') {
    const row = this.store.rows.get(executionId)!, snapshot = row.snapshot, input = snapshot.admission.input, taskId = `github:${snapshot.repository}#${input.issueNumber}`;
    const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: snapshot.baseSha, changes: [{ path: 'src/change.txt', content: Buffer.from(executionId).toString('base64'), mode: '100644' }],
      result: { contractVersion: '2.0', executionId, taskId, taskVersion: input.taskVersion, status: model, summary: `Worker ${model}`, artifacts: [], error: null } };
    const run = 5000 + this.outcomes.size, check = (name: ValidationReport['checks'][number]['name'], ok = true) => ({ name, status: ok ? 'passed' as const : 'failed' as const, exitCode: ok ? 0 : 1 });
    const validation: ValidationReport = { version: 1, executionId, taskId, taskVersion: input.taskVersion, baseSha: snapshot.baseSha, artifactHash: hash(artifact), planHash: hash(snapshot.validationPlan),
      workflowRunId: run, sourceRunId: run, runAttempt: 1, status: verdict, reason: verdict === 'passed' ? 'CHECKS_COMPLETED' : 'CHECK_FAILED', modelSecretPresent: false, workspaceUnchanged: true,
      checks: [check('install'), check('test', verdict === 'passed'), check('build'), check('source-integrity')] };
    this.outcomes.set(executionId, { artifact, validation }); this.log.push(`finish ${executionId} #${input.issueNumber} model ${model}, validation ${verdict}`);
    try {
      const result = await this.controller.executeCoding(snapshot, row.binding);
      await this.controller.publish(snapshot, row.binding, result!); this.workflows.set(row.workflowId, 'COMPLETED'); return true;
    } catch (error) { this.workflows.set(row.workflowId, 'FAILED'); this.log.push(`publish refused: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }
  /** The workflow dies without publishing (worker lost, timeout on the Temporal side). */
  crash(executionId: string) { const row = this.store.rows.get(executionId)!; this.workflows.set(row.workflowId, 'FAILED'); this.log.push(`crash ${executionId}`); }
}
