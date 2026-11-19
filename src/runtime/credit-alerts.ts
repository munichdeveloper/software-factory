import type { AgentSelection } from './agent-selection.js';
import type { SanityAlertSink } from '../notifications/sanity-alerts.js';

/** At most this many Slack messages per agent and kind, until the agent has credit again (Johannes, 2026-11-18). */
export const creditAlertLimit = 3;
export type CreditAlertKind = 'exhausted';
export interface CreditAlertStore {
  /** Claims the next message for this agent and kind; null when the limit is reached or this execution already sent one. */
  claimCreditAlert(agent: string, kind: CreditAlertKind, executionId: string, limit: number): Promise<number | null>;
  resetCreditAlerts(agent: string, kind: CreditAlertKind): Promise<void>;
}
const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', 'claude-subscription': 'das Claude-Abo' };
/** The subscription is its own agent for alerts: its limits are not the API key's credit. */
const key = (agent: { worker: string; credential?: string }) => agent.credential === 'subscription' ? 'claude-subscription' : agent.worker;

/** Slack messages about coding agents whose provider reported used-up credit before a run. */
export class CreditAlerts {
  constructor(private store: CreditAlertStore, private sink: SanityAlertSink, private channel: string, private limit = creditAlertLimit) {}
  async observe(repository: string, selection: AgentSelection): Promise<void> {
    // An agent that ran has credit again: a later shortage is announced anew.
    if (selection.selected) await this.store.resetCreditAlerts(key(selection.selected), 'exhausted');
    for (const skipped of selection.skipped.filter(s => s.reason === 'exhausted')) {
      const number = await this.store.claimCreditAlert(key(skipped), 'exhausted', selection.executionId, this.limit);
      if (number === null) continue;
      const next = selection.selected ? `Der Lauf in ${repository} läuft stattdessen mit ${names[key(selection.selected)]} (${selection.selected.model}).`
        : `Kein Agent der Liste hat Guthaben: der Lauf in ${repository} konnte nicht starten.`;
      const subscription = skipped.credential === 'subscription';
      await this.sink.post(this.channel, [subscription
        ? `SF Guthaben: das Claude-Abo hat sein Nutzungslimit erreicht (5-Stunden- oder Wochenfenster, bei ${skipped.model}).`
        : `SF Guthaben: ${names[skipped.worker]} hat kein Guthaben mehr (Anbieter meldet aufgebrauchtes Kontingent bei ${skipped.model}).`,
        next, subscription ? 'Das Abo steht wieder zur Verfügung, sobald das Limit zurückgesetzt ist.' : 'Bitte Guthaben aufladen.',
        `(Meldung ${number} von ${this.limit}; danach erst wieder, wenn ${names[key(skipped)]} erneut lief.)`].join('\n'));
    }
    // Every run the subscription takes over is announced: it uses Johannes' own Claude limits.
    if (selection.selected?.credential === 'subscription')
      await this.sink.post(this.channel, [`SF Claude-Abo springt ein: der Lauf in ${repository} läuft mit dem Claude-Abo (${selection.selected.model}, ${selection.selected.effort}),`,
        `weil ${selection.skipped.map(s => `${names[key(s)]} (${s.reason === 'exhausted' ? 'kein Guthaben' : s.reason === 'missing-key' ? 'kein Schlüssel' : 'Schlüssel abgelehnt'})`).join(' und ')} nicht laufen konnte.`,
        'Der Lauf zählt gegen dein 5-Stunden- und Wochenlimit; die Kosten im Verbrauchsbericht sind nur rechnerisch.'].join('\n'));
  }
}
