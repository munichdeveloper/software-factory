import { z } from 'zod';
import { parseDocument } from 'yaml';
import { globPattern, riskClassSchema } from '../merge/risk.js';

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
    engine: z.enum(['github-actions', 'temporal']).default('github-actions'),
    dryRun: z.boolean().default(false), maxParallelWorkers: bounded(1, 20, 1),
    maxRetries: bounded(0, 5, 2), maxNewIssues: bounded(0, 20, 3),
    workerTimeoutMinutes: bounded(1, 30, 30), dispatchGraceMinutes: bounded(1, 60, 10),
    /** A failed independent validation starts a further attempt, within maxRetries, instead of waiting for a person. */
    rework: z.boolean().default(false)
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
      validationWorkflow: z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/).nullable().default(null),
      /** Temporal executor: the worker's commands may use a private loopback (local server, browser tests); other network stays closed. */
      loopback: z.boolean().default(false),
      /** Tells the worker to keep each change to the task's one concern and to propose a split instead of one large PR. */
      smallPullRequests: z.boolean().default(true) })]).default(false),
    review: z.literal(false).default(false)
  }).prefault({}),
  reporting: z.strictObject({ persistDecisions: z.boolean().default(true) }).prefault({}),
  merge: z.strictObject({
    enabled: z.boolean().default(false), includeFactoryPRs: z.boolean().default(true),
    adoptLabel: z.string().min(1).max(100).default('sf:automerge'),
    method: z.enum(['squash', 'merge', 'rebase']).default('squash'), updateBranch: z.boolean().default(true),
    // 'github': server-side branch rules with strict required checks are mandatory. 'factory': for repositories whose
    // plan has no branch rules, the Factory itself requires requiredChecks on the exact head and a head containing the
    // current base. People with write access can still merge directly; only the Factory's own merges are gated.
    protection: z.enum(['github', 'factory']).default('github'),
    requiredChecks: z.array(z.string().min(1).max(200)).min(1).max(30).default(['test-backend', 'test-frontend', 'test-docker']),
    // Dispatched for the new head after a branch update; null where the pull request's own checks run on every push.
    validationWorkflow: z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/).nullable().default('test.yml'),
    maxReviewsPerRun: bounded(1, 5, 2), maxActionsPerRun: bounded(1, 3, 1),
    review: z.strictObject({
      // 'llm' follows llm.provider, so a mock configuration never approves a merge. 'openai' always reviews with OpenAI,
      // also when planning stays deterministic (llm.provider mock).
      provider: z.enum(['llm', 'openai']).default('llm'),
      model: z.string().min(1).max(100).default('gpt-6.1-sol'),
      reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('high'),
      timeoutSeconds: bounded(10, 120, 120), maxOutputTokens: bounded(1000, 12000, 6000),
      maxFiles: bounded(1, 100, 60), maxContextBytes: bounded(10000, 500000, 250000)
    }).prefault({}),
    postMergeWorkflows: z.array(z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/)).max(10).default([]),
    // Risk-based auto-merge: a risk class per head decides whether merge_pr 'allow' merges on its own or needs approval.
    risk: z.strictObject({
      enabled: z.boolean().default(false),
      // observe: classify and show only; enforce: above the threshold a person approves (or merges) instead of the Factory.
      mode: z.enum(['enforce', 'observe']).default('enforce'),
      autoMergeUpTo: z.enum(['low', 'medium', 'high']).default('medium'),
      aboveThreshold: z.enum(['approval', 'block']).default('approval'),
      maxLowRiskLines: bounded(1, 100000, 300), maxMediumRiskLines: bounded(1, 100000, 800),
      assessor: z.strictObject({
        provider: z.enum(['llm', 'openai']).default('llm'),
        model: z.string().min(1).max(100).default('gpt-6.1-sol'),
        reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).default('medium'),
        timeoutSeconds: bounded(10, 120, 90)
      }).prefault({}),
      guidance: z.string().min(1).max(2000).nullable().default(null),
      areas: z.array(z.strictObject({
        name: z.string().regex(/^[^\n]{1,100}$/),
        paths: z.array(globPattern).min(1).max(20),
        class: riskClassSchema
      })).max(30).default([])
    }).superRefine((risk, context) => {
      if (risk.maxMediumRiskLines < risk.maxLowRiskLines) context.addIssue({ code: 'custom', path: ['maxMediumRiskLines'], message: 'must not be lower than maxLowRiskLines' });
      if (new Set(risk.areas.map(a => a.name)).size !== risk.areas.length) context.addIssue({ code: 'custom', path: ['areas'], message: 'area names must be unique' });
    }).prefault({})
  }).superRefine((merge, context) => {
    if (merge.risk.enabled && !merge.enabled) context.addIssue({ code: 'custom', path: ['risk', 'enabled'], message: 'requires merge.enabled' });
  }).prefault({}),
  deploy: z.strictObject({
    enabled: z.boolean().default(false),
    provider: z.literal('docker-ssh').default('docker-ssh'),
    trigger: z.enum(['checks', 'push']).default('checks'),
    workflows: z.array(z.string().min(1).max(200)).max(10).default([]),
    environment: z.string().regex(/^[A-Za-z0-9 ._-]{1,100}$/).default('production'),
    host: z.string().regex(/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/).nullable().default(null),
    port: z.number().int().min(1).max(65535).nullable().default(null),
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).nullable().default(null),
    path: z.string().regex(/^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/).refine(p => !p.split('/').includes('..'), 'must not contain ..').default('/opt/app'),
    composeFile: z.string().regex(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.ya?ml$/).refine(p => !p.split('/').includes('..'), 'must not contain ..').default('compose.yaml'),
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).nullable().default(null),
    envFile: z.string().regex(/^(?:\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/).refine(p => !p.split('/').includes('..'), 'must not contain ..').nullable().default('.env'),
    healthcheck: z.strictObject({
      url: z.url({ protocol: /^https?$/ }).nullable().default(null),
      timeoutSeconds: bounded(10, 900, 180)
    }).prefault({}),
    rollback: z.boolean().default(true),
    keepReleases: bounded(1, 20, 5),
    timeoutMinutes: bounded(5, 60, 30),
    githubDeployment: z.boolean().default(false)
  }).superRefine((deploy, context) => {
    if (deploy.enabled && deploy.trigger === 'checks' && !deploy.workflows.length) {
      context.addIssue({ code: 'custom', path: ['workflows'], message: 'trigger checks requires at least one workflow name' });
    }
  }).prefault({}),
  notifications: z.strictObject({ slack: z.strictObject({
    enabled: z.boolean().default(false), channel: slackChannel.nullable().default(null),
    maxPerRun: bounded(1, 100, 20),
    since: z.iso.datetime().nullable().default(null),
    events: z.strictObject({
      // Optional without a default, so configurations that leave it out keep their hash and in-flight runs stay current.
      run_started: notificationRule.optional(),
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
