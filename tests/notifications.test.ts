import { expect, it, vi } from 'vitest';
import { config, issue, MemoryGitHub, clock } from './helpers.js';
import { deliverNotifications, SlackSink, type Notification, type NotificationSink } from '../src/notifications/slack.js';
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
  const f = await fixture(); f.send.mockRejectedValueOnce(new Error('xoxb-private'));
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
it('documents at-least-once behavior when Slack succeeds but receipt persistence fails', async () => {
  const f = await fixture(); f.cfg.notifications.slack.events.pr_merged.enabled = false;
  const write = f.gh.writeEvent.bind(f.gh); let fail = true;
  f.gh.writeEvent = async (...args) => { if (fail) { fail = false; throw new Error('Lost write'); } await write(...args); };
  expect(await f.deliver()).toHaveLength(1); await f.deliver(); await f.deliver();
  expect(f.send).toHaveBeenCalledTimes(2);
});
it('notification settings preserve existing policy approvals and execution identities', () => {
  const cfg = config(); const before = policyVersion(cfg);
  const { notifications: _notifications, ...legacy } = cfg; void _notifications;
  expect(before).toBe(hash(legacy)); cfg.notifications.slack.enabled = true; cfg.notifications.slack.channel = channel;
  expect(policyVersion(cfg)).toBe(before);
});
it('manager creates mandatory provenance before creation and delivers immediately, even without decision audit', async () => {
  const cfg = config(); cfg.reporting.persistDecisions = false; cfg.notifications.slack.enabled = true;
  cfg.notifications.slack.channel = channel; cfg.notifications.slack.events.issue_created.enabled = true;
  const gh = new MemoryGitHub(); gh.state.issues = [issue()];
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
  await expect(new SlackSink('fixture-token', fetcher).send(channel, notice)).rejects.toThrow('Slack delivery failed; check');
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
