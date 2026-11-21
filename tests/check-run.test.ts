import { expect, it, vi } from 'vitest';
import { clock, config, MemoryGitHub } from './helpers.js';
import { MergeManager } from '../src/merge/manager.js';
import type { MergeFacts, MergePort, MergeReview, ReviewInput } from '../src/merge/contract.js';
import { checkRunName, checkRunView, GitHubCheckRuns, type CheckRunView, type MergeCheckRuns } from '../src/merge/check-run.js';

function fixture() {
  const cfg = config(); cfg.merge.enabled = true; cfg.autonomy.overrides.merge_pr = 'allow'; cfg.llm.provider = 'openai';
  const f: MergeFacts = { number: 52, title: 'Feature', body: '', head: 'a'.repeat(40), base: 'b'.repeat(40), headBranch: 'feature', baseBranch: 'main',
    state: 'open', draft: false, sameRepository: true, labels: ['sf:automerge'], mergeState: 'CLEAN', reviewDecision: null,
    unresolvedThreads: [], checks: ['test-backend', 'test-frontend', 'test-docker'].map(name => ({ name, state: 'success' })),
    strictChecks: true, nativeRequiredChecks: ['test-backend'], comments: [], mergeSha: null, mergeActorType: null };
  const review: MergeReview = { decision: 'merge', reason: 'Code und Tests geprüft.', findings: [] };
  const reviewer = { review: vi.fn(async (_input: ReviewInput) => { void _input; return structuredClone(review); }) };
  const api: MergePort = { repository: 'owner/target',
    candidates: vi.fn(async () => [52]), facts: vi.fn(async () => structuredClone(f)),
    context: vi.fn(async facts => ({ facts, trustedScope: 'Community', trustedInstructions: '', changes: [
      { path: 'file.txt', status: 'modified', patch: '-old\n+new', content: 'new' }] })),
    comment: vi.fn(async (_number, body) => { f.comments.push({ id: f.comments.length + 1, body, author: 'github-actions[bot]', createdAt: clock.toISOString() }); }),
    update: vi.fn(async () => { f.head = 'c'.repeat(40); f.checks = []; return f.head; }),
    merge: vi.fn(async () => { f.state = 'closed'; f.mergeSha = 'd'.repeat(40); f.mergeActorType = 'Bot'; return f.mergeSha; }),
    dispatch: vi.fn(async () => {}), workflowAvailable: vi.fn(async () => true), canApprove: vi.fn(async login => login === 'maintainer') };
  const shown: { pr: number; head: string; view: CheckRunView }[] = [];
  const checkRuns: MergeCheckRuns = { show: (pr, head, view) => { shown.push({ pr, head, view }); } };
  const snapshot = new MemoryGitHub().state;
  const run = (assessor?: ConstructorParameters<typeof MergeManager>[5] extends infer O ? O extends { assessor?: infer A } ? A : never : never) =>
    new MergeManager(api, cfg, reviewer, 'test', undefined, { checkRuns, ...(assessor ? { assessor } : {}) }).run(structuredClone(snapshot));
  return { cfg, f, api, shown, run };
}

it('shows a merged pull request as one check run on its head, from in progress to success', async () => {
  const x = fixture();
  expect((await x.run()).merged).toBe(1);
  expect(new Set(x.shown.map(s => s.head))).toEqual(new Set(['a'.repeat(40)]));
  expect(x.shown[0]!.view.status).toBe('in_progress');
  expect(x.shown.at(-1)!.view).toMatchObject({ status: 'completed', conclusion: 'success', title: 'Gemergt' });
});
it('shows a needed approval with risk, threshold and the approve command', async () => {
  const x = fixture(); x.cfg.merge.risk.enabled = true;
  const assessor = { assess: vi.fn(async () => ({ class: 'high' as const, reason: 'Schreibt in ein externes System.', factors: [] })) };
  await x.run(assessor);
  expect(x.api.merge).not.toHaveBeenCalled();
  const id = [...x.f.comments].reverse().find(c => c.body.includes('/harness approve'))!.body.match(/\/harness approve ([a-f0-9]{64})/)![1];
  const last = x.shown.at(-1)!.view;
  expect(last).toMatchObject({ status: 'completed', conclusion: 'action_required', title: 'Freigabe nötig' });
  expect(last.summary).toContain('Risiko high über der Schwelle medium');
  expect(last.summary).toContain(`/harness approve ${id}`);
  expect(last.summary).toContain('Risiko: high');
});
it('shows a new head after a branch update on its own check run', async () => {
  const x = fixture(); x.f.mergeState = 'BEHIND';
  await x.run();
  expect(x.api.update).toHaveBeenCalled();
  expect(x.shown.find(s => s.head === 'a'.repeat(40) && s.view.title === 'Branch wird aktualisiert')).toBeTruthy();
  x.f.checks = ['test-backend', 'test-frontend', 'test-docker'].map(name => ({ name, state: 'success' })); x.f.mergeState = 'CLEAN';
  await x.run();
  expect(x.shown.at(-1)).toMatchObject({ head: 'c'.repeat(40), view: { conclusion: 'success' } });
});
it('never counts its own check run as a required, failed or blocking check', async () => {
  const x = fixture(); x.cfg.merge.requiredChecks = [...x.cfg.merge.requiredChecks, checkRunName];
  x.f.checks.push({ name: checkRunName, state: 'action_required' });
  const report = await x.run();
  expect(report.merged).toBe(0);
  expect(x.f.comments.at(-1)!.body).toContain(checkRunName);
  x.cfg.merge.requiredChecks = x.cfg.merge.requiredChecks.filter(n => n !== checkRunName);
  expect((await x.run()).merged).toBe(1);
});
it('writes no check run when merge.checkRun is false', async () => {
  const x = fixture(); x.cfg.merge.checkRun = false;
  expect((await x.run()).merged).toBe(1); expect(x.shown).toEqual([]);
});
it('keeps the step text of the merge pass and its own wording otherwise', () => {
  expect(checkRunView('review')).toMatchObject({ status: 'in_progress', title: 'KI-Review läuft' });
  expect(checkRunView('review', null, 'low').title).toBe('KI-Review fertig, Risiko low');
  expect(checkRunView('checks', 'Pflichtprüfung test fehlt oder läuft noch.').summary).toBe('Pflichtprüfung test fehlt oder läuft noch.');
});

