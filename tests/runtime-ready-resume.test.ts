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
  ready: BlockLabelEvent[] = []; private nextReady = 1000; now = new Date('2026-11-10T08:00:00.000Z');
  private record(number: number, labels: string[], actor: string) {
    const before = this.state.issues.find(i => i.number === number)!.labels.includes('harness:ready'), after = labels.includes('harness:ready');
    if (before !== after) this.ready.push({ id: this.nextReady++, event: after ? 'labeled' : 'unlabeled', actor, createdAt: this.now.toISOString() });
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
    readyApproval: async (number, expected) => authorizeReadyLabel(await github.getIssue(number), github.ready, actor => github.canApprove(actor), cfg.manager.trustedActors, expected) };
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
  it('does not treat the ready status set by the Manager itself as a grant, and leaves no dangling intent', async () => {
    const f = fixture(); await blockedThenRevised(f);
    // Reconciliation moves awaiting-pr to ready on its own. That label event is authored by the trusted bot.
    const resumed = await f.manager();
    expect(f.github.ready.at(-1)).toMatchObject({ event: 'labeled', actor: bot });
    expect(labels(f)).toEqual(['harness:ready']);
    expect(intents(f)).toBe(1); expect(f.store.rows.size).toBe(1);
    expect(resumed.errors).toEqual([]);
    expect(resumed.blockers).toContain('#1: runtime admission rejected (READY_ACTOR_NOT_AUTHORIZED); no execution was created');
    expect(resumed.nextSteps.some(step => step.includes('authorized human must apply harness:ready'))).toBe(true);
    // Previously the intent without a receipt turned into "dispatch outcome uncertain" after the grace period.
    f.advance(30); const later = await f.manager();
    expect(labels(f)).toEqual(['harness:ready']);
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
