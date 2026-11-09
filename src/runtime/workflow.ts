import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { RunSnapshot, RuntimeState, RuntimeRelease } from './contract.js';
import type { WorkerResult } from '../workers/contract.js';

export interface RuntimeActivities {
  authorize(snapshot: RunSnapshot, binding: string): Promise<void>;
  gateApproved(snapshot: RunSnapshot, binding: string): Promise<boolean>;
  execute(snapshot: RunSnapshot, binding: string): Promise<WorkerResult>;
  publish(snapshot: RunSnapshot, binding: string, result: WorkerResult): Promise<WorkerResult>;
}
export const runtimeState = defineQuery<RuntimeState>('factoryState');
export const runtimeDefinition = defineQuery<{ revision: 2; release: RuntimeRelease }>('factoryDefinition');
// Signals only wake the workflow. Permission is read from the broker, never trusted from signal payloads.
export const approvalChanged = defineSignal('approvalChanged');
export const cancelRequested = defineSignal('cancelRequested');
export async function factoryExecution(snapshot: RunSnapshot, binding: string): Promise<WorkerResult | null> {
  const { authorize, gateApproved } = proxyActivities<RuntimeActivities>({
    startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '10 seconds' },
  });
  const { publish } = proxyActivities<RuntimeActivities>({ startToCloseTimeout: '2 minutes', retry: { maximumAttempts: 5, initialInterval: '1 second', maximumInterval: '10 seconds' } });
  const { execute } = proxyActivities<RuntimeActivities>({
    startToCloseTimeout: `${snapshot.admission.input.limits.timeoutMinutes + 1} minutes`,
    scheduleToCloseTimeout: `${snapshot.admission.input.limits.timeoutMinutes + 2} minutes`,
    heartbeatTimeout: snapshot.admission.input.worker === 'codex' ? '45 seconds' : undefined,
    retry: { maximumAttempts: snapshot.admission.input.worker === 'codex' ? 5 : 1, initialInterval: '5 seconds' },
  });
  const state: RuntimeState = { phase: 'starting', binding, result: null };
  let wake = false, cancelled = false;
  setHandler(runtimeState, () => state);
  setHandler(runtimeDefinition, () => ({ revision: 2, release: snapshot.release }));
  setHandler(approvalChanged, () => { wake = true; });
  setHandler(cancelRequested, () => { cancelled = true; wake = true; });
  if (snapshot.requireHumanGate) {
    state.phase = 'awaiting-approval';
    while (!cancelled) {
      wake = false;
      if (await gateApproved(snapshot, binding)) break;
      // Recheck even if a broker write succeeded but its signal receipt was lost.
      await condition(() => wake, '30 seconds');
    }
  }
  if (cancelled) { state.phase = 'cancelled'; return null; }
  state.phase = 'authorizing';
  await authorize(snapshot, binding);
  state.phase = 'running';
  const result = await execute(snapshot, binding);
  if (cancelled) { state.phase = 'cancelled'; return null; }
  // Revalidate issue, policy, base and approval after user-controlled work and before any side effect.
  await authorize(snapshot, binding);
  state.phase = 'publishing';
  state.result = await publish(snapshot, binding, result);
  state.phase = 'completed';
  return state.result;
}
