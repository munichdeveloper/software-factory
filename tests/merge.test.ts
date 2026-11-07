import { expect, it, vi } from 'vitest';
import { config, clock, MemoryGitHub, issue } from './helpers.js';
import { MergeManager, mergeGate } from '../src/merge/manager.js';
import type { MergeFacts, MergePort, MergeReview, ReviewInput } from '../src/merge/contract.js';
import { decodeEvent, encodeEvent } from '../src/state/events.js';
import { OpenAIMergeReviewer } from '../src/merge/reviewer.js';
import { deliverNotifications } from '../src/notifications/slack.js';

function fixture(decision: MergeReview['decision'] = 'merge') {
  const cfg = config(); cfg.merge.enabled = true; cfg.autonomy.overrides.merge_pr = 'allow'; cfg.llm.provider = 'openai';
  const f: MergeFacts = { number: 52, title: 'Feature', body: '', head: 'a'.repeat(40), base: 'b'.repeat(40), headBranch: 'feature', baseBranch: 'main',
    state: 'open', draft: false, sameRepository: true, labels: ['sf:automerge'], mergeState: 'CLEAN', reviewDecision: null,
    unresolvedThreads: [], checks: ['test-backend', 'test-frontend', 'test-docker'].map(name => ({ name, state: 'success' })),
    strictChecks: true, nativeRequiredChecks: ['test-backend'], comments: [], mergeSha: null, mergeActorType: null };
  const snapshot = new MemoryGitHub().state;
  const review: MergeReview = { decision, reason: 'Code und Tests geprüft.', findings: [] };
  const reviewer = { review: vi.fn(async (_input: ReviewInput) => { void _input; return structuredClone(review); }) };
  const api: MergePort = { repository: 'owner/target',
    candidates: vi.fn(async () => [52]), facts: vi.fn(async () => structuredClone(f)),
    context: vi.fn(async facts => ({ facts, trustedScope: 'Community', trustedInstructions: 'Keep API compatible', changes: [
      { path: 'file.txt', status: 'modified', patch: '-old\n+new', content: 'new' }] })),
    comment: vi.fn(async (_number, body) => { f.comments.push({ id: f.comments.length + 1, body, author: 'github-actions[bot]', createdAt: clock.toISOString() }); }),
    update: vi.fn(async () => { f.head = 'c'.repeat(40); f.mergeState = 'CLEAN'; f.checks = []; return f.head; }),
    merge: vi.fn(async () => { f.state = 'closed'; f.mergeSha = 'd'.repeat(40); f.mergeActorType = 'Bot'; return f.mergeSha; }),
    dispatch: vi.fn(async () => {}), canApprove: vi.fn(async login => login === 'maintainer') };
  const run = () => new MergeManager(api, cfg, reviewer, 'test').run(structuredClone(snapshot));
  return { cfg, f, api, reviewer, review, snapshot, run };
}
it('requires a real AI verdict, rechecks facts, persists intent before merging exactly the reviewed head, and recovers idempotently', async () => {
  const x = fixture(); x.cfg.merge.postMergeWorkflows = ['publish.yml'];
  expect((await x.run()).merged).toBe(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'a'.repeat(40), 'squash');
  const events = x.f.comments.map(c => decodeEvent(c, x.cfg.manager.trustedActors)!);
  expect(events.findIndex(e => e.data.type === 'merge_intent')).toBeLessThan(events.findIndex(e => e.data.type === 'merge_completed'));
  await x.run(); expect(x.api.merge).toHaveBeenCalledTimes(1); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
  expect(x.api.dispatch).toHaveBeenCalledTimes(1); expect(x.api.dispatch).toHaveBeenCalledWith('publish.yml', 'main');
});
it.each(['request_changes', 'defer'] as const)('publishes the AI reason and never merges on %s, even with green CI', async decision => {
  const x = fixture(decision); x.review.reason = 'Konkreter fachlicher oder technischer Einwand.';
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.f.comments.some(c => c.body.includes(x.review.reason))).toBe(true);
  await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
});
it('blocking findings cannot be overridden by an inconsistent positive model decision', async () => {
  const x = fixture(); x.review.findings = [{ path: 'security.ts', severity: 'blocking', explanation: 'Authorization missing' }];
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled();
});
it('cached negative decisions do not consume the next run review budget or starve another enrolled PR', async () => {
  const x = fixture('defer'); x.cfg.merge.maxReviewsPerRun = 1; await x.run();
  vi.mocked(x.api.candidates).mockResolvedValue([52, 53]);
  vi.mocked(x.api.facts).mockImplementation(async n => ({ ...structuredClone(x.f), number: n, comments: n === 52 ? structuredClone(x.f.comments) : [] }));
  const report = await x.run(); expect(report.reviewed).toBe(1); expect(x.reviewer.review).toHaveBeenCalledTimes(2);
  expect(x.reviewer.review.mock.calls[1]![0].facts.number).toBe(53);
});
it.each(['head', 'base', 'enrollment', 'draft', 'description'])('discards approval when %s changes during model review', async change => {
  const x = fixture(); x.reviewer.review.mockImplementation(async () => {
    if (change === 'head') x.f.head = 'e'.repeat(40); if (change === 'base') x.f.base = 'e'.repeat(40);
    if (change === 'enrollment') x.f.labels = []; if (change === 'draft') x.f.draft = true;
    if (change === 'description') x.f.body = 'Changed requirements';
    return x.review;
  });
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.f.comments.some(c => c.body.includes('erneute Prüfung'))).toBe(true);
});
it.each(['closed', 'blocked', 'changed'])('revalidates the source task after AI review: %s', async change => {
  const x = fixture(); const task = issue(44); const execution = 'f'.repeat(32);
  x.snapshot.issues = [task]; x.f.headBranch = `sf/issue-44/${execution}`; x.f.labels = [];
  x.snapshot.comments.set(44, [{ id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(),
    body: encodeEvent({ version: 1, key: 'result', at: clock.toISOString(), correlationId: 'test', data: { type: 'result', result: {
      contractVersion: '1.0', executionId: execution, issueNumber: 44, status: 'success', summary: 'Created PR',
      artifacts: ['https://github.com/owner/target/pull/52'], error: null, proposedActions: [] } } }) }]);
  const tasks = { getIssue: vi.fn(async () => ({ ...task, state: change === 'closed' ? 'closed' as const : 'open' as const,
    labels: change === 'blocked' ? [...task.labels, 'harness:blocked'] : task.labels, body: change === 'changed' ? task.body + 'New requirement' : task.body })) };
  await new MergeManager(x.api, x.cfg, x.reviewer, 'test', tasks).run(x.snapshot);
  expect(x.reviewer.review).toHaveBeenCalledTimes(1); expect(x.api.merge).not.toHaveBeenCalled();
  expect(x.reviewer.review.mock.calls[0]![0].sourceTask?.number).toBe(44);
  expect(x.f.comments.some(c => c.body.includes('Aufgabe wurde während'))).toBe(true);
});
it.each(['disabled', 'advisory', 'dry-run', 'deny'])('never reviews or mutates in %s mode', async mode => {
  const x = fixture(); if (mode === 'disabled') x.cfg.merge.enabled = false;
  if (mode === 'advisory') x.cfg.autonomy.profile = 'advisory'; if (mode === 'dry-run') x.cfg.execution.dryRun = true;
  if (mode === 'deny') x.cfg.autonomy.overrides.merge_pr = 'deny';
  await x.run(); expect(x.api.comment).not.toHaveBeenCalled(); expect(x.reviewer.review).not.toHaveBeenCalled();
});
it.each(['unrelated', 'fork', 'blocked', 'draft'])('does not adopt or run AI on %s PRs', async mode => {
  const x = fixture(); if (mode === 'unrelated') x.f.labels = []; if (mode === 'fork') x.f.sameRepository = false;
  if (mode === 'blocked') x.f.labels.push('sf:blocked'); if (mode === 'draft') x.f.draft = true;
  await x.run(); expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
});
it.each(['BEHIND', 'BLOCKED', 'UNKNOWN', 'DIRTY', 'pending', 'failure', 'missing', 'threads', 'changes_requested', 'rules'])('hard gates survive a positive AI verdict: %s', async gate => {
  const x = fixture();
  if (['BEHIND', 'BLOCKED', 'UNKNOWN', 'DIRTY'].includes(gate)) x.f.mergeState = gate;
  if (gate === 'pending' || gate === 'failure') x.f.checks[0]!.state = gate;
  if (gate === 'missing') x.f.checks = []; if (gate === 'threads') x.f.unresolvedThreads = ['Unresolved concern'];
  if (gate === 'changes_requested') x.f.reviewDecision = 'CHANGES_REQUESTED'; if (gate === 'rules') x.f.strictChecks = false;
  expect(mergeGate(x.f, x.cfg)).toBeTruthy(); await x.run(); expect(x.api.merge).not.toHaveBeenCalled();
});
it('requires exact current human approval in supervised mode and accepts only authorized approvers', async () => {
  const x = fixture(); x.cfg.autonomy.overrides.merge_pr = 'approval';
  await x.run(); const body = x.f.comments.find(c => c.body.includes('/harness approve'))!.body;
  const approval = body.match(/\/harness approve ([a-f0-9]{64})/)![0];
  x.f.comments.push({ id: 99, author: 'attacker', body: approval, createdAt: clock.toISOString() });
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled();
  x.f.comments.push({ id: 100, author: 'maintainer', body: approval, createdAt: clock.toISOString() });
  await x.run(); expect(x.api.merge).toHaveBeenCalledTimes(1);
});
it('lets AI request a safe update, dispatches CI for the new head, and requires a new review before merging', async () => {
  const x = fixture('update_branch'); x.f.mergeState = 'BEHIND';
  expect((await x.run()).updated).toBe(1); expect(x.api.update).toHaveBeenCalledWith(52, 'a'.repeat(40));
  expect(x.api.dispatch).toHaveBeenCalledWith('test.yml', 'feature'); expect(x.api.merge).not.toHaveBeenCalled();
  x.f.checks = x.cfg.merge.requiredChecks.map(name => ({ name, state: 'success' })); x.review.decision = 'merge';
  await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(2); expect(x.api.merge).toHaveBeenCalledWith(52, 'c'.repeat(40), 'squash');
});
it('fails closed when context is incomplete or the review provider is unavailable', async () => {
  for (const stage of ['context', 'review'] as const) {
    const x = fixture(); if (stage === 'context') vi.mocked(x.api.context).mockRejectedValue(new Error('Too large'));
    else x.reviewer.review.mockRejectedValue(new Error('private secret'));
    expect((await x.run()).errors).toHaveLength(1); expect(x.api.merge).not.toHaveBeenCalled();
    expect(x.f.comments.some(c => c.body.includes('private secret'))).toBe(false);
  }
});
it('publishes Slack merge notification for an adopted PR only with a matching trusted intent and native bot merge', async () => {
  const x = fixture(); await x.run();
  const gh = new MemoryGitHub(); gh.state.comments.set(52, x.f.comments);
  gh.state.prs.push({ number: 52, state: 'closed', merged: true, mergedAt: clock.toISOString(), headSha: x.f.head,
    title: 'Adopted', closingIssues: [], referencedIssues: [], mergedBy: { login: 'github-actions[bot]', type: 'Bot' } });
  x.cfg.notifications.slack.enabled = true; x.cfg.notifications.slack.channel = 'C0CGJKK3EKS'; x.cfg.notifications.slack.events.pr_merged.enabled = true;
  const send = vi.fn(async () => ({ channel: 'C0CGJKK3EKS', timestamp: '1.2' }));
  await deliverNotifications(gh, x.cfg, gh.state, { send }, 'test', clock);
  await deliverNotifications(gh, x.cfg, gh.state, { send }, 'test', clock); expect(send).toHaveBeenCalledTimes(1);
});
it('uses real structured Responses review with no tools, keeps untrusted code in data, rejects incomplete output and mock merge approval', async () => {
  const x = fixture(); const input: ReviewInput = await x.api.context(x.f, 60, 250000);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)); expect(body.tools).toBeUndefined(); expect(body.store).toBe(false);
    expect(body.text.format.strict).toBe(true); expect(body.instructions).toContain('not just green CI');
    expect(JSON.parse(body.input).untrustedChanges[0].path).toBe('file.txt');
    return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(x.review) }] }] }));
  });
  expect(await new OpenAIMergeReviewer('fixture', x.cfg, fetcher).review(input)).toEqual(x.review);
  x.cfg.llm.provider = 'mock'; await expect(new OpenAIMergeReviewer('fixture', x.cfg, fetcher).review(input)).rejects.toThrow('real OpenAI');
  x.cfg.llm.provider = 'openai'; fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete' })));
  await expect(new OpenAIMergeReviewer('fixture', x.cfg, fetcher).review(input)).rejects.toThrow('incomplete');
});
it('decodes durable journals with a readable explanation after the JSON fence', () => {
  const event = { version: 1 as const, key: 'review', at: clock.toISOString(), correlationId: 'test',
    data: { type: 'merge_status' as const, head: 'a'.repeat(40), base: 'b'.repeat(40), reason: 'Needs work' } };
  expect(decodeEvent({ id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: encodeEvent(event) + '\n\nReadable explanation' }, ['github-actions[bot]'])).toEqual(event);
});
