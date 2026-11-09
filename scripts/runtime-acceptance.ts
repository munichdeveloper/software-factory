import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { RuntimeStore } from '../src/runtime/store.js';
import { RuntimeController } from '../src/runtime/controller.js';
import { runtimeServer } from '../src/runtime/server.js';
import type { RuntimeRelease, RuntimeObservation } from '../src/runtime/contract.js';
import { MockPlanner } from '../src/llm/provider.js';
import { config, issue, MemoryGitHub } from '../tests/helpers.js';
import { githubFixtures } from './runtime-github-fixtures.js';

// GitHub errors may embed authenticated request headers. Never print raw exceptions.
let phase = 'initialize';
process.on('uncaughtException', error => {
  console.error(JSON.stringify({ code: 'RUNTIME_ACCEPTANCE_FAILED', phase, reason: /^[A-Z_]+$/.test(error.message) ? error.message : undefined,
    status: 'status' in error && typeof error.status === 'number' ? error.status : undefined })); process.exit(1);
});

const database = new URL(process.env.RUNTIME_TEST_DATABASE_URL ?? '');
assert.equal(database.hostname, 'sf-factory-acceptance-db'); assert.equal(database.pathname, '/factory_runtime_acceptance');
const factorySha = process.env.SF_TEST_FACTORY_SHA ?? ''; assert.match(factorySha, /^[a-f0-9]{40}$/);
const namespace = 'sf-factory-runtime-acceptance', directory = resolve('.runtime/runtime-acceptance');
await mkdir(directory, { recursive: true });
const store = new RuntimeStore(new Pool({ connectionString: database.toString(), max: 8 }));
const connection = await Connection.connect({ address: 'sf-factory-acceptance-temporal:7233', connectTimeout: '10 seconds' });
const temporal = new Client({ connection, namespace });
const managerToken = randomBytes(32).toString('hex'), workerToken = randomBytes(32).toString('hex');
const bundle = await bundleWorkflowCode({ workflowsPath: resolve('dist/runtime/workflow.js') });
const bundlePath = resolve(directory, 'workflow-bundle.js'); await writeFile(bundlePath, bundle.code);
const { createHash } = await import('node:crypto');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const release: RuntimeRelease = { factorySha, harnessSha: '8f1732c05c351af32bd25a6306a92f3bb06c1bad', workflowHash: digest(bundle.code),
  deploymentName: 'sf-factory-acceptance', buildId: factorySha, taskQueue: 'sf-factory-acceptance', schemaVersion: 1 };
