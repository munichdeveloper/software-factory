import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { configSchema } from '../src/config/index.js';
import { EventWebhooks, webhookHostAllowed, type Fetch } from '../src/runtime/webhooks.js';
import type { RuntimeEvent } from '../src/runtime/events.js';

const event = (type: RuntimeEvent['type']): RuntimeEvent => ({ key: `${type}:abc`, type, issueNumber: 7, taskVersion: 'v'.repeat(64),
  executionId: 'e'.repeat(32), at: '2026-11-20T08:00:00.000Z', data: { reason: 'CHECK_FAILED' } });
const target = { repositoryId: 1, repository: 'owner/target' };

describe('webhooks of runtime events (issue #188 step 4)', () => {
  it('posts each subscribed event once per rule, signed over the exact body', async () => {
    const fetcher = vi.fn<Fetch>(async () => ({ ok: true, status: 204 }));
    const hooks = new EventWebhooks('s3cret', fetcher, () => { throw new Error('no repeat expected'); });
    hooks.deliver(target, [{ url: 'https://hooks.example.com/sf', events: ['validation_failed'] }, { url: 'https://n8n.example.org/x', events: ['attention_required'] }],
      [event('validation_failed'), event('run_failed')]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.com/sf');
    expect(JSON.parse(init.body)).toEqual({ repository: 'owner/target', repositoryId: 1, event: event('validation_failed') });
    expect(init.headers['x-factory-event']).toBe('validation_failed');
    expect(init.headers['x-factory-delivery']).toBe('1:validation_failed:abc');
    expect(init.headers['x-factory-signature-256']).toBe(`sha256=${createHmac('sha256', 's3cret').update(init.body).digest('hex')}`);
  });
  it('repeats a failed delivery twice, then gives up', async () => {
    const fetcher = vi.fn<Fetch>(async () => ({ ok: false, status: 502 }));
    const delays: number[] = [];
    const hooks = new EventWebhooks('s', fetcher, (run, delay) => { delays.push(delay); run(); });
    hooks.deliver(target, [{ url: 'https://hooks.example.com/sf', events: ['attention_required'] }], [event('attention_required')]);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    await new Promise(r => setTimeout(r, 10));
    expect(fetcher).toHaveBeenCalledTimes(3); expect(delays).toEqual([30_000, 120_000]);
  });
  it('sends nothing unsigned and nothing to internal hosts', async () => {
    const fetcher = vi.fn<Fetch>(async () => ({ ok: true, status: 200 }));
    new EventWebhooks(undefined, fetcher).deliver(target, [{ url: 'https://hooks.example.com/sf', events: ['run_failed'] }], [event('run_failed')]);
    new EventWebhooks('s', fetcher).deliver(target, [{ url: 'https://127.0.0.1/x', events: ['run_failed'] }], [event('run_failed')]);
    await new Promise(r => setTimeout(r, 10));
    expect(fetcher).not.toHaveBeenCalled();
    for (const url of ['https://localhost/x', 'https://10.0.0.5/x', 'https://192.168.1.2/x', 'https://172.20.0.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://runtime-broker:8095/x', 'https://db.internal/x'])
      expect(webhookHostAllowed(url), url).toBe(false);
    expect(webhookHostAllowed('https://n8n.example.org/webhook/abc')).toBe(true);
  });
  it('accepts https rules with known events only, and leaves the configuration hash alone when absent', () => {
    const base = { version: 1, factory: { scope: 'test' } } as const;
    expect(configSchema.safeParse({ ...base, notifications: { webhooks: [{ url: 'https://x.example.com', events: ['attention_required'] }] } }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, notifications: { webhooks: [{ url: 'http://x.example.com', events: ['attention_required'] }] } }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, notifications: { webhooks: [{ url: 'https://x.example.com', events: ['merged'] }] } }).success).toBe(false);
    expect('webhooks' in configSchema.parse(base).notifications).toBe(false);
  });
});
