import { Client, Connection } from '@temporalio/client';
import process from 'node:process';
import console from 'node:console';

const namespace = 'software-factory-poc';
const maxResults = 1000;
const age = (value) => value ? Math.max(0, (Date.now() - Number(value.seconds) * 1000 - Number(value.nanos || 0) / 1e6) / 1000) : 0;
async function main() {
  const connection = await Connection.connect({ address: 'temporal:7233', connectTimeout: '3 seconds' });
  try {
    const client = new Client({ connection, namespace });
    const metrics = { openWorkflows: 0, maximumPendingTaskAgeSeconds: 0, maximumActivityAttempt: 0, recentTimedOutWorkflows: 0 };
    const pinned = [];
    const since = new Date(Date.now() - 15 * 60000).toISOString();
    await connection.withDeadline(Date.now() + 15000, async () => {
      for await (const workflow of client.workflow.list({ query: 'ExecutionStatus = "Running"' })) {
        if (++metrics.openWorkflows > maxResults) throw new Error('OBSERVATION_LIMIT_EXCEEDED');
        const detail = await client.workflowService.describeWorkflowExecution({ namespace, execution: { workflowId: workflow.workflowId, runId: workflow.runId } });
        metrics.maximumPendingTaskAgeSeconds = Math.max(metrics.maximumPendingTaskAgeSeconds, age(detail.pendingWorkflowTask?.scheduledTime));
        for (const activity of detail.pendingActivities || []) {
          metrics.maximumActivityAttempt = Math.max(metrics.maximumActivityAttempt, activity.attempt || 0);
          if (activity.state === 1) metrics.maximumPendingTaskAgeSeconds = Math.max(metrics.maximumPendingTaskAgeSeconds, age(activity.scheduledTime));
        }
        const version = detail.workflowExecutionInfo?.versioningInfo?.deploymentVersion;
        if (version) pinned.push({ deploymentName: version.deploymentName, buildId: version.buildId });
      }
      for await (const workflow of client.workflow.list({ query: `ExecutionStatus = "TimedOut" AND CloseTime > "${since}"` })) {
        if (workflow && ++metrics.recentTimedOutWorkflows > maxResults) throw new Error('OBSERVATION_LIMIT_EXCEEDED');
      }
    });
    return { ok: true, namespace, metrics, openPinnedVersions: pinned, checkedAt: new Date().toISOString() };
  } finally { await connection.close(); }
}
main().then(result => console.log(JSON.stringify(result))).catch(() => { console.log(JSON.stringify({ ok: false, code: 'TEMPORAL_PROBE_FAILED' })); process.exitCode = 1; });
