import { z } from 'zod';
import { actionSchema } from '../types.js';

export const workerInputSchema = z.strictObject({
  contractVersion: z.literal('1.0'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issueNumber: z.number().int().positive(), taskVersion: z.string().length(64),
  description: z.string().min(1).max(20000), acceptanceCriteria: z.array(z.string().min(1)).min(1).max(20),
  contextReferences: z.array(z.string().max(1000)).max(30), executionId: z.string().regex(/^[a-f0-9]{32}$/),
  allowedActions: z.array(z.literal('publish_result')).length(1),
  limits: z.strictObject({ timeoutMinutes: z.number().int().min(1).max(30), maxOutputBytes: z.literal(16000) }),
  operation: z.enum(['sha256', 'fail', 'blocked'])
});
export const workerResultSchema = z.strictObject({
  contractVersion: z.literal('1.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), issueNumber: z.number().int().positive(),
  status: z.enum(['success', 'failed', 'blocked', 'needs_approval', 'cancelled']), summary: z.string().min(1).max(2000),
  artifacts: z.array(z.string().max(2000)).max(20), error: z.string().max(2000).nullable(),
  proposedActions: z.array(actionSchema).max(10)
});
export type WorkerInput = z.infer<typeof workerInputSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
