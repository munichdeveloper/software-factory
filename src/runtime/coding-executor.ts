import type { Octokit } from '@octokit/rest';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { codingExecutionSchema } from './coding-contract.js';
import { codingArtifactSchema, validateChanges, type CodingArtifact } from '../workers/coding.js';
import type { Config } from '../config/index.js';
import type { RunSnapshot } from './contract.js';
import type { EffectPort } from './effects.js';
import { hash } from '../state/identity.js';

export const codingWorkflow = 'factory-temporal-executor.yml';
export function executorWrapper(factorySha: string, harnessSha: string) {
  for (const sha of [factorySha, harnessSha]) if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('INVALID_EXECUTOR_RELEASE');
  return `name: Factory Temporal executor\nrun-name: SF Temporal \${{ fromJSON(inputs.request).executionId }} \${{ inputs.binding }}\non:\n  workflow_dispatch:\n    inputs:\n      request:\n        type: string\n        required: true\n      binding:\n        type: string\n        required: true\npermissions:\n  contents: read\nconcurrency:\n  group: sf-temporal-\${{ fromJSON(inputs.request).executionId }}\n  cancel-in-progress: false\njobs:\n  code:\n    permissions:\n      contents: read\n    uses: munichdeveloper/software-factory/.github/workflows/temporal-coding-executor.yml@${factorySha}\n    with:\n      factory-ref: ${factorySha}\n      harness-ref: ${harnessSha}\n      request: \${{ inputs.request }}\n    secrets:\n      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n`;
}
export function decodeCodingArchive(bytes: Uint8Array): CodingArtifact {
  if (bytes.length > 8000000) throw new Error('ARTIFACT_ARCHIVE_LIMIT');
  let count = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (++count !== 1 || entry.name !== 'artifact.json' || entry.originalSize > 7000000 || entry.originalSize < 2) throw new Error('UNEXPECTED_ARTIFACT_ENTRY');
    return true;
  } });
  if (count !== 1 || !files['artifact.json']) throw new Error('MISSING_CODING_ARTIFACT');
  const artifact = codingArtifactSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['artifact.json'])));
  validateChanges(artifact); return artifact;
}
export interface CodingExecutionPort {
  poll(snapshot: RunSnapshot, binding: string, config: Config): Promise<{ artifact: CodingArtifact } | { failed: true } | null>;
  cancel(snapshot: RunSnapshot, binding: string): Promise<void>;
}
/** Actions supplies disposable compute only. Temporal/broker retain dispatch, gate and publication authority. */
export class ActionsCodingExecutor implements CodingExecutionPort {
  constructor(private api: Octokit, private effects: (snapshot: RunSnapshot, binding: string) => EffectPort,
    private authorize: (snapshot: RunSnapshot, binding: string) => Promise<unknown>, private trustedActors: string[]) {}
  async cancel(snapshot: RunSnapshot, binding: string) {
    if (binding !== hash(snapshot)) throw new Error('EXECUTOR_BINDING_MISMATCH');
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo }, id = snapshot.admission.input.executionId;
    if ((await this.api.repos.get(target)).data.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const runs = await this.api.paginate(this.api.actions.listWorkflowRuns, { ...target, workflow_id: codingWorkflow, branch: `sf-temporal-executor/${id}`, event: 'workflow_dispatch', per_page: 100 });
    const matches = runs.filter(r => r.display_title === `SF Temporal ${id} ${binding}`);
    if (matches.length > 1) throw new Error('MULTIPLE_EXECUTOR_RUNS');
    const run = matches[0]; if (!run || run.status === 'completed') return;
    if (run.head_sha !== snapshot.baseSha || !this.trustedActors.includes(run.actor?.login ?? '')) throw new Error('EXECUTOR_RUN_CONFLICT');
    try { await this.api.actions.cancelWorkflowRun({ ...target, run_id: run.id }); }
    catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 409)) throw error; }
  }
  async poll(snapshot: RunSnapshot, binding: string, config: Config) {
    await this.authorize(snapshot, binding);
    const input = snapshot.admission.input, coding = config.workers.coding;
    if (input.worker !== 'codex' || !coding || !coding.enabled || binding !== hash(snapshot)) throw new Error('CODING_NOT_AUTHORIZED');
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo };
    const metadata = (await this.api.repos.get(target)).data;
    if (metadata.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const wrapper = (await this.api.repos.getContent({ ...target, path: `.github/workflows/${codingWorkflow}`, ref: snapshot.baseSha })).data;
    if (!('content' in wrapper) || wrapper.encoding !== 'base64' || Buffer.from(wrapper.content, 'base64').toString('utf8') !== executorWrapper(snapshot.release.factorySha, snapshot.release.harnessSha)) throw new Error('EXECUTOR_WRAPPER_RELEASE_MISMATCH');
    const request = codingExecutionSchema.parse({ contractVersion: '3.0', executionId: input.executionId, worker: 'codex',
      task: { id: `github:${snapshot.repository}#${input.issueNumber}`, version: input.taskVersion, description: input.description,
        acceptanceCriteria: input.acceptanceCriteria, contextReferences: input.contextReferences }, baseSha: snapshot.baseSha,
      allowedActions: ['edit_workspace', 'run_commands'], model: coding.model, effort: coding.reasoningEffort,
      limits: { timeoutMinutes: input.limits.timeoutMinutes, maxFiles: 100, maxPatchBytes: 5000000 } });
    const serialized = JSON.stringify(request); if (Buffer.byteLength(serialized) > 60000) throw new Error('EXECUTOR_REQUEST_LIMIT');
    const ref = `sf-temporal-executor/${input.executionId}`, name = `SF Temporal ${input.executionId} ${binding}`, effects = this.effects(snapshot, binding);
    const authorize = () => this.authorize(snapshot, binding);
    await effects.perform({ key: 'executor-ref', payload: { ref, sha: snapshot.baseSha }, authorize,
      validate: z.strictObject({ sha: z.literal(snapshot.baseSha) }).parse,
      reconcile: async () => { try { const value = (await this.api.git.getRef({ ...target, ref: `heads/${ref}` })).data;
        if (value.object.sha !== snapshot.baseSha) throw new Error('EXECUTOR_REF_CONFLICT'); return { sha: value.object.sha };
      } catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; } },
      apply: async () => ({ sha: (await this.api.git.createRef({ ...target, ref: `refs/heads/${ref}`, sha: snapshot.baseSha })).data.object.sha }) });
    const runs = [];
    for await (const page of this.api.paginate.iterator(this.api.actions.listWorkflowRuns, { ...target, workflow_id: codingWorkflow, branch: ref, event: 'workflow_dispatch', per_page: 100 })) {
      runs.push(...page.data); if (runs.length > 1000) throw new Error('EXECUTOR_RUN_SCAN_LIMIT');
    }
    const matching = runs.filter(r => r.display_title === name);
    if (matching.length > 1) throw new Error('MULTIPLE_EXECUTOR_RUNS');
    const run = matching[0];
    if (run && (run.head_sha !== snapshot.baseSha || run.event !== 'workflow_dispatch' || run.run_attempt !== 1 ||
      !this.trustedActors.includes(run.actor?.login ?? ''))) throw new Error('EXECUTOR_RUN_CONFLICT');
    try {
      await effects.perform({ key: 'coding-dispatch', payload: { ref, request, binding, workflow: codingWorkflow }, authorize,
        validate: z.strictObject({ accepted: z.literal(true) }).parse, reconcile: async () => run ? { accepted: true as const } : null,
        apply: async () => { await this.api.actions.createWorkflowDispatch({ ...target, workflow_id: codingWorkflow, ref, inputs: { request: serialized, binding } }); return { accepted: true as const }; } });
    } catch (error) {
      if (error instanceof Error && error.message === 'EFFECT_UNCERTAIN_RECONCILIATION_REQUIRED') return null;
      throw error;
    }
    if (!run || run.status !== 'completed') return null;
    if (run.conclusion !== 'success') return { failed: true as const };
    const artifacts = await this.api.paginate(this.api.actions.listWorkflowRunArtifacts, { ...target, run_id: run.id, per_page: 100 });
    const matches = artifacts.filter(a => a.name === `coding-result-${input.executionId}`);
    if (matches.length !== 1 || matches[0]!.expired || matches[0]!.size_in_bytes > 8000000) throw new Error('INVALID_EXECUTOR_ARTIFACT');
    const response = await this.api.actions.downloadArtifact({ ...target, artifact_id: matches[0]!.id, archive_format: 'zip', request: { parseSuccessResponseBody: false } });
    const reader = (response.data as ReadableStream<Uint8Array>).getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8000000) throw new Error('ARTIFACT_ARCHIVE_LIMIT'); chunks.push(value); } }
    finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const artifact = decodeCodingArchive(bytes);
    if (artifact.baseSha !== snapshot.baseSha || artifact.result.executionId !== input.executionId || artifact.result.taskId !== request.task.id || artifact.result.taskVersion !== input.taskVersion) throw new Error('UNRELATED_EXECUTOR_ARTIFACT');
    return { artifact };
  }
}
