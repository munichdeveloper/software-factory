import { afterEach, expect, it, vi } from 'vitest';
import { dependencyCycles, inspect, SanityMonitor, type Finding, type FindingKind, type SanityStore } from '../src/runtime/sanity.js';
import { monitoringSettings } from '../src/config/index.js';
import type { Execution, Task } from '../src/state/reconstruct.js';
import type { RunReport } from '../src/manager/report.js';
import { clock, config, issue } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); });
const version = 'a'.repeat(64);
const execution = (attempt: number, over: Partial<Execution> = {}, status: 'running' | 'completed' = 'completed', createdAt = clock.toISOString()): Execution => ({
  input: { executionId: `${attempt}`.padStart(32, '0'), taskVersion: version, limits: { timeoutMinutes: 30, maxOutputBytes: 16000 } } as Execution['input'],
  attempt, actionId: 'b'.repeat(64), at: createdAt, active: status === 'running', ambiguous: false, timedOut: false, orphaned: false,
  runtime: { status, phase: status === 'running' ? 'running' : 'completed', createdAt } as Execution['runtime'], ...over });
const failed = (attempt: number, error: string | null) => execution(attempt, { result: { contractVersion: '1.0', executionId: `${attempt}`.padStart(32, '0'),
  issueNumber: 1, status: 'failed', summary: 'secret worker text', artifacts: [], error, proposedActions: [] } });
const task = (number: number, over: Partial<Task> = {}, body?: string): Task => {
  const executions = over.executions ?? [];
  return { issue: { ...issue(number), ...(body ? { body } : {}) }, version, status: 'running', desiredStatus: 'running', events: [], executions,
    latest: [...executions].sort((a, b) => a.attempt - b.attempt).at(-1), blocked: false, hasOpenPR: false, hasClosingMerge: false, criteria: ['x'], reworkable: false, ...over };
};
const settings = monitoringSettings(config());
const kinds = (found: Finding[]) => found.map(f => `${f.kind}#${f.issueNumber}`);
const repo = { repositoryId: 1, repository: 'owner/target' };
const later = (minutes: number) => new Date(clock.getTime() + minutes * 60000);

it('reports a run that outlives its worker timeout plus the grace, and a long approval wait', () => {
  const running = task(1, { executions: [execution(0, {}, 'running')] });
  expect(inspect([running], config(), settings, later(89))).toEqual([]);
  expect(kinds(inspect([running], config(), settings, later(91)))).toEqual(['run_stuck#1']);
  const waiting = task(2, { executions: [execution(0, { runtime: { status: 'running', phase: 'awaiting-approval', createdAt: clock.toISOString() } as Execution['runtime'] }, 'running')] });
  expect(inspect([waiting], config(), settings, later(47 * 60))).toEqual([]);
  expect(kinds(inspect([waiting], config(), settings, later(49 * 60)))).toEqual(['approval_waiting#2']);
});

it('reports exhausted retries and the same error code ending several attempts in a row, without worker text', () => {
  const cfg = config(); cfg.execution.maxRetries = 5;
  const stale = task(1, { status: 'failed', desiredStatus: 'failed', executions: [failed(0, 'STALE_SNAPSHOT'), failed(1, 'STALE_SNAPSHOT'), failed(2, 'STALE_SNAPSHOT')] });
  const found = inspect([stale], cfg, settings, clock);
  expect(found).toEqual([{ key: 'repeated_failure:1:STALE_SNAPSHOT', kind: 'repeated_failure', issueNumber: 1, detail: '3 attempts in a row ended with STALE_SNAPSHOT' }]);
  expect(kinds(inspect([task(1, { executions: [failed(0, 'BASE_MOVED'), failed(1, 'STALE_SNAPSHOT'), failed(2, 'STALE_SNAPSHOT')] })], cfg, settings, clock))).toEqual([]);
  cfg.execution.maxRetries = 2;
  const exhausted = inspect([task(1, { executions: [failed(0, null), failed(1, null), failed(2, 'free text from upstream')] })], cfg, settings, clock);
  expect(exhausted.map(f => f.detail)).toEqual(['Retry budget used up after attempt 2 (failed); the task cannot progress without a person']);
});

it('reports a Factory block without a pull request, but not a dependency wait, a person\'s block or a pending review', () => {
  const blocked = (over: Partial<Task>) => task(1, { status: 'blocked', desiredStatus: 'blocked', ...over });
  expect(kinds(inspect([blocked({ automaticBlockCause: 'worker' })], config(), settings, clock))).toEqual(['blocked_without_pr#1']);
  expect(inspect([blocked({ automaticBlockCause: 'worker', hasOpenPR: true })], config(), settings, clock)).toEqual([]);
  expect(inspect([blocked({ blockReason: 'Unresolved dependencies: #2' })], config(), settings, clock)).toEqual([]);
  expect(inspect([blocked({ blockReason: 'Issue explicitly marked blocked; clear the blocked label to resume' })], config(), settings, clock)).toEqual([]);
  expect(inspect([blocked({ blockReason: 'Missing Acceptance criteria section' })], config(), settings, clock)[0]?.detail).toBe('Blocked without a pull request (cause: specification)');
});

