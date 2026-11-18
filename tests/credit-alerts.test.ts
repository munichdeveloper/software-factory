import { expect, it } from 'vitest';
import { CreditAlerts, type CreditAlertStore } from '../src/runtime/credit-alerts.js';
import type { AgentSelection } from '../src/runtime/agent-selection.js';

class MemoryStore implements CreditAlertStore {
  rows = new Map<string, { sent: number; last: string | null }>();
  async claimCreditAlert(agent: string, kind: string, executionId: string, limit: number) {
    const row = this.rows.get(`${agent}:${kind}`) ?? { sent: 0, last: null };
    if (row.sent >= limit || row.last === executionId) return null;
    row.sent++; row.last = executionId; this.rows.set(`${agent}:${kind}`, row); return row.sent;
  }
  async resetCreditAlerts(agent: string, kind: string) { const row = this.rows.get(`${agent}:${kind}`); if (row) row.sent = 0; }
}
const selection = (id: string, selected: boolean): AgentSelection => ({ version: 1, executionId: id.repeat(32),
  selected: selected ? { worker: 'codex', model: 'gpt-6.1-sol', effort: 'high' } : null,
  skipped: [{ worker: 'claude', model: 'claude-opus-5-5', effort: 'high', reason: 'exhausted' }] });

it('announces used-up credit at most three times per agent and again after the agent had credit', async () => {
  const posts: string[] = [], store = new MemoryStore();
  const alerts = new CreditAlerts(store, { post: async (_channel, text) => { posts.push(text); } }, 'C1');
  for (const id of ['1', '1', '2', '3', '4', '5']) await alerts.observe('o/r', selection(id, true));
  expect(posts).toHaveLength(3);
  expect(posts[0]).toContain('Claude hat kein Guthaben mehr');
  expect(posts[0]).toContain('läuft stattdessen mit Codex');
  expect(posts[2]).toContain('Meldung 3 von 3');
  await alerts.observe('o/r', { version: 1, executionId: '6'.repeat(32), selected: { worker: 'claude', model: 'claude-opus-5-5', effort: 'high' }, skipped: [] });
  await alerts.observe('o/r', selection('7', false));
  expect(posts).toHaveLength(4);
  expect(posts[3]).toContain('konnte nicht starten');
  expect(posts[3]).toContain('Meldung 1 von 3');
});
