import { expect, it } from 'vitest';
import { ConditionalCache, GitHubUsage } from '../src/runtime/github-app.js';

it('counts requests per route template and keeps every limit window GitHub reports', () => {
  const usage = new GitHubUsage();
  expect(usage.flush()).toBeNull();
  const window = (used: number, reset: number) => ({ 'x-ratelimit-used': String(used), 'x-ratelimit-remaining': String(5000 - used), 'x-ratelimit-reset': String(reset), 'x-ratelimit-resource': 'core' });
  usage.record('GET /repos/{owner}/{repo}/issues/{issue_number}', window(570, 1794499586));
  usage.record('GET /repos/{owner}/{repo}/issues/{issue_number}', window(571, 1794499586));
  usage.record('GET /repos/{owner}/{repo}/collaborators/{username}/permission', window(5000, 1794497666), 403);
  usage.record('POST /graphql', {});
  expect(usage.flush()).toEqual({ event: 'github-requests', total: 4,
    routes: { 'GET /repos/{owner}/{repo}/issues/{issue_number}': 2, 'GET /repos/{owner}/{repo}/collaborators/{username}/permission': 1, 'POST /graphql': 1 },
    notModified: 0, failures: { 403: 1 }, limits: { 'core@16:06': { used: 571, remaining: 4429 }, 'core@15:34': { used: 5000, remaining: 0 } } });
  expect(usage.flush()).toBeNull();
});

it('bounds the conditional cache by size, evicts the least recently used answer and hands out copies', () => {
  const answer = (n: number) => ({ status: 200, url: `u${n}`, headers: { etag: `"${n}"` }, data: { text: 'x'.repeat(250), n } });
  const one = JSON.stringify(answer(1)).length;
  const cache = new ConditionalCache(one * 8 + 10);
  for (let n = 1; n <= 8; n++) cache.store(`k${n}`, `"${n}"`, answer(n));
  // The budget holds eight; the ninth pushes out the least recently used one, and k1 was read since.
  expect(cache.stats().entries).toBe(8);
  const hit = cache.cached<ReturnType<typeof answer>>('k1')!;
  expect(hit.data.n).toBe(1);
  hit.data.n = 99;
  expect(cache.cached<ReturnType<typeof answer>>('k1')!.data.n).toBe(1);
  cache.store('k9', '"9"', answer(9));
  expect(cache.etag('k1')).toBe('"1"');
  expect(cache.etag('k2')).toBeUndefined();
  expect(cache.stats().entries).toBe(8);
  // Too large for the budget, binary, or without an ETag: not cached, and an older answer for the key is dropped.
  cache.store('k3', '"big"', { data: 'y'.repeat(one * 2) });
  expect(cache.etag('k3')).toBeUndefined();
  cache.store('k4', '"bin"', { data: new ArrayBuffer(8) });
  expect(cache.etag('k4')).toBeUndefined();
  cache.store('k5', undefined, answer(5));
  expect(cache.etag('k5')).toBeUndefined();
  expect(cache.stats().entries).toBe(5);
});
