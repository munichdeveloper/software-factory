import { z } from 'zod';
import { parseDocument } from 'yaml';
import { globPattern, riskClassSchema } from '../merge/risk.js';

export const actionKinds = ['transition', 'close_issue', 'create_followup', 'prioritize', 'approve_task',
  'start_worker', 'retry_worker', 'cancel_worker', 'expand_scope', 'merge_pr'] as const;
export const permissionSchema = z.enum(['allow', 'deny', 'approval']);
const bounded = (min: number, max: number, value: number) => z.number().int().min(min).max(max).default(value);
const slackChannel = z.string().regex(/^(?:[CG][A-Z0-9]{8,}|#[a-z0-9_-]{1,80})$/);
const notificationRule = z.strictObject({ enabled: z.boolean().default(false), channel: slackChannel.nullable().default(null) });
/**
 * The broker's sanity check of a repository's Factory runs (stuck runs, dead ends, endless retries). Optional and without
 * defaults in the parsed configuration: a repository that does not set it keeps its configuration hash, so in-flight runs
 * stay current. Read it through monitoringSettings().
 */
export const monitoringSchema = z.strictObject({
  enabled: z.boolean().default(true),
  /** A run still active this many minutes after its worker timeout is reported as stuck. */
  stuckRunMinutes: bounded(5, 1440, 60),
  /** A run waiting this long at its approval gate is reported. */
  approvalWaitHours: bounded(1, 720, 48),
  /** This many attempts of a task in a row ending with the same error code count as an endless retry. */
  repeatedFailures: bounded(2, 20, 3),
  /** Consecutive reconciliations a task's label may differ from its derived status, or a reconciliation may fail, before it is reported. */
  stalledPasses: bounded(2, 200, 10),
  /** Posts new and resolved findings to Slack with the broker's bot, in `channel` or else the notifications channel where notifications are enabled. */
  slack: z.boolean().default(true),
  channel: slackChannel.nullable().default(null)
});
export type MonitoringSettings = z.infer<typeof monitoringSchema>;
const codingAgentName = z.enum(['codex', 'claude']);
const codingModel = z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/);
const codingEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
function agentRules(entry: { agent: 'codex' | 'claude'; model: string; reasoningEffort: string }, context: z.RefinementCtx) {
  if (entry.agent === 'claude' && !/^claude-/.test(entry.model)) {
    context.addIssue({ code: 'custom', path: ['model'], message: 'agent claude needs a Claude model, for example claude-opus-5-5' });
  }
  if (entry.agent === 'codex' && /^claude-/.test(entry.model)) {
    context.addIssue({ code: 'custom', path: ['model'], message: 'a Claude model needs agent claude' });
  }
  if (entry.agent === 'codex' && entry.reasoningEffort === 'max') {
    context.addIssue({ code: 'custom', path: ['reasoningEffort'], message: 'max is available for agent claude only' });
  }
}
/**
 * One entry of workers.coding.agents. credential subscription (agent claude only): Claude Code runs with the OAuth token
 * of a Claude subscription (repository secret CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`) instead of the API
 * key, within the subscription's usage limits and the broker's daily cap (FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY). Only
 * as a fallback, never first in a list. Optional without a default, so entries that leave it out keep their hash.
 */
const codingAgentSchema = z.strictObject({ agent: codingAgentName, model: codingModel, reasoningEffort: codingEffort.default('high'),
  credential: z.literal('subscription').optional() })
  .superRefine((entry, context) => {
    agentRules(entry, context);
    if (entry.credential && entry.agent !== 'claude') context.addIssue({ code: 'custom', path: ['credential'], message: 'credential subscription is available for agent claude only' });
  });
export type CodingAgent = z.infer<typeof codingAgentSchema>;
/** An option the model router may pick; id names it in the decision. Jev sees its model, runner and effort, plus the optional description. */
const routerOptionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), routerDescription = z.string().min(1).max(300).optional();
const codingCandidateSchema = z.strictObject({ id: routerOptionId, agent: codingAgentName, model: codingModel, reasoningEffort: codingEffort,
  description: routerDescription }).superRefine((entry, context) => agentRules(entry, context));
