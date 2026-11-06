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
  publish(base: CodingBase, artifact: CodingArtifact, issue: number): Promise<string>;
}
export function validateChanges(artifact: CodingArtifact): void {
  const seen = new Set<string>();
  let total = 0;
  for (const change of artifact.changes) {
    const parts = change.path.split('/');
    if (change.path.includes('\\') || change.path.includes(':') || [...change.path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      parts.some(p => !p || p === '.' || p === '..' || p.endsWith('.') || p.endsWith(' ') ||
        /^(\.git.*|\.codex|\.agents|\.squad|\.copilot|\.claude|agents\.md|codeowners)$/i.test(p))) throw new Error('Protected or invalid artifact path');
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
    task: { id: taskId(github.repository, issue), version: auth.input.taskVersion, description: auth.input.description,
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
      if (status === 'success' && artifact.changes.length) artifacts.push(await repository.publish(base, artifact, issue));
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
