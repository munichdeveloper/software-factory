import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { RuntimeController, type RuntimeRepository } from '../src/runtime/controller.js';
import { RuntimeStore, type StoredRun } from '../src/runtime/store.js';
import type { RuntimeRelease } from '../src/runtime/contract.js';
import { authorizeReadyLabel } from '../src/runtime/ready-approval.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { decodeEvent } from '../src/state/events.js';
import type { BlockLabelEvent } from '../src/types.js';
import type { WorkerResult } from '../src/workers/contract.js';
import { config, issue, MemoryGitHub } from './helpers.js';

const bot = 'github-actions[bot]';
/** Records native harness:ready label events with their real actor, as the GitHub timeline does. */
class TimelineGitHub extends MemoryGitHub {
  private readyBy = new Map<number, BlockLabelEvent[]>(); private nextReady = 1000;
  readyFor(number: number) { let events = this.readyBy.get(number); if (!events) this.readyBy.set(number, events = []); return events; }
  get ready() { return this.readyFor(1); }
  now = new Date('2026-11-10T08:00:00.000Z');
  private record(number: number, labels: string[], actor: string) {
    const before = this.state.issues.find(i => i.number === number)!.labels.includes('harness:ready'), after = labels.includes('harness:ready');
    if (before !== after) this.readyFor(number).push({ id: this.nextReady++, event: after ? 'labeled' : 'unlabeled', actor, createdAt: this.now.toISOString() });
  }
  override async updateIssue(number: number, update: { labels?: string[]; state?: 'open' | 'closed' }) {
    if (update.labels) this.record(number, update.labels, bot);
    await super.updateIssue(number, update);
  }
  human(number: number, labels: string[], actor = 'maintainer') {
    this.record(number, labels, actor); this.state.issues.find(i => i.number === number)!.labels = labels;
  }
}
class MapStore extends RuntimeStore {
  rows = new Map<string, StoredRun>();
  constructor() { super(new Pool()); }
  override async get(_repo: number, id: string) { return this.rows.get(id) ?? null; }
  override async insert(snapshot: StoredRun['snapshot'], binding: string, workflowId: string) {
    const id = snapshot.admission.input.executionId, row = this.rows.get(id) ?? { snapshot, binding, workflowId, runId: null, createdAt: new Date().toISOString(), approved: false, cancelled: false, terminal: false, result: null };
    this.rows.set(id, row); return row;
  }
  override async started(_repo: number, id: string, runId: string) { this.rows.get(id)!.runId = runId; }
  override async complete(_repo: number, id: string, result: WorkerResult) { Object.assign(this.rows.get(id)!, { result, terminal: true }); }
  override async terminal(_repo: number, id: string) { this.rows.get(id)!.terminal = true; }
  override async locked<T>(_repo: number, _id: string, work: (client: PoolClient) => Promise<T>): Promise<T> { return work({} as PoolClient); }
}
const release: RuntimeRelease = { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'factory-runtime', buildId: 'v1', taskQueue: 'factory-runtime', schemaVersion: 1 };

