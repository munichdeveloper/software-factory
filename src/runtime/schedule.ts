import { reconcileBinding, type RuntimeBinding, type ServerOptions } from './server.js';

/** Expected outcomes that need no log line: another pass still runs, or the repository left Temporal. */
const quiet = new Set(['BUSY', 'TEMPORAL_NOT_ENABLED']);

/**
 * The broker picks up work by itself: every interval it reconciles each bound repository in turn, so Factory runs
 * do not depend on the SF Manager being up. Passes never overlap (the next one is planned after the previous pass
 * ends), and the per-repository lock answers a concurrent Manager call with BUSY. Bindings registered later are
 * picked up on the next pass. Returns a function that stops the schedule and waits for a running pass.
 */
export function startReconcileSchedule(bindings: RuntimeBinding[], options: Pick<ServerOptions, 'store' | 'notifications' | 'monitor'>, intervalMs: number) {
  let timer: NodeJS.Timeout | undefined, stopped = false, running: Promise<void> = Promise.resolve();
  const pass = async () => {
    for (const binding of [...bindings]) {
      if (stopped) return;
      try { await reconcileBinding(binding, options); }
      catch (error) {
        const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED';
        // Fixed codes only: never external error text, repository content or connection strings.
        if (!quiet.has(reason)) console.warn(JSON.stringify({ event: 'factory-reconcile-failed', repositoryId: binding.repository.repositoryId, reason,
          httpStatus: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined }));
        if (!quiet.has(reason)) await options.monitor?.failed(binding.repository, reason);
      }
    }
  };
  const plan = () => { if (!stopped) timer = setTimeout(() => { running = pass().finally(plan); }, intervalMs); };
  plan();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await running; };
}
