import { z } from 'zod';
export const codingExecutionSchema = z.strictObject({ contractVersion: z.literal('3.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), worker: z.literal('codex'),
  task: z.strictObject({ id: z.string().min(1).max(200), version: z.string().regex(/^[a-f0-9]{64}$/), description: z.string().min(1).max(20000),
    acceptanceCriteria: z.string().min(1).array().min(1).max(20), contextReferences: z.string().max(1000).array().max(30) }),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/), allowedActions: z.tuple([z.literal('edit_workspace'), z.literal('run_commands')]),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), effort: z.enum(['low', 'medium', 'high', 'xhigh']),
  limits: z.strictObject({ timeoutMinutes: z.number().int().min(1).max(30), maxFiles: z.literal(100), maxPatchBytes: z.literal(5000000) }) });
