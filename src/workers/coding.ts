import { z } from 'zod';
import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import { authorizeDelegation, persistResult } from './execute-delegation.js';
import { workerResultSchema, type WorkerResult } from './contract.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const codingArtifactSchema = z.strictObject({
  contractVersion: z.literal('3.0'), baseSha: sha,
  result: z.strictObject({ contractVersion: z.literal('2.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/),
    taskId: z.string().max(200), taskVersion: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['success', 'failed', 'blocked', 'needs_approval', 'cancelled', 'timed_out']),
    summary: z.string().min(1).max(2000), artifacts: z.array(z.string().max(2000)).max(20), error: z.string().max(2000).nullable() }),
  changes: z.array(z.strictObject({ path: z.string().min(1).max(500), content: z.string().max(6666668).nullable(),
    mode: z.enum(['100644', '100755']) })).max(100)
});
export type CodingArtifact = z.infer<typeof codingArtifactSchema>;
export interface CodingBase { sha: string; branch: string }
export interface CodingRepositoryPort {
  base(): Promise<CodingBase>;
  publish(base: CodingBase, artifact: CodingArtifact, issue: number, validationWorkflow?: string | null): Promise<string>;
}
const protectedPathSegment = /^(\.git.*|\.codex|\.agents|\.squad|\.copilot|\.claude|agents\.md|codeowners)$/i;
/** Plain ignore and attribute files are ordinary project files; `.git/`, `.github/`, `.gitmodules` and the rest stay protected (controla#124). */
const allowedGitFile = /^\.git(ignore|attributes)$/i;
export function validateChanges(artifact: CodingArtifact): void {
  const seen = new Set<string>();
  let total = 0;
  for (const change of artifact.changes) {
    const parts = change.path.split('/');
    if (change.path.includes('\\') || change.path.includes(':') || [...change.path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') ||
        (protectedPathSegment.test(p) && !allowedGitFile.test(p)))) throw new Error(`Protected or invalid artifact path: ${JSON.stringify(change.path)}`);
    const key = change.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate artifact path');
    seen.add(key);
    if (change.content !== null) {
      const bytes = Buffer.from(change.content, 'base64');
      if (bytes.toString('base64') !== change.content) throw new Error('Invalid artifact encoding');
      total += bytes.length;
    }
  }
  if (total > 5000000) throw new Error('Artifact exceeds publication limit');
}
/**
 * Small, single-concern pull requests are reviewed more reliably and are easier to keep within the risk-based merge's
 * threshold. Sent when `workers.coding.smallPullRequests` is on.
 */
export const smallPullRequestGuidance = '\n\nFactory working rule, small pull requests: keep this change to the one concern of this task. Change only what the task and its acceptance criteria need: no drive-by refactoring, renaming, reformatting, dependency upgrades or unrelated fixes, even where they look worthwhile; mention them in your summary instead. If the task bundles several independent concerns or is too large for one reviewable change, do not build one large change: make no changes, report `blocked` and name in your summary how to split it into follow-up tasks, one concern each.';

/**
 * Isolate risk (Johannes, 2026-11-20, SF #210): with risk-based merging, a change touching authentication, permissions,
 * money or data migrations needs a person (#209), everything else merges on its own. A task that mixes both should land
 * as two pull requests, so only the small risky one waits for a person. Sent with the small pull request rule when
 * `merge.risk` is enabled; the Jev planner catches such tasks before the start where it plans, this is the fallback during the run
 * (llm/risk-split.ts writes the two tasks).
 */
export const riskIsolationGuidance = '\n\nFactory working rule, isolate risk: pull requests that change authentication, permissions or roles, anything involving money (payments, billing, prices, invoices, credits) or data migrations need a person to approve the merge; everything else merges automatically. If this task mixes such a risky part with routine work that is useful and correct on its own, do not build one mixed change: make no changes, report `blocked` and start your summary with `Risk split:` followed by the routine part and the risky part; the Factory then creates the two tasks. If the risky part cannot be separated, or the task is only the risky part, implement it and keep the risky change as small as possible.';
/** The scope rules sent with a coding request: small pull requests, plus risk isolation when risk-based merging is on. */
export const scopeGuidance = (config: Config) => !config.workers.coding || !config.workers.coding.smallPullRequests ? ''
  : smallPullRequestGuidance + (config.merge.risk.enabled && config.merge.risk.mode === 'enforce' ? riskIsolationGuidance : '');

