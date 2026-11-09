import { expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { RuntimeStore, StoredRun } from '../src/runtime/store.js';
import type { RuntimeRelease } from '../src/runtime/contract.js';
import { hash } from '../src/state/identity.js';
import { assertRetainedReleases } from '../src/runtime/retention.js';

const release = { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'factory-runtime', buildId: 'v1', taskQueue: 'factory-runtime', schemaVersion: 1 } satisfies RuntimeRelease;
function fixture(count = 1) {
  const rows = Array.from({ length: count }, (_, i) => {
    const snapshot = { release, admission: { input: { executionId: String(i) } } } as StoredRun['snapshot'];
    return { snapshot, binding: hash(snapshot), workflowId: `run-${i}`, runId: 'run-id', terminal: false } as StoredRun;
  });
  const terminal = vi.fn(async () => {}), describe = vi.fn(async () => ({ runId: 'run-id', status: { name: 'RUNNING' } }));
  const store = { async *inFlight() { yield* rows; }, terminal } as unknown as RuntimeStore;
  const temporal = { workflow: { getHandle: () => ({ describe }) } } as unknown as Client;
  return { rows, terminal, describe, check: (retained: RuntimeRelease[]) => assertRetainedReleases(42, retained, store, temporal) };
}
it('blocks removal of an old human-gate version beyond the first thousand admissions', async () => {
  const f = fixture(1001), next = { ...release, buildId: 'v2' };
  for (const row of f.rows.slice(0, 1000)) { row.snapshot = { ...row.snapshot, release: next }; row.binding = hash(row.snapshot); }
  await expect(f.check([next])).rejects.toThrow('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
  await expect(f.check([next, release])).resolves.toBeUndefined();
});
it('retains admitted executions even when the start receipt is missing', async () => {
  const f = fixture(); f.rows[0]!.runId = null;
  await expect(f.check([])).rejects.toThrow('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
  expect(f.describe).not.toHaveBeenCalled();
});
it('fails closed on Temporal outages, unknown status and mismatched execution identity', async () => {
  const f = fixture(); f.describe.mockRejectedValueOnce(new Error('Temporal unavailable'));
  await expect(f.check([])).rejects.toThrow('Temporal unavailable');
  f.describe.mockResolvedValueOnce({ runId: 'run-id', status: { name: 'UNSPECIFIED' } });
  await expect(f.check([])).rejects.toThrow('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
  f.describe.mockResolvedValueOnce({ runId: 'other', status: { name: 'COMPLETED' } });
  await expect(f.check([])).rejects.toThrow('WORKFLOW_BINDING_CONFLICT');
  expect(f.terminal).not.toHaveBeenCalled();
});
it('allows retirement only after Temporal confirms a terminal execution', async () => {
  const f = fixture(); f.describe.mockResolvedValueOnce({ runId: 'run-id', status: { name: 'COMPLETED' } });
  await f.check([]); expect(f.terminal).toHaveBeenCalledWith(42, '0');
});