function fixture() {
  const cfg = config(), github = new TimelineGitHub(), store = new MapStore();
  cfg.execution.engine = 'temporal';
  github.state.issues.push(issue(1, ['harness:managed']));
  const status = new Map<string, string>(); let runs = 0;
  const handleFor = (workflowId: string) => {
    const row = [...store.rows.values()].find(r => r.workflowId === workflowId)!;
    return { describe: async () => ({ runId: row.runId, status: { name: status.get(workflowId) ?? 'RUNNING' } }),
      query: async () => ({ phase: 'running', binding: row.binding, result: null }), signal: async () => {} };
  };
  let deploymentBuild = release.buildId, startError: Error | null = null;
  const client = { options: { namespace: 'test' },
    workflowService: { describeWorkerDeploymentVersion: async () => ({ workerDeploymentVersionInfo: { deploymentVersion: { deploymentName: release.deploymentName, buildId: deploymentBuild } } }) },
    workflow: { start: async (_type: string, options: { workflowId: string }) => { if (startError) throw startError; status.set(options.workflowId, 'RUNNING'); return { firstExecutionRunId: `00000000-0000-4000-8000-00000000000${++runs}` }; },
      getHandle: (workflowId: string) => handleFor(workflowId) } } as unknown as Client;
  const repo: RuntimeRepository = { repositoryId: 42, repository: github.repository, release, github, requireHumanGate: false, config: async () => cfg, baseSha: async () => 'd'.repeat(40),
    readyApproval: async (number, expected) => authorizeReadyLabel(await github.getIssue(number), github.readyFor(number), actor => github.canApprove(actor), cfg.manager.trustedActors, expected) };
  const controller = new RuntimeController(repo, store, client);
  const manager = () => new Manager(github, cfg, new MockPlanner(), { correlationId: 'temporal:42', now: () => github.now, workerRuntime: controller }).run();
  const events = () => (github.state.comments.get(1) ?? []).flatMap(c => { const e = decodeEvent(c, cfg.manager.trustedActors); return e ? [e.data] : []; });
  const advance = (minutes: number) => { github.now = new Date(github.now.getTime() + minutes * 60000); };
  /** The worker returns a blocked result for the latest execution, as the first Backofficer#13 run did. */
  const finishBlocked = async () => {
    const row = [...store.rows.values()].at(-1)!, input = row.snapshot.admission.input;
    const result: WorkerResult = { contractVersion: '1.0', executionId: input.executionId, issueNumber: 1, status: 'blocked', summary: 'Validation unavailable', artifacts: [], error: null, proposedActions: [] };
    await store.complete(42, input.executionId, result); status.set(row.workflowId, 'COMPLETED');
  };
  return { cfg, github, store, repo, manager, events, advance, finishBlocked,
    unknownDeployment: () => { deploymentBuild = 'other'; }, failStart: (error: Error) => { startError = error; } };
}
const labels = (f: ReturnType<typeof fixture>) => f.github.state.issues[0]!.labels.filter(l => l !== 'harness:managed');

/** First run ends blocked; the human revises the task, clears the block and merges the review PR into a test branch. */
async function blockedThenRevised(f: ReturnType<typeof fixture>) {
  f.github.human(1, ['harness:managed', 'harness:ready']);
  await f.manager(); expect(labels(f)).toEqual(['harness:running']);
  await f.finishBlocked(); f.advance(10);
  await f.manager(); expect(labels(f)).toEqual(['harness:blocked']);
  f.advance(600);
  f.github.state.prs.push({ number: 14, state: 'open', merged: false, closingIssues: [], referencedIssues: [1] });
  f.github.state.issues[0]!.body += '\n## Resume\nPrepare a deployable test version.\n';
  f.github.labelBlock(1, false);
  await f.manager(); expect(labels(f)).toEqual(['harness:awaiting-pr']);
  f.advance(6); Object.assign(f.github.state.prs[0]!, { state: 'closed', merged: true, mergedAt: f.github.now.toISOString() });
  f.advance(1);
}
const intents = (f: ReturnType<typeof fixture>) => f.events().filter(e => e.type === 'intent').length;

