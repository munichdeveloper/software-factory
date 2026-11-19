import { expect, it, vi } from 'vitest';
import { SubscriptionCap, subscriptionMaxRunsPerDay } from '../src/runtime/subscription.js';

it('allows the Claude subscription below the daily cap and reports reaching it once per day', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  let runs = 0; const since: Date[] = [], claims = new Set<string>(), posts: string[] = [];
  const store = { subscriptionRunsSince: async (from: Date) => { since.push(from); return runs; },
    claimUsageAlert: async (key: string, kind: string) => { const id = `${key}:${kind}`; if (claims.has(id)) return false; claims.add(id); return true; } };
  const now = new Date('2026-11-19T12:00:00Z');
  const cap = new SubscriptionCap(store, 3, { post: async (_c, text) => { posts.push(text); } }, 'C1', () => now);
  expect(await cap.allowed('o/r')).toBe(true);
  expect(since[0]).toEqual(new Date('2026-11-18T12:00:00Z'));
  runs = 3;
  expect(await cap.allowed('o/r')).toBe(false);
  expect(await cap.allowed('o/s')).toBe(false);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('Tageslimit erreicht (3 von 3');
  expect(subscriptionMaxRunsPerDay({})).toBe(6);
  expect(subscriptionMaxRunsPerDay({ FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY: '' })).toBe(6);
  expect(subscriptionMaxRunsPerDay({ FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY: '0' })).toBe(0);
  expect(() => subscriptionMaxRunsPerDay({ FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY: 'x' })).toThrow();
});
