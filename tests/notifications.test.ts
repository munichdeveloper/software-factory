import { expect, it, vi } from 'vitest';
import { config, issue, MemoryGitHub, clock, finishedAttempt } from './helpers.js';
import { deliverNotifications, NotificationRejected, SlackSink, type Notification, type NotificationSink } from '../src/notifications/slack.js';
import { actionId, hash, taskVersion } from '../src/state/identity.js';
import { policyVersion } from '../src/policies/engine.js';
import { Manager } from '../src/manager/index.js';
import type { Planner } from '../src/llm/provider.js';

const channel = 'C0CGJKK3EKS';
const id = 'a'.repeat(32), key = 'b'.repeat(64), decision = 'c'.repeat(64);
async function fixture() {
  const cfg = config(); cfg.reporting.persistDecisions = false; cfg.llm.maxCalls = 0;
  cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  cfg.notifications.slack.events.issue_created.enabled = true; cfg.notifications.slack.events.pr_merged.enabled = true;
  const gh = new MemoryGitHub(); gh.state.issues = [issue(1), { ...issue(2), title: 'New task', authorType: 'Bot', createdAt: clock.toISOString(),
    body: `Origin: #1\nDecision: ${decision}\n\n<!-- harness:followup:${key} -->` }];
  await gh.writeEvent(1, { version: 1, key: 'creation', at: clock.toISOString(), correlationId: 'test',
    data: { type: 'issue_creation_intent', followupKey: key, actionId: decision } });
  await gh.writeEvent(1, { version: 1, key: 'result', at: clock.toISOString(), correlationId: 'test', data: { type: 'result', result: {
    contractVersion: '1.0', executionId: id, issueNumber: 1, status: 'success', summary: 'Implemented',
    artifacts: ['https://github.com/owner/target/pull/9'], error: null, proposedActions: [] } } });
  gh.state.prs = [{ number: 9, state: 'closed', merged: true, mergedAt: clock.toISOString(), closingIssues: [1], referencedIssues: [1],
    title: 'Implemented task', headRefName: `sf/issue-1/${id}`, mergedBy: { login: 'github-actions[bot]', type: 'Bot' } }];
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const deliver = () => deliverNotifications(gh, cfg, structuredClone(gh.state), { send }, 'test', clock);
  return { cfg, gh, send, deliver };
}
it('delivers two native, correlated SF events and does not repeat them across runs with optional audit disabled', async () => {
  const f = await fixture(); expect(await f.deliver()).toEqual([]); expect(await f.deliver()).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls.map(c => c[1].event)).toEqual(['issue_created', 'pr_merged']);
});
it.each(['human-merge', 'unmerged', 'unrelated-pr', 'wrong-branch', 'untrusted-journal', 'human-issue', 'wrong-decision', 'wrong-origin'])('does not notify forged or out-of-scope facts: %s', async condition => {
  const f = await fixture();
  if (condition === 'human-merge') f.gh.state.prs[0]!.mergedBy = { login: 'maintainer', type: 'User' };
  if (condition === 'unmerged') f.gh.state.prs[0]!.merged = false;
  if (condition === 'unrelated-pr') f.gh.state.prs[0]!.number = 10;
  if (condition === 'wrong-branch') f.gh.state.prs[0]!.headRefName = 'other';
  if (condition === 'untrusted-journal') for (const c of f.gh.state.comments.get(1)!) c.author = 'attacker';
  if (condition === 'human-issue') f.gh.state.issues[1]!.authorType = 'User';
  if (condition === 'wrong-decision') f.gh.state.issues[1]!.body = f.gh.state.issues[1]!.body.replace(decision, 'f'.repeat(64));
  if (condition === 'wrong-origin') f.gh.state.issues[1]!.body = f.gh.state.issues[1]!.body.replace('Origin: #1', 'Origin: #99');
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(condition === 'untrusted-journal' ? 0 : 1);
});
it('uses per-event channels and explicit bot allow-lists', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.issue_created.channel = 'C123456789';
  f.cfg.notifications.slack.events.pr_merged.actors = ['other-bot[bot]'];
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(1); expect(f.send.mock.calls[0]![0]).toBe('C123456789');
});
it.each(['disabled', 'dry-run', 'advisory', 'factory-disabled', 'rules-disabled', 'since'])('does not send in %s mode', async mode => {
  const f = await fixture();
  if (mode === 'disabled') f.cfg.notifications.slack.enabled = false;
  if (mode === 'dry-run') f.cfg.execution.dryRun = true;
  if (mode === 'advisory') f.cfg.autonomy.profile = 'advisory';
  if (mode === 'factory-disabled') f.cfg.factory.enabled = false;
  if (mode === 'rules-disabled') { f.cfg.notifications.slack.events.issue_created.enabled = false; f.cfg.notifications.slack.events.pr_merged.enabled = false; }
  if (mode === 'since') f.cfg.notifications.slack.since = '2026-11-07T00:00:00Z';
  await f.deliver(); expect(f.send).not.toHaveBeenCalled();
});
it('keeps failed sends retryable, without leaking errors or repeating repository mutations', async () => {
  const f = await fixture(); f.send.mockRejectedValueOnce(new NotificationRejected('xoxb-private'));
  expect(JSON.stringify(await f.deliver())).not.toContain('xoxb-private');
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(3);
  expect(await f.deliver()).toEqual([]); expect(f.send).toHaveBeenCalledTimes(3);
});
it('reports absent connection/channel and only journals confirmed successful sends', async () => {
  const f = await fixture(); f.cfg.notifications.slack.channel = null;
  expect(await f.deliver()).toHaveLength(2); expect(f.send).not.toHaveBeenCalled();
  f.cfg.notifications.slack.channel = channel;
  expect(await deliverNotifications(f.gh, f.cfg, f.gh.state, undefined, 'test', clock)).toHaveLength(2);
});
it('limits per-run attempts and resumes pending events on the next run', async () => {
  const f = await fixture(); f.cfg.notifications.slack.maxPerRun = 1;
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(1);
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(2);
});
it('never sends if the attempt journal cannot be written, and reports only safe HTTP diagnostics', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  f.gh.writeEvent = async () => { throw Object.assign(new Error('private-token'), { status: 403 }); };
  const errors = await f.deliver(); expect(errors[0]).toContain('HTTP 403'); expect(errors[0]).toContain('nothing sent');
  expect(JSON.stringify(errors)).not.toContain('private-token'); expect(f.send).not.toHaveBeenCalled();
});
it('quarantines an ambiguous Slack timeout across runs rather than resending', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  f.send.mockRejectedValueOnce(new Error('private-token'));
  expect((await f.deliver())[0]).toContain('automatic resend blocked');
  expect((await f.deliver())[0]).toContain('previous delivery unconfirmed'); expect(f.send).toHaveBeenCalledTimes(1);
});
it('never resends when Slack succeeds but receipt persistence fails', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  const write = f.gh.writeEvent.bind(f.gh); let fail = true;
  f.gh.writeEvent = async (...args) => { if (fail && args[1].data.type === 'notification_sent') { fail = false; throw new Error('Lost write'); } await write(...args); };
  expect(await f.deliver()).toHaveLength(1); await f.deliver(); await f.deliver();
  expect(f.send).toHaveBeenCalledTimes(1);
});
it('unblocks an ambiguous attempt only after a trusted operator records actual delivery', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  f.send.mockRejectedValueOnce(new Error('Timeout after Slack accepted'));
  await f.deliver();
  const deliveryId = hash({ repository: f.gh.repository.toLowerCase(), event: 'issue_created', number: 2, channel });
  await f.gh.writeEvent(1, { version: 1, key: `notification:${deliveryId}`, at: clock.toISOString(), correlationId: 'recovery',
    data: { type: 'notification_sent', deliveryId, channel, timestamp: '1.23' } });
  expect(await f.deliver()).toEqual([]); expect(f.send).toHaveBeenCalledTimes(1);
});
it('blocks retries if persistence of a definite rejection fails', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  f.send.mockRejectedValueOnce(new NotificationRejected('Rejected'));
  const write = f.gh.writeEvent.bind(f.gh);
  f.gh.writeEvent = async (...args) => { if (args[1].data.type === 'notification_rejected') throw new Error('Failed'); await write(...args); };
  expect((await f.deliver())[0]).toContain('rejection receipt failed');
  expect((await f.deliver())[0]).toContain('previous delivery unconfirmed'); expect(f.send).toHaveBeenCalledTimes(1);
});
it('notification settings preserve existing policy approvals and execution identities', () => {
  const cfg = config(); const before = policyVersion(cfg);
  const { notifications: _notifications, merge: _merge, ...legacy } = cfg; void _notifications; void _merge;
  expect(before).toBe(hash(legacy)); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  expect(policyVersion(cfg)).toBe(before);
});
it('manager creates mandatory provenance before creation and delivers immediately, even without decision audit', async () => {
  const cfg = config(); cfg.reporting.persistDecisions = false; cfg.notifications.slack.enabled = true;
  cfg.notifications.slack.channel = channel; cfg.notifications.slack.events.issue_created.enabled = true;
  const gh = new MemoryGitHub(); gh.state.issues = [issue()]; await finishedAttempt(gh, 1, 'blocked');
  const create = gh.createIssue.bind(gh);
  gh.createIssue = async (...args) => { const result = await create(...args); gh.state.issues.at(-1)!.authorType = 'Bot'; return result; };
  const action = { kind: 'create_followup' as const, issueNumber: 1, taskVersion: taskVersion(gh.state.issues[0]!), status: null,
    priority: null, attempt: null, reason: 'Needed work', followup: { key: 'new-task', title: 'New task', context: 'context', goal: 'goal',
      acceptanceCriteria: ['Observable result'], dependencies: [], expandsScope: false } };
  const planner: Planner = { async plan() { return { version: 1, actions: [action] }; } };
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const run = () => new Manager(gh, cfg, planner, { correlationId: 'test', notifications: { send } }).run();
  expect((await run()).errors).toEqual([]); expect(gh.state.issues).toHaveLength(2); expect(send).toHaveBeenCalledTimes(1);
  await run(); expect(gh.state.issues).toHaveLength(2); expect(send).toHaveBeenCalledTimes(1);
  expect(actionId(action, policyVersion(cfg))).toHaveLength(64);
});

