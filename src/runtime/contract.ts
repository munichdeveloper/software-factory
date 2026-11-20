import { z } from 'zod';
import { workerInputSchema, workerResultSchema } from '../workers/contract.js';
import { validationPlanSchema } from './validation-contract.js';
import { routeRecordSchema } from '../llm/router.js';
import { usageRecordSchema } from './usage.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const baseRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)
  .refine(v => !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.lock') && !v.startsWith('refs/'));
export const executorWorkflowSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}\.ya?ml$/);
export const executionKey = z.string().regex(/^[a-f0-9]{32}$/);
export const releaseSchema = z.strictObject({
  factorySha: sha, harnessSha: sha, workflowHash: digest,
  deploymentName: z.string().regex(/^[a-z][a-z0-9-]{2,100}$/),
  buildId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  taskQueue: z.string().regex(/^[a-z][a-z0-9-]{2,100}$/),
  schemaVersion: z.literal(1),
});
export type RuntimeRelease = z.infer<typeof releaseSchema>;
export const admissionSchema = z.strictObject({ input: workerInputSchema, actionId: digest, policyHash: digest });
export type Admission = z.infer<typeof admissionSchema>;
export const readyApprovalSchema = z.strictObject({ eventId: z.number().int().positive().safe(), actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/), createdAt: z.iso.datetime() });
export type ReadyApproval = z.infer<typeof readyApprovalSchema>;
export const snapshotSchema = z.strictObject({
  version: z.literal(1), repositoryId: z.number().int().positive().safe(),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  release: releaseSchema, admission: admissionSchema, baseSha: sha,
  baseRef: baseRefSchema.optional(), executorWorkflow: executorWorkflowSchema.optional(),
  allowedPaths: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
  readyApproval: readyApprovalSchema.optional(),
  validationPlan: validationPlanSchema.optional(),
  specHash: digest, configHash: digest, requireHumanGate: z.boolean(),
});
export type RunSnapshot = z.infer<typeof snapshotSchema>;
/** The agent a coding route chose, as stored with the execution. */
export const routedAgentSchema = z.strictObject({ agent: z.enum(['codex', 'claude']), model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']) });
/** The stored routing decision of a coding execution (effect `coding-route`); null fields: not routed. */
export const codingRouteSchema = z.strictObject({ route: routeRecordSchema.nullable(), agent: routedAgentSchema.nullable() });
export type RunPhase = 'starting' | 'awaiting-approval' | 'authorizing' | 'running' | 'publishing' | 'completed' | 'cancelled';
export interface RuntimeState { phase: RunPhase; binding: string; result: z.infer<typeof workerResultSchema> | null }
export const observationSchema = z.strictObject({
  issueNumber: z.number().int().positive(),
  executionId: executionKey, workflowId: z.string().min(1).max(200), runId: z.uuid(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']),
  phase: z.enum(['starting', 'awaiting-approval', 'authorizing', 'running', 'publishing', 'completed', 'cancelled']),
  binding: digest, createdAt: z.iso.datetime(), result: workerResultSchema.nullable(),
  /** For a blocked result: what the independent validation found, from the broker's own bound report. */
  validation: z.strictObject({ status: z.enum(['passed', 'failed', 'unsupported', 'invalid']), reason: z.string().regex(/^[A-Z_]{1,40}$/),
    failed: z.strictObject({ name: z.string().regex(/^[a-z-]{1,30}$/), exitCode: z.number().int().nullable() }).array().max(10),
    runId: z.number().int().positive().safe() }).optional(),
  /**
   * The model router's decision for this coding execution (router.coding), for the status comment. Broker-internal: the
   * HTTP API leaves it out, so clients of earlier releases keep parsing their observations.
   */
  route: z.strictObject({ record: routeRecordSchema, agent: routedAgentSchema.nullable() }).optional(),
  /** Token usage and cost of this execution's agent run, once recorded; broker-internal like route. */
  usage: usageRecordSchema.optional(),
});
export type RuntimeObservation = z.infer<typeof observationSchema>;
/**
 * A deterministic policy rejection raised before any run was persisted or started.
 * The caller may record a definite outcome; no workflow can exist for this execution.
 */
export class RuntimeAdmissionRejected extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RuntimeAdmissionRejected'; }
}
export const admissionCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : null;
export interface WorkerRuntimePort {
  /** True when harness:ready, applied by an authorized person, is what grants execution. */
  readonly readyIsGrant?: boolean;
  /**
   * Checks grants that must exist before a durable intent is written. Rejects with RuntimeAdmissionRejected.
   * `previousExecutionId` names the attempt a rework continues or a retry repeats; its grant may carry over.
   */
  preflight?(issueNumber: number, previousExecutionId?: string): Promise<void>;
  /**
   * Whether the cause of a journaled refusal is gone (issue #188 step 3, concept 6.1): the executor workflow pins the
   * runtime's release again, or the worker deployment of the runtime's release is known. Such a refusal no longer waits
   * for its backoff. False for every other code.
   */
  refusalCleared?(code: string): Promise<boolean>;
  start(admission: Admission): Promise<RuntimeObservation>;
  observations(executionIds: string[]): Promise<RuntimeObservation[]>;
  cancel(executionId: string): Promise<void>;
}
export const workflowId = (repositoryId: number, executionId: string) => `sf-${repositoryId}-${executionId}`;
