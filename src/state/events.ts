import { z } from 'zod';
import type { Comment } from '../types.js';
import { workerInputSchema, workerResultSchema } from '../workers/contract.js';

export const marker = '<!-- software-factory:v1 -->';
const legacyMarker = '<!-- dev-agent-harness:v1 -->';
export const blockCauseSchema = z.enum(['specification', 'dependencies', 'dispatch', 'worker', 'planner']);
export type BlockCause = z.infer<typeof blockCauseSchema>;
export const eventSchema = z.strictObject({
  version: z.literal(1), key: z.string().min(1).max(200), at: z.iso.datetime(), correlationId: z.string().max(100),
  data: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('intent'), input: workerInputSchema, actionId: z.string().length(64), attempt: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('receipt'), executionId: z.string().length(32), runId: z.number().int().positive() }),
    z.strictObject({ type: z.literal('result'), result: workerResultSchema }),
    z.strictObject({ type: z.literal('block_intent'), taskVersion: z.string().length(64), cause: blockCauseSchema, afterLabelEventId: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('decision'), action: z.string().max(30000), outcome: z.enum(['allow', 'deny', 'approval', 'executed']), reason: z.string().max(2000) })
  ])
});
export type HarnessEvent = z.infer<typeof eventSchema>;
export function encodeEvent(event: HarnessEvent): string {
  const body = `${marker}\n\`\`\`json\n${JSON.stringify(eventSchema.parse(event), null, 2)}\n\`\`\``;
  if (Buffer.byteLength(body) > 60000) throw new Error('Harness event exceeds GitHub comment limit');
  return body;
}
export function decodeEvent(comment: Comment, trustedActors: string[]): HarnessEvent | undefined {
  const prefix = [marker, legacyMarker].map(m => `${m}\n\`\`\`json\n`).find(p => comment.body.startsWith(p));
  if (!trustedActors.includes(comment.author) || !prefix) return;
  try {
    const data: unknown = JSON.parse(comment.body.slice(prefix.length).replace(/\n```$/, ''));
    const result = eventSchema.safeParse(data);
    return result.success ? result.data : undefined;
  } catch { return; }
}