/** A broker-side model (merge review, risk assessment, planner): Claude with the broker's Anthropic key or OpenAI. */
const llmCandidateSchema = z.strictObject({ id: routerOptionId, provider: z.enum(['claude', 'openai']), model: codingModel,
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']), description: routerDescription }).superRefine((entry, context) => {
  if ((entry.provider === 'claude') !== /^claude-/.test(entry.model)) context.addIssue({ code: 'custom', path: ['model'], message: 'provider claude needs a Claude model, provider openai a non-Claude model' });
});
/** Room for a full matrix of models and efforts (Johannes, 2026-11-19: Jev chooses freely between models and efforts). */
export const maxRouterCandidates = 16;
const routerCandidates = <T extends z.ZodType<{ id: string }>>(candidate: T) => z.strictObject({ candidates: z.array(candidate).min(2).max(maxRouterCandidates) })
  .superRefine((value, context) => {
    if (new Set(value.candidates.map(c => c.id)).size !== value.candidates.length) context.addIssue({ code: 'custom', path: ['candidates'], message: 'candidate ids must be unique' });
  });
/**
 * Model router: before a model works, a decision model (TypeSafe Jev via OpenRouter, the broker's OPENROUTER_API_KEY)
 * picks one of the candidates of that purpose. Without an answer above minConfidence the configured models run as
 * before, and the broker reports it. A purpose without candidates is not routed. Optional without a default, so
 * configurations that leave it out keep their hash.
 */
