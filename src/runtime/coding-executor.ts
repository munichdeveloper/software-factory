import type { Octokit } from '@octokit/rest';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { codingExecutionSchema } from './coding-contract.js';
import { agentSelectionSchema, type AgentSelection } from './agent-selection.js';
import { codingArtifactSchema, scopeGuidance, testSecretGuidance, validateChanges, type CodingArtifact } from '../workers/coding.js';
import { attemptAgents, type CodingAgent, type Config } from '../config/index.js';
import type { Routing } from '../llm/router.js';
import { codingRouteSchema, type RunSnapshot } from './contract.js';
import type { EffectPort } from './effects.js';
import { hash } from '../state/identity.js';
import { bindValidation, validationReportSchema, type ValidationReport } from './validation-contract.js';
import { defaultCodingBudgetUsd, usageEntry, type UsageEntry } from './usage.js';
import type { Reconciler } from './reconcile.js';
import { failedChecksEntry, escalated, loopbackEntry, maxContextRefs, namedRefs, outputEntries, refEntry, reworkEntry, reworkOf, unavailableEntry } from './coding-context.js';

export const codingWorkflow = 'factory-temporal-executor.yml';
export function executorWrapper(factorySha: string, harnessSha: string, validated = false) {
  for (const sha of [factorySha, harnessSha]) if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('INVALID_EXECUTOR_RELEASE');
  if (!validated) return `name: Factory Temporal executor\nrun-name: SF Temporal \${{ fromJSON(inputs.request).executionId }} \${{ inputs.binding }}\non:\n  workflow_dispatch:\n    inputs:\n      request:\n        type: string\n        required: true\n      binding:\n        type: string\n        required: true\npermissions:\n  contents: read\nconcurrency:\n  group: sf-temporal-\${{ fromJSON(inputs.request).executionId }}\n  cancel-in-progress: false\njobs:\n  code:\n    permissions:\n      contents: read\n    uses: munichdeveloper/software-factory/.github/workflows/temporal-coding-executor.yml@${factorySha}\n    with:\n      factory-ref: ${factorySha}\n      harness-ref: ${harnessSha}\n      request: \${{ inputs.request }}\n    secrets:\n      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}\n      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n`;
  return `name: Factory Temporal executor\nrun-name: SF Temporal \${{ fromJSON(inputs.request).executionId }} \${{ inputs.binding }}\non:\n  workflow_dispatch:\n    inputs:\n      request:\n        type: string\n        required: true\n      binding:\n        type: string\n        required: true\n      validation:\n        type: string\n        required: true\npermissions:\n  contents: read\n  actions: read\nconcurrency:\n  group: sf-temporal-\${{ fromJSON(inputs.request).executionId }}\n  cancel-in-progress: false\njobs:\n  code:\n    permissions:\n      contents: read\n      actions: read\n    uses: munichdeveloper/software-factory/.github/workflows/temporal-coding-executor.yml@${factorySha}\n    with:\n      factory-ref: ${factorySha}\n      harness-ref: ${harnessSha}\n      request: \${{ inputs.request }}\n      validation: \${{ inputs.validation }}\n    secrets:\n      OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}\n      ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}\n      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}\n`;
}
/**
 * The executor's agent choice of one execution, stored once as an effect: the first call reads it (a completed run's
 * coding-agent artifact), later calls, the publication's included, return the stored value. Null when there was none.
 */
