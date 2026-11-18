import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appCommitIdentity, scopedRuntimeGitHub } from '../src/runtime/github-app.js';
import { Octokit } from '@octokit/rest';

describe('runtime GitHub App scope', () => {
  it('requests only one numeric repository and minimal permissions for every scoped client', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const scopes: unknown[] = [], authorizations: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/app/installations/123/access_tokens')) {
        const scope = JSON.parse(String(init?.body)) as { repository_ids: number[] }; scopes.push(scope);
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^bearer /i);
        return Response.json({ token: `scope-${scope.repository_ids[0]}`, expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'selected' }, { status: 201 });
      }
      authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ id: url.endsWith('/repo-a') ? 42 : 43 });
    };
    for (const [id, repo] of [[42, 'repo-a'], [43, 'repo-b']] as const) {
      const api = scopedRuntimeGitHub({ appId: '1', privateKey, installationId: 123, repositoryId: id }, fetcher);
      await api.repos.get({ owner: 'test', repo });
      await api.repos.get({ owner: 'test', repo });
    }
    expect(scopes).toEqual([42, 43].map(id => ({ repository_ids: [id], permissions: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write' } })));
    expect(authorizations).toEqual(['token scope-42', 'token scope-42', 'token scope-43', 'token scope-43']);
  });
  it('rejects missing or unsafe numeric installation/repository identity', () => {
    for (const repositoryId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => scopedRuntimeGitHub({ appId: '1', privateKey: 'unused', installationId: 123, repositoryId })).toThrow('INVALID_APP_SCOPE');
  });
  it('never falls back to an installation-wide token when scoped authorization fails', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    let requests = 0;
    const api = scopedRuntimeGitHub({ appId: '1', privateKey, installationId: 123, repositoryId: 42 }, async (_input, init) => {
      requests++; expect(JSON.parse(String(init?.body))).toHaveProperty('repository_ids', [42]);
      return Response.json({ message: 'Repository not allowed' }, { status: 403 });
    });
    await expect(api.repos.get({ owner: 'test', repo: 'repo-a' })).rejects.toThrow(); expect(requests).toBe(1);
  });
  it('asks with the last ETag and serves an unchanged answer from the cache, as a copy', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const sent: (string | null)[] = [];
    let body = { id: 42, name: 'first' };
    const api = scopedRuntimeGitHub({ appId: '1', privateKey, installationId: 123, repositoryId: 4242 }, async (input, init) => {
      const url = String(input);
      if (url.endsWith('/access_tokens')) return Response.json({ token: 't', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'selected' }, { status: 201 });
      if (init?.method === 'POST') return Response.json({ data: { ok: true } });
      const match = new Headers(init?.headers).get('if-none-match'); sent.push(match);
      const etag = `"${body.name}"`;
      return match === etag ? new Response(null, { status: 304, headers: { etag } }) : Response.json(body, { headers: { etag } });
    });
    const first = await api.repos.get({ owner: 'test', repo: 'cached' });
    (first.data as { name: string }).name = 'changed by a caller';
    const second = await api.repos.get({ owner: 'test', repo: 'cached' });
    expect(second.data).toEqual({ id: 42, name: 'first' });
    body = { id: 42, name: 'second' };
    expect((await api.repos.get({ owner: 'test', repo: 'cached' })).data).toEqual({ id: 42, name: 'second' });
    expect(sent).toEqual([null, '"first"', '"first"']);
    await api.graphql('query { viewer { login } }');
    expect(sent).toHaveLength(3);
  });
});

describe('commit identity of the App', () => {
  it('resolves the bot user from the App slug and its user id, once, and again after a failure', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const calls: string[] = []; let fail = true;
    const fetcher: typeof fetch = async input => {
      const path = new URL(String(input)).pathname; calls.push(decodeURIComponent(path));
      if (path === '/app') return fail ? (fail = false, Response.json({ message: 'down' }, { status: 502 })) : Response.json({ slug: 'sf-manager' });
      return Response.json({ id: 354123657, login: 'sf-manager[bot]' });
    };
    const api = new Octokit({ auth: 'test-only', request: { fetch: fetcher, retries: 0 }, log: { debug() {}, info() {}, warn() {}, error() {} } });
    await expect(appCommitIdentity('1', privateKey, api, fetcher)).rejects.toBeTruthy();
    const identity = await appCommitIdentity('1', privateKey, api, fetcher);
    expect(identity).toEqual({ name: 'sf-manager[bot]', email: '354123657+sf-manager[bot]@users.noreply.github.com' });
    expect(await appCommitIdentity('1', privateKey, api, fetcher)).toBe(identity);
    expect(calls).toEqual(['/app', '/app', '/users/sf-manager[bot]']);
  });
});