function checksApi(existing: { id: number; name: string; head_sha: string; status: string; conclusion: string | null; output: { title: string | null; summary: string | null } }[] = []) {
  let next = 100;
  const api = { checks: {
    listForRef: vi.fn(async () => ({ data: { check_runs: existing } })),
    create: vi.fn(async () => ({ data: { id: next++ } })),
    update: vi.fn(async () => ({ data: {} }))
  } };
  return api;
}
const view = (title: string, status: CheckRunView['status'] = 'in_progress'): CheckRunView =>
  ({ status, ...(status === 'completed' ? { conclusion: 'success' as const } : {}), title, summary: `${title}.` });

it('creates one check run per head and writes it again only when the view changed', async () => {
  const api = checksApi(); const runs = new GitHubCheckRuns('owner/target', api as never, () => {});
  runs.show(52, 'a'.repeat(40), view('KI-Review läuft')); runs.show(52, 'a'.repeat(40), view('KI-Review läuft'));
  runs.show(52, 'a'.repeat(40), view('Gemergt', 'completed')); await runs.flush();
  expect(api.checks.listForRef).toHaveBeenCalledTimes(1);
  expect(api.checks.create).toHaveBeenCalledTimes(1);
  expect(api.checks.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'owner', repo: 'target', name: checkRunName, head_sha: 'a'.repeat(40),
    status: 'in_progress', details_url: 'https://github.com/owner/target/pull/52', output: { title: 'KI-Review läuft', summary: 'KI-Review läuft.' } }));
  expect(api.checks.update).toHaveBeenCalledTimes(1);
  expect(api.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 100, status: 'completed', conclusion: 'success' }));
});
it('takes over the check run of a head after a restart instead of creating a second one', async () => {
  const head = 'a'.repeat(40);
  const same = checksApi([{ id: 7, name: checkRunName, head_sha: head, status: 'in_progress', conclusion: null, output: { title: 'KI-Review läuft', summary: 'KI-Review läuft.' } }]);
  const a = new GitHubCheckRuns('owner/target', same as never, () => {});
  a.show(52, head, view('KI-Review läuft')); await a.flush();
  expect(same.checks.create).not.toHaveBeenCalled(); expect(same.checks.update).not.toHaveBeenCalled();
  a.show(52, head, view('Gemergt', 'completed')); await a.flush();
  expect(same.checks.update).toHaveBeenCalledWith(expect.objectContaining({ check_run_id: 7 }));
  expect(same.checks.create).not.toHaveBeenCalled();
});
it('pauses itself without the checks permission, says so once, and tries again later', async () => {
  let now = 0; const log = vi.fn();
  const api = checksApi(); api.checks.listForRef.mockRejectedValue(Object.assign(new Error('Resource not accessible by integration'), { status: 403 }));
  const runs = new GitHubCheckRuns('owner/target', api as never, log, 1000, () => now);
  runs.show(52, 'a'.repeat(40), view('KI-Review läuft')); await runs.flush();
  runs.show(53, 'b'.repeat(40), view('KI-Review läuft')); await runs.flush();
  expect(runs.disabled).toBe(true); expect(api.checks.listForRef).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledTimes(1); expect(log).toHaveBeenCalledWith({ event: 'factory-check-run-disabled', repository: 'owner/target', status: '403' });
  now = 1001; api.checks.listForRef.mockResolvedValue({ data: { check_runs: [] } });
  runs.show(52, 'a'.repeat(40), view('KI-Review läuft')); await runs.flush();
  expect(api.checks.create).toHaveBeenCalledTimes(1);
});
it('keeps the merge pass running when writing the check run fails', async () => {
  const x = fixture();
  const failing: MergeCheckRuns = { show: () => { throw new Error('boom'); } };
  const report = await new MergeManager(x.api, x.cfg, { review: vi.fn(async () => ({ decision: 'merge' as const, reason: 'ok', findings: [] })) }, 'test', undefined,
    { checkRuns: failing }).run(new MemoryGitHub().state);
  expect(report.merged).toBe(1); expect(report.errors).toEqual([]);
});
