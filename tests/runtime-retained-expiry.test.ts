import { expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { RuntimeStore, StoredRun } from '../src/runtime/store.js';
import type { RuntimeRelease } from '../src/runtime/contract.js';
import { RuntimeController, workflowFailure, type RuntimeRepository } from '../src/runtime/controller.js';

const release = (buildId: string) => ({ factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf', buildId, taskQueue: 'sf-v1', schemaVersion: 1 }) satisfies RuntimeRelease;
const hour = 3600000, now = Date.parse('2026-11-14T22:00:00Z');
function run(id: string, build: string, ageHours: number, extra: Partial<StoredRun> = {}): StoredRun {
  return { snapshot: { release: release(build), admission: { input: { executionId: id, worker: 'codex' } } } as unknown as StoredRun['snapshot'], binding: `b-${id}`,
    workflowId: `wf-${id}`, runId: `run-${id}`, createdAt: new Date(now - ageHours * hour).toISOString(), approved: true, cancelled: false, terminal: false, result: null, ...extra };
}
function fixture(rows: StoredRun[], retainedRunMs: number | null = 2 * hour) {
  const terminate = vi.fn<(reason: string) => Promise<void>>(async () => {}), cancel = vi.fn(async () => {}), status = new Map<string, string>();
  const temporal = { workflow: { getHandle: (workflowId: string) => ({ describe: async () => ({ status: { name: status.get(workflowId) ?? 'RUNNING' } }), terminate: (reason: string) => terminate(`${workflowId}:${reason}`) }) } } as unknown as Client;
  const store = { async *inFlight() { yield* rows; } } as unknown as RuntimeStore;
  const repo = { repositoryId: 42, repository: 'o/r', release: release('new'), retainedReleases: [release('old')], requireHumanGate: false, ...(retainedRunMs === null ? {} : { retainedRunMs }),
    coding: { executor: { cancel } } } as unknown as RuntimeRepository;
  return { controller: new RuntimeController(repo, store, temporal), terminate, cancel, status };
}
it('ends only open runs of the previous release older than the retention bound (software-factory#102)', async () => {
  const f = fixture([run('old-expired', 'old', 3), run('old-young', 'old', 1), run('new-long', 'new', 5),
    run('old-cancelled', 'old', 3, { cancelled: true }), run('old-unstarted', 'old', 3, { runId: null }),
    run('old-publishing', 'old', 3, { result: { status: 'success' } as StoredRun['result'] }), run('old-ended', 'old', 3)]);
  f.status.set('wf-old-ended', 'COMPLETED');
  expect(await f.controller.expireRetained(now)).toEqual(['old-expired']);
  expect(f.terminate.mock.calls).toEqual([['wf-old-expired:RETAINED_RELEASE_EXPIRED']]);
  expect(f.cancel).toHaveBeenCalledTimes(1);
});
it('ends the workflow even when its executor run cannot be cancelled', async () => {
  const f = fixture([run('x', 'old', 3)]); f.cancel.mockRejectedValueOnce(new Error('EXECUTOR_RUN_CONFLICT'));
  expect(await f.controller.expireRetained(now)).toEqual(['x']);
});
it('keeps retained runs without a bound', async () => {
  const f = fixture([run("x", "old", 300)], null);
  expect(await f.controller.expireRetained(now)).toEqual([]);
});
it('reports the expiry as the failure code of the run', async () => {
  const terminated = Object.assign(new Error('Workflow execution terminated'), { cause: new Error('RETAINED_RELEASE_EXPIRED') });
  expect(await workflowFailure({ result: () => Promise.reject(terminated) }, 'failed')).toBe('RETAINED_RELEASE_EXPIRED');
});
