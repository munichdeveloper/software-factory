import { expect, it } from 'vitest';
import { CodingRepository } from '../src/github/coding.js';
import type { CodingArtifact } from '../src/workers/coding.js';

const base = { sha: 'c'.repeat(40), branch: 'main' };
const artifact = (): CodingArtifact => ({ contractVersion: '3.0', baseSha: base.sha,
  result: { contractVersion: '2.0', executionId: 'a'.repeat(32), taskId: 'task:1', taskVersion: 'b'.repeat(64),
    status: 'success', summary: 'Implemented and tested', artifacts: [], error: null },
  changes: [{ path: 'new.txt', content: Buffer.from('new').toString('base64'), mode: '100644' },
    { path: 'delete.txt', content: null, mode: '100644' }] });
function fixture(options: { moved?: boolean; truncated?: boolean; collision?: boolean; treeMode?: string; sameTree?: boolean; transportFailure?: boolean } = {}) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let branch: string | null = null;
  let commitMessage = '';
  let prs: { html_url: string }[] = [];
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)); const path = decodeURIComponent(url.pathname).replace('/repos/owner/target', '');
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, method, body });
    let value: unknown; let status = 200;
    if (options.transportFailure) return new Response('{}', { status: 403, headers: { 'content-type': 'application/json' } });
    if (path === '') value = { default_branch: 'main' };
    else if (path === '/git/ref/heads/main') value = { object: { sha: options.moved ? 'f'.repeat(40) : base.sha } };
    else if (path === `/git/commits/${base.sha}`) value = { tree: { sha: 'base-tree' } };
    else if (path === '/git/trees/base-tree') value = { truncated: !!options.truncated,
      tree: [{ path: 'delete.txt', type: 'blob', mode: options.treeMode ?? '100644' }] };
    else if (path === '/git/blobs') value = { sha: 'new-blob' };
    else if (path === '/git/trees') value = { sha: options.sameTree ? 'base-tree' : 'new-tree' };
    else if (path.startsWith('/git/ref/heads/sf/')) { value = branch ? { object: { sha: branch } } : { message: 'missing' }; if (!branch) status = 404; }
    else if (path === '/git/commits' && method === 'POST') { commitMessage = body.message; value = { sha: 'commit' }; }
    else if (path === '/git/refs') { branch = body.sha; value = {}; }
    else if (path === '/git/commits/commit') value = { tree: { sha: options.collision ? 'wrong-tree' : 'new-tree' }, parents: [{ sha: base.sha }], message: commitMessage };
    else if (path === '/pulls') {
      if (method === 'POST') prs = [{ html_url: 'https://github.com/owner/target/pull/9' }];
      value = method === 'POST' ? prs[0] : prs;
    } else throw new Error(`Unexpected API ${method} ${path}`);
    const response = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    Object.defineProperty(response, 'url', { value: url.href }); return response;
  }) as typeof fetch;
  return { repository: new CodingRepository('owner/target', 'test-token', fetcher), calls };
}
it('creates blobs/tree/branch and a closing PR without executing target files, idempotently', async () => {
  const f = fixture(); const output = artifact();
  expect(await f.repository.publish(base, output, 1)).toBe('https://github.com/owner/target/pull/9');
  expect(await f.repository.publish(base, output, 1)).toBe('https://github.com/owner/target/pull/9');
  expect(f.calls.filter(c => c.path === '/pulls' && c.method === 'POST')).toHaveLength(1);
  expect(f.calls.find(c => c.path === '/pulls' && c.method === 'POST')!.body.body).toContain('Closes #1');
  expect(f.calls.find(c => c.path === '/git/trees' && c.method === 'POST')!.body.tree).toEqual([
    { path: 'new.txt', mode: '100644', type: 'blob', sha: 'new-blob' },
    { path: 'delete.txt', mode: '100644', type: 'blob', sha: null }]);
});
it.each([
  [{ moved: true }, 'moved'], [{ truncated: true }, 'truncated'], [{ treeMode: '120000' }, 'Non-regular'],
  [{ sameTree: true }, 'No changes'], [{ transportFailure: true }, 'Unknown error']
] as const)('refuses unsafe or ambiguous publication %j', async (options, message) => {
  const f = fixture(options); await expect(f.repository.publish(base, artifact(), 1)).rejects.toThrow(message);
});
it('refuses deleting a missing file or writing below a base symlink', async () => {
  const f = fixture(); const output = artifact(); output.changes[1]!.path = 'missing.txt';
  await expect(f.repository.publish(base, output, 1)).rejects.toThrow('missing');
  output.changes = [{ path: 'delete.txt/nested.txt', content: 'eA==', mode: '100644' }];
  await expect(f.repository.publish(base, output, 1)).rejects.toThrow('ancestor');
});
it('refuses a conflicting preexisting execution branch', async () => {
  const f = fixture({ collision: true }); const output = artifact();
  await f.repository.publish(base, output, 1);
  await expect(f.repository.publish(base, output, 1)).rejects.toThrow('collision');
});
