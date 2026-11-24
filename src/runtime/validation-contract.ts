import { z } from 'zod';
import { hash } from '../state/identity.js';
import { isProtectedArtifactPath, type CodingArtifact } from '../workers/coding.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), sha = z.string().regex(/^[a-f0-9]{40}$/);
const reserved = /^(?:PATH|HOME|USER|SHELL|CI|NODE_OPTIONS|NODE_PATH|DATABASE_URL|COMPOSE_PROJECT_NAME|COMPOSE_FILE|DOCKER_HOST|DOCKER_CONTEXT|LD_.+|GITHUB_.+|GH_.+|ACTIONS_.+|RUNNER_.+|OPENAI_.+|ANTHROPIC_.+|AI_API_KEY|FACTORY_.+|AWS_.+|NPM_CONFIG_.+)$/i;
const generatedEntry = z.strictObject({
  command: z.string().min(1).max(200).regex(/^[\w.@:=+/-]+(?: [\w.@:=+/-]+)*$/, 'Generated command must be a fixed string without shell metacharacters'),
  paths: z.string().max(200).regex(/^[\w.@+-][\w.@+/-]*$/, 'Generated paths must be relative').refine(p => !p.split('/').some(part => part === '..' || part === '.' || part === '' || part === '.git'), 'Generated paths must stay inside the repository').array().min(1).max(10),
  /**
   * The coding job reruns the command after the agent, with network and the locked dependencies installed, and adopts
   * the changes inside `paths` into the same change (SF #281). No default: plans without it keep their hash.
   */
  regenerate: z.literal(true).optional(),
}).refine(e => !e.regenerate || !e.paths.some(isProtectedArtifactPath), 'Regenerated paths may not name protected files (.github, agent instructions, CODEOWNERS)');
const environmentKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(k => !reserved.test(k), 'Reserved validation environment key');
/** A disposable, empty Postgres for the tests. Absent by default, so plans without it keep their hash. */
const postgresService = z.strictObject({ version: z.number().int().min(12).max(18), env: environmentKey });
export const validationPlanSchema = z.strictObject({
  version: z.literal(1).default(1), profile: z.enum(['npm', 'npm-docker', 'maven']).default('npm'),
  /** Maven only: the JDK the validator installs. Absent means the runner's default JDK. */
  javaVersion: z.enum(['17', '21', '25']).optional(),
  timeoutMinutes: z.number().int().min(1).max(30).default(20),
  composeProjectPrefix: z.string().regex(/^[a-z][a-z0-9-]{0,30}-(?:ci|test|validation)$/).default('sf-validation'),
  /** Generated files the repository checks in: each command is rerun and must leave its paths as they are. No default. */
  generated: generatedEntry.array().max(3).optional(),
  /** Test infrastructure the validation starts before install/test (npm profiles only). */
  services: z.strictObject({ postgres: postgresService.optional() }).optional(),
  environment: z.record(environmentKey,
    z.string().max(1000).refine(v => !v.includes('${{'), 'Only literal test values are allowed')).default({}),
}).refine(p => Object.keys(p.environment).length <= 30 && Buffer.byteLength(JSON.stringify(p)) < 6000, 'Validation plan limit')
  .refine(p => !p.services?.postgres || p.profile !== 'maven', 'services.postgres applies to the npm profiles only')
  .refine(p => !p.services?.postgres || !(p.services.postgres.env in p.environment), 'services.postgres.env must not repeat an environment key')
  .refine(p => p.profile === 'maven' || p.javaVersion === undefined, 'javaVersion applies to the maven profile only')
  .refine(p => p.profile !== 'maven' || !p.generated?.some(e => e.regenerate), 'regenerate applies to the npm profiles only');
export type ValidationPlan = z.infer<typeof validationPlanSchema>;
export const defaultValidationPlan = () => validationPlanSchema.parse({});
export const validationCheckSchema = z.strictObject({ name: z.enum(['install', 'test', 'build', 'browser-install', 'browser', 'compose-config', 'docker-start', 'docker-smoke', 'docker-stop', 'database-start', 'database-stop', 'generated', 'source-integrity']),
  status: z.enum(['passed', 'failed', 'skipped']), exitCode: z.number().int().min(-1).max(255).nullable() });
export const validationReportSchema = z.strictObject({
  version: z.literal(1), executionId: z.string().regex(/^[a-f0-9]{32}$/), taskId: z.string().max(200), taskVersion: digest, baseSha: sha,
  artifactHash: digest, planHash: digest, workflowRunId: z.number().int().positive().safe(), sourceRunId: z.number().int().positive().safe(), runAttempt: z.literal(1),
  status: z.enum(['passed', 'failed', 'unsupported', 'invalid']), checks: validationCheckSchema.array().max(13),
  reason: z.enum(['CHECKS_COMPLETED', 'CHECK_FAILED', 'NO_PUBLISHABLE_CHANGES', 'UNSUPPORTED_PROJECT', 'VALIDATION_SETUP_FAILED', 'SOURCE_CHANGED', 'TEST_INFRASTRUCTURE_FAILED']),
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
    const required = ['install', 'test', 'build', 'source-integrity', ...(plan.services?.postgres ? ['database-start', 'database-stop'] : []), ...(plan.generated?.length ? ['generated'] : []), ...(plan.profile === 'npm-docker' ? ['compose-config', 'docker-start', 'docker-smoke', 'docker-stop'] : [])];
    if (!report.workspaceUnchanged || new Set(report.checks.map(c => c.name)).size !== report.checks.length || report.checks.some(c => c.status === 'failed') ||
      required.some(name => !report.checks.some(c => c.name === name && c.status === 'passed' && c.exitCode === 0))) throw new Error('INCONSISTENT_VALIDATION_REPORT');
  }
  return report;
}
