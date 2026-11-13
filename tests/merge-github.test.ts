import { expect, it } from 'vitest';
import { GitHubMergePort } from '../src/merge/github.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture(options: { approval?: boolean; tooManyThreads?: boolean; noPatch?: boolean; largeFile?: boolean; failMerge?: boolean; forbidden?: boolean } = {}) {
  let currentHead = head;
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ path, method, body });
    let value: unknown;
    if (options.forbidden) return new Response('{"message":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } });
    if (path === '/graphql') value = { data: { repository: { pullRequest: { mergeStateStatus: 'CLEAN', reviewDecision: null, mergedBy: null,
      reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ body: 'Please check authorization' }] } }], pageInfo: { hasNextPage: !!options.tooManyThreads } } } } } };
    else if (path.endsWith('/rules/branches/main')) value = [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: 'test-backend' }] } }];
    else if (path.endsWith('/pulls/52/merge')) {
      expect(body.sha).toBe(head); expect(body.merge_method).toBe('squash'); expect(body).not.toHaveProperty('force');
      value = { merged: !options.failMerge, sha: 'd'.repeat(40) };
    } else if (path.endsWith('/pulls/52/update-branch')) {
      expect(body.expected_head_sha).toBe(head); currentHead = 'c'.repeat(40); value = { message: 'Updating' };
    } else if (path.endsWith('/pulls/52')) value = { number: 52, title: 'Feature', body: '', state: 'open', draft: false, labels: [{ name: 'sf:automerge' }], merged: false,
      head: { sha: currentHead, ref: 'feature', repo: { full_name: 'owner/target' } }, base: { ref: 'main' } };
    else if (path.endsWith('/pulls')) value = [
      { number: 52, labels: [{ name: 'sf:automerge' }], head: { ref: 'feature' } },
      { number: 46, labels: [], head: { ref: 'sf/issue-44/run' } }, { number: 1, labels: [], head: { ref: 'unrelated' } }];
    else if (path.endsWith('/comments')) value = method === 'GET' ? [{ id: 1, user: { login: 'maintainer' }, body: 'comment', created_at: '2026-11-07T00:00:00Z' }] : {};
    else if (path.endsWith('/git/ref/heads/main')) value = { object: { sha: base } };
    else if (path.endsWith('/check-runs')) value = { total_count: 1, check_runs: [{ name: 'test-backend', status: 'completed', conclusion: 'success' }] };
    else if (path.endsWith('/statuses')) value = [{ context: 'Vercel', state: 'success' }, { context: 'Vercel', state: 'failure' }];
    else if (path.endsWith('/actions/runs')) value = { total_count: 3, workflow_runs: options.approval ? [
      { head_sha: head, conclusion: 'action_required', name: 'Test', html_url: 'https://github.com/owner/target/actions/runs/1', pull_requests: [{ number: 52 }] },
      { head_sha: base, conclusion: 'action_required', name: 'Stale', pull_requests: [{ number: 52 }] },
      { head_sha: head, conclusion: 'action_required', name: 'Unrelated', pull_requests: [{ number: 99 }] }
    ] : [] };
    else if (path.includes('/compare/')) {
      expect(path).toContain(`${base}...${head}`);
      value = { files: [{ filename: 'file.txt', status: 'modified', patch: options.noPatch ? undefined : '-old\n+new' }] };
    } else if (path.includes('/contents/')) value = { encoding: 'base64', size: options.largeFile ? 999999 : 3, content: Buffer.from('new').toString('base64') };
    else if (path.includes('/collaborators/')) value = { permission: 'write' };
    else if (path.endsWith('/dispatches')) return new Response(null, { status: 204 });
    else value = { default_branch: 'main' };
    const response = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href }); return response;
  }) as typeof fetch;
  return { api: new GitHubMergePort('owner/target', 'fixture-token', 'Community', 'sf:automerge', fetcher), calls };
}
it('reads effective rules, native review discussions, exact-head CI and default-branch SHA; narrows candidates before review', async () => {
  const x = fixture(); expect(await x.api.candidates()).toEqual([52, 46]);
  const facts = await x.api.facts(52);
  expect(facts.strictChecks).toBe(true); expect(facts.base).toBe(base); expect(facts.head).toBe(head);
  expect(facts.unresolvedThreads).toEqual(['Please check authorization']);
  expect(facts.checks.filter(c => c.name === 'Vercel')).toEqual([{ name: 'Vercel', state: 'success' }]);
  expect(x.calls.some(c => c.path.includes(`/commits/${head}/check-runs`))).toBe(true);
});
it('loads immutable full source context, binds update and merge mutations to expected SHA, and uses explicit workflow dispatch', async () => {
  const x = fixture(); const facts = await x.api.facts(52);
  const context = await x.api.context(facts, 60, 250000); expect(context.changes[0]!.content).toBe('new');
  expect(await x.api.update(52, head)).toBe('c'.repeat(40)); expect(await x.api.merge(52, head, 'squash')).toBe('d'.repeat(40));
  await x.api.dispatch('test.yml', 'feature'); await x.api.comment(52, 'Explanation'); expect(await x.api.canApprove('maintainer')).toBe(true);
  expect(await x.api.workflowAvailable('publish.yml')).toBe(true);
});
it.each(['threads', 'patch', 'size', 'count', 'context'])('refuses incomplete evidence: %s', async kind => {
  const x = fixture({ tooManyThreads: kind === 'threads', noPatch: kind === 'patch', largeFile: kind === 'size' });
  if (kind === 'threads') { await expect(x.api.facts(52)).rejects.toThrow('threads'); return; }
  const facts = await x.api.facts(52);
  await expect(x.api.context(facts, kind === 'count' ? 0 : 60, kind === 'context' ? 10 : 250000)).rejects.toThrow();
});
it('does not treat an HTTP-success merge response with merged=false as completion', async () => {
  await expect(fixture({ failMerge: true }).api.merge(52, head, 'squash')).rejects.toThrow('did not confirm');
});
it('reports only approval-required PR workflows on the exact head alongside green dispatch checks', async () => {
  const x = fixture({ approval: true }); const facts = await x.api.facts(52);
  expect(facts.checks.filter(c => c.state === 'action_required')).toEqual([
    { name: 'Workflow-Freigabe erforderlich: Test (https://github.com/owner/target/actions/runs/1)', state: 'action_required' }
  ]);
  expect(facts.checks).toContainEqual({ name: 'test-backend', state: 'success' });
  expect(x.calls.some(c => c.method !== 'GET' && c.path !== '/graphql')).toBe(false);
});
it('fails closed for unavailable collaborator permission', async () => {
  expect(await fixture({ forbidden: true }).api.canApprove('maintainer')).toBe(false);
});

