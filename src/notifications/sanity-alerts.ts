import type { Finding, FindingKind } from '../runtime/sanity.js';

const labels: Record<FindingKind, string> = {
  run_stuck: 'Lauf hängt', approval_waiting: 'Lauf wartet lange auf Freigabe', run_orphaned: 'Verwaister Lauf',
  dispatch_unresolved: 'Start eines Laufs unbestätigt', retries_exhausted: 'Retries ausgeschöpft', repeated_failure: 'Endlos-Retry',
  blocked_without_pr: 'Blockiert ohne PR', dependency_cycle: 'Deadlock: Abhängigkeitszyklus', status_stalled: 'Status stellt sich nicht ein',
  reconcile_failing: 'Abgleich scheitert wiederholt',
};

/** The text of one sanity message: what opened and what resolved in one reconciliation of one repository. */
export function sanityText(repository: string, opened: Finding[], resolved: Finding[]): string {
  const line = (f: Finding) => `• ${labels[f.kind]}${f.issueNumber === null ? '' : ` – https://github.com/${repository}/issues/${f.issueNumber}`}`;
  return [`SF Sanity-Check: ${repository}`,
    ...(opened.length ? ['Neue Probleme:', ...opened.slice(0, 20).flatMap(f => [line(f), `  ${f.detail}`])] : []),
    ...(opened.length > 20 ? [`… und ${opened.length - 20} weitere`] : []),
    ...(resolved.length ? ['Behoben:', ...resolved.slice(0, 20).map(line)] : []),
    ...(resolved.length > 20 ? [`… und ${resolved.length - 20} weitere`] : []),
  ].join('\n').slice(0, 2900);
}

export interface SanityAlertSink { post(channel: string, text: string): Promise<void> }

/** Posts sanity messages with the broker's Slack bot. Plain text with parsing off: no mentions or links are expanded. */
export class SlackSanityAlerts implements SanityAlertSink {
  private lastCall = 0;
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async post(channel: string, text: string): Promise<void> {
    const delay = this.lastCall + 1100 - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    this.lastCall = Date.now();
    let ok: boolean;
    try {
      const response = await this.fetcher('https://slack.com/api/chat.postMessage', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
          blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
          mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false }) });
      ok = response.ok && (await response.json() as { ok?: boolean }).ok === true;
    } catch { ok = false; }
    // Provider errors can carry credentials: only a fixed message leaves this method.
    if (!ok) throw new Error('SLACK_DELIVERY_FAILED');
  }
}
