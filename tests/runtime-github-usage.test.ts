import { expect, it } from 'vitest';
import { GitHubUsage } from '../src/runtime/github-app.js';

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
    failures: { 403: 1 }, limits: { 'core@16:06': { used: 571, remaining: 4429 }, 'core@15:34': { used: 5000, remaining: 0 } } });
  expect(usage.flush()).toBeNull();
});
