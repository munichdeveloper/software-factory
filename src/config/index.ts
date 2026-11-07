import { z } from 'zod';
import { parseDocument } from 'yaml';

export const actionKinds = ['transition', 'close_issue', 'create_followup', 'prioritize', 'approve_task',
  'start_worker', 'retry_worker', 'cancel_worker', 'expand_scope', 'merge_pr'] as const;
export const permissionSchema = z.enum(['allow', 'deny', 'approval']);
const bounded = (min: number, max: number, value: number) => z.number().int().min(min).max(max).default(value);
const slackChannel = z.string().regex(/^(?:[CG][A-Z0-9]{8,}|#[a-z0-9_-]{1,80})$/);
const notificationRule = z.strictObject({ enabled: z.boolean().default(false), channel: slackChannel.nullable().default(null) });
export const configSchema = z.strictObject({
  version: z.literal(1),
  factory: z.strictObject({ enabled: z.boolean().default(true), scope: z.string().min(1).max(4000) }),
  manager: z.strictObject({
    workflow: z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/).default('factory-manager.yml'),
    maxActions: bounded(1, 100, 10), timeoutMinutes: bounded(1, 30, 15),
    maxContextTasks: bounded(1, 100, 20), maxContextChars: bounded(1000, 100000, 20000),
    trustedActors: z.array(z.string().min(1)).min(1).default(['github-actions[bot]'])
  }).prefault({}),
  autonomy: z.strictObject({
    profile: z.enum(['advisory', 'supervised', 'autonomous']).default('supervised'),
    overrides: z.partialRecord(z.enum(actionKinds), permissionSchema).default({})
  }).prefault({}),
  execution: z.strictObject({
    dryRun: z.boolean().default(false), maxParallelWorkers: bounded(1, 20, 1),
    maxRetries: bounded(0, 5, 2), maxNewIssues: bounded(0, 20, 3),
    workerTimeoutMinutes: bounded(1, 30, 30), dispatchGraceMinutes: bounded(1, 60, 10)
  }).prefault({}),
  llm: z.strictObject({
    provider: z.enum(['mock', 'openai']).default('mock'), model: z.string().min(1).default('gpt-4.1-mini'),
    reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().default(null),
    maxOutputTokens: bounded(256, 16000, 4000), timeoutSeconds: bounded(1, 120, 60),
    maxCalls: bounded(0, 3, 1)
  }).prefault({}),
  workers: z.strictObject({
    test: z.strictObject({ enabled: z.boolean().default(true), operation: z.enum(['sha256', 'fail', 'blocked']).default('sha256') })
      .prefault({}),
    coding: z.union([z.literal(false), z.strictObject({ enabled: z.boolean(), agent: z.literal('codex'),
      model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/).default('gpt-6.1-sol'),
      reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
      validationWorkflow: z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/).nullable().default(null) })]).default(false),
    review: z.literal(false).default(false)
  }).prefault({}),
  reporting: z.strictObject({ persistDecisions: z.boolean().default(true) }).prefault({}),
  notifications: z.strictObject({ slack: z.strictObject({
    enabled: z.boolean().default(false), channel: slackChannel.nullable().default(null),
    maxPerRun: bounded(1, 100, 20),
    since: z.iso.datetime().nullable().default(null),
    events: z.strictObject({
      issue_created: notificationRule.prefault({}),
      pr_merged: notificationRule.extend({ actors: z.array(z.string().regex(/^[A-Za-z0-9_-]+(?:\[bot\])?$/)).max(20).default([]) }).prefault({})
    }).prefault({})
  }).prefault({}) }).prefault({})
});
export type Config = z.infer<typeof configSchema>;
export function loadConfig(source: string): Config {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors.map(e => e.message).join('; ')}`);
  const result = configSchema.safeParse(doc.toJS({ maxAliasCount: 20 }));
  if (!result.success) throw new Error(`Invalid factory configuration: ${result.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`);
  return result.data;
}
