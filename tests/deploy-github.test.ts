import { expect, it } from 'vitest';
import { GitHubDeployPort } from '../src/deploy/github.js';

const head = 'a'.repeat(40);
function fixture() {
  const calls: { path: string; method: string; body: Record<string, unknown>; query: URLSearchParams }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), path = decodeURIComponent(url.pathname), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {}; calls.push({ path, method, body, query: url.searchParams });
    let value: unknown;
    if (path === '/repos/owner/target') value = { default_branch: 'main' };
    else if (path.endsWith('/git/ref/heads/main')) value = { object: { sha: head } };
    else if (path.endsWith('/actions/runs')) value = { total_count: 1, workflow_runs: [{ name: 'Application checks', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-11-07T00:00:00Z' }] };
    else if (path.endsWith('/deployments') && method === 'POST') value = { id: 42 };
    else if (path.endsWith('/deployments/42/statuses')) value = { id: 1 };
    else return new Response('{"message":"Not Found"}', { status: 404, headers: { 'content-type': 'application/json' } });
    const response = new Response(JSON.stringify(value), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href }); return response;
  }) as typeof fetch;
  return { port: new GitHubDeployPort('owner/target', 'token', fetcher), calls };
}

it('reads the default-branch head and the workflow runs of a commit', async () => {
  const { port, calls } = fixture();
  expect(await port.defaultBranch()).toEqual({ name: 'main', sha: head });
  expect(await port.workflowRuns(head)).toEqual([{ name: 'Application checks', event: 'push', status: 'completed', conclusion: 'success', createdAt: '2026-11-07T00:00:00Z' }]);
  expect(calls.at(-1)?.query.get('head_sha')).toBe(head);
});

it('records deployments without merging or requiring extra contexts', async () => {
  const { port, calls } = fixture();
  expect(await port.createDeployment(head, 'production', 'deploy')).toBe(42);
  expect(calls.at(-1)?.body).toMatchObject({ ref: head, environment: 'production', auto_merge: false, required_contexts: [], production_environment: true });
  await port.setDeploymentStatus(42, 'success', 'x'.repeat(200), 'https://github.com/owner/target/actions/runs/1');
  expect(calls.at(-1)?.body).toMatchObject({ state: 'success', auto_inactive: true, log_url: 'https://github.com/owner/target/actions/runs/1' });
  expect(String(calls.at(-1)?.body.description)).toHaveLength(140);
  await port.setDeploymentStatus(42, 'failure', 'failed');
  expect(calls.at(-1)?.body).not.toHaveProperty('log_url');
});

it('validates repository and token', () => {
  expect(() => new GitHubDeployPort('invalid', 'token')).toThrow('Repository must be owner/name');
  expect(() => new GitHubDeployPort('owner/target', '')).toThrow('GITHUB_TOKEN is required');
});
