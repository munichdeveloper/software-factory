import { z } from 'zod';
import type { SanityAlertSink } from '../notifications/sanity-alerts.js';
import type { SubscriptionGate } from './coding-executor.js';

/**
 * Daily cap of coding runs on the Claude subscription (workers.coding.agents entries with credential subscription;
 * Johannes, 2026-11-19). The subscription shares its 5-hour and weekly limits with Johannes' own Claude use, so the
 * Factory takes at most this many runs in any 24 hours across all repositories. Counted are finished runs (stored
 * usage); a run still going when the cap is checked is not, so parallel runs can exceed it by their number.
 */
export const subscriptionMaxRunsPerDay = (env: Record<string, string | undefined>) =>
  z.coerce.number().int().min(0).max(1000).parse(env.FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY || '6');
export interface SubscriptionStore {
  subscriptionRunsSince(from: Date): Promise<number>;
  claimUsageAlert(key: string, kind: string): Promise<boolean>;
}
export class SubscriptionCap implements SubscriptionGate {
  constructor(private store: SubscriptionStore, private max: number, private sink?: SanityAlertSink, private channel?: string,
    private now: () => Date = () => new Date()) {}
  async allowed(repository: string): Promise<boolean> {
    const now = this.now(), runs = await this.store.subscriptionRunsSince(new Date(now.getTime() - 86400000));
    if (runs < this.max) return true;
    console.log(JSON.stringify({ event: 'factory-subscription-cap', repository, runs, max: this.max }));
    // One message per UTC day.
    if (this.sink && this.channel && await this.store.claimUsageAlert(`subscription-cap:${now.toISOString().slice(0, 10)}`, 'subscription')) {
      await this.sink.post(this.channel, [`SF Claude-Abo: Tageslimit erreicht (${runs} von ${this.max} Läufen in 24 Stunden).`,
        `Der Lauf in ${repository} und weitere Läufe nutzen das Abo nicht mehr als Fallback, bis ältere Läufe aus dem 24-Stunden-Fenster fallen.`,
        'Limit änderbar über die Deploy-Variable FACTORY_SUBSCRIPTION_MAX_RUNS_PER_DAY.'].join('\n'));
    }
    return false;
  }
}