it('finds each dependency cycle once among open tasks', () => {
  const body = (deps: string) => `Do it.\n\n## Acceptance criteria\n- x\n\nDepends on: ${deps}\n`;
  const tasks = [task(3, {}, body('#5')), task(5, {}, body('#4')), task(4, {}, body('#3')), task(7, {}, body('#3')), task(8, {}, body('#8'))];
  expect(dependencyCycles(tasks)).toEqual([[3, 5, 4], [8]]);
  expect(inspect(tasks, config(), settings, clock).map(f => f.detail)).toEqual(['Dependency cycle #3 -> #5 -> #4 -> #3', 'Dependency cycle #8 -> #8']);
});

class MemoryFindings implements SanityStore {
  open = new Map<string, Finding>();
  async syncFindings(_repositoryId: number, findings: Finding[], scope: readonly FindingKind[]) {
    const opened = findings.filter(f => !this.open.has(f.key));
    const resolved = [...this.open.values()].filter(f => scope.includes(f.kind) && !findings.some(x => x.key === f.key));
    for (const f of resolved) this.open.delete(f.key);
    for (const f of findings) this.open.set(f.key, f);
    return { opened, resolved };
  }
}
const report = (errors: string[] = []): RunReport => ({ correlationId: 'c', startedAt: clock.toISOString(), durationMs: 0, outcome: errors.length ? 'partial' : 'success', tasks: 0, decisions: [], errors, blockers: [], nextSteps: [] });
const snapshot = (labels: string[]) => ({ issues: [{ ...issue(1, labels), createdAt: clock.toISOString() }], comments: new Map(), prs: [], runs: [], defaultBranch: 'main', dependencyStates: new Map(), readyIsGrant: true });

it('counts a status that never settles and failing reconciliations over passes, and resolves them when they recover', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const store = new MemoryFindings(), monitor = new SanityMonitor(store, () => clock), cfg = config();
  cfg.monitoring = { stalledPasses: 3 };
  // awaiting-pr without any pull request: the derived status differs, every pass.
  for (let i = 0; i < 2; i++) await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:awaiting-pr']), report());
  expect([...store.open.keys()]).toEqual([]);
  await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:awaiting-pr']), report());
  expect([...store.open.keys()]).toEqual(['status_stalled:1']);
  await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:backlog']), report());
  expect([...store.open.keys()]).toEqual([]);

  for (let i = 0; i < 3; i++) await monitor.failed(repo, 'OPERATION_FAILED');
  expect([...store.open.values()].map(f => f.detail)).toEqual(['3 reconciliations in a row failed (OPERATION_FAILED)']);
  await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:backlog']), report());
  expect(store.open.size).toBe(0);
  for (let i = 0; i < 3; i++) await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:backlog']), report(['LLM planning failed']));
  expect([...store.open.keys()]).toEqual(['reconcile_failing:-']);
});

it('stays silent where a repository turns it off and never lets a store failure reach the reconciliation', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const store = { syncFindings: vi.fn(async () => { throw new Error('pool exhausted: postgres://secret'); }) };
  const monitor = new SanityMonitor(store, () => clock), cfg = config();
  await expect(monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:backlog']), report())).resolves.toBeUndefined();
  expect(warn.mock.calls.map(c => c[0])).toEqual([JSON.stringify({ event: 'factory-sanity-failed', repositoryId: 1 })]);
  cfg.monitoring = { enabled: false }; store.syncFindings.mockClear();
  await monitor.observed(repo, cfg, snapshot(['harness:managed', 'harness:awaiting-pr']), report());
  await monitor.failed(repo, 'OPERATION_FAILED');
  expect(store.syncFindings).not.toHaveBeenCalled();
});

it('posts new and resolved findings once to the configured or the notifications channel, and survives a Slack failure', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const alerts = { post: vi.fn(async () => {}) }, store = new MemoryFindings(), monitor = new SanityMonitor(store, () => clock, alerts), cfg = config();
  cfg.monitoring = { stalledPasses: 2 };
  const stuck = snapshot(['harness:managed', 'harness:awaiting-pr']), fine = snapshot(['harness:managed', 'harness:backlog']);
  for (let i = 0; i < 3; i++) await monitor.observed(repo, cfg, stuck, report());
  expect(alerts.post).not.toHaveBeenCalled(); // no channel anywhere
  await monitor.observed(repo, cfg, fine, report());
  cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = '#factory';
  for (let i = 0; i < 3; i++) await monitor.observed(repo, cfg, stuck, report());
  await monitor.observed(repo, cfg, fine, report());
  expect(alerts.post.mock.calls).toEqual([
    ['#factory', 'SF Sanity-Check: owner/target\nNeue Probleme:\n• Status stellt sich nicht ein – https://github.com/owner/target/issues/1\n  Status awaiting-pr should be backlog but has not changed for 2 reconciliations'],
    ['#factory', 'SF Sanity-Check: owner/target\nBehoben:\n• Status stellt sich nicht ein – https://github.com/owner/target/issues/1'],
  ]);
  cfg.monitoring = { stalledPasses: 2, channel: 'C0123456789' }; alerts.post.mockRejectedValueOnce(new Error('xoxb-secret'));
  for (let i = 0; i < 2; i++) await monitor.observed(repo, cfg, stuck, report());
  expect(alerts.post).toHaveBeenLastCalledWith('C0123456789', expect.any(String));
  expect(warn.mock.calls.map(c => c[0])).toEqual([JSON.stringify({ event: 'factory-sanity-alert-failed', repositoryId: 1 })]);
  cfg.monitoring = { stalledPasses: 2, slack: false }; alerts.post.mockClear();
  await monitor.observed(repo, cfg, fine, report());
  expect(alerts.post).not.toHaveBeenCalled();
});
