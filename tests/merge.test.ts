import { expect, it, vi } from 'vitest';
import { config, clock, MemoryGitHub, issue } from './helpers.js';
import { MergeManager, mergeGate } from '../src/merge/manager.js';
import type { MergeFacts, MergePort, MergeReview, ReviewInput } from '../src/merge/contract.js';
import { decodeEvent, encodeEvent } from '../src/state/events.js';
import { taskVersion } from '../src/state/identity.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { OpenAIMergeReviewer } from '../src/merge/reviewer.js';
import { deliverNotifications } from '../src/notifications/slack.js';
import { ModelRouter, routedCall, Routing } from '../src/llm/router.js';

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
    dispatch: vi.fn(async () => {}), workflowAvailable: vi.fn(async () => true), canApprove: vi.fn(async login => login === 'maintainer') };
  const run = () => new MergeManager(api, cfg, reviewer, 'test').run(structuredClone(snapshot));
  return { cfg, f, api, reviewer, review, snapshot, run };
}
it.each(['merge', 'defer'] as const)('explains native workflow approval and never auto-approves or merges despite green dispatch CI and verdict %s', async decision => {
  const x = fixture(decision); x.f.mergeState = 'BLOCKED';
  x.f.checks.push({ name: 'Workflow-Freigabe erforderlich: Test', state: 'action_required' });
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.api.update).not.toHaveBeenCalled();
  expect(x.api.dispatch).not.toHaveBeenCalled();
  expect(x.f.comments.at(-1)!.body).toContain('Approve workflows to run');
  expect(x.f.comments.at(-1)!.body).toContain('workflow_dispatch');
});
it('requires a real AI verdict, rechecks facts, persists intent before merging exactly the reviewed head, and recovers idempotently', async () => {
  const x = fixture(); x.cfg.merge.postMergeWorkflows = ['publish.yml'];
  expect((await x.run()).merged).toBe(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'a'.repeat(40), 'squash');
  const events = x.f.comments.map(c => decodeEvent(c, x.cfg.manager.trustedActors)!);
  expect(events.findIndex(e => e.data.type === 'merge_intent')).toBeLessThan(events.findIndex(e => e.data.type === 'merge_completed'));
  await x.run(); expect(x.api.merge).toHaveBeenCalledTimes(1); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
  expect(x.api.dispatch).toHaveBeenCalledTimes(1); expect(x.api.dispatch).toHaveBeenCalledWith('publish.yml', 'main');
});
it('defers optional publication hooks until their workflow is installed, then recovers them without another merge', async () => {
  const x = fixture(); x.cfg.merge.postMergeWorkflows = ['publish.yml']; vi.mocked(x.api.workflowAvailable).mockResolvedValue(false);
  expect((await x.run()).merged).toBe(1); expect(x.api.dispatch).not.toHaveBeenCalled();
  vi.mocked(x.api.workflowAvailable).mockResolvedValue(true); await x.run(); expect(x.api.dispatch).toHaveBeenCalledTimes(1);
  expect(x.api.merge).toHaveBeenCalledTimes(1);
});
it('does not falsely report an unmerged PR when only a post-merge workflow failed', async () => {
  const x = fixture(); x.cfg.merge.postMergeWorkflows = ['publish.yml']; vi.mocked(x.api.dispatch).mockRejectedValue(new Error('Unavailable'));
  const report = await x.run(); expect(report.merged).toBe(1); expect(report.errors).toHaveLength(1);
  expect(x.f.comments.at(-1)!.body).toContain('Merge bestätigt – Nacharbeit offen');
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
it.each(['closed', 'blocked', 'changed', 'edited by a stranger'])('revalidates the source task after AI review: %s', async change => {
  const x = fixture(); const task = issue(44); const execution = 'f'.repeat(32);
  x.snapshot.issues = [task]; x.f.headBranch = `sf/issue-44/${execution}`; x.f.labels = [];
  x.snapshot.comments.set(44, [{ id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(),
    body: encodeEvent({ version: 1, key: 'result', at: clock.toISOString(), correlationId: 'test', data: { type: 'result', result: {
      contractVersion: '1.0', executionId: execution, issueNumber: 44, status: 'success', summary: 'Created PR',
      artifacts: ['https://github.com/owner/target/pull/52'], error: null, proposedActions: [] } } }) }]);
  const tasks = { getIssue: vi.fn(async () => ({ ...task, state: change === 'closed' ? 'closed' as const : 'open' as const,
    labels: change === 'blocked' ? [...task.labels, 'harness:blocked'] : task.labels, body: change === 'changed' ? task.body + 'New requirement' : task.body,
    contentEdits: change === 'edited by a stranger' ? [{ actor: 'stranger', at: clock.toISOString(), trusted: false }] : [] })) };
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
it('updates a branch behind its base before any review, dispatches CI for the new head, and reviews only the new head', async () => {
  const x = fixture(); x.f.mergeState = 'BEHIND';
  expect((await x.run()).updated).toBe(1); expect(x.api.update).toHaveBeenCalledWith(52, 'a'.repeat(40));
  expect(x.reviewer.review).not.toHaveBeenCalled();
  expect(x.api.dispatch).toHaveBeenCalledWith('test.yml', 'feature'); expect(x.api.merge).not.toHaveBeenCalled();
  x.f.checks = x.cfg.merge.requiredChecks.map(name => ({ name, state: 'success' }));
  await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'c'.repeat(40), 'squash');
});
it('leaves a stale branch alone when merge.updateBranch is off', async () => {
  const x = fixture(); x.f.mergeState = 'BEHIND'; x.cfg.merge.updateBranch = false;
  await x.run(); expect(x.api.update).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
});
it.each(['DIRTY', 'update'] as const)('hands an adopted pull request with a merge conflict (%s) over to a person, without review and without waiting for checks', async how => {
  const x = fixture(); const needsHuman = vi.fn(async () => {}); Object.assign(x.api, { needsHuman });
  if (how === 'DIRTY') { x.f.mergeState = 'DIRTY'; x.f.checks = []; }
  else { x.f.mergeState = 'BEHIND'; vi.mocked(x.api.update).mockRejectedValue(new Error('MERGE_CONFLICT')); }
  const report = await x.run(); expect(report.errors).toEqual([]);
  expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
  const handovers = x.f.comments.map(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data).filter(d => d?.type === 'merge_handover');
  expect(handovers).toEqual([expect.objectContaining({ decision: 'conflict', head: 'a'.repeat(40) })]);
  expect(needsHuman).toHaveBeenCalledWith(52, true);
  expect(x.f.comments.at(-1)!.body).toContain('Merge-Konflikte');
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
  // An explicit OpenAI reviewer with deterministic planning; still never without a key.
  x.cfg.merge.review.provider = 'openai'; expect(await new OpenAIMergeReviewer('fixture', x.cfg, fetcher).review(input)).toEqual(x.review);
  await expect(new OpenAIMergeReviewer('', x.cfg, fetcher).review(input)).rejects.toThrow('real OpenAI');
  x.cfg.llm.provider = 'openai'; fetcher.mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete' })));
  await expect(new OpenAIMergeReviewer('fixture', x.cfg, fetcher).review(input)).rejects.toThrow('incomplete');
});
it('decodes durable journals with a readable explanation after the JSON fence', () => {
  const event = { version: 1 as const, key: 'review', at: clock.toISOString(), correlationId: 'test',
    data: { type: 'merge_status' as const, head: 'a'.repeat(40), base: 'b'.repeat(40), reason: 'Needs work' } };
  expect(decodeEvent({ id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: encodeEvent(event) + '\n\nReadable explanation' }, ['github-actions[bot]'])).toEqual(event);
});

/** A pull request the Temporal broker published for task #7, as its journal and publication record show it. */
function temporal(status: 'success' | 'blocked' = 'success') {
  const x = fixture(); const exec = 'e'.repeat(32), url = 'https://github.com/owner/target/pull/52';
  x.f.labels = []; x.f.draft = true; x.f.headBranch = `sf/issue-7/${exec}`;
  x.cfg.merge.protection = 'factory'; x.f.strictChecks = false; x.f.nativeRequiredChecks = []; x.f.behindBy = 0;
  x.snapshot.issues.push(issue(7));
  x.snapshot.comments.set(7, [
    { id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: encodeEvent({ version: 1, key: `result:${exec}`, at: clock.toISOString(), correlationId: 'c',
      data: { type: 'result', result: { contractVersion: '1.0', executionId: exec, issueNumber: 7, status, summary: 'Done', error: null, artifacts: [url], proposedActions: [] } } }) },
    { id: 2, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: `Draft PR: ${url}\nHead: ${x.f.head}\n<!-- sf-publication -->` }]);
  const ready = vi.fn(async () => { x.f.draft = false; }), rerunFailed = vi.fn(async () => 0);
  Object.assign(x.api, { ready, rerunFailed });
  const owned = () => new MergeManager(x.api, x.cfg, x.reviewer, 'test', undefined, { ownedOnly: true }).run(structuredClone(x.snapshot));
  return { ...x, ready, rerunFailed, owned };
}
it('marks a validated Temporal draft ready, then reviews and merges exactly the published head without branch rules', async () => {
  const x = temporal();
  expect((await x.owned()).merged).toBe(0); expect(x.ready).toHaveBeenCalledWith(52, 'a'.repeat(40)); expect(x.reviewer.review).not.toHaveBeenCalled();
  expect((await x.owned()).merged).toBe(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'a'.repeat(40), 'squash');
});
it('never marks ready or merges a draft that was published with a blocked status', async () => {
  const x = temporal('blocked'); await x.owned(); x.f.draft = false; await x.owned();
  expect(x.ready).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.reviewer.review).not.toHaveBeenCalled();
  expect(x.f.comments.at(-1)!.body).toContain('Status blocked');
});
it('validates and reviews a blocked run again once people with write access repaired its branch (issue #188 step 6)', async () => {
  const x = temporal('blocked'); x.f.head = 'f'.repeat(40);
  const pushedSince = vi.fn(async () => ['maintainer']); Object.assign(x.api, { pushedSince });
  expect((await x.owned()).merged).toBe(0); expect(x.ready).toHaveBeenCalledWith(52, 'f'.repeat(40));
  expect(x.api.dispatch).toHaveBeenCalledWith('test.yml', x.f.headBranch);
  x.f.draft = false;
  expect((await x.owned()).merged).toBe(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'f'.repeat(40), 'squash');
  expect(x.reviewer.review.mock.calls[0]![0].validationNote).toContain(`blocked by its independent validation at commit ${'a'.repeat(40)}`);
  const y = temporal('blocked'); y.f.head = 'f'.repeat(40); Object.assign(y.api, { pushedSince: vi.fn(async () => ['stranger']) });
  await y.owned(); y.f.draft = false; await y.owned();
  expect(y.api.merge).not.toHaveBeenCalled(); expect(y.reviewer.review).not.toHaveBeenCalled();
});
it('does not merge a Factory pull request whose head was changed by someone else', async () => {
  const x = temporal(); x.f.draft = false; x.f.head = 'f'.repeat(40);
  await x.owned(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.f.comments.at(-1)!.body).toContain('fremden Änderungen');
});
it('adopts commits a person with write access pushed onto a Factory pull request after review findings (controla#124)', async () => {
  const x = temporal(); x.f.draft = false; x.f.head = 'f'.repeat(40);
  const pushedSince = vi.fn(async () => ['maintainer', 'maintainer']); Object.assign(x.api, { pushedSince });
  expect((await x.owned()).merged).toBe(1);
  expect(pushedSince).toHaveBeenCalledWith('a'.repeat(40), 'f'.repeat(40));
  expect(x.api.dispatch).toHaveBeenCalledWith('test.yml', x.f.headBranch);
  expect(x.reviewer.review).toHaveBeenCalledTimes(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'f'.repeat(40), 'squash');
  expect(x.f.comments.some(c => c.body.includes('Nachträgliche Commits von maintainer (Schreibrecht im Repository) werden übernommen'))).toBe(true);
});
it.each([
  ['an account without write access', ['maintainer', 'stranger'], 'ohne Schreibrecht im Repository: stranger'],
  ['a commit without any GitHub account', [''], 'ohne Schreibrecht im Repository: unbekannt'],
  ['rewritten history', null, 'umgeschriebene Historie']
] as const)('refuses later commits from %s', async (_case, authors, reason) => {
  const x = temporal(); x.f.draft = false; x.f.head = 'f'.repeat(40);
  Object.assign(x.api, { pushedSince: vi.fn(async () => authors && [...authors]) });
  await x.owned(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.reviewer.review).not.toHaveBeenCalled();
  expect(x.f.comments.at(-1)!.body).toContain('fremden Änderungen'); expect(x.f.comments.at(-1)!.body).toContain(reason);
});
it.each([
  ['request_changes without rework', 'request_changes', false, true],
  ['request_changes with rework', 'request_changes', true, false],
  ['defer, even with rework', 'defer', true, true]
] as const)('hands a Factory pull request over to a person on %s', async (_case, decision, rework, handOver) => {
  const x = temporal(); x.f.draft = false; x.review.decision = decision; x.cfg.execution.rework = rework;
  const needsHuman = vi.fn(async (_n: number, on: boolean) => { x.f.labels = on ? [...x.f.labels, 'sf:needs-human'] : x.f.labels.filter(l => l !== 'sf:needs-human'); });
  Object.assign(x.api, { needsHuman });
  await x.owned(); expect(x.api.merge).not.toHaveBeenCalled();
  const handovers = x.f.comments.map(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data).filter(d => d?.type === 'merge_handover');
  expect(handovers).toHaveLength(handOver ? 1 : 0);
  if (handOver) expect(handovers[0]).toMatchObject({ prNumber: 52, head: 'a'.repeat(40), decision });
  expect(needsHuman.mock.calls).toEqual(handOver ? [[52, true]] : []);
  // The label is display only: it does not invalidate the cached review, and a later approving review removes it.
  await x.owned(); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
  if (handOver) {
    x.f.head = 'f'.repeat(40); Object.assign(x.api, { pushedSince: vi.fn(async () => ['maintainer']) }); x.review.decision = 'merge';
    expect((await x.owned()).merged).toBe(1); expect(needsHuman).toHaveBeenLastCalledWith(52, false);
  }
});
it('with Factory protection requires the head to contain the current base and updates a stale branch through a new review', async () => {
  const x = temporal(); x.f.draft = false; x.f.behindBy = 2; x.review.decision = 'update_branch';
  await x.owned(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.api.update).toHaveBeenCalledWith(52, 'a'.repeat(40));
  // The updated head is accepted as the Factory's own base update; it needs green checks and a new review.
  x.f.behindBy = 0; x.f.checks = x.cfg.merge.requiredChecks.map(name => ({ name, state: 'success' })); x.review.decision = 'merge';
  expect((await x.owned()).merged).toBe(1); expect(x.api.merge).toHaveBeenCalledWith(52, 'c'.repeat(40), 'squash');
  expect(mergeGate({ ...x.f, state: 'open', behindBy: null }, x.cfg)).toContain('unbekannt');
  expect(mergeGate({ ...x.f, state: 'open', behindBy: 0 }, config())).toContain('Serverseitige PR-Regeln');
});
it('sends a conflicting Factory pull request back to the coding worker as a conflict rework (execution.rework)', async () => {
  const x = temporal(); x.f.draft = false; x.f.mergeState = 'DIRTY'; x.f.checks = []; x.cfg.execution.rework = true;
  const task = x.snapshot.issues.find(i => i.number === 7)!, exec = 'e'.repeat(32);
  x.snapshot.comments.get(7)!.unshift({ id: 0, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: encodeEvent({ version: 1, key: `intent:${exec}`,
    at: clock.toISOString(), correlationId: 'c', data: { type: 'intent', actionId: 'a'.repeat(64), attempt: 0, input: { contractVersion: '1.0', repository: 'owner/target',
      issueNumber: 7, taskVersion: taskVersion(task), description: task.body, acceptanceCriteria: ['Done'], contextReferences: [], executionId: exec,
      allowedActions: ['publish_result'], limits: { timeoutMinutes: 30, maxOutputBytes: 16000 }, operation: 'sha256', worker: 'test' } } }) });
  const tasks: { number: number; body: string }[] = [];
  vi.mocked(x.api.comment).mockImplementation(async (number, body) => {
    if (number === 7) tasks.push({ number, body }); else x.f.comments.push({ id: x.f.comments.length + 1, body, author: 'github-actions[bot]', createdAt: clock.toISOString() });
  });
  await x.owned(); expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
  const journaled = tasks.map(t => decodeEvent({ id: 1, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: t.body }, x.cfg.manager.trustedActors)?.data);
  expect(journaled).toEqual([expect.objectContaining({ type: 'merge_changes_requested', cause: 'conflict', prNumber: 52, executionId: 'e'.repeat(32) })]);
  expect(tasks[0]!.body).toContain('Merge-Konflikt');
  expect(x.f.comments.some(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data.type === 'merge_handover')).toBe(false);
  // Once per head: the next pass journals nothing new on the task.
  x.snapshot.comments.get(7)!.push({ id: 9, author: 'github-actions[bot]', createdAt: clock.toISOString(), body: tasks[0]!.body });
  await x.owned(); expect(tasks).toHaveLength(1);
  x.snapshot.prs.push({ number: 52, state: 'open', merged: false, closingIssues: [7], referencedIssues: [], headRefName: `sf/issue-7/${exec}`, headSha: x.f.head });
  const state = reconstruct(x.snapshot, x.cfg).find(t => t.issue.number === 7)!;
  expect(state).toMatchObject({ reworkable: true, reworkCause: 'conflict' }); expect(state.reworkReview!.reason).toContain('Konfliktmarker');
});
it('hands a conflicting Factory pull request over to a person without execution.rework', async () => {
  const x = temporal(); x.f.draft = false; x.f.mergeState = 'DIRTY'; x.cfg.execution.rework = false;
  await x.owned();
  expect(x.f.comments.some(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data.type === 'merge_handover')).toBe(true);
  expect(x.f.comments.at(-1)!.body).toContain('execution.rework');
});
it('re-runs a failed required check once before review, and lets the failure stand after that', async () => {
  const x = temporal(); x.f.draft = false; x.f.checks[0]!.state = 'failure';
  x.rerunFailed.mockResolvedValueOnce(1);
  await x.owned(); expect(x.rerunFailed).toHaveBeenCalledWith(52, 'a'.repeat(40), x.cfg.merge.requiredChecks);
  expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.f.comments.at(-1)!.body).toContain('einmal wiederholt');
  await x.owned(); expect(x.api.merge).not.toHaveBeenCalled(); expect(x.f.comments.at(-1)!.body).toContain('test-backend');
});
it('an issue-scoped broker adopts no pull request by label', async () => {
  const x = temporal(); x.snapshot.comments.set(7, []); x.f.labels = ['sf:automerge']; x.f.draft = false;
  await x.owned(); expect(x.api.facts).toHaveBeenCalled(); expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
});
it('dispatches no validation workflow after a branch update where the pull request checks run on every push', async () => {
  const x = fixture('update_branch'); x.f.mergeState = 'BEHIND'; x.cfg.merge.validationWorkflow = null;
  expect((await x.run()).updated).toBe(1); expect(x.api.dispatch).not.toHaveBeenCalled();
  x.f.checks = x.cfg.merge.requiredChecks.map(name => ({ name, state: 'success' })); x.review.decision = 'merge';
  await x.run(); expect(x.api.dispatch).not.toHaveBeenCalled(); expect(x.api.merge).toHaveBeenCalledWith(52, 'c'.repeat(40), 'squash');
});
it('names a missing review key on the pull request instead of an unexplained failure', async () => {
  const x = fixture(); x.reviewer.review.mockRejectedValue(new Error('A real OpenAI merge reviewer is required'));
  await x.run(); expect(x.api.merge).not.toHaveBeenCalled();
  expect(x.f.comments.at(-1)!.body).toContain('OPENAI_API_KEY');
});
it('names the model the router picked in the review comment, without journaling it', async () => {
  const x = fixture();
  const routing = new Routing(new ModelRouter('key', async () => Response.json({ answers: { route: { choice: 'opus-high', confidence: 0.75 } } })));
  const candidates = [{ id: 'sonnet-medium', description: 'Small', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' },
    { id: 'opus-high', description: 'Large', model: 'claude-opus-5-5', reasoningEffort: 'high' }];
  const reviewer = { review: (input: ReviewInput) => routedCall({ routing, repository: 'owner/target', purpose: 'review', state: () => 'pr', candidates,
    router: { enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5 }, configured: () => x.reviewer.review(input), run: () => () => x.reviewer.review(input) }) };
  await new MergeManager(x.api, x.cfg, reviewer, 'test').run(structuredClone(x.snapshot));
  const comment = x.f.comments.find(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data.type === 'merge_review')!;
  expect(comment.body).toContain('Modellwahl: Der Model Router (Jev) wählte `opus-high` (claude-opus-5-5, high) mit 88 % Wahrscheinlichkeit.');
  expect(decodeEvent(comment, x.cfg.manager.trustedActors)!.data).toEqual(expect.objectContaining({ review: x.review }));
});
it.each(['request_changes', 'defer'] as const)('does not review an unchanged head again when only the base moves after %s (controla#123)', async decision => {
  const x = fixture(decision);
  await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
  for (const base of ['e', 'f', '1']) { x.f.base = base.repeat(40); await x.run(); }
  expect(x.reviewer.review).toHaveBeenCalledTimes(1); expect(x.api.merge).not.toHaveBeenCalled();
  // One explanation per head, not one per base.
  expect(x.f.comments.filter(c => c.body.includes('bereits abgelehnt'))).toHaveLength(1);
  x.f.head = '2'.repeat(40); await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(2);
});
it('reviews an unchanged head again after a rejection when the configuration changes', async () => {
  const x = fixture('request_changes'); await x.run();
  x.f.base = 'e'.repeat(40); x.cfg.merge.review.maxFiles += 1; await x.run();
  expect(x.reviewer.review).toHaveBeenCalledTimes(2);
});
it('reviews a new base again after an approval that could not merge yet', async () => {
  const x = fixture(); x.f.mergeState = 'BLOCKED'; await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
  x.f.base = 'e'.repeat(40); await x.run(); expect(x.reviewer.review).toHaveBeenCalledTimes(2);
});
it('marks a Factory pull request and its task when the risk needs a person to approve, once, and clears both on merge (issue #204)', async () => {
  const x = temporal(); x.f.draft = false; x.cfg.merge.risk.enabled = true;
  const assessor = { assess: vi.fn(async () => ({ class: 'high' as const, reason: 'Schreibt in ein externes System.', factors: [] })) };
  const task = x.snapshot.issues.find(i => i.number === 7)!;
  const needsHuman = vi.fn(async (n: number, on: boolean) => {
    if (n === 52) x.f.labels = on ? [...x.f.labels, 'sf:needs-human'] : x.f.labels.filter(l => l !== 'sf:needs-human');
    if (n === 7) task.labels = on ? [...task.labels, 'sf:needs-human'] : task.labels.filter(l => l !== 'sf:needs-human');
  });
  // Comments on the task land in the snapshot the next pass reads, as they would on GitHub.
  const prComment = x.api.comment;
  const comment = vi.fn(async (n: number, body: string) => {
    if (n !== 7) return prComment(n, body);
    x.snapshot.comments.set(7, [...x.snapshot.comments.get(7) ?? [], { id: 500 + (x.snapshot.comments.get(7)?.length ?? 0), body, author: 'github-actions[bot]', createdAt: clock.toISOString() }]);
  });
  Object.assign(x.api, { needsHuman, comment });
  const run = () => new MergeManager(x.api, x.cfg, x.reviewer, 'test', undefined, { ownedOnly: true, assessor }).run(structuredClone(x.snapshot));

  await run(); await run();
  expect(x.api.merge).not.toHaveBeenCalled();
  expect(x.f.labels).toContain('sf:needs-human'); expect(task.labels).toContain('sf:needs-human');
  expect(needsHuman.mock.calls).toEqual([[52, true], [7, true]]);
  const onTask = (x.snapshot.comments.get(7) ?? []).filter(c => decodeEvent(c, x.cfg.manager.trustedActors)?.data.type === 'merge_approval_required');
  expect(onTask).toHaveLength(1);
  const id = [...x.f.comments].reverse().find(c => c.body.includes('/harness approve'))!.body.match(/\/harness approve ([a-f0-9]{64})/)![1];
  expect(onTask[0]!.body).toContain('Risiko high liegt über der Schwelle medium');
  expect(onTask[0]!.body).toContain(`/harness approve ${id}`);
  expect(onTask[0]!.body).toContain('PR #52');

  x.f.comments.push({ id: 900, author: 'maintainer', body: `/harness approve ${id}`, createdAt: clock.toISOString() });
  expect((await run()).merged).toBe(1);
  expect(x.f.labels).not.toContain('sf:needs-human'); expect(task.labels).not.toContain('sf:needs-human');
  expect(needsHuman.mock.calls.slice(2)).toEqual([[52, false], [7, false]]);
});
it('leaves sf:needs-human alone when nothing waits for a person', async () => {
  const x = temporal(); x.f.draft = false;
  const needsHuman = vi.fn(async () => {}); Object.assign(x.api, { needsHuman });
  expect((await x.owned()).merged).toBe(1); expect(needsHuman).not.toHaveBeenCalled();
});