const harnessEntrypoint = resolve('.runtime/harness/dist/cli.js');
const packageFile = resolve(directory, 'worker-package.json');
await writeFile(packageFile, JSON.stringify({ release, bundlePath, harnessEntrypoint, harnessEntrypointHash: digest(await readFile(harnessEntrypoint)) }));
class Target extends MemoryGitHub {
  override readonly repository: string;
  lostResultResponse = false;
  constructor(name: string) { super(); this.repository = name; }
  override async writeEvent(...args: Parameters<MemoryGitHub['writeEvent']>) {
    await super.writeEvent(...args);
    if (args[1].data.type === 'result' && this.lostResultResponse) { this.lostResultResponse = false; throw new Error('Injected lost journal response'); }
  }
}
const simulated = [42, 43].map(repositoryId => {
  const github = new Target(`acceptance/repo-${repositoryId}`), cfg = config(); cfg.execution.engine = 'temporal'; github.state.issues.push(issue());
  const repository = { repositoryId, repository: github.repository, release, requireHumanGate: true, github, config: async () => cfg, baseSha: async () => 'd'.repeat(40) };
  return { repository, controller: new RuntimeController(repository, store, temporal), planner: new MockPlanner(), github, issueNumber: 1 };
});
const real = process.env.SF_TEST_REAL_GITHUB === '1';
const publisherFixture = process.env.SF_TEST_PUBLISHER_FIXTURE === '1';
const actualCoding = process.env.SF_TEST_REAL_CODING === '1';
phase = 'prepare-repository-fixtures';
const { fixtures, actor } = real ? await githubFixtures(release, store, temporal) : { fixtures: simulated, actor: 'maintainer' };
const [repoA, repoB] = fixtures.map(f => f.repository.repositoryId) as [number, number];
const server = runtimeServer({ managerToken, workerToken, bindings: fixtures, store });
let child: ChildProcess | undefined;
const wait = async <T>(work: () => Promise<T | null | false>, timeout = 30000): Promise<T> => {
  const end = Date.now() + timeout; let last: unknown;
  while (Date.now() < end) {
    try { const value = await work(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('ACCEPTANCE_TIMEOUT', { cause: last });
};
try {
  await store.migrate();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path: string, body?: unknown, token = managerToken) => {
    const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() };
  };
  const childEnvironment = { PATH: process.env.PATH, TEMPORAL_ADDRESS: 'sf-factory-acceptance-temporal:7233', TEMPORAL_NAMESPACE: namespace,
    FACTORY_BROKER_URL: base, FACTORY_WORKER_TOKEN: workerToken };
  const startWorker = () => {
    child = spawn(process.execPath, ['dist/runtime/main.js', 'worker', '--file', packageFile], { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; child.stdout!.on('data', chunk => { logs += chunk; }); child.stderr!.on('data', chunk => { logs += chunk; });
    child.on('exit', () => { void writeFile(resolve(directory, 'worker.log'), logs); });
  };
  startWorker();
  phase = 'worker-readiness';
  await wait(async () => (await temporal.workflowService.describeWorkerDeploymentVersion({ namespace,
    deploymentVersion: { deploymentName: release.deploymentName, buildId: release.buildId } })).workerDeploymentVersionInfo);
  assert.equal((await call(`/v1/repositories/${repoA}/reconcile`, { actor }, workerToken)).status, 401);
  assert.equal((await call('/v1/repositories/999/runs')).status, 409);
  phase = 'reconcile';
  const first = await call(`/v1/repositories/${repoA}/reconcile`, { actor }); assert.equal(first.status, 200);
  const second = await call(`/v1/repositories/${repoB}/reconcile`, { actor }); assert.equal(second.status, 200);
  phase = 'await-two-human-gates';
  const rows = await Promise.all([repoA, repoB].map(id => wait(async () => {
    const data = (await call(`/v1/repositories/${id}/runs`)).body as RuntimeObservation[];
    return data[0]?.phase === 'awaiting-approval' ? data[0] : null;
  })));
  assert.notEqual(rows[0]!.runId, rows[1]!.runId);
  for (const row of rows) {
    const detail = await temporal.workflowService.describeWorkflowExecution({ namespace, execution: { workflowId: row.workflowId, runId: row.runId } });
    assert.equal(detail.workflowExecutionInfo?.versioningInfo?.behavior, 1);
  }
  const row = rows[0]!;
  phase = 'gate-negatives-and-worker-crash';
  assert.equal((await call(`/v1/repositories/${repoA}/runs/${row.executionId}/approve`, { actor: 'attacker', binding: row.binding })).status, 409);
  assert.equal((await call(`/v1/repositories/${repoA}/runs/${row.executionId}/approve`, { actor, binding: 'f'.repeat(64) })).status, 409);
  assert.equal((await call(`/v1/repositories/${repoB}/runs/${row.executionId}/approve`, { actor, binding: row.binding })).status, 409);
  await call(`/v1/repositories/${repoA}/reconcile`, { actor });
  assert.equal((await store.list(repoA)).length, 1);
  child!.kill('SIGKILL'); await new Promise<void>(resolve => child!.once('exit', () => resolve()));
  fixtures[0]!.github.lostResultResponse = true;
  assert.equal((await call(`/v1/repositories/${repoA}/runs/${row.executionId}/approve`, { actor, binding: row.binding })).status, 200);
  startWorker();
  phase = 'execution-and-publication';
  let codingCrashRestart = false;
  if (actualCoding) {
    await wait(async () => (await store.pool.query('SELECT phase FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 AND effect=$3', [repoA, row.executionId, 'coding-dispatch'])).rows[0]?.phase === 'confirmed', 120000);
    child!.kill('SIGKILL'); await new Promise<void>(resolve => child!.once('exit', () => resolve()));
    startWorker(); codingCrashRestart = true;
  }
  const completed = await wait(async () => {
    const data = (await call(`/v1/repositories/${repoA}/runs`)).body as RuntimeObservation[];
    return data[0]?.status === 'completed' && data[0].result ? data[0] : null;
  }, actualCoding ? 780000 : publisherFixture ? 180000 : 60000);
  assert.equal(completed.runId, row.runId); assert.equal(completed.result!.status, 'success');
  assert(completed.result!.artifacts.some(a => publisherFixture || actualCoding ? a.startsWith('https://github.com/') && a.includes('/pull/') : a.startsWith('urn:sha256:')));
  const resultComments = (await fixtures[0]!.github.comments(fixtures[0]!.issueNumber)).filter(c => c.body.includes('"type": "result"')); assert.equal(resultComments.length, 1);
  assert.equal((await call(`/v1/repositories/${repoB}/runs`)).body[0].phase, 'awaiting-approval');
  const codingRuns = [];
  if (actualCoding) {
    for (const f of fixtures) { assert('verifyCoding' in f); }
    if ('verifyCoding' in fixtures[0]!) codingRuns.push(await fixtures[0].verifyCoding(row.executionId));
    assert.equal((await call(`/v1/repositories/${repoB}/runs/${rows[1]!.executionId}/approve`, { actor, binding: rows[1]!.binding })).status, 200);
    const other = await wait(async () => { const data = (await call(`/v1/repositories/${repoB}/runs`)).body as RuntimeObservation[];
      return data[0]?.status === 'completed' && data[0].result ? data[0] : null; }, 780000);
    assert.equal(other.runId, rows[1]!.runId); assert.equal(other.result!.status, 'success');
    if ('verifyCoding' in fixtures[1]!) codingRuns.push(await fixtures[1].verifyCoding(other.executionId));
  } else {
    await call(`/v1/repositories/${repoB}/runs/${rows[1]!.executionId}/cancel`, { actor });
    await wait(async () => {
      const data = (await call(`/v1/repositories/${repoB}/runs`)).body as RuntimeObservation[]; return data[0]?.status === 'cancelled' ? data[0] : null;
    });
  }
  const effectReceipts = (await store.pool.query('SELECT repository_id,execution_id,effect,payload_hash,phase,receipt FROM factory_runtime_effects ORDER BY repository_id,effect')).rows;
  const report = { passed: true, factorySha, release, runs: rows.map(r => ({ workflowId: r.workflowId, runId: r.runId })),
    workerCrashRestartSameRunId: true, persistedApprovalWhileWorkerStopped: true, ...(publisherFixture ? { publisherResult: completed.result } : actualCoding ? { codingResult: completed.result } : { realHarnessResult: completed.result }),
    lostJournalResponseReconciled: true, resultJournalCount: resultComments.length, duplicateDispatchCount: (await store.list(repoA)).length,
    crossRepositoryGateRejected: true, untrustedActorRejected: true, staleBindingRejected: true, workerCannotCallManager: true,
    sharedCluster: true, pinnedServerBehavior: true, githubAdapter: actualCoding ? 'real repository-scoped GitHub App; real pinned Codex compute and Draft PR publisher' : publisherFixture ? 'real repository-scoped GitHub App; deterministic artifact fixture and real Draft PR publisher' : real ? 'real repository-scoped GitHub App; result journal only, no PR publication' : 'simulated GitHub port; no real PR publication in this test',
    repositories: fixtures.map(f => ({ id: f.repository.repositoryId, name: f.repository.repository, issueNumber: f.issueNumber,
      retiredFixtureIssues: 'retiredFixtureIssues' in f ? f.retiredFixtureIssues : [] })),
    publisherFixture, actualModelExecution: actualCoding, codingCrashRestart, codingRuns, effectReceipts,
    workerEnvironmentKeys: Object.keys(childEnvironment), checkedAt: new Date().toISOString() };
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise<void>(resolve => child!.once('exit', () => resolve())); }
  await new Promise<void>(resolve => server.close(() => resolve())); await connection.close(); await store.pool.end();
}
