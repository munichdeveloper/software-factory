import type { Octokit } from '@octokit/rest';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { codingExecutionSchema } from './coding-contract.js';
import { codingArtifactSchema, validateChanges, type CodingArtifact } from '../workers/coding.js';
import type { Config } from '../config/index.js';
import type { RunSnapshot } from './contract.js';
import type { EffectPort } from './effects.js';
import { hash } from '../state/identity.js';
import { bindValidation, validationReportSchema, type ValidationReport } from './validation-contract.js';
import { failedChecksEntry, maxContextRefs, namedRefs, outputEntries, refEntry, reworkEntry, reworkOf, unavailableEntry } from './coding-context.js';

export const codingWorkflow = 'factory-temporal-executor.yml';
export function executorWrapper(factorySha: string, harnessSha: string, validated = false) {
  for (const sha of [factorySha, harnessSha]) if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('INVALID_EXECUTOR_RELEASE');
  if (!validated) return `name: Factory Temporal executor\nrun-name: SF Temporal \${{ fromJSON(inputs.request).executionId }} \${{ inputs.binding }}\non:\n  workflow_dispatch:\n    inputs:\n      request:\n        type: string\n        required: true\n      binding:\n        type: string\n        required: true\npermissions:\n  contents: read\nconcurrency:\n  group: sf-temporal-\${{ fromJSON(inputs.request).executionId }}\n  cancel-in-progress: false\njobs:\n  code:\n    permissions:\n      contents: read\n    uses: munichdeveloper/software-factory/.github/workflows/temporal-coding-executor.yml@${factorySha}\n    with:\n      factory-ref: ${factorySha}\n      harness-ref: ${harnessSha}\n      request: \${{ inputs.request }}\n    secrets:\n      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n`;
  return `name: Factory Temporal executor\nrun-name: SF Temporal \${{ fromJSON(inputs.request).executionId }} \${{ inputs.binding }}\non:\n  workflow_dispatch:\n    inputs:\n      request:\n        type: string\n        required: true\n      binding:\n        type: string\n        required: true\n      validation:\n        type: string\n        required: true\npermissions:\n  contents: read\n  actions: read\nconcurrency:\n  group: sf-temporal-\${{ fromJSON(inputs.request).executionId }}\n  cancel-in-progress: false\njobs:\n  code:\n    permissions:\n      contents: read\n      actions: read\n    uses: munichdeveloper/software-factory/.github/workflows/temporal-coding-executor.yml@${factorySha}\n    with:\n      factory-ref: ${factorySha}\n      harness-ref: ${harnessSha}\n      request: \${{ inputs.request }}\n      validation: \${{ inputs.validation }}\n    secrets:\n      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n`;
}
export function decodeValidationArchive(bytes: Uint8Array): ValidationReport {
  if (bytes.length > 100000) throw new Error('VALIDATION_ARCHIVE_LIMIT');
  let count = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (++count !== 1 || entry.name !== 'validation.json' || entry.originalSize > 60000 || entry.originalSize < 2) throw new Error('UNEXPECTED_VALIDATION_ENTRY');
    return true;
  } });
  if (count !== 1 || !files['validation.json']) throw new Error('MISSING_VALIDATION_REPORT');
  return validationReportSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files['validation.json'])));
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
  poll(snapshot: RunSnapshot, binding: string, config: Config): Promise<{ artifact: CodingArtifact; validation?: ValidationReport } | { failed: true } | null>;
  cancel(snapshot: RunSnapshot, binding: string): Promise<void>;
}
/** Actions supplies disposable compute only. Temporal/broker retain dispatch, gate and publication authority. */
export class ActionsCodingExecutor implements CodingExecutionPort {
  constructor(private api: Octokit, private effects: (snapshot: RunSnapshot, binding: string) => EffectPort,
    private authorize: (snapshot: RunSnapshot, binding: string) => Promise<unknown>,
    /** A list fixed at construction, or a provider read at use so a repository's current configuration applies. */
    private trustedActors: string[] | (() => Promise<string[]>),
    /** The bound validation report of an earlier attempt of the same repository, from the broker's own store. */
    private previousValidation: (executionId: string) => Promise<ValidationReport | null> = async () => null) {}
  private async download(target: { owner: string; repo: string }, artifactId: number, limit: number, error: string) {
    const response = await this.api.actions.downloadArtifact({ ...target, artifact_id: artifactId, archive_format: 'zip', request: { parseSuccessResponseBody: false } });
    const reader = (response.data as ReadableStream<Uint8Array>).getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error(error); chunks.push(value); } }
    finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  /**
   * Context for the worker, resolved once per execution and then fixed: the previous attempt of a rework with the
   * outcome of its validation, and the refs of this repository that the task names. Task text only names candidates;
   * every commit comes from this repository's own refs, and nothing here can fail the run.
   */
  private async context(snapshot: RunSnapshot, target: { owner: string; repo: string }, baseBranch: string): Promise<string[]> {
    const input = snapshot.admission.input, entries: string[] = [], seen = new Set([snapshot.baseSha]);
    const missing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [404, 422].includes(error.status as number);
    const previousId = reworkOf(input), report = previousId ? await this.previousValidation(previousId) : null;
    if (previousId && report) {
      const branch = `sf/issue-${input.issueNumber}/${previousId}`;
      try {
        const head = (await this.api.git.getRef({ ...target, ref: `heads/${branch}` })).data.object.sha;
        entries.push(reworkEntry(head, previousId)); seen.add(head);
      } catch (error) { if (!missing(error)) throw error; entries.push(unavailableEntry('branch', branch)); }
      const failed = report.checks.filter(c => c.status === 'failed');
      if (failed.length) entries.push(failedChecksEntry(report));
      try {
        const logs = (await this.api.paginate(this.api.actions.listWorkflowRunArtifacts, { ...target, run_id: report.workflowRunId, per_page: 100 }))
          .filter(a => a.name === `coding-validation-logs-${previousId}` && !a.expired && a.size_in_bytes <= 2000000);
        if (logs.length === 1) {
          const wanted = failed.slice(0, 3).map(c => `${c.name}.log`);
          const files = unzipSync(await this.download(target, logs[0]!.id, 2000000, 'VALIDATION_LOG_LIMIT'), { filter: entry => wanted.includes(entry.name) && entry.originalSize <= 70000 });
          for (const name of wanted) if (files[name]) entries.push(...outputEntries(name.slice(0, -4), new TextDecoder().decode(files[name])));
        }
      } catch { /* The check names above stand on their own; their output is an aid, not a precondition. */ }
    }
    const named = namedRefs([input.description, ...input.acceptanceCriteria].join('\n')), refs: string[] = [], unavailable: string[] = [];
    const add = (commit: string, kind: 'branch' | 'commit' | 'pull', name: string) => { if (!seen.has(commit) && refs.length < maxContextRefs) { seen.add(commit); refs.push(refEntry(commit, kind, name)); } };
    for (const commit of named.commits) {
      try { add((await this.api.git.getCommit({ ...target, commit_sha: commit })).data.sha, 'commit', commit.slice(0, 12)); }
      catch (error) { if (!missing(error)) throw error; unavailable.push(unavailableEntry('commit', commit.slice(0, 12))); }
    }
    for (const number of named.pulls.filter(n => n !== input.issueNumber)) {
      try {
        const pull = (await this.api.pulls.get({ ...target, pull_number: number })).data;
        // A fork's head is third-party content; only heads of this repository are context.
        if (pull.head.repo?.id === snapshot.repositoryId) add(pull.head.sha, 'pull', `#${number}`); else unavailable.push(unavailableEntry('pull', `#${number}`));
      } catch (error) { if (!missing(error)) throw error; /* The number is an issue or nothing: not a ref the task named. */ }
    }
    if (named.names.length) {
      const branches = new Map<string, string>(); let pages = 0;
      for await (const page of this.api.paginate.iterator(this.api.repos.listBranches, { ...target, per_page: 100 })) {
        for (const b of page.data) branches.set(b.name, b.commit.sha);
        if (++pages >= 5) break;
      }
      for (const name of named.names) if (name !== baseBranch && branches.has(name)) add(branches.get(name)!, 'branch', name);
    }
    return [...entries, ...refs, ...unavailable.slice(0, 4)].slice(0, 30 - input.contextReferences.length);
  }
  private async actors() { return typeof this.trustedActors === 'function' ? this.trustedActors() : this.trustedActors; }
  async cancel(snapshot: RunSnapshot, binding: string) {
    if (binding !== hash(snapshot)) throw new Error('EXECUTOR_BINDING_MISMATCH');
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo }, id = snapshot.admission.input.executionId;
    if ((await this.api.repos.get(target)).data.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const runs = await this.api.paginate(this.api.actions.listWorkflowRuns, { ...target, workflow_id: snapshot.executorWorkflow ?? codingWorkflow, branch: `sf-temporal-executor/${id}`, event: 'workflow_dispatch', per_page: 100 });
    const matches = runs.filter(r => r.display_title === `SF Temporal ${id} ${binding}`);
    if (matches.length > 1) throw new Error('MULTIPLE_EXECUTOR_RUNS');
    const run = matches[0]; if (!run || run.status === 'completed') return;
    if (run.head_sha !== snapshot.baseSha || !(await this.actors()).includes(run.actor?.login ?? '')) throw new Error('EXECUTOR_RUN_CONFLICT');
    try { await this.api.actions.cancelWorkflowRun({ ...target, run_id: run.id }); }
    catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 409)) throw error; }
  }
  async poll(snapshot: RunSnapshot, binding: string, config: Config) {
    await this.authorize(snapshot, binding);
    const input = snapshot.admission.input, coding = config.workers.coding, workflow = snapshot.executorWorkflow ?? codingWorkflow;
    if (input.worker !== 'codex' || !coding || !coding.enabled || binding !== hash(snapshot)) throw new Error('CODING_NOT_AUTHORIZED');
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo };
    const metadata = (await this.api.repos.get(target)).data;
    if (metadata.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const wrapper = (await this.api.repos.getContent({ ...target, path: `.github/workflows/${workflow}`, ref: snapshot.baseSha })).data;
    if (!('content' in wrapper) || wrapper.encoding !== 'base64' || Buffer.from(wrapper.content, 'base64').toString('utf8') !== executorWrapper(snapshot.release.factorySha, snapshot.release.harnessSha, !!snapshot.validationPlan)) throw new Error('EXECUTOR_WRAPPER_RELEASE_MISMATCH');
    const context = '\n\nFactory execution context: a separate hosted validation job runs project tests, build, browser and configured Docker checks after coding. Implement the change and run checks available here. Report unavailable and manual checks accurately; never claim an unperformed check. A blocked implementation remains reviewable.';
    const description = snapshot.validationPlan && input.description.length + context.length <= 20000 ? input.description + context : input.description;
    const effects = this.effects(snapshot, binding), authorize = () => this.authorize(snapshot, binding);
    // Resolved once and stored: later polls rebuild the identical request even when a named branch has moved since.
    const extra = await effects.perform({ key: 'coding-context', payload: { baseSha: snapshot.baseSha, rework: reworkOf(input) }, authorize, contentAddressed: true,
      validate: z.strictObject({ entries: z.string().max(1000).array().max(30) }).parse, reconcile: async () => null,
      apply: async () => {
        // An execution whose executor ref exists was dispatched before its context was resolved; its request stays as sent.
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { entries: [] }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { entries: await this.context(snapshot, target, snapshot.baseRef ?? metadata.default_branch) };
      } });
    const request = codingExecutionSchema.parse({ contractVersion: '3.0', executionId: input.executionId, worker: 'codex',
      task: { id: `github:${snapshot.repository}#${input.issueNumber}`, version: input.taskVersion, description,
        acceptanceCriteria: input.acceptanceCriteria, contextReferences: [...input.contextReferences, ...extra.entries] }, baseSha: snapshot.baseSha,
      allowedActions: ['edit_workspace', 'run_commands'], model: coding.model, effort: coding.reasoningEffort,
      limits: { timeoutMinutes: input.limits.timeoutMinutes, maxFiles: 100, maxPatchBytes: 5000000 } });
    const serialized = JSON.stringify(request); if (Buffer.byteLength(serialized) > 60000) throw new Error('EXECUTOR_REQUEST_LIMIT');
    const ref = `sf-temporal-executor/${input.executionId}`, name = `SF Temporal ${input.executionId} ${binding}`;
    await effects.perform({ key: 'executor-ref', payload: { ref, sha: snapshot.baseSha }, authorize,
      validate: z.strictObject({ sha: z.literal(snapshot.baseSha) }).parse,
      reconcile: async () => { try { const value = (await this.api.git.getRef({ ...target, ref: `heads/${ref}` })).data;
        if (value.object.sha !== snapshot.baseSha) throw new Error('EXECUTOR_REF_CONFLICT'); return { sha: value.object.sha };
      } catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; } },
      apply: async () => ({ sha: (await this.api.git.createRef({ ...target, ref: `refs/heads/${ref}`, sha: snapshot.baseSha })).data.object.sha }) });
    const runs = [];
    for await (const page of this.api.paginate.iterator(this.api.actions.listWorkflowRuns, { ...target, workflow_id: workflow, branch: ref, event: 'workflow_dispatch', per_page: 100 })) {
      runs.push(...page.data); if (runs.length > 1000) throw new Error('EXECUTOR_RUN_SCAN_LIMIT');
    }
    const matching = runs.filter(r => r.display_title === name);
    if (matching.length > 1) throw new Error('MULTIPLE_EXECUTOR_RUNS');
    const run = matching[0];
    if (run && (run.head_sha !== snapshot.baseSha || run.event !== 'workflow_dispatch' || run.run_attempt !== 1 ||
      !(await this.actors()).includes(run.actor?.login ?? ''))) throw new Error('EXECUTOR_RUN_CONFLICT');
    try {
      await effects.perform({ key: 'coding-dispatch', payload: { ref, request, binding, workflow }, authorize,
        validate: z.strictObject({ accepted: z.literal(true) }).parse, reconcile: async () => run ? { accepted: true as const } : null,
        apply: async () => { await this.api.actions.createWorkflowDispatch({ ...target, workflow_id: workflow, ref, inputs: { request: serialized, binding, ...(snapshot.validationPlan ? { validation: JSON.stringify(snapshot.validationPlan) } : {}) } }); return { accepted: true as const }; } });
    } catch (error) {
      if (error instanceof Error && error.message === 'EFFECT_UNCERTAIN_RECONCILIATION_REQUIRED') return null;
      throw error;
    }
    if (!run || run.status !== 'completed') return null;
    if (run.conclusion !== 'success') return { failed: true as const };
    const artifacts = await this.api.paginate(this.api.actions.listWorkflowRunArtifacts, { ...target, run_id: run.id, per_page: 100 });
    const matches = artifacts.filter(a => a.name === `coding-result-${input.executionId}`);
    if (matches.length !== 1 || matches[0]!.expired || matches[0]!.size_in_bytes > 8000000) throw new Error('INVALID_EXECUTOR_ARTIFACT');
    const artifact = decodeCodingArchive(await this.download(target, matches[0]!.id, 8000000, 'ARTIFACT_ARCHIVE_LIMIT'));
    if (artifact.baseSha !== snapshot.baseSha || artifact.result.executionId !== input.executionId || artifact.result.taskId !== request.task.id || artifact.result.taskVersion !== input.taskVersion) throw new Error('UNRELATED_EXECUTOR_ARTIFACT');
    if (!snapshot.validationPlan) return { artifact };
    const validations = artifacts.filter(a => a.name === `coding-validation-${input.executionId}`);
    if (validations.length !== 1 || validations[0]!.expired || validations[0]!.size_in_bytes > 100000) throw new Error('INVALID_VALIDATION_ARTIFACT');
    const validation = bindValidation(decodeValidationArchive(await this.download(target, validations[0]!.id, 100000, 'VALIDATION_ARCHIVE_LIMIT')), artifact, snapshot.validationPlan, run.id);
    return { artifact, validation };
  }
}