export async function storedSelection(effects: EffectPort, executionId: string, authorize: () => Promise<unknown>, read: () => Promise<AgentSelection | null> = async () => null) {
  return (await effects.perform({ key: 'coding-agent', payload: { executionId }, authorize, contentAddressed: true,
    validate: z.strictObject({ selection: agentSelectionSchema.nullable() }).parse, reconcile: async () => null,
    apply: async () => ({ selection: await read() }) })).selection;
}
/** A ZIP of Actions that holds exactly the one named small JSON file. */
export const usageArchiveLimit = 300000;
export function decodeSingleJson(bytes: Uint8Array, name: string, maxSize = 60000): unknown {
  let count = 0;
  const files = unzipSync(bytes, { filter: entry => {
    if (++count !== 1 || entry.name !== name || entry.originalSize > maxSize || entry.originalSize < 2) throw new Error('UNEXPECTED_ARCHIVE_ENTRY');
    return true;
  } });
  if (count !== 1 || !files[name]) throw new Error('MISSING_ARCHIVE_ENTRY');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files[name]));
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
  /** `config` is the configuration of an authorization the caller has just completed; new effects authorize again. */
  /**
   * `beforeAgent`: the run failed before any coding agent started (runner or setup), so no attempt was spent.
   * `dependencies`: it failed installing the workspace's locked npm dependencies (see failedDependencies).
   */
  poll(snapshot: RunSnapshot, binding: string, config: Config): Promise<{ artifact: CodingArtifact; validation?: ValidationReport } | { failed: true; beforeAgent?: boolean; dependencies?: boolean } | null>;
  cancel(snapshot: RunSnapshot, binding: string): Promise<void>;
}
/** Actions supplies disposable compute only. Temporal/broker retain dispatch, gate and publication authority. */
/** Sent to executions dispatched before `validationGuidance`; kept verbatim so their requests stay identical. */
export const legacyValidationGuidance = '\n\nFactory execution context: a separate hosted validation job runs project tests, build, browser and configured Docker checks after coding. Implement the change and run checks available here. Report unavailable and manual checks accurately; never claim an unperformed check. A blocked implementation remains reviewable.';
/**
 * The coding sandbox has no network, so installing dependencies or running the project's build and tests there only
 * fails and costs time. Those checks run in the independent validation job, whose result decides (controla#63).
 */
export const validationGuidance = '\n\nFactory execution context: your environment has no network access. After coding, a separate hosted validation job installs the dependencies and runs the project\'s build, tests, browser and configured Docker checks on your change; its result decides whether the change is accepted. Do not install dependencies or try to run the project\'s build, test, lint or browser commands here; if the task needs a new or different npm dependency, add it to package.json and leave package-lock.json alone, the Factory resolves the lockfile after your run; acceptance criteria that name such checks are covered by that job. Offline checks such as reading code or `git diff --check` are fine. Report `success` when the implementation is complete, and say which checks you left to the validation job. Report `blocked` only when the implementation itself is incomplete or cannot be done as specified. Never claim a check you did not perform. You may not change `.github/` (CI workflows), agent instruction files or CODEOWNERS; if the task needs such a change, report `blocked` with error `PROTECTED_PATH_REQUIRED` and name the change a maintainer must make.';

type Job = { name: string; conclusion: string | null; runner_id?: number | null; steps?: { name: string; conclusion: string | null }[] };
/** The step of the code job that runs the coding harness; steps before it only prepare the runner and workspace. */
const harnessStep = 'Run ./.runtime/harness';
/** The step of the code job that installs the locked npm dependencies before the network is closed. */
export const dependenciesStep = 'Prepare locked npm dependencies before network-isolated coding';
/**
 * Whether a failed executor run failed only because the locked npm dependencies of the workspace could not be
 * installed (typically a package.json that no longer matches package-lock.json). That is the work's fault, not the
 * runner's: it is reported as WORKSPACE_DEPENDENCIES_FAILED and costs an attempt (letterflow#34).
 */
export function failedDependencies(jobs: Job[]): boolean {
  const failed = jobs.filter(j => j.conclusion === 'failure');
  const code = failed.length === 1 ? failed.find(j => j.name === 'code' || j.name.endsWith(' / code')) : undefined;
  return !!code?.steps?.length && code.steps.find(s => s.conclusion === 'failure')?.name === dependenciesStep;
}
/**
 * Whether a failed executor run ended before any coding agent started. Only positive evidence counts: a job GitHub
 * never gave a runner or a step, a code-job step before the harness, or a harness step whose log shows a setup step
 * failing ahead of both agent steps. Anything else, an unreadable log included, is a real attempt.
 * `log` returns the code job's log, or null when it cannot be read within its limit.
 */
