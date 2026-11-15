import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { Comment, Issue } from '../types.js';
import { decodeEvent } from '../state/events.js';
import { reconstruct } from '../state/reconstruct.js';
import { managedLabel } from '../state/lifecycle.js';
import type { RuntimeObservation } from './contract.js';

/**
 * The acceptance repository the end-to-end canary runs in after every runtime deployment (software-factory#27).
 * The broker binds it without a ready-label grant and only with the deterministic test worker, so a canary needs
 * no person, no model secret and changes no code.
 */
export const canaryRepositorySchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  githubInstallationId: z.number().int().positive().safe(),
});
export type CanaryRepository = z.infer<typeof canaryRepositorySchema>;
/** Reads FACTORY_CANARY_REPOSITORY; empty means no canary is configured. */
export function canaryRepository(value: string | undefined): CanaryRepository | null {
  return value?.trim() ? canaryRepositorySchema.parse(JSON.parse(value)) : null;
}
/** A canary repository runs the test worker only: a configuration that enables coding is refused. */
export function assertCanaryConfig(config: Config): Config {
  if (config.workers.coding && config.workers.coding.enabled) throw new Error('CANARY_CODING_FORBIDDEN');
  if (!config.workers.test.enabled) throw new Error('CANARY_TEST_WORKER_DISABLED');
  return config;
}
export const canaryLabel = 'sf:canary';

export interface CanaryPorts {
  /** Open issues carrying the canary label. */
  openCanaries(): Promise<number[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<Issue>;
  getIssue(number: number): Promise<Issue>;
  comments(number: number): Promise<Comment[]>;
  close(number: number): Promise<void>;
  /** The broker's observations of the given executions (one per Temporal run it knows). */
  observations(executionIds: string[]): Promise<RuntimeObservation[]>;
  config(): Promise<Config>;
  now(): Date;
  sleep(ms: number): Promise<void>;
}
export type CanaryStage = 'create' | 'intent' | 'temporal-run' | 'result' | 'lifecycle';
export interface CanaryOutcome { ok: boolean; stage: CanaryStage | 'done'; issue?: number; detail: string; executionId?: string }

/**
 * One small task through the whole chain: grant-free start, exactly one intent, exactly one Temporal run, a journaled
 * successful result and a lifecycle status that matches the reconstructed facts. Leftover canary issues are closed
 * first and the canary issue is closed afterwards, success or not, so canary tasks never accumulate.
 */
export async function runCanary(ports: CanaryPorts, options: { release: string; timeoutMs: number; pollMs?: number }): Promise<CanaryOutcome> {
  for (const number of await ports.openCanaries()) await ports.close(number);
  const deadline = ports.now().getTime() + options.timeoutMs, poll = options.pollMs ?? 10000;
  let issue: Issue;
  try {
    issue = await ports.createIssue(`Factory canary ${options.release.slice(0, 12)}`,
      `Canary of the runtime deployment of release \`${options.release}\`. The test worker computes a digest; nothing is changed.\n\n` +
      '## Acceptance criteria\n- The test worker returns its digest.\n', [managedLabel, canaryLabel]);
  } catch { return { ok: false, stage: 'create', detail: 'Could not create the canary issue' }; }
  let stage: CanaryStage = 'intent', detail = 'No delegation intent was written';
  let executionId: string | undefined;
  try {
    while (ports.now().getTime() < deadline) {
      await ports.sleep(poll);
      const config = await ports.config();
      const comments = await ports.comments(issue.number);
      const events = comments.flatMap(c => { const e = decodeEvent(c, config.manager.trustedActors); return e ? [e.data] : []; });
      const intents = events.flatMap(e => e.type === 'intent' ? [e.input.executionId] : []);
      if (!intents.length) continue;
      if (intents.length > 1) return { ok: false, stage: 'intent', issue: issue.number, detail: `${intents.length} intents instead of exactly one` };
      executionId = intents[0]!;
      stage = 'temporal-run'; detail = 'The runtime has no Temporal run for the intent';
      const receipts = events.filter(e => e.type === 'temporal_receipt' && e.executionId === executionId);
      const observed = await ports.observations([executionId]);
      if (receipts.length > 1) return { ok: false, stage, issue: issue.number, executionId, detail: `${receipts.length} Temporal receipts instead of exactly one` };
      if (!receipts.length || observed.length !== 1) continue;
      stage = 'result'; detail = 'No result was journaled';
      const result = events.find(e => e.type === 'result' && e.result.executionId === executionId);
      if (result?.type !== 'result') continue;
      if (result.result.status !== 'success') return { ok: false, stage, issue: issue.number, executionId,
        detail: `The run ended ${result.result.status}${result.result.error && /^[A-Z_]{1,60}$/.test(result.result.error) ? ` (${result.result.error})` : ''}` };
      stage = 'lifecycle'; detail = 'The lifecycle label does not match the journaled result';
      const live = await ports.getIssue(issue.number);
      const task = reconstruct({ issues: [live], comments: new Map([[issue.number, comments]]), prs: [], runs: [], defaultBranch: '',
        dependencyStates: new Map(), runtimeExecutions: observed }, config, ports.now())[0]!;
      if (task.status === task.desiredStatus && task.attemptsUsed === 1) return { ok: true, stage: 'done', issue: issue.number, executionId, detail: `Canary passed (${task.status})` };
    }
    return { ok: false, stage, issue: issue.number, ...(executionId ? { executionId } : {}), detail: `${detail} within ${Math.round(options.timeoutMs / 1000)} s` };
  } finally {
    await ports.close(issue.number).catch(() => {});
  }
}
