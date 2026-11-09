import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { NativeConnection, Worker } from '@temporalio/worker';
import { releaseSchema, snapshotSchema, type RunSnapshot } from './contract.js';
import type { RuntimeActivities } from './workflow.js';
import { HarnessProcessClient } from '../workers/harness-client.js';
import { workerResultSchema, type WorkerResult } from '../workers/contract.js';
import { hash } from '../state/identity.js';

export interface WorkerPackage { release: ReturnType<typeof releaseSchema.parse>; bundlePath: string; harnessEntrypoint: string; harnessEntrypointHash: string }
export function createActivities(pack: WorkerPackage, broker: (operation: string, snapshot: RunSnapshot, binding: string, result?: WorkerResult) => Promise<unknown>): RuntimeActivities {
  const validate = (value: RunSnapshot) => {
    const snapshot = snapshotSchema.parse(value);
    if (hash(snapshot.release) !== hash(pack.release)) throw new Error('WORKER_RELEASE_MISMATCH');
    return snapshot;
  };
  return {
    async authorize(value, binding) { await broker('authorize', validate(value), binding); },
    async gateApproved(value, binding) { return (await broker('gate', validate(value), binding)) === true; },
    async execute(value, binding) {
      const snapshot = validate(value);
      await broker('authorize', snapshot, binding);
      if (snapshot.admission.input.worker !== 'test') throw new Error('Coding requires its isolated executor; test worker will not downgrade a coding task');
      return new HarnessProcessClient(pack.harnessEntrypoint).execute(snapshot.admission.input);
    },
    async publish(value, binding, result) { return workerResultSchema.parse(await broker('publish', validate(value), binding, result)); },
  };
}
export async function startRuntimeWorker(pack: WorkerPackage, address: string, namespace: string, brokerUrl: string, token: string) {
  const release = releaseSchema.parse(pack.release), url = new URL(brokerUrl);
  if (!isAbsolute(pack.bundlePath) || !isAbsolute(pack.harnessEntrypoint) || token.length < 32 ||
    (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password) throw new Error('INVALID_WORKER_CONFIGURATION');
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY', 'DOCKER_HOST', 'NODE_OPTIONS']) {
    if (process.env[key]) throw new Error('WORKER_SECRET_BOUNDARY_VIOLATION');
  }
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  if (digest(await readFile(pack.bundlePath)) !== release.workflowHash || digest(await readFile(pack.harnessEntrypoint)) !== pack.harnessEntrypointHash) throw new Error('WORKER_PACKAGE_INTEGRITY_FAILED');
  const activities = createActivities(pack, async (operation, snapshot, binding, result) => {
    const response = await fetch(new URL(`/v1/worker/${operation}`, url), { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot, binding, ...(result ? { result } : {}) }), signal: AbortSignal.timeout(25000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('BROKER_REJECTED_OR_UNAVAILABLE'); }
    const text = await response.text(); if (Buffer.byteLength(text) > 100000) throw new Error('BROKER_RESPONSE_LIMIT');
    return JSON.parse(text);
  });
  const connection = await NativeConnection.connect({ address });
  try {
    const worker = await Worker.create({ connection, namespace, taskQueue: release.taskQueue,
      workflowBundle: { codePath: pack.bundlePath }, activities,
      workerDeploymentOptions: { version: { deploymentName: release.deploymentName, buildId: release.buildId }, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED' },
      maxConcurrentActivityTaskExecutions: 2, maxConcurrentWorkflowTaskExecutions: 4 });
    await worker.run();
  } finally { await connection.close(); }
}
