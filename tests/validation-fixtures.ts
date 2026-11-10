import type { CodingArtifact } from '../src/workers/coding.js';
import { hash } from '../src/state/identity.js';
import { validationReportSchema, type ValidationPlan, type ValidationReport } from '../src/runtime/validation-contract.js';
export function reportFor(artifact: CodingArtifact, plan: ValidationPlan, status: ValidationReport['status'] = 'passed', workflowRunId = 12): ValidationReport {
  const names = ['install', 'test', 'build', ...(plan.profile === 'npm-docker' ? ['compose-config', 'docker-start', 'docker-smoke', 'docker-stop'] : []), 'source-integrity'];
  return validationReportSchema.parse({ version: 1, executionId: artifact.result.executionId, taskId: artifact.result.taskId, taskVersion: artifact.result.taskVersion,
    baseSha: artifact.baseSha, artifactHash: hash(artifact), planHash: hash(plan), workflowRunId, sourceRunId: workflowRunId, runAttempt: 1,
    status, checks: names.map(name => ({ name, status: name === 'test' && status === 'failed' ? 'failed' : 'passed', exitCode: name === 'test' && status === 'failed' ? 1 : 0 })),
    reason: status === 'passed' ? 'CHECKS_COMPLETED' : 'CHECK_FAILED', modelSecretPresent: false, workspaceUnchanged: true });
}