const notice: Notification = { event: 'issue_created', number: 2, title: '<!channel> secret & title', actor: 'SF', url: 'https://github.com/owner/target/issues/2' };
it('uses the fixed authenticated Slack API, disables unfurls/mentions and validates the API receipt', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(url).toBe('https://slack.com/api/chat.postMessage'); expect(init!.headers).toHaveProperty('Authorization', 'Bearer fixture-token');
    expect(init!.redirect).toBe('error'); const body = JSON.parse(String(init!.body));
    expect(body.channel).toBe(channel); expect(body.text).toContain('&lt;!channel&gt;');
    expect(body.blocks[0].text.type).toBe('plain_text'); expect(body.unfurl_links).toBe(false); expect(body.mrkdwn).toBe(false);
    return new Response(JSON.stringify({ ok: true, channel, ts: '1.23' }));
  });
  expect(await new SlackSink('fixture-token', fetcher).send(channel, notice)).toEqual({ channel, timestamp: '1.23' });
});
it.each([429, 500, 'rejected', 'invalid', 'transport'])('does not acknowledge or leak provider errors: %s', async failure => {
  const fetcher = vi.fn<typeof fetch>(async () => {
    if (failure === 'transport') throw new Error('private token');
    return new Response(JSON.stringify(failure === 'invalid' ? { ok: true } : { ok: false, error: 'private token' }), { status: typeof failure === 'number' ? failure : 200 });
  });
  const send = new SlackSink('fixture-token', fetcher).send(channel, notice);
  if (failure === 429 || failure === 'rejected') await expect(send).rejects.toBeInstanceOf(NotificationRejected);
  else await expect(send).rejects.toThrow('Slack delivery failed; check');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('does not make a request without a token', async () => {
  const fetcher = vi.fn<typeof fetch>(); await expect(new SlackSink('', fetcher).send(channel, notice)).rejects.toThrow('token missing');
  expect(fetcher).not.toHaveBeenCalled();
});
it('checks a bot connection without posting or exposing account metadata', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => {
    expect(url).toBe('https://slack.com/api/auth.test');
    return new Response(JSON.stringify({ ok: true, bot_id: 'B12345' }));
  });
  await new SlackSink('fixture-token', fetcher).checkConnection(); expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([{}, { ok: true }, { ok: false, error: 'private token' }])('rejects invalid or user-token connections safely: %j', async response => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
  await expect(new SlackSink('fixture-token', fetcher).checkConnection()).rejects.toThrow('Slack connection failed: check');
});

async function runStartFixture(at = clock.toISOString()) {
  const cfg = config(); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  cfg.notifications.slack.events.run_started = { enabled: true, channel: null };
  const gh = new MemoryGitHub(); gh.state.issues = [{ ...issue(4), title: 'Add the export button' }];
  const receipt = (executionId: string, when = at) => gh.writeEvent(4, { version: 1, key: `temporal-receipt:${executionId}`, at: when, correlationId: 'test',
    data: { type: 'temporal_receipt', executionId, workflowId: `sf-${executionId}`, runId: '00000000-0000-4000-8000-000000000001', binding: 'd'.repeat(64) } });
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const deliver = () => deliverNotifications(gh, cfg, structuredClone(gh.state), { send }, 'test', clock);
  return { cfg, gh, receipt, send, deliver };
}
it('announces each confirmed run start once, naming the repository and the task', async () => {
  const f = await runStartFixture(); await f.receipt(id);
  expect(await f.deliver()).toEqual([]); expect(await f.deliver()).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![1]).toMatchObject({ event: 'run_started', number: 4, title: 'Add the export button',
    repository: f.gh.repository, url: `https://github.com/${f.gh.repository}/issues/4`, executionId: id });
  // A retry or rework of the same task is a new run and is announced again.
  await f.receipt('e'.repeat(32)); await f.deliver(); expect(f.send).toHaveBeenCalledTimes(2);
});
it('says why a run started and when the message comes late', async () => {
  const f = await runStartFixture(); const version = 'f'.repeat(64);
  const input = (executionId: string, taskVersion = version) => ({ contractVersion: '1.0' as const, repository: f.gh.repository, issueNumber: 4, taskVersion,
    description: 'Do it', acceptanceCriteria: ['done'], contextReferences: [], executionId, allowedActions: ['publish_result' as const],
    limits: { timeoutMinutes: 30, maxOutputBytes: 16000 as const }, operation: 'sha256' as const, worker: 'codex' as const });
  const at = (minutesAgo: number) => new Date(clock.getTime() - minutesAgo * 60000).toISOString();
  const intent = (executionId: string, attempt: number, when: string, taskVersion = version) => f.gh.writeEvent(4, { version: 1, key: `intent:${executionId}`, at: when,
    correlationId: 'test', data: { type: 'intent', input: input(executionId, taskVersion), actionId: 'c'.repeat(64), attempt } });
  const result = (executionId: string, when: string, summary: string, error: string | null) => f.gh.writeEvent(4, { version: 1, key: `result:${executionId}`, at: when,
    correlationId: 'test', data: { type: 'result', result: { contractVersion: '1.0', executionId, issueNumber: 4, status: 'failed', summary, artifacts: [], error, proposedActions: [] } } });
  const [a, b, c, d] = ['1', '2', '3', '4'].map(n => n.repeat(32)) as [string, string, string, string];
  await intent(a, 0, at(300)); await f.receipt(a, at(300));
  await result(a, at(290), 'Temporal execution ended without a committed worker result', 'failed');
  await intent(b, 1, at(200)); await f.receipt(b, at(200));
  await result(b, at(190), 'The coding run failed before the agent started', 'EXECUTOR_INFRASTRUCTURE_FAILURE');
  await intent(c, 1, at(100)); await f.receipt(c, at(100));
  await result(c, at(90), 'Agent wrote <!channel> something', 'free text from the worker');
  await intent(d, 0, at(2), 'e'.repeat(64)); await f.receipt(d, at(2));
  await f.deliver();
  expect(f.send.mock.calls.map(call => call[1].detail)).toEqual([
    'Grund: erster Lauf dieser Aufgabe.\nNachmeldung: Der Lauf startete bereits vor 5 Std.',
    'Grund: Versuch 2 von 3, weil der vorige Lauf ohne Ergebnis endete.\nNachmeldung: Der Lauf startete bereits vor 3 Std. 20 Min.',
    'Grund: neuer Start, weil der vorige Lauf vor dem Start des Agenten scheiterte (EXECUTOR_INFRASTRUCTURE_FAILURE) (zählt nicht als Versuch).\nNachmeldung: Der Lauf startete bereits vor 1 Std. 40 Min.',
    'Grund: neuer Lauf für die geänderte Aufgabe, nachdem der vorige Lauf gescheitert ist.'
  ]);
});
it('keeps the delivery of a run start independent of its detail line', async () => {
  const f = await runStartFixture(new Date(clock.getTime() - 3600000).toISOString()); await f.receipt(id);
  const before = await f.deliver(); expect(before).toEqual([]);
  expect(f.send.mock.calls[0]![1].detail).toBe('Nachmeldung: Der Lauf startete bereits vor 1 Std.');
  await f.deliver(); expect(f.send).toHaveBeenCalledTimes(1);
});
it('routes run starts to their own channel', async () => {
  const f = await runStartFixture(); f.cfg.notifications.slack.events.run_started = { enabled: true, channel: 'C987654321' };
  await f.receipt(id); await f.deliver(); expect(f.send.mock.calls[0]![0]).toBe('C987654321');
});
it.each(['absent', 'disabled', 'intent-only', 'untrusted', 'stale', 'since'])('does not announce a run start: %s', async condition => {
  const f = await runStartFixture(condition === 'stale' ? new Date(clock.getTime() - 25 * 3600 * 1000).toISOString() : undefined);
  if (condition === 'absent') delete f.cfg.notifications.slack.events.run_started;
  if (condition === 'disabled') f.cfg.notifications.slack.events.run_started = { enabled: false, channel: null };
  if (condition === 'since') f.cfg.notifications.slack.since = new Date(clock.getTime() + 1000).toISOString();
  if (condition !== 'intent-only') await f.receipt(id);
  if (condition === 'untrusted') for (const c of f.gh.state.comments.get(4)!) c.author = 'attacker';
  await f.deliver(); expect(f.send).not.toHaveBeenCalled();
});
it('leaves configurations without run starts unchanged', () => {
  expect(config().notifications.slack.events).not.toHaveProperty('run_started');
});
it('names the repository in a run start message', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body.blocks[0].text.text).toBe('SF: Factory-Lauf gestartet\nRepository: owner/target\nhttps://github.com/owner/target/issues/4\n#4: Add the export button\nAkteur: Software Factory');
    return new Response(JSON.stringify({ ok: true, channel, ts: '1.23' }));
  });
  await new SlackSink('fixture-token', fetcher).send(channel, { event: 'run_started', number: 4, title: 'Add the export button', actor: 'Software Factory',
    url: 'https://github.com/owner/target/issues/4', repository: 'owner/target', executionId: id });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