describe('resuming a ready-label task after a blocked run (Backofficer#13)', () => {
  it('leaves the grant label to a person after a revision and creates no intent without it', async () => {
    const f = fixture(); await blockedThenRevised(f);
    // Reconciliation once moved awaiting-pr to ready on its own; the runtime then refused that label as a grant.
    const resumed = await f.manager();
    expect(f.github.ready.some(e => e.event === 'labeled' && e.actor === bot)).toBe(false);
    expect(labels(f)).toEqual(['harness:backlog']);
    expect(intents(f)).toBe(1); expect(f.store.rows.size).toBe(1);
    expect(resumed.errors).toEqual([]);
    expect(resumed.blockers.some(b => b.startsWith('#1: runtime admission rejected (READY_') && b.endsWith('no execution was created'))).toBe(true);
    expect(resumed.nextSteps.some(step => step.includes('authorized human must apply harness:ready'))).toBe(true);
    f.advance(30); const later = await f.manager();
    expect(labels(f)).toEqual(['harness:backlog']);
    expect(later.blockers.some(b => b.includes('uncertain'))).toBe(false);
    expect(f.events().filter(e => e.type === 'block_intent' && e.cause === 'dispatch')).toEqual([]);
  });
  it('starts exactly one new run once an authorized human re-applies the native label', async () => {
    const f = fixture(); await blockedThenRevised(f); await f.manager();
    f.github.human(1, ['harness:managed']); f.github.human(1, ['harness:managed', 'harness:ready']);
    const granted = await f.manager();
    expect(granted.errors).toEqual([]); expect(granted.blockers).toEqual([]);
    expect(labels(f)).toEqual(['harness:running']);
    expect(intents(f)).toBe(2); expect(f.store.rows.size).toBe(2);
    expect([...f.store.rows.values()].at(-1)!.snapshot.readyApproval).toMatchObject({ actor: 'maintainer' });
    await f.manager(); expect(intents(f)).toBe(2);
  });
  it('accepts a human grant given before reconciliation without a detour', async () => {
    const f = fixture(); await blockedThenRevised(f);
    f.github.human(1, ['harness:managed', 'harness:ready']);
    const report = await f.manager();
    expect(report.errors).toEqual([]); expect(labels(f)).toEqual(['harness:running']); expect(intents(f)).toBe(2);
  });
  it('closes an intent with a definite cancelled result when the runtime rejects admission after the intent', async () => {
    const f = fixture(); f.github.human(1, ['harness:managed', 'harness:ready']);
    // The grant is withdrawn between the Manager preflight and admission.
    const original = f.repo.readyApproval!; let calls = 0;
    f.repo.readyApproval = async (number, expected) => { if (++calls > 1) throw new Error('READY_APPROVAL_REVOKED'); return original(number, expected); };
    const report = await f.manager();
    expect(report.errors).toEqual([]);
    expect(report.blockers).toContain('#1: runtime admission rejected (READY_APPROVAL_REVOKED); the execution was closed as cancelled');
    expect(f.store.rows.size).toBe(0);
    expect(f.events().find(e => e.type === 'result')).toMatchObject({ result: { status: 'cancelled', error: 'READY_APPROVAL_REVOKED' } });
    f.repo.readyApproval = async () => { throw new Error('READY_APPROVAL_REVOKED'); };
    f.advance(30); const later = await f.manager();
    expect(later.blockers.some(b => b.includes('uncertain'))).toBe(false);
    expect(labels(f)).not.toContain('harness:blocked');
  });
  it('names a fixed policy code for failures that still abort the run, without leaking other messages', async () => {
    const f = fixture(); f.github.human(1, ['harness:managed', 'harness:ready']);
    delete f.repo.readyApproval; f.unknownDeployment();
    expect((await f.manager()).blockers).toContain('#1: runtime admission rejected (UNKNOWN_WORKER_DEPLOYMENT_VERSION); the execution was closed as cancelled');
    const g = fixture(); g.github.human(1, ['harness:managed', 'harness:ready']);
    g.failStart(new Error('connect ECONNREFUSED 10.0.0.1:7233 password=secret'));
    const report = await g.manager();
    expect(report.errors).toEqual(['Action start_worker on #1 failed (HTTP unknown); durable intents preserved for recovery']);
  });
});