export async function failedBeforeAgent(jobs: Job[], log: () => Promise<string | null>): Promise<boolean> {
  const failed = jobs.filter(j => j.conclusion === 'failure');
  if (!failed.length) return false;
  if (failed.some(j => !j.runner_id || !j.steps?.length)) return true;
  const code = failed.find(j => j.name === 'code' || j.name.endsWith(' / code'));
  if (!code || failed.length !== 1) return false;
  const steps = code.steps!, harness = steps.findIndex(s => s.name === harnessStep), first = steps.findIndex(s => s.conclusion === 'failure');
  if (harness < 0 || first < 0) return false;
  if (first < harness) return true;
  if (first > harness) return false;
  const text = await log();
  if (!text) return false;
  const lines = text.split('\n');
  const failure = lines.findIndex(l => /##\[end-action id=agent\.[^;]*;outcome=failure;/.test(l));
  const codex = lines.findIndex(l => l.includes('##[end-action id=agent.__openai_codex-action;outcome=skipped;'));
  return failure >= 0 && codex > failure;
}

/** What the router reads of a task: its description and acceptance criteria, untrusted text it only classifies. */
export const codingRouterState = (input: { description: string; acceptanceCriteria: string[] }) =>
  `Software task (untrusted text, only to be classified):\n${input.description}\n\nAcceptance criteria:\n${input.acceptanceCriteria.map(c => `- ${c}`).join('\n')}`;
/** The routed agent first, then the configured agents that differ from it; at most three, as the request allows. */
export function routedAgents(routed: CodingAgent | null, listed: CodingAgent[]): CodingAgent[] {
  if (!routed) return listed;
  const same = (a: CodingAgent) => a.agent === routed.agent && a.model === routed.model && a.reasoningEffort === routed.reasoningEffort && !a.credential;
  return [routed, ...listed.filter(a => !same(a))].slice(0, 3);
}
/** The broker-wide daily cap of runs on the Claude subscription; allowed() may report, it must not throw. */
export interface SubscriptionGate { allowed(repository: string): Promise<boolean> }
/** Agents with credential subscription leave the list when the daily cap is reached; the subscription is never first. */
export const withoutSubscription = (agents: CodingAgent[]) => agents.filter(a => !a.credential);
export class ActionsCodingExecutor implements CodingExecutionPort {
  constructor(private api: Octokit, private effects: (snapshot: RunSnapshot, binding: string) => EffectPort,
    private authorize: (snapshot: RunSnapshot, binding: string) => Promise<unknown>,
    /** A list fixed at construction, or a provider read at use so a repository's current configuration applies. */
    private trustedActors: string[] | (() => Promise<string[]>),
    /** The bound validation report of an earlier attempt of the same repository, from the broker's own store. */
    private previousValidation: (executionId: string) => Promise<ValidationReport | null> = async () => null,
    /** Called with each execution's stored agent choice, e.g. for the used-up credit alert; must not throw. */
    private onSelection?: (snapshot: RunSnapshot, selection: AgentSelection) => Promise<void>,
    /** The model router (router.coding): picks the first attempt's agent among the configured candidates. */
    private routing?: Routing,
    /** Called with the token usage of each completed run (UsageAlerts); must not throw. */
    private onUsage?: (entry: UsageEntry) => Promise<void>,
    /** Whether the Claude subscription may still take runs today (broker-wide daily cap); without it always. */
    private subscription?: SubscriptionGate,
    /** The survey before a first attempt (SF #255): related open and merged work as context; without it none. */
    private reconciler?: Reconciler) {}
  private async download(target: { owner: string; repo: string }, artifactId: number, limit: number, error: string) {
    const response = await this.api.actions.downloadArtifact({ ...target, artifact_id: artifactId, archive_format: 'zip', request: { parseSuccessResponseBody: false } });
    const reader = (response.data as ReadableStream<Uint8Array>).getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error(error); chunks.push(value); } }
    finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  /** A failure to inspect the run is no evidence: the run then counts as an attempt. */
  private async beforeAgent(target: { owner: string; repo: string }, runId: number): Promise<boolean | 'dependencies'> {
    try {
      const jobs = (await this.api.actions.listJobsForWorkflowRun({ ...target, run_id: runId, filter: 'latest', per_page: 100 })).data.jobs as Job[];
      if (failedDependencies(jobs)) return 'dependencies';
      return await failedBeforeAgent(jobs, async () => {
        const code = jobs.find(j => j.conclusion === 'failure');
        if (!code || !('id' in code)) return null;
        const response = await this.api.actions.downloadJobLogsForWorkflowRun({ ...target, job_id: (code as Job & { id: number }).id });
        const text = typeof response.data === 'string' ? response.data : String(response.data);
        return text.length > 5000000 ? null : text;
      });
    } catch { return false; }
  }
  /**
   * Context for the worker, resolved once per execution and then fixed: the previous attempt of a rework with the
   * outcome of its validation, and the refs of this repository that the task names. Task text only names candidates;
   * every commit comes from this repository's own refs, and nothing here can fail the run.
   */
  private async context(snapshot: RunSnapshot, target: { owner: string; repo: string }, baseBranch: string, loopback: boolean): Promise<string[]> {
    const input = snapshot.admission.input, entries: string[] = loopback ? [loopbackEntry] : [], seen = new Set([snapshot.baseSha]);
    const missing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [404, 422].includes(error.status as number);
    const previousId = reworkOf(input), report = previousId ? await this.previousValidation(previousId) : null;
    // A rework always continues the previous attempt's branch; a failed validation adds its checks and their output.
    if (previousId) {
      const branch = `sf/issue-${input.issueNumber}/${previousId}`;
      try {
        const head = (await this.api.git.getRef({ ...target, ref: `heads/${branch}` })).data.object.sha;
        entries.push(reworkEntry(head, previousId)); seen.add(head);
      } catch (error) { if (!missing(error)) throw error; entries.push(unavailableEntry('branch', branch)); }
      const failed = report?.checks.filter(c => c.status === 'failed') ?? [];
      if (report && failed.length) entries.push(failedChecksEntry(report));
      if (report && failed.length) try {
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
  /**
   * The executor's agent choice (coding-agent-<id>), read once per execution and stored, so the publication names the
   * agent that ran and the broker alerts once about agents skipped for used-up credit. Absent or unreadable: null.
   */
  /** Hands the run's usage record (coding-usage-<id>, uploaded also for failed runs) to onUsage; never fails the poll. */
  private async usage(snapshot: RunSnapshot, target: { owner: string; repo: string }, runId: number, artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean }[], billing: 'api' | 'subscription') {
    if (!this.onUsage) return;
    try {
      const match = artifacts.filter(a => a.name === `coding-usage-${snapshot.admission.input.executionId}`);
      // usage.json carries the run's insight (trace, change size) since harness #19, bounded there to 150 kB.
      if (match.length !== 1 || match[0]!.expired || match[0]!.size_in_bytes > usageArchiveLimit) return;
      const entry = usageEntry(snapshot, runId, decodeSingleJson(await this.download(target, match[0]!.id, usageArchiveLimit, 'USAGE_ARCHIVE_LIMIT'), 'usage.json', usageArchiveLimit), billing);
      if (entry) await this.onUsage(entry);
    } catch (error) {
      console.warn(JSON.stringify({ event: 'factory-usage', repository: snapshot.repository, executionId: snapshot.admission.input.executionId,
        outcome: 'unreadable', code: error instanceof Error ? error.message.slice(0, 80) : 'unknown' }));
    }
  }
  private async selection(snapshot: RunSnapshot, binding: string, target: { owner: string; repo: string }, artifacts: { id: number; name: string; size_in_bytes: number; expired: boolean }[]) {
    const id = snapshot.admission.input.executionId;
    const selection = await storedSelection(this.effects(snapshot, binding), id, () => this.authorize(snapshot, binding), async () => {
      const match = artifacts.filter(a => a.name === `coding-agent-${id}`);
      if (match.length !== 1 || match[0]!.expired || match[0]!.size_in_bytes > 100000) return null;
      try {
        const value = agentSelectionSchema.parse(decodeSingleJson(await this.download(target, match[0]!.id, 100000, 'AGENT_ARCHIVE_LIMIT'), 'coding-agent.json'));
        return value.executionId === id ? value : null;
      } catch { return null; }
    });
    if (selection && this.onSelection) await this.onSelection(snapshot, selection);
    return selection;
  }
  async poll(snapshot: RunSnapshot, binding: string, config: Config) {
    const input = snapshot.admission.input, coding = config.workers.coding, workflow = snapshot.executorWorkflow ?? codingWorkflow;
    if (input.worker !== 'codex' || !coding || !coding.enabled || binding !== hash(snapshot)) throw new Error('CODING_NOT_AUTHORIZED');
    const [owner, repo] = snapshot.repository.split('/') as [string, string], target = { owner, repo };
    const metadata = (await this.api.repos.get(target)).data;
    if (metadata.id !== snapshot.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
    const wrapper = (await this.api.repos.getContent({ ...target, path: `.github/workflows/${workflow}`, ref: snapshot.baseSha })).data;
    if (!('content' in wrapper) || wrapper.encoding !== 'base64' || Buffer.from(wrapper.content, 'base64').toString('utf8') !== executorWrapper(snapshot.release.factorySha, snapshot.release.harnessSha, !!snapshot.validationPlan)) throw new Error('EXECUTOR_WRAPPER_RELEASE_MISMATCH');
    const effects = this.effects(snapshot, binding), authorize = () => this.authorize(snapshot, binding);
    // Resolved once and stored, like the coding context below: an execution dispatched before this guidance existed
    // keeps the text it was sent, so its later polls rebuild the identical request.
    const guidance = snapshot.validationPlan ? (await effects.perform({ key: 'coding-guidance', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: z.strictObject({ text: z.string().max(2000) }).parse, reconcile: async () => null,
      apply: async () => {
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { text: legacyValidationGuidance }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { text: validationGuidance };
      } })).text : '';
    // Resolved once and stored like the guidance above: switching the rule later does not change a dispatched request.
    const scope = (await effects.perform({ key: 'coding-scope', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: z.strictObject({ text: z.string().max(2000) }).parse, reconcile: async () => null,
      apply: async () => {
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { text: '' }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { text: scopeGuidance(config) };
      } })).text;
    // Not a scope rule: sent whatever smallPullRequests and merge.risk say, resolved once and stored like the scope above.
    const secrets = (await effects.perform({ key: 'coding-secrets', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: z.strictObject({ text: z.string().max(2000) }).parse, reconcile: async () => null,
      apply: async () => {
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { text: '' }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { text: testSecretGuidance };
      } })).text;
    let description = input.description;
    for (const text of [guidance, scope, secrets]) if (text && description.length + text.length <= 20000) description += text;
    // Resolved once and stored: later polls rebuild the identical request even when a named branch has moved since.
    const extra = await effects.perform({ key: 'coding-context', payload: { baseSha: snapshot.baseSha, rework: reworkOf(input) }, authorize, contentAddressed: true,
      validate: z.strictObject({ entries: z.string().max(1000).array().max(30) }).parse, reconcile: async () => null,
      apply: async () => {
        // An execution whose executor ref exists was dispatched before its context was resolved; its request stays as sent.
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { entries: [] }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { entries: await this.context(snapshot, target, snapshot.baseRef ?? metadata.default_branch, coding.loopback) };
      } });
    // The survey of related work (SF #255), once per execution and stored like the context above. Only a first attempt
    // gets one: a rework continues its branch with the review's or the checks' findings. It never fails the run.
    const survey = this.reconciler ? await effects.perform({ key: 'coding-reconcile', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: z.strictObject({ entries: z.string().max(1000).array().max(8) }).parse, reconcile: async () => null,
      apply: async () => {
        if (reworkOf(input)) return { entries: [] };
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { entries: [] }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { entries: (await this.reconciler!.survey(snapshot.repository, target, input)).entries.slice(0, 8) };
      } }) : { entries: [] };
    const room = Math.max(0, 30 - input.contextReferences.length - extra.entries.length);
    // The model router (router.coding) picks the agent of a non-escalated attempt among its candidates, once per
    // execution; the decision and the chosen agent are stored, so later polls rebuild the identical request even when the
    // configuration changed meanwhile. No decision, a refused one or an execution dispatched before routing: null.
    const routed = await effects.perform({ key: 'coding-route', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: codingRouteSchema.parse, reconcile: async () => null,
      apply: async () => {
        const router = config.router, candidates = router?.enabled ? router.coding?.candidates : undefined;
        if (!this.routing || !router || !candidates || escalated(input)) return { route: null, agent: null };
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { route: null, agent: null }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        const route = await this.routing.route(snapshot.repository, 'coding', codingRouterState(input), candidates, router,
          { kind: 'issue', number: input.issueNumber });
        const chosen = route.used ? candidates.find(c => c.id === route.choice) : undefined;
        return { route, agent: chosen ? { agent: chosen.agent, model: chosen.model, reasoningEffort: chosen.reasoningEffort } : null };
      } });
    // The admission's worker "codex" names the isolated coding worker; which agent runs comes from workers.coding: the
    // first agent of the list, with the others as fallbacks the executor tries when a provider reports used-up credit.
    // An escalated attempt (see escalationMarker) uses retryAgents when configured: a cheap first attempt escalates to a
    // stronger model only after the agent itself failed, not after a runner failure. A routed agent goes first, the
    // configured list stays behind it as the fallbacks.
    let agents = routedAgents(routed.agent, attemptAgents(coding, escalated(input)));
    // The Claude subscription's daily cap, decided once per execution and stored like the budget below, so later polls
    // rebuild the identical request; only asked when the list names the subscription at all.
    if (agents.some(a => a.credential)) {
      const gate = await effects.perform({ key: 'coding-subscription', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
        validate: z.strictObject({ allowed: z.boolean() }).parse, reconcile: async () => null,
        apply: async () => ({ allowed: this.subscription ? await this.subscription.allowed(snapshot.repository) : true }) });
      if (!gate.allowed) agents = withoutSubscription(agents);
    }
    const [first, ...others] = agents;
    // The spend cap, resolved once and stored like the scope above: an execution dispatched before caps existed keeps
    // its request without one, and a later configuration change does not alter a dispatched request.
    const budget = (await effects.perform({ key: 'coding-budget', payload: { baseSha: snapshot.baseSha }, authorize, contentAddressed: true,
      validate: z.strictObject({ usd: z.number().positive().max(1000).nullable() }).parse, reconcile: async () => null,
      apply: async () => {
        try { await this.api.git.getRef({ ...target, ref: `heads/sf-temporal-executor/${input.executionId}` }); return { usd: null }; }
        catch (error) { if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error; }
        return { usd: coding.maxCostUsd ?? defaultCodingBudgetUsd };
      } })).usd;
    const request = codingExecutionSchema.parse({ contractVersion: '3.0', executionId: input.executionId, worker: first!.agent,
      task: { id: `github:${snapshot.repository}#${input.issueNumber}`, version: input.taskVersion, description,
        acceptanceCriteria: input.acceptanceCriteria, contextReferences: [...input.contextReferences, ...extra.entries, ...survey.entries.slice(0, room)] }, baseSha: snapshot.baseSha,
      allowedActions: ['edit_workspace', 'run_commands'], model: first!.model, effort: first!.reasoningEffort,
      limits: { timeoutMinutes: input.limits.timeoutMinutes, maxFiles: 100, maxPatchBytes: 5000000, ...(budget === null ? {} : { maxCostUsd: budget }) },
      ...(others.length ? { fallbacks: others.map(a => ({ worker: a.agent, model: a.model, effort: a.reasoningEffort, ...(a.credential ? { credential: a.credential } : {}) })) } : {}) });
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
    const artifacts = run.conclusion === 'success' || request.fallbacks || this.onUsage ? await this.api.paginate(this.api.actions.listWorkflowRunArtifacts, { ...target, run_id: run.id, per_page: 100 }) : [];
    const selection = request.fallbacks ? await this.selection(snapshot, binding, target, artifacts) : null;
    await this.usage(snapshot, target, run.id, artifacts, selection?.selected?.credential === 'subscription' ? 'subscription' : 'api');
    if (run.conclusion !== 'success') {
      // No agent could run because every provider reported used-up credit: nothing started, so no attempt is spent.
      const noAgent = !!selection && !selection.selected;
      const cause = noAgent || await this.beforeAgent(target, run.id);
      return { failed: true as const, ...(cause === 'dependencies' ? { dependencies: true } : cause ? { beforeAgent: true } : {}) };
    }
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
