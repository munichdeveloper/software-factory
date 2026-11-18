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
const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** Slack messages about coding agents whose provider reported used-up credit before a run. */
export class CreditAlerts {
  constructor(private store: CreditAlertStore, private sink: SanityAlertSink, private channel: string, private limit = creditAlertLimit) {}
  async observe(repository: string, selection: AgentSelection): Promise<void> {
    // An agent that ran has credit again: a later shortage is announced anew.
    if (selection.selected) await this.store.resetCreditAlerts(selection.selected.worker, 'exhausted');
    for (const skipped of selection.skipped.filter(s => s.reason === 'exhausted')) {
      const number = await this.store.claimCreditAlert(skipped.worker, 'exhausted', selection.executionId, this.limit);
      if (number === null) continue;
      const next = selection.selected ? `Der Lauf in ${repository} läuft stattdessen mit ${names[selection.selected.worker]} (${selection.selected.model}).`
        : `Kein Agent der Liste hat Guthaben: der Lauf in ${repository} konnte nicht starten.`;
      await this.sink.post(this.channel, [`SF Guthaben: ${names[skipped.worker]} hat kein Guthaben mehr (Anbieter meldet aufgebrauchtes Kontingent bei ${skipped.model}).`,
        next, 'Bitte Guthaben aufladen.', `(Meldung ${number} von ${this.limit}; danach erst wieder, wenn ${names[skipped.worker]} erneut Guthaben hatte.)`].join('\n'));
    }
  }
}
