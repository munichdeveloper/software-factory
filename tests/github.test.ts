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
  const isHistory = (url: URL, body: unknown) => url.pathname === '/graphql' && JSON.stringify(body).includes('userContentEdits');
  const history = (nodes: unknown[] = []) => json({ data: { repository: { issue: { userContentEdits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } });
  it('authenticates ready approval against native label events and current repository permission', async () => {
    let permission='write';
    const gh=new GitHubClient('owner/target','token',1000,transport((url,_m,body)=>{
      if(isHistory(url,body))return history();
      if(url.pathname.endsWith('/permission'))return json({permission});
      if(url.pathname.endsWith('/timeline'))return json([{id:123,event:'labeled',label:{name:'harness:ready'},actor:{login:'maintainer'},created_at:'2026-11-06T10:00:00Z'}]);
      return json({number:1,title:'Task',body:'Implement',state:'open',labels:['harness:managed','harness:ready'],updated_at:'2026-11-06T10:00:00Z'});
    }));
    expect(await gh.readyApproval(1,[])).toMatchObject({eventId:123,actor:'maintainer'});
    permission='read';await expect(gh.readyApproval(1,[])).rejects.toThrow('READY_ACTOR_NOT_AUTHORIZED');
  });
  it('paginates managed issues/comments, includes merged PRs and targets the caller repository', async () => {
    const requested: string[] = [];
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url, _method, body) => {
      requested.push(url.href);
      if (isHistory(url, body)) return history();
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
  it('reads the journal of open and recently touched tasks only', async () => {
    const requested: string[] = [], recent = new Date(Date.now() - 3600000).toISOString();
    const row = (number: number, state: string, updated_at: string) => ({ number, title: 'task', body: '', state, labels: [{ name: 'harness:managed' }], updated_at });
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url, _method, body) => {
      requested.push(url.pathname);
      if (isHistory(url, body)) return history();
      if (url.pathname === '/graphql') return json({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } } });
      if (url.pathname.endsWith('/issues')) return json([row(1, 'open', '2020-01-01T00:00:00Z'), row(2, 'closed', recent), row(3, 'closed', '2020-01-01T00:00:00Z')]);
      if (/\/issues\/[12]\/(comments|timeline)$/.test(url.pathname)) return json([]);
      if (url.pathname === '/repos/owner/target') return json({ default_branch: 'main', has_issues: true });
      throw new Error(`Unexpected request ${url.pathname}`);
    }));
    const state = await gh.snapshot(null);
    expect(state.issues.map(i => i.number)).toEqual([1, 2, 3]);
    expect([...state.comments.keys()]).toEqual([1, 2, 3]);
    expect(requested.filter(p => p.includes('/issues/3/'))).toEqual([]);
    expect(requested.filter(p => p.endsWith('/timeline')).sort()).toEqual(['/repos/owner/target/issues/1/timeline', '/repos/owner/target/issues/2/timeline']);
    expect(requested.filter(p => p.endsWith('/comments')).sort()).toEqual(['/repos/owner/target/issues/1/comments', '/repos/owner/target/issues/2/comments']);
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
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url, _method, body) => {
      if (isHistory(url, body)) return history();
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
  it('reads title and body changes after the managed label with the editor\'s current write access', async () => {
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url, _method, body) => {
      if (isHistory(url, body)) return history([{ editedAt: '2026-11-06T10:05:00Z', editor: { login: 'stranger' } },
        { editedAt: '2026-11-06T10:04:00Z', editor: { login: 'maintainer' } }, { editedAt: '2026-11-06T09:00:00Z', editor: null }]);
      if (url.pathname.endsWith('/permission')) return json({ permission: url.pathname.includes('/maintainer/') ? 'write' : 'read' });
      if (url.pathname.endsWith('/timeline')) return json([
        { id: 1, event: 'labeled', label: { name: 'harness:managed' }, actor: { login: 'maintainer' }, created_at: '2026-11-06T10:00:00Z' },
        { id: 2, event: 'renamed', actor: { login: 'stranger' }, created_at: '2026-11-06T10:06:00Z' }]);
      return json({ number: 1, title: 'task', body: 'changed', state: 'open', labels: [{ name: 'harness:managed' }], updated_at: '2026-11-06T10:06:00Z' });
    }));
    const issue = await gh.getIssue(1);
    expect(issue.managedAt).toBe('2026-11-06T10:00:00Z');
    expect(issue.contentEdits).toEqual([{ actor: 'stranger', at: '2026-11-06T10:06:00Z', trusted: false },
      { actor: 'stranger', at: '2026-11-06T10:05:00Z', trusted: false }, { actor: 'maintainer', at: '2026-11-06T10:04:00Z', trusted: true },
      { actor: '', at: '2026-11-06T09:00:00Z', trusted: false }]);
  });
  it('fails instead of assuming an unchanged text when the content history is unavailable', async () => {
    const gh = new GitHubClient('owner/target', 'token', 1000, transport((url, _method, body) => {
      if (isHistory(url, body)) return json({ data: { repository: { issue: null } } });
      if (url.pathname.endsWith('/timeline')) return json([]);
      return json({ number: 1, title: 'task', body: '', state: 'open', labels: [{ name: 'harness:managed' }], updated_at: '2026-11-06T10:06:00Z' });
    }));
    await expect(gh.getIssue(1)).rejects.toThrow('Content history of #1 is unavailable');
  });
});
