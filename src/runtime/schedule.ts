import { reconcileBinding, type RuntimeBinding, type ServerOptions } from './server.js';

/** Expected outcomes that need no log line: another pass still runs, or the repository left Temporal. */
const quiet = new Set(['BUSY', 'TEMPORAL_NOT_ENABLED']);

export interface ReconcileSchedule {
  /**
   * Asks for a reconciliation of one repository soon (software-factory#197): the SF Manager calls this for GitHub webhooks.
   * A nudge carries no decision, the reconciliation reads everything from GitHub itself. While the repository is being
   * reconciled, nudges are merged into exactly one further reconciliation after it. False for an unknown repository.
   */
  nudge(repositoryId: number): boolean;
  /** Stops the schedule and waits for running reconciliations. */
  stop(): Promise<void>;
}
type Options = Pick<ServerOptions, 'store' | 'notifications' | 'monitor' | 'queue' | 'analytics' | 'events'>;

/**
 * The broker picks up work by itself: every interval it reconciles each bound repository in turn, so Factory runs
 * do not depend on the SF Manager being up. Passes never overlap (the next one is planned an interval after the previous
 * pass ends). Between passes, nudges (webhooks through the SF Manager) reconcile single repositories right away. Per
 * repository only one reconciliation runs at a time, across passes and nudges; at most `parallel` run at once, so the
 * database pool and the GitHub secondary limits stay out of reach. Bindings registered later are picked up on the next
 * pass. An interval of 0 turns the schedule off; nudges still work.
 */
export function startReconcileSchedule(bindings: RuntimeBinding[], options: Options, intervalMs: number,
  settings: { parallel?: number; busyRetryMs?: number; now?: () => Date } = {}): ReconcileSchedule {
  const parallel = settings.parallel ?? 2, busyRetryMs = settings.busyRetryMs ?? 10000, now = settings.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined, stopped = false, pass: Promise<void> = Promise.resolve();
  const retries = new Set<NodeJS.Timeout>();
  // Per repository: the running reconciliation (including the reruns nudges asked for meanwhile), and whether one more is due.
  const repositories = new Map<number, { running: Promise<void>; again: boolean }>();
  let free = parallel; const waiting: (() => void)[] = [];
  const slot = async () => { if (free > 0) { free--; return; } await new Promise<void>(resolve => waiting.push(resolve)); };
  const release = () => { const next = waiting.shift(); if (next) next(); else free++; };

  /** One reconciliation; the fixed failure code, or null when it completed. Never throws. */
  const once = async (binding: RuntimeBinding): Promise<string | null> => {
    await slot();
    try { await reconcileBinding(binding, options); return null; }
    catch (error) {
      const reason = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED';
      // Fixed codes only: never external error text, repository content or connection strings.
      if (!quiet.has(reason)) console.warn(JSON.stringify({ event: 'factory-reconcile-failed', repositoryId: binding.repository.repositoryId, reason,
        httpStatus: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined }));
      if (!quiet.has(reason)) await options.monitor?.failed(binding.repository, reason).catch(() => undefined);
      if (reason !== 'BUSY') options.queue?.failed(binding.repository, reason);
      return reason;
    } finally { release(); }
  };
  /** Reconciles a repository, or joins the reconciliation that already runs. `again` asks for one more after a running one. */
  const reconcile = (binding: RuntimeBinding, again: boolean): Promise<void> => {
    const id = binding.repository.repositoryId, current = repositories.get(id);
    if (current) { if (again) current.again = true; return current.running; }
    const state = { running: Promise.resolve(), again: false };
    state.running = (async () => {
      try {
        let busy = false;
        do { state.again = false; busy = await once(binding) === 'BUSY'; } while (state.again && !stopped);
        // Another caller (the SF Manager's own reconcile request) held the lock: the nudge must not get lost.
        if (busy && again && !stopped) { const retry = setTimeout(() => { retries.delete(retry); reconcile(binding, true).catch(() => undefined); }, busyRetryMs); retries.add(retry); }
      } finally { repositories.delete(id); }
    })();
    repositories.set(id, state);
    return state.running;
  };
  const run = async () => {
    options.queue?.schedule({ passStartedAt: now().toISOString(), nextPassAt: null });
    for (const binding of [...bindings]) { if (stopped) return; await reconcile(binding, false); }
  };
  const plan = () => {
    if (stopped || !intervalMs) return;
    options.queue?.schedule({ passStartedAt: null, nextPassAt: new Date(now().getTime() + intervalMs).toISOString() });
    timer = setTimeout(() => { pass = run().finally(plan); }, intervalMs);
  };
  plan();
  return {
    nudge(repositoryId) {
      const binding = bindings.find(b => b.repository.repositoryId === repositoryId);
      if (!binding || stopped) return false;
      reconcile(binding, true).catch(() => undefined);
      return true;
    },
    async stop() {
      stopped = true; if (timer) clearTimeout(timer);
      for (const retry of retries) clearTimeout(retry);
      await pass; await Promise.all([...repositories.values()].map(r => r.running));
    },
  };
}