function routes(table: Record<string, (body: Record<string, unknown>, method: string) => unknown>) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ path, method, body });
    const key = Object.keys(table).find(k => path.endsWith(k) || path.includes(k));
    if (!key) throw new Error(`unexpected ${method} ${path}`);
    const value = table[key]!(body, method);
    if (value instanceof Response) return value;
    const response = new Response(JSON.stringify(value ?? {}), { headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href }); return response;
  }) as typeof fetch;
  return { calls, fetcher };
}
it('treats branch rules unavailable on the plan as absent and reads how far the head is behind the current base', async () => {
  const x = routes({
    '/graphql': () => ({ data: { repository: { pullRequest: { mergeStateStatus: 'CLEAN', reviewDecision: null, mergedBy: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
    '/rules/branches/main': () => new Response('{"message":"Upgrade to GitHub Pro"}', { status: 403, headers: { 'content-type': 'application/json' } }),
    '/pulls/52': () => ({ number: 52, title: 'F', body: '', state: 'open', draft: false, labels: [], merged: false, head: { sha: head, ref: 'sf/issue-7/x', repo: { full_name: 'owner/target' } }, base: { ref: 'main' } }),
    '/comments': () => [], '/git/ref/heads/main': () => ({ object: { sha: base } }),
    '/check-runs': () => ({ total_count: 0, check_runs: [] }), '/statuses': () => [], '/actions/runs': () => ({ total_count: 0, workflow_runs: [] }),
    [`/compare/${base}...${head}`]: () => ({ behind_by: 3, files: [] }), '/repos/owner/target': () => ({ default_branch: 'main' }) });
  const facts = await new GitHubMergePort('owner/target', 'token', 'Community', 'sf:automerge', x.fetcher).facts(52);
  expect(facts.strictChecks).toBe(false); expect(facts.nativeRequiredChecks).toEqual([]); expect(facts.behindBy).toBe(3);
});
it('lists only open or recently updated pull requests for the broker', async () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const x = routes({ '/pulls': () => [
    { number: 3, state: 'open', updated_at: '2026-01-01T00:00:00Z', labels: [], head: { ref: 'sf/issue-1/a' } },
    { number: 4, state: 'closed', updated_at: '2026-11-13T11:00:00Z', labels: [], head: { ref: 'sf/issue-2/b' } },
    { number: 5, state: 'closed', updated_at: '2026-11-01T00:00:00Z', labels: [], head: { ref: 'sf/issue-3/c' } }] });
  expect(await new GitHubMergePort('owner/target', 'token', 'C', 'sf:automerge', x.fetcher, 48 * 3600000, () => now).candidates()).toEqual([3, 4]);
});
it('marks a draft ready only while its head is unchanged', async () => {
  let sha = head;
  const x = routes({ '/pulls/52': () => ({ number: 52, state: 'open', draft: true, node_id: 'PR_node', head: { sha } }),
    '/graphql': body => { expect(body.variables).toEqual({ id: 'PR_node' }); return { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }; } });
  const api = new GitHubMergePort('owner/target', 'token', 'C', 'sf:automerge', x.fetcher);
  await api.ready(52, head); expect(x.calls.filter(c => c.path === '/graphql')).toHaveLength(1);
  sha = 'f'.repeat(40); await expect(api.ready(52, head)).rejects.toThrow('changed'); expect(x.calls.filter(c => c.path === '/graphql')).toHaveLength(1);
});
it('re-runs only first attempts of failed pull-request runs on the exact head that contain a required check', async () => {
  const run = (id: number, extra: Record<string, unknown>) => ({ id, head_sha: head, run_attempt: 1, status: 'completed', conclusion: 'failure', pull_requests: [{ number: 52 }], ...extra });
  const x = routes({
    '/actions/runs/1/jobs': () => ({ total_count: 1, jobs: [{ name: 'test-and-build (24)', conclusion: 'failure' }] }),
    '/actions/runs/4/jobs': () => ({ total_count: 1, jobs: [{ name: 'lint', conclusion: 'failure' }] }),
    '/rerun-failed-jobs': () => new Response(null, { status: 201 }),
    '/actions/runs': () => ({ total_count: 5, workflow_runs: [run(1, {}), run(2, { run_attempt: 2 }), run(3, { head_sha: base }), run(4, {}), run(5, { conclusion: 'success' })] }) });
  const api = new GitHubMergePort('owner/target', 'token', 'C', 'sf:automerge', x.fetcher);
  expect(await api.rerunFailed(52, head, ['test-and-build (24)'])).toBe(1);
  expect(x.calls.filter(c => c.path.endsWith('/rerun-failed-jobs')).map(c => c.path)).toEqual(['/repos/owner/target/actions/runs/1/rerun-failed-jobs']);
});
it('reads check states from the Actions jobs of the exact head where the token has no checks or statuses access', async () => {
  const denied = () => new Response('{"message":"Resource not accessible by integration"}', { status: 403, headers: { 'content-type': 'application/json' } });
  const x = routes({
    '/graphql': () => ({ data: { repository: { pullRequest: { mergeStateStatus: 'CLEAN', reviewDecision: null, mergedBy: null, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } } }),
    '/rules/branches/main': () => [], '/check-runs': denied, '/statuses': denied,
    '/pulls/52': () => ({ number: 52, title: 'F', body: '', state: 'open', draft: false, labels: [], merged: false, head: { sha: head, ref: 'sf/issue-7/x', repo: { full_name: 'owner/target' } }, base: { ref: 'main' } }),
    '/comments': () => [], '/git/ref/heads/main': () => ({ object: { sha: base } }),
    '/actions/runs/7/jobs': () => ({ total_count: 2, jobs: [{ name: 'test-and-build (24)', status: 'completed', conclusion: 'success' }, { name: 'docker', status: 'in_progress', conclusion: null }] }),
    '/actions/runs': () => ({ total_count: 2, workflow_runs: [{ id: 7, head_sha: head }, { id: 8, head_sha: base }] }),
    [`/compare/${base}...${head}`]: () => ({ behind_by: 0, files: [] }), '/repos/owner/target': () => ({ default_branch: 'main' }) });
  const facts = await new GitHubMergePort('owner/target', 'token', 'Community', 'sf:automerge', x.fetcher).facts(52);
  expect(facts.checks).toEqual([{ name: 'test-and-build (24)', state: 'success' }, { name: 'docker', state: 'in_progress' }]);
  expect(x.calls.some(c => c.path.endsWith('/actions/runs/8/jobs'))).toBe(false);
});
