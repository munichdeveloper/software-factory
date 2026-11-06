// SF owns authorization and durable publication around one external Harness call.
import type { GitHubPort } from '../github/port.js';
import type { Config } from '../config/index.js';
import { decodeEvent } from '../state/events.js';
import { workerInputSchema, workerResultSchema, type WorkerResult } from './contract.js';
import type { HarnessPort } from './harness-client.js';
import { actionId, taskVersion } from '../state/identity.js';
import { currentAutomaticBlock } from '../state/blocks.js';
import { permission, policyVersion } from '../policies/engine.js';
import type { Action } from '../types.js';

export async function executeDelegation(github: GitHubPort, config: Config, issueNumber: number, id: string, correlationId: string, harness: HarnessPort): Promise<WorkerResult> {
  if (!config.factory.enabled || !config.workers.test.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') throw new Error('Worker execution disabled by configuration');
  const issue = await github.getIssue(issueNumber);
  const comments = await github.comments(issueNumber);
  const events = comments.flatMap(c => { const e = decodeEvent(c, config.manager.trustedActors); return e ? [e] : []; });
  const previous = events.find(e => e.data.type === 'result' && e.data.result.executionId === id);
  if (previous?.data.type === 'result') return previous.data.result;
  const event = events.find(e => e.data.type === 'intent' && e.data.input.executionId === id);
  if (event?.data.type !== 'intent') throw new Error('No trusted manager intent for this execution');
  const input = workerInputSchema.parse(event.data.input);
  if (input.repository.toLowerCase() !== github.repository.toLowerCase() || input.issueNumber !== issueNumber) throw new Error('Worker repository/issue mismatch');
  const original: Action = { kind: event.data.attempt === 0 ? 'start_worker' : 'retry_worker', issueNumber,
    taskVersion: input.taskVersion, attempt: event.data.attempt, status: null, priority: null, followup: null, reason: 'Revalidate original delegation' };
  let approved = false;
  for (const c of comments) {
    const command = c.body.trim().match(/^\/harness (approve|revoke) ([a-f0-9]{64})$/);
    if (command?.[2] === event.data.actionId && await github.canApprove(c.author)) approved = command[1] === 'approve';
  }
  const rule = permission(config, original.kind);
  const policyChanged = actionId(original, policyVersion(config)) !== event.data.actionId || rule === 'deny' || (rule === 'approval' && !approved);
  const explicitlyBlocked = issue.labels.includes('harness:blocked') && !currentAutomaticBlock(issue, events, config.manager.trustedActors);
  const stale = policyChanged || explicitlyBlocked || issue.state !== 'open' || !issue.labels.includes('harness:managed') || taskVersion(issue) !== input.taskVersion;
  let result: WorkerResult;
  if (stale) result = workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber, status: 'cancelled',
    summary: 'Task, policy or approval changed after delegation', artifacts: [], error: null, proposedActions: [] });
  else {
    try { result = workerResultSchema.parse(await harness.execute(input)); }
    catch { result = workerResultSchema.parse({ contractVersion: '1.0', executionId: id, issueNumber, status: 'failed',
      summary: 'Harness invocation failed', artifacts: [], error: 'Runtime unavailable or invalid result', proposedActions: [] }); }
    if (result.executionId !== id || result.issueNumber !== issueNumber) throw new Error('Harness adapter returned an unrelated delegation result');
  }
  if (Buffer.byteLength(JSON.stringify(result)) > input.limits.maxOutputBytes) throw new Error('Worker output exceeds contract resource limit');
  // Persistence and lifecycle decisions are SF responsibilities; Harness only returned a run result.
  await github.writeEvent(issueNumber, { version: 1, key: `result:${id}`, at: new Date().toISOString(), correlationId, data: { type: 'result', result } });
  return result;
}
