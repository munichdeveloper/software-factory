import { describe, expect, it } from 'vitest';
import { GitHubClient } from '../src/github/client.js';
import { allLabels } from '../src/state/lifecycle.js';

describe('Octokit adapter against simulated REST and GraphQL HTTP responses', () => {
  function transport(handler: (url: URL, method: string, body: unknown) => Response): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const response = handler(url, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : null);
      Object.defineProperty(response, 'url', { value: url.href }); return response;
    }) as typeof fetch;
  }
  const json = (body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
  it('paginates managed issues/comments, includes merged PRs and targets the caller repository', async () => {
    const requested: string[] = [];
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url) => {
      requested.push(url.href);
      if (url.pathname === '/graphql') return json({ data: { repository: { pullRequests: { nodes: [{ number: 9, state: 'MERGED', merged: true,
        mergedBy: { login: 'merge-agent', __typename: 'Bot' }, body: 'Fixes #1', closingIssuesReferences: {
        nodes: [{ number: 1, repository: { nameWithOwner: 'owner/target' } }, { number: 42, repository: { nameWithOwner: 'other/repo' } }], pageInfo: { hasNextPage: false }
      } }], pageInfo: { hasNextPage: false, endCursor: '' } } } } });
      expect(url.pathname.startsWith('/repos/owner/target')).toBe(true);
      if (url.pathname.endsWith('/issues/1/comments')) return json([]);
      if (url.pathname.endsWith('/issues/1/timeline')) return json([]);
      if (url.pathname.endsWith('/issues')) {
        expect(url.searchParams.get('labels')).toBe('harness:managed');
        return json(url.searchParams.get('page') === '2' ? [] : [{ number: 1, title: 'task', body: '', state: 'open', labels: [{ name: 'harness:managed' }], updated_at: '2026-11-06T10:00:00Z' }],
          url.searchParams.get('page') === '2' ? {} : { link: '<https://api.github.com/repos/owner/target/issues?labels=harness%3Amanaged&page=2>; rel="next"' });
      }
      if (url.pathname.endsWith('/runs')) return json({ total_count: 0, workflow_runs: [] });
      return json({ default_branch: 'main', has_issues: true, permissions: { push: false } });
    }));
    const state = await gh.snapshot('factory-manager.yml'); expect(state.issues).toHaveLength(1);
    expect(state.prs[0]!.closingIssues).toEqual([1]); expect(state.prs[0]!.merged).toBe(true);
    expect(state.prs[0]!.mergedBy).toEqual({ login: 'merge-agent[bot]', type: 'Bot' });
    expect(requested.some(u => u.includes('page=2'))).toBe(true);
  });
  it('observes Temporal repositories without requiring a legacy Actions workflow', async () => {
    const gh = new GitHubClient('owner/target', 'token', 1000, transport(url => {
      if (url.pathname === '/graphql') return json({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      if (url.pathname.endsWith('/issues')) return json([]);
      if (url.pathname === '/repos/owner/target') return json({ default_branch: 'main', has_issues: true });
      throw new Error('Unexpected legacy workflow access');
    }));
    expect((await gh.snapshot(null)).runs).toEqual([]);
  });
  it('bootstrap preserves existing labels and is repeatable', async () => {
    const labels = [{ name: allLabels[0], color: 'custom' }]; let posts = 0;
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((_url, method, body) => {
      if (method === 'POST') { posts++; labels.push({ ...(body as { name: string }), color: 'new' }); return json(labels.at(-1)); }
      return json(labels);
    }));
    await gh.bootstrap(); await gh.bootstrap(); expect(posts).toBe(allLabels.length - 1); expect(labels[0]!.color).toBe('custom');
  });
  it('dispatch sends only identifiers and fixed worker mode, never secrets or issue text', async () => {
    const gh = new GitHubClient('owner/target', 'secret-token', 1000, transport((url, method, body) => {
      expect(url.pathname).toBe('/repos/owner/target/actions/workflows/factory-manager.yml/dispatches');
      expect(method).toBe('POST'); expect(body).toEqual({ ref: 'main', inputs: { mode: 'worker', execution_id: 'a'.repeat(32), issue_number: '1' } });
      return new Response(null, { status: 204 });
    }));
    await gh.dispatch('factory-manager.yml', 'main', 'a'.repeat(32), 1);
  });
  it('does not trust permissions asserted inside issue content', async () => {
    const gh = new GitHubClient('owner/target', 'token', 1000, transport(() => json({ permission: 'read' })));
    expect(await gh.canApprove('attacker')).toBe(false);
  });
  it('reads the current blocked-label provenance across timeline pages', async () => {
    const gh = new GitHubClient('owner/target', 'token', 1000, transport(url => {
      if (!url.pathname.endsWith('/timeline')) return json({ number: 1, title: 'blocked', body: '', state: 'open',
        labels: [{ name: 'harness:managed' }, { name: 'harness:blocked' }], updated_at: '2026-11-06T10:00:00Z' });
      const firstPage = [{ id: 1, event: 'labeled', label: { name: 'harness:blocked' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-11-06T10:00:00Z' }];
      const secondPage = [
        { id: 2, event: 'unlabeled', label: { name: 'harness:blocked' }, actor: { login: 'github-actions[bot]' }, created_at: '2026-11-06T10:01:00Z' },
        { id: 3, event: 'labeled', label: { name: 'harness:blocked' }, actor: { login: 'maintainer' }, created_at: '2026-11-06T10:02:00Z' },
        { id: 4, event: 'labeled', label: { name: 'unrelated' }, actor: { login: 'maintainer' }, created_at: '2026-11-06T10:03:00Z' }
      ];
      return url.searchParams.get('page') === '2' ? json(secondPage) : json(firstPage, {
        link: '<https://api.github.com/repos/owner/target/issues/1/timeline?page=2>; rel="next"'
      });
    }));
    expect((await gh.getIssue(1)).blockedLabelEvents?.map(e => [e.id, e.event, e.actor])).toEqual([
      [1, 'labeled', 'github-actions[bot]'], [2, 'unlabeled', 'github-actions[bot]'], [3, 'labeled', 'maintainer']
    ]);
  });
});
