import { expect, it } from 'vitest';
import { GitHubMergePort } from '../src/merge/github.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
function fixture(options: { tooManyThreads?: boolean; noPatch?: boolean; largeFile?: boolean; failMerge?: boolean; forbidden?: boolean } = {}) {
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
it('fails closed for unavailable collaborator permission', async () => {
  expect(await fixture({ forbidden: true }).api.canApprove('maintainer')).toBe(false);
});