async function approvalFixture(head = 'a'.repeat(40)) {
  const cfg = config(); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  cfg.notifications.slack.events.approval_required = { enabled: true, channel: null };
  const gh = new MemoryGitHub();
  gh.state.prs = [{ number: 52, state: 'open', merged: false, closingIssues: [], referencedIssues: [], title: 'Rework billing', headRefName: 'sf/issue-4/x', headSha: 'a'.repeat(40) }];
  const request = (approvalId = key, at = clock.toISOString()) => gh.writeEvent(52, { version: 1, key: `merge-approval-required:${approvalId}`, at, correlationId: 'test',
    data: { type: 'merge_approval_required', prNumber: 52, head, base: 'b'.repeat(40), approvalId, riskClass: 'high', autoMergeUpTo: 'medium' } });
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const deliver = () => deliverNotifications(gh, cfg, structuredClone(gh.state), { send }, 'test', clock);
  return { cfg, gh, request, send, deliver };
}
it('announces a PR waiting for a risk approval once per approval request', async () => {
  const f = await approvalFixture(); await f.request();
  expect(await f.deliver()).toEqual([]); expect(await f.deliver()).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![1]).toMatchObject({ event: 'approval_required', number: 52, title: 'Rework billing', approvalId: key,
    url: `https://github.com/${f.gh.repository}/pull/52`, repository: f.gh.repository });
  expect(f.send.mock.calls[0]![1].detail).toBe(`Risiko high liegt über der Schwelle medium. Freigabe im PR: /harness approve ${key}`);
  // A new assessment asks again and is announced again.
  await f.request(decision); await f.deliver(); expect(f.send).toHaveBeenCalledTimes(2);
});
it.each(['absent', 'disabled', 'closed', 'moved-head', 'untrusted', 'since', 'other-channel'])('handles approval notices: %s', async condition => {
  const f = await approvalFixture(condition === 'moved-head' ? 'c'.repeat(40) : undefined); await f.request();
  if (condition === 'absent') delete f.cfg.notifications.slack.events.approval_required;
  if (condition === 'disabled') f.cfg.notifications.slack.events.approval_required = { enabled: false, channel: null };
  if (condition === 'closed') f.gh.state.prs[0]!.state = 'closed';
  if (condition === 'untrusted') for (const c of f.gh.state.comments.get(52)!) c.author = 'attacker';
  if (condition === 'since') f.cfg.notifications.slack.since = new Date(clock.getTime() + 1000).toISOString();
  if (condition === 'other-channel') f.cfg.notifications.slack.events.approval_required = { enabled: true, channel: 'C987654321' };
  await f.deliver();
  if (condition === 'other-channel') expect(f.send.mock.calls[0]![0]).toBe('C987654321');
  else expect(f.send).not.toHaveBeenCalled();
});
it('announces a Factory pull request handed over to a person once per review, only for its current head', async () => {
  const cfg = config(); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  cfg.notifications.slack.events.handover_required = { enabled: true, channel: null };
  const gh = new MemoryGitHub();
  gh.state.prs = [{ number: 52, state: 'open', merged: false, closingIssues: [], referencedIssues: [], title: 'Rework billing', headRefName: 'sf/issue-4/x', headSha: 'a'.repeat(40) }];
  const handover = (reviewKey: string, head = 'a'.repeat(40), d: 'request_changes' | 'defer' = 'request_changes') => gh.writeEvent(52, { version: 1,
    key: `merge-handover:${reviewKey}`, at: clock.toISOString(), correlationId: 'test',
    data: { type: 'merge_handover', prNumber: 52, head, base: 'b'.repeat(40), reviewKey, decision: d } });
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const deliver = () => deliverNotifications(gh, cfg, structuredClone(gh.state), { send }, 'test', clock);
  await handover(key); await handover('c'.repeat(64), 'c'.repeat(40));
  expect(await deliver()).toEqual([]); await deliver();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![1]).toMatchObject({ event: 'handover_required', number: 52, reviewKey: key, url: `https://github.com/${gh.repository}/pull/52` });
  expect(send.mock.calls[0]![1].detail).toContain('execution.rework');
  await handover('e'.repeat(64), 'a'.repeat(40), 'defer'); await deliver();
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]![1].detail).toContain('defer');
  delete cfg.notifications.slack.events.handover_required; await handover('d'.repeat(64)); await deliver(); expect(send).toHaveBeenCalledTimes(2);
});
it('leaves configurations without approval notices unchanged', () => {
  expect(config().notifications.slack.events).not.toHaveProperty('approval_required');
});
it('renders the approval notice with its detail line', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body.blocks[0].text.text).toBe(`SF: PR wartet auf Freigabe (Risiko über Schwelle)\nRepository: owner/target\nhttps://github.com/owner/target/pull/52\n#52: Rework billing\nRisiko high liegt über der Schwelle medium. Freigabe im PR: /harness approve ${key}\nAkteur: Software Factory`);
    return new Response(JSON.stringify({ ok: true, channel, ts: '1.23' }));
  });
  await new SlackSink('fixture-token', fetcher).send(channel, { event: 'approval_required', number: 52, title: 'Rework billing', actor: 'Software Factory',
    url: 'https://github.com/owner/target/pull/52', repository: 'owner/target', approvalId: key,
    detail: `Risiko high liegt über der Schwelle medium. Freigabe im PR: /harness approve ${key}` });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

