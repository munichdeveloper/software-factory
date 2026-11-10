import { z } from 'zod';
import { hash } from '../state/identity.js';
import type { CodingArtifact } from '../workers/coding.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const reserved = /^(?:PATH|HOME|USER|SHELL|CI|NODE_OPTIONS|NODE_PATH|DATABASE_URL|COMPOSE_PROJECT_NAME|COMPOSE_FILE|DOCKER_HOST|DOCKER_CONTEXT|LD_.+|GITHUB_.+|GH_.+|ACTIONS_.+|RUNNER_.+|OPENAI_.+|ANTHROPIC_.+|AI_API_KEY|FACTORY_.+|AWS_.+|NPM_CONFIG_.+)$/i;
export const validationPlanSchema = z.strictObject({
  version: z.literal(1).default(1), profile: z.enum(['npm', 'npm-docker']).default('npm'),
  timeoutMinutes: z.number().int().min(1).max(30).default(20),
  composeProjectPrefix: z.string().regex(/^[a-z][a-z0-9-]{0,30}-(?:ci|test|validation)$/).default('sf-validation'),
  environment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(k => !reserved.test(k), 'Reserved validation environment key'),
    z.string().max(1000).refine(v => !v.includes('${{'), 'Only literal test values are allowed')).default({}),
}).refine(p => Object.keys(p.environment).length <= 30 && Buffer.byteLength(JSON.stringify(p)) < 6000, 'Validation plan limit');
export type ValidationPlan = z.infer<typeof validationPlanSchema>;
export const defaultValidationPlan = () => validationPlanSchema.parse({});
export const validationCheckSchema = z.strictObject({ name: z.enum(['install', 'test', 'build', 'browser-install', 'browser', 'compose-config', 'docker-start', 'docker-smoke', 'docker-stop', 'source-integrity']),
  status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().min(-1).max(255).nullable() });
export const validationReportSchema = z.strictObject({
  version: z.literal(1), executionId: z.string().regex(/^[a-f0-9]{32}$/), taskId: z.string().max(200), taskVersion: digest, baseSha: sha,
  artifactHash: digest, planHash: digest, workflowRunId: z.number().int().positive().safe(), sourceRunId: z.number().int().positive().safe(), runAttempt: z.literal(1),
  status: z.enum(['passed', 'failed', 'unsupported', 'invalid']), checks: validationCheckSchema.array().max(10),
  reason: z.enum(['CHECKS_COMPLETED', 'CHECK_FAILED', 'NO_PUBLISHABLE_CHANGES', 'UNSUPPORTED_PROJECT', 'VALIDATION_SETUP_FAILED', 'SOURCE_CHANGED']),
  modelSecretPresent: z.literal(false), workspaceUnchanged: z.boolean(),
});
export type ValidationReport = z.infer<typeof validationReportSchema>;
export function bindValidation(report: ValidationReport, artifact: CodingArtifact, plan: ValidationPlan, workflowRunId?: number) {
  validationReportSchema.parse(report); validationPlanSchema.parse(plan);
  if (report.executionId !== artifact.result.executionId || report.taskId !== artifact.result.taskId || report.taskVersion !== artifact.result.taskVersion ||
    report.baseSha !== artifact.baseSha || report.artifactHash !== hash(artifact) || report.planHash !== hash(plan) ||
    workflowRunId !== undefined && (report.workflowRunId !== workflowRunId || report.sourceRunId !== workflowRunId)) throw new Error('UNRELATED_VALIDATION_REPORT');
  if (report.status === 'invalid') throw new Error('INVALID_VALIDATION_SOURCE');
  if (report.status === 'passed') {
    const required = ['install', 'test', 'build', 'source-integrity', ...(plan.profile === 'npm-docker' ? ['compose-config', 'docker-start', 'docker-smoke', 'docker-stop'] : [])];
    if (!report.workspaceUnchanged || new Set(report.checks.map(c => c.name)).size !== report.checks.length || report.checks.some(c => c.status === 'failed') ||
      required.some(name => !report.checks.some(c => c.name === name && c.status === 'passed' && c.exitCode === 0))) throw new Error('INCONSISTENT_VALIDATION_REPORT');
  }
  return report;
}
