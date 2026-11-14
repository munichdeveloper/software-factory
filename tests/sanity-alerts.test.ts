import { expect, it, vi } from 'vitest';
import { SlackSanityAlerts, sanityText } from '../src/notifications/sanity-alerts.js';

it('sends plain text with parsing off and reports only a fixed error', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
  await new SlackSanityAlerts('xoxb-token', fetcher as unknown as typeof fetch).post('#factory', 'a <!channel> & b');
  const body = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
  expect(body).toMatchObject({ channel: '#factory', text: 'a &lt;!channel&gt; &amp; b', parse: 'none', link_names: false, mrkdwn: false });
  const failing = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth xoxb-token' })));
  await expect(new SlackSanityAlerts('xoxb-token', failing as unknown as typeof fetch).post('#factory', 'x')).rejects.toThrow(/^SLACK_DELIVERY_FAILED$/);
});

it('caps long lists', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, kind: 'run_stuck' as const, issueNumber: i + 1, detail: 'd' }));
  const text = sanityText('o/r', many, []);
  expect(text).toContain('… und 5 weitere');
  expect(text.split('\n').filter(l => l.startsWith('•'))).toHaveLength(20);
});
