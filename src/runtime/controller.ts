import { WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import { hash } from '../state/identity.js';
import { policyVersion } from '../policies/engine.js';
import { authorizeDelegation } from '../workers/execute-delegation.js';
import { decodeEvent } from '../state/events.js';
import { workerResultSchema, type WorkerResult } from '../workers/contract.js';
import { RuntimeStore, type StoredRun } from './store.js';
import { admissionCode, admissionSchema, RuntimeAdmissionRejected, snapshotSchema, workflowId, type Admission, type RunSnapshot, type RuntimeObservation, type RuntimeRelease, type RuntimeState, type WorkerRuntimePort } from './contract.js';
import type { CodingExecutionPort } from './coding-executor.js';
import type { CodingArtifact } from '../workers/coding.js';
import type { ReadyApproval } from './contract.js';
import { bindValidation, type ValidationPlan, type ValidationReport } from './validation-contract.js';
import { reworkOf } from './coding-context.js';

export interface RuntimeRepository {
  repositoryId: number; repository: string; release: RuntimeRelease; retainedReleases?: RuntimeRelease[]; requireHumanGate: boolean;
  baseRef?: string; executorWorkflow?: string; issueNumbers?: number[]; allowedPaths?: string[];
  readyApproval?(issueNumber: number, expected?: ReadyApproval, rework?: ReadyApproval): Promise<ReadyApproval>;
  validationPlan?(): Promise<ValidationPlan>;
  github: GitHubPort; config(): Promise<Config>; baseSha(): Promise<string>;
  coding?: { executor: CodingExecutionPort; publish(snapshot: RunSnapshot, binding: string, artifact: CodingArtifact, createdAt: string, validation?: ValidationReport): Promise<{ url: string }> };
}
export class RuntimeController implements WorkerRuntimePort {
  constructor(private repo: RuntimeRepository, private store: RuntimeStore, private temporal: Client) {}
  async deployment() {
    const release = this.repo.release;
    const result = await this.temporal.workflow.execute('factoryHealth', {
      workflowId: `sf-health-${this.repo.repositoryId}-${randomUUID()}`, taskQueue: release.taskQueue,
      args: [], workflowExecutionTimeout: '10 seconds',
      versioningOverride: { pinnedTo: { deploymentName: release.deploymentName, buildId: release.buildId } },
    });
    if (result !== 'sf-runtime-ready-v1') throw new Error('WORKER_READINESS_FAILED');
    return { version: 1, repositoryId: this.repo.repositoryId, repository: this.repo.repository, release,
      executorWorkflow: this.repo.executorWorkflow ?? 'factory-temporal-executor.yml',
      baseRef: this.repo.baseRef ?? null, issueNumbers: this.repo.issueNumbers ?? null,
      approvalMode: this.repo.readyApproval ? 'ready-label' : 'manual', requireHumanGate: this.repo.requireHumanGate,
      validationEnabled: !!this.repo.validationPlan, workerReady: true as const, checkedAt: new Date().toISOString() };
  }
  /**
   * The attempt a rework continues, from the broker's own records: same task and version, ended blocked by a failed
   * validation. Its ready grant, where one admitted it, carries over to the rework.
   */
  private async reworked(input: { issueNumber: number; taskVersion: string; contextReferences: string[] }, previousId = reworkOf(input)): Promise<StoredRun | null> {
    if (!previousId) return null;
    const previous = await this.store.get(this.repo.repositoryId, previousId);
    if (!previous || previous.snapshot.admission.input.issueNumber !== input.issueNumber || previous.snapshot.admission.input.taskVersion !== input.taskVersion ||
      previous.result?.status !== 'blocked' || (await this.store.validation(this.repo.repositoryId, previousId))?.status !== 'failed') throw new Error('REWORK_SOURCE_INVALID');
    return previous;
  }
  private scope(number: number) { if (this.repo.issueNumbers && !this.repo.issueNumbers.includes(number)) throw new Error('ISSUE_OUTSIDE_RUNTIME_SCOPE'); }
  private async current(snapshot: RunSnapshot) {
    const config = await this.repo.config();
    if (snapshot.validationPlan && !this.repo.validationPlan) throw new Error('VALIDATION_MODE_CHANGED');
    if (Boolean(this.repo.readyApproval) !== Boolean(snapshot.readyApproval)) throw new Error('APPROVAL_MODE_CHANGED');
    if (snapshot.readyApproval) {
      if (snapshot.requireHumanGate || !this.repo.readyApproval || hash(await this.repo.readyApproval(snapshot.admission.input.issueNumber, snapshot.readyApproval, (await this.reworked(snapshot.admission.input))?.snapshot.readyApproval)) !== hash(snapshot.readyApproval)) throw new Error('READY_APPROVAL_CHANGED');
    }
    if (this.repo.repositoryId !== snapshot.repositoryId || this.repo.repository !== snapshot.repository || this.repo.baseRef !== snapshot.baseRef || this.repo.executorWorkflow !== snapshot.executorWorkflow || hash(this.repo.allowedPaths ?? null) !== hash(snapshot.allowedPaths ?? null) ||
      ![this.repo.release, ...(this.repo.retainedReleases ?? [])].some(r => hash(r) === hash(snapshot.release)) || config.execution.engine !== 'temporal' ||
      hash(config) !== snapshot.configHash || policyVersion(config) !== snapshot.admission.policyHash || await this.repo.baseSha() !== snapshot.baseSha) throw new Error('STALE_SNAPSHOT');
    const auth = await authorizeDelegation(this.repo.github, config, snapshot.admission.input.issueNumber, snapshot.admission.input.executionId);
    if (auth.cancelled || hash(auth.input) !== hash(snapshot.admission.input)) throw new Error('DELEGATION_REVOKED');
    return config;
  }
  get readyIsGrant() { return !!this.repo.readyApproval; }
  async preflight(issueNumber: number, reworkOfExecutionId?: string): Promise<void> {
    try {
      this.scope(issueNumber);
      if (this.repo.readyApproval) {
        const previous = reworkOfExecutionId ? await this.store.get(this.repo.repositoryId, reworkOfExecutionId) : null;
        await this.repo.readyApproval(issueNumber, undefined, previous?.snapshot.admission.input.issueNumber === issueNumber ? previous.snapshot.readyApproval : undefined);
      }
    } catch (error) { const code = admissionCode(error); throw code ? new RuntimeAdmissionRejected(code) : error; }
  }
  async start(value: Admission): Promise<RuntimeObservation> {
    const admission = admissionSchema.parse(value), id = admission.input.executionId;
    this.scope(admission.input.issueNumber);
    if (admission.input.repository !== this.repo.repository) throw new Error('REPOSITORY_MISMATCH');
    await this.store.locked(this.repo.repositoryId, id, async () => {
      let stored = await this.store.get(this.repo.repositoryId, id);
      if (stored) {
        if (hash(stored.snapshot.admission) !== hash(admission)) throw new Error('ADMISSION_CONFLICT');
      } else try {
        const config = await this.repo.config();
        if (policyVersion(config) !== admission.policyHash || config.execution.engine !== 'temporal') throw new Error('POLICY_MISMATCH');
        const comments = await this.repo.github.comments(admission.input.issueNumber);
        const intent = comments.map(c => decodeEvent(c, config.manager.trustedActors)).find(e => e?.data.type === 'intent' && e.data.input.executionId === id);
        if (intent?.data.type !== 'intent' || intent.data.actionId !== admission.actionId) throw new Error('NO_MATCHING_INTENT');
        await this.reworked(admission.input);
        const snapshot = snapshotSchema.parse({ version: 1, repositoryId: this.repo.repositoryId, repository: this.repo.repository,
          release: this.repo.release, admission, baseSha: await this.repo.baseSha(), specHash: admission.input.taskVersion,
          ...(this.repo.baseRef ? { baseRef: this.repo.baseRef } : {}), ...(this.repo.executorWorkflow ? { executorWorkflow: this.repo.executorWorkflow } : {}),
          ...(this.repo.allowedPaths ? { allowedPaths: this.repo.allowedPaths } : {}),
          ...(this.repo.readyApproval ? { readyApproval: await this.repo.readyApproval(admission.input.issueNumber, undefined, (await this.reworked(admission.input))?.snapshot.readyApproval) } : {}),
          ...(admission.input.worker === 'codex' && this.repo.validationPlan ? { validationPlan: await this.repo.validationPlan() } : {}),
          configHash: hash(config), requireHumanGate: this.repo.requireHumanGate });
        await this.current(snapshot);
        const info = (await this.temporal.workflowService.describeWorkerDeploymentVersion({ namespace: this.temporal.options.namespace,
          deploymentVersion: { deploymentName: snapshot.release.deploymentName, buildId: snapshot.release.buildId } })).workerDeploymentVersionInfo;
        if (info?.deploymentVersion?.deploymentName !== snapshot.release.deploymentName || info.deploymentVersion.buildId !== snapshot.release.buildId) {
          throw new Error('UNKNOWN_WORKER_DEPLOYMENT_VERSION');
        }
        stored = await this.store.insert(snapshot, hash(snapshot), workflowId(this.repo.repositoryId, id));
      } catch (error) {
        // Nothing is persisted or started before the insert: a policy code here is a definite rejection.
        const code = admissionCode(error); throw code ? new RuntimeAdmissionRejected(code) : error;
      }
      if (!stored.runId) {
        if (stored.cancelled) throw new Error('ADMISSION_CANCELLED');
        await this.current(stored.snapshot);
        try {
          const handle = await this.temporal.workflow.start('factoryExecution', { workflowId: stored.workflowId,
            taskQueue: stored.snapshot.release.taskQueue, args: [stored.snapshot, stored.binding],
            versioningOverride: { pinnedTo: { deploymentName: stored.snapshot.release.deploymentName, buildId: stored.snapshot.release.buildId } },
            workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowExecutionTimeout: '30 days' });
          await this.store.started(this.repo.repositoryId, id, handle.firstExecutionRunId);
        } catch (error) {
          if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
          // A lost start response is reconciled with immutable workflow input, not just a matching name.
          const handle = this.temporal.workflow.getHandle(stored.workflowId), history = await handle.fetchHistory();
          const first = history.events?.find(e => e.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes;
          const payload = first?.input?.payloads?.[1];
          if (!payload?.data || JSON.parse(Buffer.from(payload.data).toString('utf8')) !== stored.binding) throw new Error('WORKFLOW_BINDING_CONFLICT', { cause: error });
          await this.store.started(this.repo.repositoryId, id, (await handle.describe()).runId);
        }
      }
    });
    return (await this.observations([id]))[0]!;
  }
  async observations(ids: string[]): Promise<RuntimeObservation[]> {
    const result: RuntimeObservation[] = [];
    for (const id of ids) {
      const row = await this.store.get(this.repo.repositoryId, id);
      if (!row) continue;
      this.scope(row.snapshot.admission.input.issueNumber);
      if (!row.runId) { if (!row.cancelled) result.push(await this.start(row.snapshot.admission)); continue; }
      const handle = this.temporal.workflow.getHandle(row.workflowId, row.runId), description = await handle.describe();
      const status: RuntimeObservation['status'] = description.status.name === 'RUNNING' ? 'running' : description.status.name === 'COMPLETED' ? (row.cancelled ? 'cancelled' : 'completed')
        : description.status.name === 'CANCELLED' ? 'cancelled' : description.status.name === 'TIMED_OUT' ? 'timed_out' : 'failed';
      let state: RuntimeState = { phase: row.cancelled ? 'cancelled' : row.result ? 'completed' : 'starting', binding: row.binding, result: row.result };
      if (status === 'running') state = await handle.query<RuntimeState>('factoryState');
      if (state.binding !== row.binding) throw new Error('WORKFLOW_BINDING_CONFLICT');
      if (status !== 'running') await this.store.terminal(this.repo.repositoryId, id);
      // Only a blocked result needs explaining; its small validation report says which checks failed.
      const report = row.result?.status === 'blocked' && row.snapshot.validationPlan ? await this.store.validation(this.repo.repositoryId, id) : null;
      result.push({ issueNumber: row.snapshot.admission.input.issueNumber, executionId: id, workflowId: row.workflowId, runId: row.runId, status, phase: state.phase, binding: row.binding, createdAt: row.createdAt, result: row.result,
        ...(report ? { validation: { status: report.status, reason: report.reason, runId: report.workflowRunId,
          failed: report.checks.filter(c => c.status === 'failed').map(c => ({ name: c.name, exitCode: c.exitCode })) } } : {}) });
    }
    return result;
  }
  async authorize(snapshot: RunSnapshot, binding: string): Promise<StoredRun> {
    this.scope(snapshot.admission.input.issueNumber);
    const stored = await this.store.get(this.repo.repositoryId, snapshot.admission.input.executionId);
    if (!stored || stored.binding !== binding || hash(snapshot) !== binding || stored.cancelled) throw new Error('UNKNOWN_OR_CANCELLED_RUN');
    if (snapshot.requireHumanGate && !stored.approved) throw new Error('APPROVAL_REQUIRED');
    await this.current(snapshot);
    return stored;
  }
  async gateApproved(snapshot: RunSnapshot, binding: string) {
    this.scope(snapshot.admission.input.issueNumber);
    const row = await this.store.get(this.repo.repositoryId, snapshot.admission.input.executionId);
    if (!row || row.binding !== binding || row.cancelled || hash(snapshot) !== binding) throw new Error('UNKNOWN_OR_CANCELLED_RUN');
    return row.approved;
  }
  async gate(id: string, binding: string, actor: string, approved: boolean) {
    if (!await this.repo.github.canApprove(actor)) throw new Error('ACTOR_NOT_AUTHORIZED');
    const row = await this.store.get(this.repo.repositoryId, id);
    if (!row || row.binding !== binding) throw new Error('STALE_APPROVAL');
    this.scope(row.snapshot.admission.input.issueNumber);
    await this.current(row.snapshot);
    await this.store.gate(this.repo.repositoryId, id, binding, actor, approved);
    if (row.runId) await this.temporal.workflow.getHandle(row.workflowId, row.runId).signal('approvalChanged');
  }
  async cancel(id: string) {
    const row = await this.store.get(this.repo.repositoryId, id);
    if (!row) throw new Error('UNKNOWN_RUN');
    this.scope(row.snapshot.admission.input.issueNumber);
    await this.store.locked(this.repo.repositoryId, id, () => this.store.cancel(this.repo.repositoryId, id));
    if (row.snapshot.admission.input.worker === 'codex' && this.repo.coding) await this.repo.coding.executor.cancel(row.snapshot, row.binding);
    if (row.runId) await this.temporal.workflow.getHandle(row.workflowId, row.runId).signal('cancelRequested');
  }
  private codingResult(snapshot: RunSnapshot, artifact: CodingArtifact, validation?: ValidationReport | null): WorkerResult {
    if (snapshot.allowedPaths && artifact.changes.some(c => !snapshot.allowedPaths!.includes(c.path))) throw new Error('ARTIFACT_OUTSIDE_RUNTIME_SCOPE');
    const input = snapshot.admission.input;
    if (artifact.baseSha !== snapshot.baseSha || artifact.result.executionId !== input.executionId || artifact.result.taskVersion !== snapshot.specHash ||
      artifact.result.taskId !== `github:${snapshot.repository}#${input.issueNumber}`) throw new Error('UNRELATED_EXECUTOR_ARTIFACT');
    if (snapshot.validationPlan) {
      if (!validation) throw new Error('VALIDATION_REPORT_REQUIRED');
      bindValidation(validation, artifact, snapshot.validationPlan);
    }
    const validationBlocked = validation && validation.status !== 'passed';
    const summary = validation ? `${artifact.result.summary.slice(0, 1650)}\nOriginal model status: ${artifact.result.status}. Independent automated validation: ${validation.status}. Manual acceptance is not implied.` : artifact.result.summary;
    return workerResultSchema.parse({ contractVersion: '1.0', executionId: input.executionId, issueNumber: input.issueNumber,
      status: artifact.result.status === 'timed_out' ? 'failed' : artifact.result.status === 'success' && (!artifact.changes.length || validationBlocked) ? 'blocked' : artifact.result.status,
      summary, error: artifact.result.error, artifacts: [`urn:sf-artifact:${hash(artifact)}`, ...(validation ? [`urn:sf-validation:${hash(validation)}`] : [])], proposedActions: [] });
  }
  async executeCoding(snapshot: RunSnapshot, binding: string): Promise<WorkerResult | null> {
    await this.authorize(snapshot, binding);
    if (snapshot.admission.input.worker !== 'codex' || !this.repo.coding) throw new Error('CODING_EXECUTOR_UNAVAILABLE');
    const id = snapshot.admission.input.executionId, previous = await this.store.artifact(this.repo.repositoryId, id);
    const validation = snapshot.validationPlan ? await this.store.validation(this.repo.repositoryId, id) : null;
    if (previous && (!snapshot.validationPlan || validation)) return this.codingResult(snapshot, previous, validation);
    const outcome = await this.repo.coding.executor.poll(snapshot, binding, await this.current(snapshot));
    if (!outcome) return null;
    if ('failed' in outcome) return workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber: snapshot.admission.input.issueNumber,
      status: 'failed', summary: 'Isolated coding executor failed', error: 'Inspect the scoped executor run', artifacts: [], proposedActions: [] });
    const result = this.codingResult(snapshot, outcome.artifact, outcome.validation);
    await this.store.saveArtifact(this.repo.repositoryId, id, outcome.artifact);
    if (outcome.validation) await this.store.saveValidation(this.repo.repositoryId, id, outcome.validation);
    return result;
  }
  async publish(snapshot: RunSnapshot, binding: string, value: WorkerResult): Promise<WorkerResult> {
    let result = workerResultSchema.parse(value); const id = snapshot.admission.input.executionId;
    this.scope(snapshot.admission.input.issueNumber);
    if (result.executionId !== id || result.issueNumber !== snapshot.admission.input.issueNumber) throw new Error('RESULT_MISMATCH');
    return this.store.locked(this.repo.repositoryId, id, async client => {
      const row = await this.store.get(this.repo.repositoryId, id);
      if (!row || row.binding !== binding || hash(snapshot) !== binding) throw new Error('UNKNOWN_RUN');
      const artifact = snapshot.admission.input.worker === 'codex' ? await this.store.artifact(this.repo.repositoryId, id) : null;
      const validation = snapshot.validationPlan ? await this.store.validation(this.repo.repositoryId, id) : null;
      if (artifact && hash(this.codingResult(snapshot, artifact, validation)) !== hash(result)) throw new Error('RESULT_CONFLICT');
      if (row.result) { if (!artifact && hash(row.result) !== hash(result)) throw new Error('RESULT_CONFLICT'); return row.result; }
      await this.authorize(snapshot, binding);
      if (snapshot.admission.input.worker === 'codex' && (result.status === 'success' || snapshot.validationPlan && artifact?.changes.length && ['success', 'blocked'].includes(artifact.result.status))) {
        if (!artifact || !this.repo.coding) throw new Error('MISSING_CODING_ARTIFACT');
        const pr = await this.repo.coding.publish(snapshot, binding, artifact, row.createdAt, validation ?? undefined);
        result = { ...result, artifacts: [pr.url, ...(validation ? [`urn:sf-validation:${hash(validation)}`] : [])] };
      }
      const config = await this.repo.config(), digest = hash(result);
      const events = (await this.repo.github.comments(result.issueNumber)).map(c => decodeEvent(c, config.manager.trustedActors));
      const published = events.find(e => e?.data.type === 'result' && e.data.result.executionId === id);
      if (published?.data.type === 'result') {
        if (hash(published.data.result) !== digest) throw new Error('RESULT_CONFLICT');
      } else {
        const prior = await client.query<{ payload_hash: string; phase: string }>('SELECT * FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 AND effect=$3', [this.repo.repositoryId, id, 'result-journal']);
        if (prior.rows[0]) throw new Error('PUBLICATION_UNCERTAIN_RECONCILIATION_REQUIRED');
        // Durable claim BEFORE GitHub. An unknown outcome remains fail-closed until actual journal evidence exists.
        await client.query('INSERT INTO factory_runtime_effects(repository_id,execution_id,effect,payload_hash,phase) VALUES($1,$2,$3,$4,$5)', [this.repo.repositoryId, id, 'result-journal', digest, 'attempted']);
        await this.repo.github.writeEvent(result.issueNumber, { version: 1, key: `result:${id}`, at: new Date().toISOString(), correlationId: row.workflowId, data: { type: 'result', result } });
      }
      await client.query('UPDATE factory_runtime_effects SET phase=$3 WHERE repository_id=$1 AND execution_id=$2 AND effect=$4', [this.repo.repositoryId, id, 'confirmed', 'result-journal']);
      await this.store.complete(this.repo.repositoryId, id, result);
      return result;
    });
  }
}
