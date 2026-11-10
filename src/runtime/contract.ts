import { z } from 'zod';
import { workerInputSchema, workerResultSchema } from '../workers/contract.js';

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
  specHash: digest, configHash: digest, requireHumanGate: z.boolean(),
});
export type RunSnapshot = z.infer<typeof snapshotSchema>;
export type RunPhase = 'starting' | 'awaiting-approval' | 'authorizing' | 'running' | 'publishing' | 'completed' | 'cancelled';
export interface RuntimeState { phase: RunPhase; binding: string; result: z.infer<typeof workerResultSchema> | null }
export const observationSchema = z.strictObject({
  issueNumber: z.number().int().positive(),
  executionId: executionKey, workflowId: z.string().min(1).max(200), runId: z.uuid(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'timed_out']),
  phase: z.enum(['starting', 'awaiting-approval', 'authorizing', 'running', 'publishing', 'completed', 'cancelled']),
  binding: digest, createdAt: z.iso.datetime(), result: workerResultSchema.nullable(),
});
export type RuntimeObservation = z.infer<typeof observationSchema>;
export interface WorkerRuntimePort {
  start(admission: Admission): Promise<RuntimeObservation>;
  observations(executionIds: string[]): Promise<RuntimeObservation[]>;
  cancel(executionId: string): Promise<void>;
}
export const workflowId = (repositoryId: number, executionId: string) => `sf-${repositoryId}-${executionId}`;