export const testSecretGuidance = '\n\nFactory working rule, test secrets: test and example values for tokens, API keys, passwords, private keys, connection strings and similar must be obvious placeholders (for example `test-token`, `dummy-api-key`, `not-a-real-password`) or be assembled at runtime from harmless parts. Never use realistic vendor formats: known key prefixes, high-entropy strings of real key length, PEM blocks or real-looking connection strings with credentials. This applies to tests, fixtures, examples, docs and seed data. If existing code validates a specific secret format, build the test value at runtime (string concatenation or `repeat`) instead of writing a literal that looks real.';

const workingRules = (config: Config) => scopeGuidance(config) + testSecretGuidance;

const taskId = (repository: string, issue: number) => `github:${repository}#${issue}`;

export async function prepareCoding(github: GitHubPort, config: Config, repository: CodingRepositoryPort,
  issue: number, id: string, correlationId: string) {
  const auth = await authorizeDelegation(github, config, issue, id);
  if (auth.previous) return null;
  if (auth.cancelled) { await persistResult(github, auth.cancelled, correlationId); return null; }
  if (auth.input.worker !== 'codex' || !config.workers.coding || !config.workers.coding.enabled) throw new Error('Coding worker disabled');
  const base = await repository.base();
  sha.parse(base.sha);
  return { base, request: { contractVersion: '3.0', executionId: id, worker: 'codex',
    task: { id: taskId(github.repository, issue), version: auth.input.taskVersion,
      description: auth.input.description.length + workingRules(config).length <= 20000
        ? auth.input.description + workingRules(config) : auth.input.description,
      acceptanceCriteria: auth.input.acceptanceCriteria, contextReferences: auth.input.contextReferences },
    baseSha: base.sha, allowedActions: ['edit_workspace', 'run_commands'], model: config.workers.coding.model,
    effort: config.workers.coding.reasoningEffort,
    limits: { timeoutMinutes: auth.input.limits.timeoutMinutes, maxFiles: 100, maxPatchBytes: 5000000 } } };
}

export async function publishCoding(github: GitHubPort, config: Config, repository: CodingRepositoryPort,
  issue: number, id: string, correlationId: string, base: CodingBase, source: unknown): Promise<WorkerResult> {
  const auth = await authorizeDelegation(github, config, issue, id);
  if (auth.previous) return auth.previous;
  let result = auth.cancelled;
  if (!result) {
    if (auth.input.worker !== 'codex') throw new Error('Not a coding delegation');
    try {
      const artifact = codingArtifactSchema.parse(source);
      if (artifact.baseSha !== base.sha || artifact.result.executionId !== id || artifact.result.taskVersion !== auth.input.taskVersion ||
        artifact.result.taskId !== taskId(github.repository, issue)) throw new Error('Unrelated coding artifact');
      validateChanges(artifact);
      const status = artifact.result.status === 'timed_out' ? 'failed' : artifact.result.status;
      const artifacts: string[] = [];
      if (status === 'success' && artifact.changes.length) artifacts.push(await repository.publish(base, artifact, issue,
        config.workers.coding ? config.workers.coding.validationWorkflow : null));
      result = workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber: issue,
        status: status === 'success' && !artifact.changes.length ? 'blocked' : status,
        summary: artifact.result.summary, artifacts, error: artifact.result.error, proposedActions: [] });
    } catch {
      result = workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber: issue, status: 'failed',
        summary: 'Coding run or publication failed', artifacts: [], error: 'Missing, invalid or unpublishable coding result', proposedActions: [] });
    }
  }
  await persistResult(github, result, correlationId);
  return result;
}
