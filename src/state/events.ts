import { z } from 'zod';
import type { Comment } from '../types.js';
import { workerInputSchema, workerResultSchema } from '../workers/contract.js';
import { mergeReviewSchema } from '../merge/contract.js';

export const marker = '<!-- software-factory:v1 -->';
const legacyMarker = '<!-- dev-agent-harness:v1 -->';
export const blockCauseSchema = z.enum(['specification', 'dependencies', 'dispatch', 'worker', 'planner']);
export type BlockCause = z.infer<typeof blockCauseSchema>;
export const eventSchema = z.strictObject({
  version: z.literal(1), key: z.string().min(1).max(200), at: z.iso.datetime(), correlationId: z.string().max(100),
  data: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('intent'), input: workerInputSchema, actionId: z.string().length(64), attempt: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('receipt'), executionId: z.string().length(32), runId: z.number().int().positive() }),
    z.strictObject({ type: z.literal('temporal_receipt'), executionId: z.string().length(32), workflowId: z.string().max(200), runId: z.uuid(), binding: z.string().length(64) }),
    z.strictObject({ type: z.literal('result'), result: workerResultSchema }),
    z.strictObject({ type: z.literal('block_intent'), taskVersion: z.string().length(64), cause: blockCauseSchema, afterLabelEventId: z.number().int().nonnegative() }),
    z.strictObject({ type: z.literal('issue_creation_intent'), followupKey: z.string().regex(/^[a-f0-9]{64}$/), actionId: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.strictObject({ type: z.literal('notification_sent'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/), channel: z.string().max(100), timestamp: z.string().max(100) }),
    z.strictObject({ type: z.literal('notification_attempt'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.strictObject({ type: z.literal('notification_rejected'), deliveryId: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.strictObject({ type: z.literal('merge_review'), head: z.string().length(40), base: z.string().length(40), reviewKey: z.string().length(64), review: mergeReviewSchema }),
    z.strictObject({ type: z.literal('merge_intent'), prNumber: z.number().int().positive(), head: z.string().length(40), base: z.string().length(40), reviewKey: z.string().length(64) }),
    z.strictObject({ type: z.literal('merge_completed'), prNumber: z.number().int().positive(), head: z.string().length(40), mergeSha: z.string().length(40) }),
    z.strictObject({ type: z.literal('branch_update'), head: z.string().length(40), base: z.string().length(40) }),
    z.strictObject({ type: z.literal('workflow_dispatch'), workflow: z.string().max(100), ref: z.string().max(200), sha: z.string().length(40) }),
    z.strictObject({ type: z.literal('merge_status'), head: z.string().length(40), base: z.string().length(40), reason: z.string().max(3000) }),
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
    const payload = comment.body.slice(prefix.length);
    const end = payload.indexOf('\n```');
    if (end < 0) return;
    const data: unknown = JSON.parse(payload.slice(0, end));
    const result = eventSchema.safeParse(data);
    return result.success ? result.data : undefined;
  } catch { return; }
}