async function grantFixture() {
  const cfg = config(); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  cfg.notifications.slack.events.grant_required = { enabled: true, channel: null };
  const gh = new MemoryGitHub(); gh.state.issues = [{ ...issue(7), title: 'Read the newest n8n version' }];
  const send = vi.fn<NotificationSink['send']>(async () => ({ channel, timestamp: '1.23' }));
  const deliver = (waits: { number: number; title: string; after?: string }[]) => deliverNotifications(gh, cfg, structuredClone(gh.state), { send }, 'test', clock, waits);
  return { cfg, gh, send, deliver };
}
it('announces a task waiting only for the grant once per wait (software-factory#127)', async () => {
  const f = await grantFixture(), wait = { number: 7, title: 'Read the newest n8n version' };
  expect(await f.deliver([wait])).toEqual([]); expect(await f.deliver([wait])).toEqual([]);
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]![1]).toMatchObject({ event: 'grant_required', number: 7, title: 'Read the newest n8n version',
    url: `https://github.com/${f.gh.repository}/issues/7`, repository: f.gh.repository,
    detail: 'Bereit zum Start, es fehlt nur die Freigabe: eine berechtigte Person setzt das Label harness:ready.' });
  // A further attempt after a run is a new wait and is announced again, once.
  await f.deliver([{ ...wait, after: id }]); await f.deliver([{ ...wait, after: id }]);
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1]![1].detail).toBe('Ein weiterer Versuch wartet nur noch auf die Freigabe: eine berechtigte Person setzt das Label harness:ready.');
});
it.each(['absent', 'disabled', 'no-wait', 'other-channel'])('handles grant notices: %s', async condition => {
  const f = await grantFixture();
  if (condition === 'absent') delete f.cfg.notifications.slack.events.grant_required;
  if (condition === 'disabled') f.cfg.notifications.slack.events.grant_required = { enabled: false, channel: null };
  if (condition === 'other-channel') f.cfg.notifications.slack.events.grant_required = { enabled: true, channel: 'C987654321' };
  await f.deliver(condition === 'no-wait' ? [] : [{ number: 7, title: 'Read the newest n8n version' }]);
  if (condition === 'other-channel') expect(f.send.mock.calls[0]![0]).toBe('C987654321');
  else expect(f.send).not.toHaveBeenCalled();
});
it('leaves configurations without grant notices unchanged', () => {
  expect(config().notifications.slack.events).not.toHaveProperty('grant_required');
});
it('renders the grant notice with its detail line', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body.blocks[0].text.text).toBe('SF: Issue wartet auf Freigabe (harness:ready)\nRepository: owner/target\nhttps://github.com/owner/target/issues/7\n#7: Read the newest n8n version\nBereit zum Start, es fehlt nur die Freigabe: eine berechtigte Person setzt das Label harness:ready.\nAkteur: Software Factory');
    return new Response(JSON.stringify({ ok: true, channel, ts: '1.23' }));
  });
  await new SlackSink('fixture-token', fetcher).send(channel, { event: 'grant_required', number: 7, title: 'Read the newest n8n version', actor: 'Software Factory',
    url: 'https://github.com/owner/target/issues/7', repository: 'owner/target',
    detail: 'Bereit zum Start, es fehlt nur die Freigabe: eine berechtigte Person setzt das Label harness:ready.' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
