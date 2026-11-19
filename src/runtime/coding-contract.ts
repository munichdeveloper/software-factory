import { z } from 'zod';
const worker = z.enum(['codex', 'claude']), model = z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
// Same rules as the harness (dev-agent-harness coding request 3.0): max effort and claude- models belong to Claude only.
const agentValid = (r: { worker: string; model: string; effort: string }) => (r.worker === 'claude' || r.effort !== 'max') && (r.worker === 'claude') === /^claude-/.test(r.model);
/** subscription: Claude Code with the OAuth token of a Claude subscription instead of the API key (claude only). */
const credential = z.literal('subscription').optional();
/** A further agent of workers.coding.agents, tried in order when the providers of the agents before it report no credit. */
export const codingFallbackSchema = z.strictObject({ worker, model, effort, credential }).refine(agentValid).refine(r => !r.credential || r.worker === 'claude');
export type CodingFallback = z.infer<typeof codingFallbackSchema>;
export const codingExecutionSchema = z.strictObject({ contractVersion: z.literal('3.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), worker,
  task: z.strictObject({ id: z.string().min(1).max(200), version: z.string().regex(/^[a-f0-9]{64}$/), description: z.string().min(1).max(20000),
    acceptanceCriteria: z.string().min(1).array().min(1).max(20), contextReferences: z.string().max(1000).array().max(30) }),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/), allowedActions: z.tuple([z.literal('edit_workspace'), z.literal('run_commands')]),
  model, effort,
  limits: z.strictObject({ timeoutMinutes: z.number().int().min(1).max(30), maxFiles: z.literal(100), maxPatchBytes: z.literal(5000000),
    /** Spend cap of the attempt (harness: Claude Code --max-budget-usd); absent for executions dispatched before caps existed. */
    maxCostUsd: z.number().positive().max(1000).optional() }),
  /**
   * Broker to executor only: the executor's agent selection removes it and may swap in the first fallback whose
   * provider still has credit, so the Harness always receives a plain 3.0 request. Absent for a single agent.
   */
  fallbacks: codingFallbackSchema.array().min(1).max(2).optional() })
  .refine(r => r.worker === 'claude' || r.effort !== 'max', { path: ['effort'] })
  .refine(r => (r.worker === 'claude') === /^claude-/.test(r.model), { path: ['model'] });
export type CodingExecutionRequest = z.infer<typeof codingExecutionSchema>;
