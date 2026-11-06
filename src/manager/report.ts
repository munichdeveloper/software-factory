import type { Action, Decision } from '../types.js';

export interface RunReport {
  correlationId: string; startedAt: string; durationMs: number; outcome: 'success' | 'partial' | 'disabled' | 'failed';
  tasks: number; decisions: { action: Action; decision: Decision; executed: boolean }[];
  errors: string[]; blockers: string[]; nextSteps: string[];
}
export function summary(report: RunReport): string {
  const safe = (s: string) => s.replace(/[<>|\r\n]/g, ' ').replace(/`/g, "'");
  const executed = report.decisions.filter(d => d.executed);
  return [`# Software Factory v0.1`, '', `Run: \`${report.correlationId}\``,
    `Started: ${report.startedAt} · Duration: ${report.durationMs}ms · Result: ${report.outcome}`,
    `Managed tasks: ${report.tasks} · Status changes: ${executed.filter(d => ['transition', 'close_issue', 'approve_task'].includes(d.action.kind)).length} · Workers started: ${executed.filter(d => ['start_worker', 'retry_worker'].includes(d.action.kind)).length} · Issues created: ${executed.filter(d => d.action.kind === 'create_followup').length} · Denied: ${report.decisions.filter(d => d.decision.outcome === 'deny').length}`,
    '', '| Issue | Action | Decision | Executed | Reason / approval ID |',
    '|---|---|---|---|---|',
    ...report.decisions.map(({ action, decision, executed }) => `| #${action.issueNumber} | ${action.kind}${action.status ? ` → ${action.status}` : ''} | ${decision.outcome} | ${executed} | ${safe(decision.reason)} — \`${decision.actionId}\` |`),
    '', '## Errors', ...report.errors.map(e => `- ${safe(e)}`), '', '## Blockers', ...report.blockers.map(e => `- ${safe(e)}`),
    '', '## Next steps', ...report.nextSteps.map(e => `- ${safe(e)}`), ''
  ].join('\n');
}
