import { configSchema, type Config } from '../src/config/index.js';
import { taskVersion } from '../src/state/identity.js';
import type { GitHubPort } from '../src/github/port.js';
import type { Comment, Issue, Snapshot, WorkflowRun } from '../src/types.js';
import { encodeEvent, type HarnessEvent } from '../src/state/events.js';
import type { HarnessPort } from '../src/workers/harness-client.js';
export const fakeHarness: HarnessPort = { async execute(input) {
  return { contractVersion: '1.0', executionId: input.executionId, issueNumber: input.issueNumber,
    status: input.operation === 'fail' ? 'failed' : input.operation === 'blocked' ? 'blocked' : 'success',
    summary: 'Injected runtime fixture', artifacts: [], error: null, proposedActions: [] };
} };
export const clock = new Date('2026-11-06T10:00:00.000Z');
export const config = (profile: Config['autonomy']['profile'] = 'autonomous'): Config => configSchema.parse({ version: 1, factory: { scope: 'Test task coordination' }, autonomy: { profile } });
export const issue = (number = 1, labels = ['harness:managed', 'harness:ready']): Issue => ({ number, title: `Task ${number}`,
  body: 'Implement the feature.\n\n## Acceptance criteria\n- Deterministic observable result\n', state: 'open', labels, updatedAt: clock.toISOString() });
export class MemoryGitHub implements GitHubPort {
  readonly repository = 'owner/target';
  state: Snapshot = { issues: [], comments: new Map(), prs: [], runs: [], defaultBranch: 'main', dependencyStates: new Map() };
  mutations: string[] = [];
  failDispatchAfterStart = false;
  failReceipt = false;
  failAfterBlockUpdate = false;
  private nextLabelEventId = 1;
  dispatches = 0;
  async readConfig(): Promise<string> { return ''; }
  async snapshot(): Promise<Snapshot> { return structuredClone(this.state); }
  async getIssue(number: number): Promise<Issue> { const value = this.state.issues.find(i => i.number === number); if (!value) throw new Error('404'); return structuredClone(value); }
  async comments(number: number): Promise<Comment[]> { return structuredClone(this.state.comments.get(number) ?? []); }
  async canApprove(login: string): Promise<boolean> { return login === 'maintainer'; }
  async writeEvent(number: number, event: HarnessEvent): Promise<void> {
    if (event.data.type === 'receipt' && this.failReceipt) throw new Error('simulated receipt failure');
    this.mutations.push(`event:${event.key}`);
    const rows = this.state.comments.get(number) ?? [];
    rows.push({ id: rows.length + 1, author: 'github-actions[bot]', body: encodeEvent(event), createdAt: clock.toISOString() });
    this.state.comments.set(number, rows);
  }
  async writeComment(number: number, body: string, id?: number): Promise<void> {
    const rows = this.state.comments.get(number) ?? [], existing = rows.find(r => r.id === id);
    if (existing) existing.body = body; else rows.push({ id: rows.length + 1, author: 'github-actions[bot]', body, createdAt: clock.toISOString() });
    this.state.comments.set(number, rows);
  }
  async updateIssue(number: number, update: { labels?: string[]; state?: 'open' | 'closed' }): Promise<void> {
    this.mutations.push(`update:${number}`);
    const task = this.state.issues.find(i => i.number === number)!;
    if (update.labels && task.labels.includes('harness:blocked') !== update.labels.includes('harness:blocked')) {
      this.labelBlock(number, update.labels.includes('harness:blocked'), 'github-actions[bot]');
    }
    Object.assign(task, update);
    if (this.failAfterBlockUpdate && update.labels?.includes('harness:blocked')) throw new Error('Simulated crash after block label update');
  }
  labelBlock(number: number, blocked: boolean, actor = 'maintainer'): void {
    const task = this.state.issues.find(i => i.number === number)!;
    task.blockedLabelEvents ??= [];
    const id = Math.max(this.nextLabelEventId, ...task.blockedLabelEvents.map(e => e.id + 1));
    this.nextLabelEventId = id + 1;
    task.blockedLabelEvents.push({ id, event: blocked ? 'labeled' : 'unlabeled', actor, createdAt: clock.toISOString() });
    task.labels = task.labels.filter(l => l !== 'harness:blocked');
    if (blocked) task.labels.push('harness:blocked');
  }
  async createIssue(title: string, body: string, labels: string[]): Promise<Issue> {
    const next = { ...issue(this.state.issues.length + 1, labels), title, body };
    this.state.issues.push(next); this.mutations.push(`create:${next.number}`); return structuredClone(next);
  }
  async bootstrap(): Promise<string[]> { return []; }
  async dispatch(_workflow: string, _ref: string, id: string): Promise<void> {
    this.dispatches++;
    this.state.runs.push({ id: this.dispatches, title: `Factory worker ${id}`, status: 'in_progress', conclusion: null, createdAt: clock.toISOString(), url: `https://github.com/owner/target/actions/runs/${this.dispatches}` });
    if (this.failDispatchAfterStart) throw new Error('Ambiguous network failure after dispatch');
  }
  async runs(): Promise<WorkflowRun[]> { return structuredClone(this.state.runs); }
  async cancelRun(id: number): Promise<void> { this.mutations.push(`cancel:${id}`); const run = this.state.runs.find(r => r.id === id)!; run.status = 'completed'; run.conclusion = 'cancelled'; }
  approve(number: number, id: string, author = 'maintainer'): void {
    const rows = this.state.comments.get(number) ?? [];
    rows.push({ id: rows.length + 1, body: `/harness approve ${id}`, author, createdAt: clock.toISOString() }); this.state.comments.set(number, rows);
  }
}
/** Records a finished attempt of an issue, as a Manager intent followed by its worker result. */
export async function finishedAttempt(github: MemoryGitHub, number: number, status: 'blocked' | 'success' | 'failed', attempt = 0) {
  const task = github.state.issues.find(i => i.number === number)!;
  const executionId = `${String(number).padStart(4, '0')}${String(attempt).padStart(4, '0')}`.padEnd(32, 'a');
  const input = { contractVersion: '1.0' as const, repository: github.repository, issueNumber: number, taskVersion: taskVersion(task), description: task.body,
    acceptanceCriteria: ['Deterministic observable result'], contextReferences: [], executionId, allowedActions: ['publish_result' as const],
    limits: { timeoutMinutes: 30, maxOutputBytes: 16000 as const }, operation: 'sha256' as const, worker: 'test' as const };
  await github.writeEvent(number, { version: 1, key: `intent:${executionId}`, at: clock.toISOString(), correlationId: 'test', data: { type: 'intent', input, actionId: 'a'.repeat(64), attempt } });
  await github.writeEvent(number, { version: 1, key: `result:${executionId}`, at: clock.toISOString(), correlationId: 'test', data: { type: 'result', result: {
    contractVersion: '1.0', executionId, issueNumber: number, status, summary: 'Finished attempt', artifacts: [], error: null, proposedActions: [] } } });
}