export const routerSchema = z.strictObject({
  enabled: z.boolean().default(true),
  model: z.string().regex(/^~?[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]{0,80}$/).default('typesafe/jev-1.14'),
  minConfidence: z.number().min(0).max(1).default(0.5),
  timeoutSeconds: bounded(1, 30, 10),
  /** First attempts of coding runs (Temporal engine); escalated attempts keep retryAgents. */
  coding: routerCandidates(codingCandidateSchema).optional(),
  review: routerCandidates(llmCandidateSchema).optional(),
  risk: routerCandidates(llmCandidateSchema).optional(),
  planner: routerCandidates(llmCandidateSchema).optional()
});
export type RouterConfig = z.infer<typeof routerSchema>;
export type CodingCandidate = z.infer<typeof codingCandidateSchema>;
export type LlmCandidate = z.infer<typeof llmCandidateSchema>;
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
    overrides: z.partialRecord(z.enum(actionKinds), permissionSchema).default({}),
    /**
     * What admits a run in a repository the SF Manager registered with the ready label as grant. `ready-label`: only
     * `harness:ready` applied by a person with write access. `managed-label`: `harness:managed` applied by a person
     * with write access is the grant, and the Factory's own follow-ups inherit it. `none`: no grant; every managed, runnable task starts
     * within the autonomy policy and the execution limits.
     */
    startGrant: z.enum(['ready-label', 'managed-label', 'none']).default('ready-label')
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
    coding: z.union([z.literal(false), z.strictObject({ enabled: z.boolean(),
      /**
       * codex (OpenAI Codex CLI, OPENAI_API_KEY) or claude (Claude Code CLI, ANTHROPIC_API_KEY; Temporal engine only).
       * Name either agent (one agent, with model and reasoningEffort below) or agents (a priority list).
       */
      agent: codingAgentName.optional(),
      /**
       * Priority list, Temporal engine only: before each run the executor asks each agent's provider, in this order,
       * whether its credit is used up, and runs the first one that still has credit. Optional without a default, so
       * configurations that leave it out keep their hash and in-flight runs stay current.
       */
      agents: z.array(codingAgentSchema).min(1).max(3).optional(),
      /**
       * Optional priority list for escalated attempts, Temporal engine only: a further attempt after an earlier attempt
       * failed for a reason the agent owns (failed validation, requested changes, failed or timed-out agent run). A retry
       * after the runner failed before the agent started keeps agents. Without it every attempt uses agents (or agent). Optional without a default, so configurations that leave it out keep their hash.
       */
      retryAgents: z.array(codingAgentSchema).min(1).max(3).optional(),
      /** The default is a Codex model; with agent claude name a Claude model such as claude-opus-5-5 or claude-sonnet-5-5. */
      model: codingModel.default('gpt-6.1-sol'),
      /** max is available for Claude only. */
      reasoningEffort: codingEffort.default('high'),
      validationWorkflow: z.string().regex(/^[a-zA-Z0-9_-]+\.ya?ml$/).nullable().default(null),
      /** Temporal executor: the worker's commands may use a private loopback (local server, browser tests); other network stays closed. */
      loopback: z.boolean().default(false),
      /** Tells the worker to keep each change to the task's one concern and to propose a split instead of one large PR. */
      smallPullRequests: z.boolean().default(true),
      /**
       * Spend cap per coding attempt in US dollars, Temporal engine only: Claude Code stops at it (--max-budget-usd; Codex
       * has no such limit). Without it the broker uses 10 $. Optional without a default, so configurations keep their hash.
       */
      maxCostUsd: z.number().positive().max(1000).optional() }).superRefine((coding, context) => {
      for (const key of ['agents', 'retryAgents'] as const) {
        const seen = new Set<string>();
        coding[key]?.forEach((entry, index) => {
          const id = `${entry.agent}:${entry.credential ?? 'api-key'}`;
          if (seen.has(id)) context.addIssue({ code: 'custom', path: [key, index, 'agent'], message: 'each agent may appear once (claude may appear once more with credential subscription)' });
          seen.add(id);
        });
        if (coding[key]?.[0]?.credential) context.addIssue({ code: 'custom', path: [key, 0, 'credential'], message: 'the subscription is a fallback: list an agent with its API key first' });
      }
      if (coding.agents) {
        if (coding.agent) context.addIssue({ code: 'custom', path: ['agent'], message: 'name either agent or agents, not both' });
        return;
      }
      if (!coding.agent) { context.addIssue({ code: 'custom', path: ['agent'], message: 'name agent or agents' }); return; }
      agentRules({ agent: coding.agent, model: coding.model, reasoningEffort: coding.reasoningEffort }, context);
    })]).default(false),
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
      maxFiles: bounded(1, 100, 60), maxContextBytes: bounded(10000, 500000, 250000),
      // A larger change set is reviewed in up to maxParts parts of maxContextBytes each (1: no parts, rejected as before).
      // Optional without a default (4 applies, reviewParts): configurations that leave it out keep their hash, so runs
      // in flight across the broker deploy stay current.
      maxParts: z.number().int().min(1).max(8).optional()
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
    // An end-to-end check after the release is healthy, e.g. the runtime canary (software-factory#27). A failure fails the
    // deployment; with verify.rollback the previous release is started again, otherwise the new release keeps running.
    verify: z.strictObject({
      script: z.string().regex(/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.sh$/).refine(p => !p.split('/').includes('..'), 'must not contain ..').nullable().default(null),
      timeoutSeconds: bounded(30, 3600, 900),
      rollback: z.boolean().default(false),
    }).prefault({}),
    keepReleases: bounded(1, 20, 5),
    timeoutMinutes: bounded(5, 60, 30),
    githubDeployment: z.boolean().default(false),
    // Application secrets from the deploy environment's GitHub secrets: variable name -> secret name. The SF Manager
    // writes them into the wrapper's deploy-env (NAME=${{ secrets.SECRET }}); the values never enter this file.
    // The deployment's own credentials (DEPLOY_*) and GitHub's reserved names cannot be passed on.
    secrets: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).refine(s => !/^(?:GITHUB_|DEPLOY_)/i.test(s), 'must not name a GITHUB_ or DEPLOY_ secret'))
      .refine(s => Object.keys(s).length <= 30, 'at most 30 secrets').default({})
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
      // A PR whose risk class is above merge.risk.autoMergeUpTo waits for `/harness approve`; optional for the same reason.
      approval_required: notificationRule.optional(),
      // A task that waits for nothing but a person's `harness:ready` grant (ready-label repositories); optional for the same reason.
      grant_required: notificationRule.optional(),
      // A Factory PR the review handed over to a person (merge_handover); optional for the same reason.
      handover_required: notificationRule.optional(),
      // Runtime events (docs/failure-events.md, issue #188), posted by the broker; optional for the same reason.
      // start_refused posts only refusals that hold for the whole repository, once per repository, code and day.
      validation_failed: notificationRule.optional(),
      start_refused: notificationRule.optional(),
      attention_required: notificationRule.optional(),
      issue_created: notificationRule.prefault({}),
      pr_merged: notificationRule.extend({ actors: z.array(z.string().regex(/^[A-Za-z0-9_-]+(?:\[bot\])?$/)).max(20).default([]) }).prefault({})
    }).prefault({})
  }).prefault({}) }).prefault({}),
  monitoring: monitoringSchema.partial().optional(),
  router: routerSchema.optional()
}).superRefine((config, context) => {
  if (config.router?.coding && config.execution.engine !== 'temporal') context.addIssue({ code: 'custom', path: ['router', 'coding'], message: 'router.coding requires execution.engine temporal' });
  // The Claude worker and the agent priority list exist only in the Temporal executor; the legacy Actions coding workflow runs Codex.
  if (config.workers.coding && config.execution.engine !== 'temporal') {
    if (config.workers.coding.retryAgents) context.addIssue({ code: 'custom', path: ['workers', 'coding', 'retryAgents'], message: 'retryAgents requires execution.engine temporal' });
    if (config.workers.coding.agents) context.addIssue({ code: 'custom', path: ['workers', 'coding', 'agents'], message: 'agents requires execution.engine temporal' });
    else if (config.workers.coding.agent === 'claude') context.addIssue({ code: 'custom', path: ['workers', 'coding', 'agent'], message: 'agent claude requires execution.engine temporal' });
  }
});
export type Config = z.infer<typeof configSchema>;
/** The repository's coding agents in priority order: agents, or the single agent with model and reasoningEffort. */
export function codingAgents(coding: Exclude<Config['workers']['coding'], false>): CodingAgent[] {
  return coding.agents ?? [{ agent: coding.agent ?? 'codex', model: coding.model, reasoningEffort: coding.reasoningEffort }];
}
/** The agents of one attempt: retryAgents for an escalated attempt when configured, otherwise the regular list. */
export function attemptAgents(coding: Exclude<Config['workers']['coding'], false>, escalate: boolean): CodingAgent[] {
  return escalate && coding.retryAgents ? coding.retryAgents : codingAgents(coding);
}
export function loadConfig(source: string): Config {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid YAML: ${doc.errors.map(e => e.message).join('; ')}`);
  const result = configSchema.safeParse(doc.toJS({ maxAliasCount: 20 }));
  if (!result.success) throw new Error(`Invalid factory configuration: ${result.error.issues.map(i => `${i.path.join('.') || 'root'}: ${i.message}`).join('; ')}`);
  return result.data;
}
export const monitoringSettings = (config: Config): MonitoringSettings => monitoringSchema.parse(config.monitoring ?? {});
/** Where a repository's sanity findings go in Slack, or null. */
export function monitoringChannel(config: Config): string | null {
  const settings = monitoringSettings(config);
  if (!settings.enabled || !settings.slack) return null;
  return settings.channel ?? (config.notifications.slack.enabled ? config.notifications.slack.channel : null);
}
