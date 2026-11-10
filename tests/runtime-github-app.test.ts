import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scopedRuntimeGitHub } from '../src/runtime/github-app.js';

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
});