describe('recovering an intent the runtime has no record of', () => {
  /** The grant lookup fails with a transport error once: the intent is written, nothing is persisted or started. */
  async function dangling(f: ReturnType<typeof fixture>) {
    f.github.human(1, ['harness:managed', 'harness:ready']);
    const original = f.repo.readyApproval!; let calls = 0;
    f.repo.readyApproval = async (number, expected) => { if (++calls === 2) throw new Error('GitHub 502 for https://api.github.com'); return original(number, expected); };
    const report = await f.manager();
    expect(report.errors).toEqual(['Action start_worker on #1 failed (HTTP unknown); durable intents preserved for recovery']);
    expect(intents(f)).toBe(1); expect(f.store.rows.size).toBe(0); expect(f.events().some(e => e.type === 'temporal_receipt')).toBe(false);
  }
  it('starts the original execution on the next run while the human grant still holds', async () => {
    const f = fixture(); await dangling(f);
    f.advance(1); const report = await f.manager();
    expect(report.errors).toEqual([]); expect(report.blockers).toEqual([]);
    expect(intents(f)).toBe(1); expect(f.store.rows.size).toBe(1);
    expect(f.events().filter(e => e.type === 'temporal_receipt')).toHaveLength(1);
    expect(labels(f)).toEqual(['harness:running']);
    f.advance(30); await f.manager();
    expect(intents(f)).toBe(1); expect(f.store.rows.size).toBe(1); expect(labels(f)).toEqual(['harness:running']);
  });
  it('closes the intent with the runtime reason once the grant is gone, even after it was blocked as uncertain', async () => {
    const f = fixture(); await dangling(f);
    // State as left behind on Backofficer#13: no grant any more and the task already blocked as an uncertain dispatch.
    f.github.human(1, ['harness:managed']);
    f.github.state.issues[0]!.labels = ['harness:managed', 'harness:running'];
    const recover = Manager.prototype as unknown as { recover: () => Promise<boolean> }, real = recover.recover;
    recover.recover = async () => false;
    try { f.advance(30); const stuck = await f.manager(); expect(stuck.blockers.some(b => b.includes('uncertain'))).toBe(true); expect(labels(f)).toEqual(['harness:blocked']); }
    finally { recover.recover = real; }
    f.advance(1); const report = await f.manager();
    expect(report.blockers.some(b => b.includes('uncertain'))).toBe(false);
    expect(report.blockers).toContain('#1: runtime admission rejected (READY_APPROVAL_REVOKED); the execution was closed as cancelled');
    expect(f.events().find(e => e.type === 'result')).toMatchObject({ result: { status: 'cancelled', error: 'READY_APPROVAL_REVOKED' } });
    expect(f.store.rows.size).toBe(0);
    f.advance(30); const later = await f.manager();
    expect(later.blockers.some(b => b.includes('uncertain'))).toBe(false); expect(intents(f)).toBe(1);
  });
  it('keeps the intent unresolved while the runtime cannot answer, and never recovers dry-run tasks', async () => {
    const f = fixture(); await dangling(f);
    f.repo.readyApproval = async () => { throw new Error('GitHub 502 for https://api.github.com'); };
    f.advance(1); const failing = await f.manager();
    expect(failing.errors.some(e => /^Recovery of execution [a-f0-9]{32} on #1 failed; the intent remains unresolved$/.test(e))).toBe(true);
    expect(f.events().some(e => e.type === 'result')).toBe(false);
    const g = fixture(); await dangling(g); g.cfg.execution.dryRun = true;
    g.advance(1); await g.manager(); expect(g.store.rows.size).toBe(0);
  });
  it('closes the intent of a closed task so it stops occupying a worker slot (Backofficer#13 after #21)', async () => {
    const f = fixture(); await dangling(f);
    // The stuck task is closed and replaced by a new one, which a human grants.
    f.github.state.issues[0]!.state = 'closed';
    f.github.state.issues.push(issue(2, ['harness:managed']));
    f.github.human(2, ['harness:managed', 'harness:ready']);
    f.advance(30); const report = await f.manager();
    expect(report.decisions.filter(d => d.decision.reason === 'Maximum parallel workers reached')).toEqual([]);
    expect(f.events().find(e => e.type === 'result')).toMatchObject({ result: { status: 'cancelled', executionId: expect.stringMatching(/^[a-f0-9]{32}$/) } });
    expect(f.store.rows.size).toBe(1);
    expect([...f.store.rows.values()][0]!.snapshot.admission.input.issueNumber).toBe(2);
    expect(f.github.state.issues[1]!.labels).toContain('harness:running');
  });
  it('also closes the intent of a closed task when no ready-label grant is configured', async () => {
    const f = fixture(); await dangling(f);
    delete f.repo.readyApproval; f.github.state.issues[0]!.state = 'closed';
    f.advance(30); const report = await f.manager();
    expect(report.blockers).toContain('#1: runtime admission rejected (DELEGATION_REVOKED); the execution was closed as cancelled');
    expect(f.store.rows.size).toBe(0);
    expect(f.events().find(e => e.type === 'result')).toMatchObject({ result: { status: 'cancelled', error: 'DELEGATION_REVOKED' } });
  });
});
