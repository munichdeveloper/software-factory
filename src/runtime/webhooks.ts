import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { RuntimeEvent } from './events.js';

/**
 * Webhook delivery of runtime events (docs/failure-events.md 5.2, issue #188 step 4). A subscriber such as a Claude
 * project thread or n8n gets a signed POST for each new event its rule names:
 *
 *   X-Factory-Event: <type>, X-Factory-Delivery: <repositoryId>:<event key>,
 *   X-Factory-Signature-256: sha256=<hex HMAC-SHA256 of the raw body with FACTORY_WEBHOOK_SECRET>
 *
 * The body is `{ repository, repositoryId, event }`; events carry fixed codes and numbers only. One secret signs every
 * delivery (deploy secret BROKER_WEBHOOK_SECRET); without it nothing is sent, so no unsigned request ever leaves the broker.
 * A failed delivery is repeated after 30 s and 2 min, then given up. Every attempt is logged.
 */
export interface WebhookRule { url: string; events: readonly string[] }
export const webhookRetryDelaysMs = [30_000, 120_000] as const;
const timeoutMs = 10_000;

/** Hosts a configured webhook may not name: loopback, private and link-local addresses, and internal names. */
export function webhookHostAllowed(url: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) return false;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) return false;
  return true;
}

export const signature = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

export type Fetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
type Schedule = (run: () => void, delayMs: number) => void;

export class EventWebhooks {
  constructor(private secret: string | undefined, private fetcher: Fetch = (url, init) => fetch(url, init),
    private schedule: Schedule = (run, delay) => { setTimeout(run, delay).unref(); }) {}
  /** Sends every event to every rule that names its type. Returns at once; deliveries and their repeats run on their own. */
  deliver(target: { repositoryId: number; repository: string }, rules: readonly WebhookRule[] | undefined, events: readonly RuntimeEvent[]) {
    if (!rules?.length || !events.length) return;
    if (!this.secret) {
      console.warn(JSON.stringify({ event: 'factory-webhook-skipped', repositoryId: target.repositoryId, reason: 'FACTORY_WEBHOOK_SECRET missing' }));
      return;
    }
    for (const [index, rule] of rules.entries()) {
      if (!webhookHostAllowed(rule.url)) continue;
      for (const e of events) if (rule.events.includes(e.type)) void this.attempt(target, index, rule.url, e, 0);
    }
  }
  private async attempt(target: { repositoryId: number; repository: string }, rule: number, url: string, e: RuntimeEvent, attempt: number): Promise<void> {
    const body = JSON.stringify({ repository: target.repository, repositoryId: target.repositoryId, event: e });
    let status: number | null = null, ok = false;
    try {
      const response = await this.fetcher(url, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs), headers: {
        'content-type': 'application/json', 'user-agent': 'software-factory-broker', 'x-factory-event': e.type,
        'x-factory-delivery': `${target.repositoryId}:${e.key}`, 'x-factory-signature-256': signature(this.secret!, body) } });
      status = response.status; ok = response.ok;
    } catch { /* network error or timeout: repeated below */ }
    const retryIn = ok ? undefined : webhookRetryDelaysMs[attempt];
    // The URL may hold a token in its path or query; the log names the rule by its position only.
    console.log(JSON.stringify({ event: 'factory-webhook-delivery', repositoryId: target.repositoryId, rule, type: e.type, key: e.key,
      attempt: attempt + 1, status, ok, ...(retryIn !== undefined ? { retryInMs: retryIn } : {}) }));
    if (retryIn !== undefined) this.schedule(() => { void this.attempt(target, rule, url, e, attempt + 1); }, retryIn);
  }
}
