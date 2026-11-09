import type { Client } from '@temporalio/client';
import type { RuntimeRelease } from './contract.js';
import type { RuntimeStore } from './store.js';
import { hash } from '../state/identity.js';

/** Validate the entire durable admission set, not the bounded UI history list. */
export async function assertRetainedReleases(repositoryId: number, releases: RuntimeRelease[], store: RuntimeStore, temporal: Client) {
  const retained = new Set(releases.map(hash));
  for await (const row of store.inFlight(repositoryId)) {
    if (row.binding !== hash(row.snapshot)) throw new Error('WORKFLOW_BINDING_CONFLICT');
    if (retained.has(hash(row.snapshot.release))) continue;
    // An admitted run without a start receipt still requires its frozen package.
    if (!row.runId) throw new Error('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
    const description = await temporal.workflow.getHandle(row.workflowId, row.runId).describe();
    if (description.runId !== row.runId) throw new Error('WORKFLOW_BINDING_CONFLICT');
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'].includes(description.status.name)) {
      throw new Error('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
    }
    await store.terminal(repositoryId, row.snapshot.admission.input.executionId);
  }
}
