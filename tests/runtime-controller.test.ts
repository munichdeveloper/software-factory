import { Pool, type PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { RuntimeController, type RuntimeRepository } from '../src/runtime/controller.js';
import { RuntimeStore, type StoredRun } from '../src/runtime/store.js';
import { type Admission, type RuntimeRelease } from '../src/runtime/contract.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner } from '../src/llm/provider.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';
import { hash } from '../src/state/identity.js';
import type { WorkerResult } from '../src/workers/contract.js';
import { createActivities } from '../src/runtime/worker.js';
import type { CodingArtifact } from '../src/workers/coding.js';

class MemoryStore extends RuntimeStore {
  row: StoredRun | null = null; effect = false; private tail = Promise.resolve();
  codingArtifact: CodingArtifact | null = null;
  constructor() { super(new Pool()); }
  override async get() { return this.row; }
  override async insert(snapshot: StoredRun['snapshot'], binding: string, workflowId: string) {
    if (this.row && this.row.binding !== binding) throw new Error('SNAPSHOT_CONFLICT');
    return this.row ??= { snapshot, binding, workflowId, runId: null, createdAt: clock.toISOString(), approved: false, cancelled: false, terminal: false, result: null };
  }
  override async started(_repositoryId: number, _executionId: string, runId: string) { this.row!.runId = runId; }
  override async complete(_repositoryId: number, _executionId: string, result: WorkerResult) { this.row!.result = result; this.row!.terminal = true; }
  override async terminal() { this.row!.terminal = true; }
  override async artifact() { return this.codingArtifact; }
  override async saveArtifact(_repo: number, _id: string, artifact: CodingArtifact) { this.codingArtifact = artifact; }
  override async cancel() { this.row!.cancelled = true; this.row!.approved = false; }
  override async gate(_repositoryId: number, _executionId: string, binding: string, _actor: string, approved: boolean) {
    if (this.row?.binding !== binding || this.row.terminal || this.row.cancelled) throw new Error('STALE_APPROVAL'); this.row.approved = approved;
  }
  override async locked<T>(_repositoryId: number, _executionId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const previous = this.tail; let unlock!: () => void; this.tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
    try { return await work({ query: async (sql: string) => {
      if (sql.startsWith('SELECT')) return { rows: this.effect ? [{ payload_hash: 'recorded', phase: 'attempted' }] : [] };
      if (sql.startsWith('INSERT')) this.effect = true;
      return { rows: [] };
    } } as unknown as PoolClient); } finally { unlock(); }
  }
}
const release: RuntimeRelease = { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'factory-runtime', buildId: 'v1', taskQueue: 'factory-runtime', schemaVersion: 1 };
async function fixture(requireHumanGate = true, coding = false) {
  const cfg = config(), github = new MemoryGitHub(); cfg.execution.engine = 'temporal'; github.state.issues.push(issue());
  if (coding) cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null };
  let admission!: Admission;
  await new Manager(github, cfg, new MockPlanner(), { correlationId: 'prepare', now: () => clock,
    workerRuntime: { observations: async () => [], cancel: async () => {}, start: async value => { admission = value; throw new Error('test captures admission'); } } }).run();
  const store = new MemoryStore(), runId = '00000000-0000-4000-8000-000000000001';
  let status = 'RUNNING';
  const signal = vi.fn(async () => {});
  const handle = { firstExecutionRunId: runId, describe: async () => ({ runId, status: { name: status } }),
    query: async () => ({ phase: 'awaiting-approval', binding: store.row!.binding, result: null }), signal,
    fetchHistory: async () => ({ events: [{ workflowExecutionStartedEventAttributes: { input: { payloads: [{}, { data: Buffer.from(JSON.stringify(store.row!.binding)) }] } } }] }) };
  const deployment = vi.fn(async () => ({ workerDeploymentVersionInfo: { deploymentVersion: { deploymentName: release.deploymentName, buildId: release.buildId } } }));
  const start = vi.fn(async () => handle), client = { options: { namespace: 'test' }, workflowService: { describeWorkerDeploymentVersion: deployment }, workflow: { start, getHandle: () => handle } } as unknown as Client;
  const repo: RuntimeRepository = { repositoryId: 42, repository: github.repository, release, github, requireHumanGate, config: async () => cfg, baseSha: async () => 'd'.repeat(40) };
  const controller = new RuntimeController(repo, store, client);
  const result: WorkerResult = { contractVersion: '1.0', executionId: admission.input.executionId, issueNumber: 1, status: 'success', summary: 'Verified result', artifacts: [], error: null, proposedActions: [] };
  return { cfg, github, store, start, deployment, signal, handle, repo, controller, admission, result, status: (value: string) => { status = value; } };
}
describe('Temporal admission, identity and approval', () => {
  it('freezes canary branch/workflow and rejects later target changes', async () => {
    const f = await fixture(); f.repo.baseRef = 'test/temporal-rc'; f.repo.executorWorkflow = 'factory-manager.yml';
    await f.controller.start(f.admission); expect(f.store.row!.snapshot).toMatchObject({baseRef:'test/temporal-rc',executorWorkflow:'factory-manager.yml'});
    f.repo.baseRef = 'main'; await expect(f.controller.gate(f.result.executionId,f.store.row!.binding,'maintainer',true)).rejects.toThrow('STALE_SNAPSHOT');
  });
  it('cannot cancel, observe or approve unrelated persisted runs through a canary binding', async () => {
    const f = await fixture(); await f.controller.start(f.admission); f.repo.issueNumbers = [2];
    await expect(f.controller.cancel(f.result.executionId)).rejects.toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
    await expect(f.controller.observations([f.result.executionId])).rejects.toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
    await expect(f.controller.gate(f.result.executionId,f.store.row!.binding,'maintainer',true)).rejects.toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
    expect(f.store.row!.cancelled).toBe(false); expect(f.store.row!.approved).toBe(false);
  });
  it('does not persist or start admission for an unknown deployment or unavailable Temporal', async () => {
    const f = await fixture(); f.deployment.mockRejectedValueOnce(new Error('Unknown version'));
    await expect(f.controller.start(f.admission)).rejects.toThrow('Unknown version'); expect(f.store.row).toBeNull(); expect(f.start).not.toHaveBeenCalled();
    f.deployment.mockResolvedValueOnce({ workerDeploymentVersionInfo: { deploymentVersion: { deploymentName: release.deploymentName, buildId: 'unknown' } } });
    await expect(f.controller.start(f.admission)).rejects.toThrow('UNKNOWN_WORKER_DEPLOYMENT_VERSION'); expect(f.store.row).toBeNull();
  });
  it('starts one pinned execution and reuses the exact run on repeat', async () => {
    const f = await fixture(); const first = await f.controller.start(f.admission), repeat = await f.controller.start(f.admission);
    expect(first).toEqual(repeat); expect(f.start).toHaveBeenCalledOnce(); expect(f.start.mock.calls[0]![1]).toMatchObject({ versioningOverride: { pinnedTo: { deploymentName: release.deploymentName, buildId: release.buildId } } });
  });
  it('blocks altered admissions, unknown intents and cross-repository requests', async () => {
    const f = await fixture(); await expect(f.controller.start({ ...f.admission, actionId: 'e'.repeat(64) })).rejects.toThrow('NO_MATCHING_INTENT');
    await expect(f.controller.start({ ...f.admission, input: { ...f.admission.input, repository: 'other/repo' } })).rejects.toThrow('REPOSITORY_MISMATCH');
    await f.controller.start(f.admission); await expect(f.controller.start({ ...f.admission, policyHash: 'f'.repeat(64) })).rejects.toThrow('ADMISSION_CONFLICT');
  });
  it('reconciles a lost Temporal start receipt by checking the recorded input binding', async () => {
    const f = await fixture(); await f.controller.start(f.admission); f.store.row!.runId = null;
    f.start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('duplicate', 'existing', 'factoryExecution'));
    const result = await f.controller.start(f.admission); expect(result.runId).toBe(f.handle.firstExecutionRunId);
  });
  it('blocks a name collision with different immutable input', async () => {
    const f = await fixture(); await f.controller.start(f.admission); f.store.row!.runId = null;
    f.start.mockRejectedValueOnce(new WorkflowExecutionAlreadyStartedError('duplicate', 'existing', 'factoryExecution'));
    f.handle.fetchHistory = async () => ({ events: [{ workflowExecutionStartedEventAttributes: { input: { payloads: [{}, { data: Buffer.from('"forged"') }] } } }] });
    await expect(f.controller.start(f.admission)).rejects.toThrow('WORKFLOW_BINDING_CONFLICT');
  });
  it('rejects a forged actor, stale approval and changed task before execution', async () => {
    const f = await fixture(); await f.controller.start(f.admission); const row = f.store.row!;
    await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('APPROVAL_REQUIRED');
    await expect(f.controller.gate(f.result.executionId, row.binding, 'attacker', true)).rejects.toThrow('ACTOR_NOT_AUTHORIZED');
    await expect(f.controller.gate(f.result.executionId, 'f'.repeat(64), 'maintainer', true)).rejects.toThrow('STALE_APPROVAL');
    await f.controller.gate(f.result.executionId, row.binding, 'maintainer', true); await expect(f.controller.authorize(row.snapshot, row.binding)).resolves.toBeTruthy();
    f.github.state.issues[0]!.body += '\nChanged scope'; await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('DELEGATION_REVOKED');
  });
  it('preserves a retained old release, but blocks unreviewed release/config/base changes', async () => {
    const f = await fixture(false); await f.controller.start(f.admission); const row = f.store.row!;
    f.repo.release = { ...release, buildId: 'v2' };
    await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('STALE_SNAPSHOT');
    Object.assign(f.repo, { retainedReleases: [release] }); await expect(f.controller.authorize(row.snapshot, row.binding)).resolves.toBeTruthy();
    f.cfg.execution.maxRetries++; await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('STALE_SNAPSHOT'); f.cfg.execution.maxRetries--;
    f.repo.baseSha = async () => 'e'.repeat(40); await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('STALE_SNAPSHOT');
  });
  it('revokes approval and preserves cancellation independently of wake-up signal delivery', async () => {
    const f = await fixture(); await f.controller.start(f.admission); const row = f.store.row!;
    await f.controller.gate(f.result.executionId, row.binding, 'maintainer', true); await f.controller.gate(f.result.executionId, row.binding, 'maintainer', false);
    expect(await f.controller.gateApproved(row.snapshot, row.binding)).toBe(false); await f.controller.cancel(f.result.executionId);
    await expect(f.controller.authorize(row.snapshot, row.binding)).rejects.toThrow('UNKNOWN_OR_CANCELLED_RUN');
    f.status('COMPLETED'); expect((await f.controller.observations([f.result.executionId]))[0]!.status).toBe('cancelled');
  });
});
describe('durable result outbox', () => {
  it('persists a correlated coding artifact, publishes a draft result and reuses it after restart', async () => {
    const f = await fixture(true, true); await f.controller.start(f.admission); const row = f.store.row!;
    const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: row.snapshot.baseSha,
      result: { contractVersion: '2.0', executionId: f.admission.input.executionId, taskId: `github:${f.github.repository}#1`, taskVersion: f.admission.input.taskVersion,
        status: 'success', summary: 'Implemented and tested', artifacts: [], error: null }, changes: [{ path: 'result.txt', content: 'eA==', mode: '100644' }] };
    const poll = vi.fn(async () => ({ artifact })), publish = vi.fn(async () => ({ url: 'https://github.com/owner/target/pull/3' }));
    Object.assign(f.repo, { coding: { executor: { poll, cancel: vi.fn(async () => {}) }, publish } });
    await expect(f.controller.executeCoding(row.snapshot, row.binding)).rejects.toThrow('APPROVAL_REQUIRED');
    await f.controller.gate(f.result.executionId, row.binding, 'maintainer', true);
    const result = (await f.controller.executeCoding(row.snapshot, row.binding))!;
    expect(await f.controller.executeCoding(row.snapshot, row.binding)).toEqual(result); expect(poll).toHaveBeenCalledOnce();
    await expect(f.controller.publish(row.snapshot, row.binding, { ...result, summary: 'forged' })).rejects.toThrow('RESULT_CONFLICT');
    const final = await f.controller.publish(row.snapshot, row.binding, result); expect(final.artifacts).toEqual(['https://github.com/owner/target/pull/3']);
    f.github.state.issues[0]!.body += '\nLater task change';
    expect(await f.controller.publish(row.snapshot, row.binding, result)).toEqual(final); expect(publish).toHaveBeenCalledOnce();
  });
  it('rejects an executor artifact belonging to a different base before persisting it', async () => {
    const f = await fixture(false, true); await f.controller.start(f.admission); const row = f.store.row!;
    Object.assign(f.repo, { coding: { executor: { poll: async () => ({ artifact: { baseSha: 'f'.repeat(40), result: {} } }) } } });
    await expect(f.controller.executeCoding(row.snapshot, row.binding)).rejects.toThrow('UNRELATED_EXECUTOR_ARTIFACT'); expect(f.store.codingArtifact).toBeNull();
  });
  it('reconciles after GitHub accepted a write but its response was lost', async () => {
    const f = await fixture(false); await f.controller.start(f.admission); const row = f.store.row!;
    const original = f.github.writeEvent.bind(f.github); let lose = true;
    vi.spyOn(f.github, 'writeEvent').mockImplementation(async (issue, event) => { await original(issue, event); if (event.data.type === 'result' && lose) { lose = false; throw new Error('lost response'); } });
    await expect(f.controller.publish(row.snapshot, row.binding, f.result)).rejects.toThrow('lost response');
    expect(await f.controller.publish(row.snapshot, row.binding, f.result)).toEqual(f.result);
    expect((f.github.state.comments.get(1) ?? []).filter(c => c.body.includes('Verified result'))).toHaveLength(1);
    f.github.state.issues[0]!.body += '\nLater changed task';
    expect(await f.controller.publish(row.snapshot, row.binding, f.result)).toEqual(f.result);
  });
  it('does not blindly repeat an uncertain publication without evidence', async () => {
    const f = await fixture(false); await f.controller.start(f.admission); const row = f.store.row!;
    vi.spyOn(f.github, 'writeEvent').mockRejectedValue(new Error('uncertain request'));
    await expect(f.controller.publish(row.snapshot, row.binding, f.result)).rejects.toThrow('uncertain request');
    await expect(f.controller.publish(row.snapshot, row.binding, f.result)).rejects.toThrow('PUBLICATION_UNCERTAIN');
  });
  it('serializes concurrent publications and rejects unrelated or conflicting results', async () => {
    const f = await fixture(false); await f.controller.start(f.admission); const row = f.store.row!;
    await Promise.all([f.controller.publish(row.snapshot, row.binding, f.result), f.controller.publish(row.snapshot, row.binding, f.result)]);
    expect((f.github.state.comments.get(1) ?? []).filter(c => c.body.includes('Verified result'))).toHaveLength(1);
    await expect(f.controller.publish(row.snapshot, row.binding, { ...f.result, summary: 'conflict' })).rejects.toThrow('RESULT_CONFLICT');
    await expect(f.controller.publish(row.snapshot, row.binding, { ...f.result, executionId: 'f'.repeat(32) })).rejects.toThrow('RESULT_MISMATCH');
  });
  it('correlates worker calls with the exact built release before broker access', async () => {
    const f = await fixture(false); await f.controller.start(f.admission); const row = f.store.row!, broker = vi.fn(async () => true);
    const activities = createActivities({ release, bundlePath: '/unused', harnessEntrypoint: '/unused', harnessEntrypointHash: 'a'.repeat(64) }, broker);
    expect(await activities.gateApproved(row.snapshot, row.binding)).toBe(true); await activities.authorize(row.snapshot, row.binding);
    await expect(activities.authorize({ ...row.snapshot, release: { ...release, buildId: 'forged' } }, row.binding)).rejects.toThrow('WORKER_RELEASE_MISMATCH');
    expect(hash(row.snapshot)).toBe(row.binding);
  });
});
