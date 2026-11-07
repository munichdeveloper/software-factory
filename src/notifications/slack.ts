import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import type { Snapshot } from '../types.js';
import { decodeEvent } from '../state/events.js';
import { hash } from '../state/identity.js';

export interface Notification { event: 'issue_created' | 'pr_merged'; number: number; title: string; actor: string; url: string }
export interface NotificationSink { send(channel: string, notification: Notification): Promise<{ channel: string; timestamp: string }> }
// Only a definite rejection permits automatic retry. Transport/response failures are ambiguous.
export class NotificationRejected extends Error {}
const httpStatus = (error: unknown) => {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
};

export class SlackSink implements NotificationSink {
  private lastCall = 0;
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async checkConnection(): Promise<void> {
    try {
      if (!this.token) throw new Error('Missing token');
      const response = await this.fetcher('https://slack.com/api/auth.test', { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${this.token}` } });
      if (!response.ok) throw new Error('Slack authentication failed');
      const result = await response.json() as { ok?: boolean; bot_id?: string };
      if (!result.ok || !result.bot_id) throw new Error('Bot token required');
    } catch { throw new Error('Slack connection failed: check SLACK_BOT_TOKEN and Slack app installation'); }
  }
  async send(channel: string, notification: Notification) {
    if (!this.token) throw new Error('Slack token missing');
    const delay = this.lastCall + 1100 - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    this.lastCall = Date.now();
    const label = notification.event === 'issue_created' ? 'SF: Issue autonom angelegt' : 'SF: PR durch Bot gemergt';
    // Titles are untrusted. Plain text and disabled parsing prevent @channel / link injection.
    const text = `${label}\n${notification.url}\n#${notification.number}: ${notification.title.slice(0, 300)}\nAkteur: ${notification.actor}`;
    try {
      const response = await this.fetcher('https://slack.com/api/chat.postMessage', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
          blocks: [{ type: 'section', text: { type: 'plain_text', text, emoji: false } }],
          mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false })
      });
      if (response.status === 429) throw new NotificationRejected('Slack rate limited');
      if (!response.ok) throw new Error('Slack delivery failed');
      const result = await response.json() as { ok?: boolean; channel?: string; ts?: string };
      if (result.ok === false) throw new NotificationRejected('Slack rejected the message');
      if (!result.ok || !result.channel || !result.ts || result.channel.length > 100 || result.ts.length > 100) throw new Error('Slack delivery failed');
      return { channel: result.channel, timestamp: result.ts };
    } catch (error) {
      if (error instanceof NotificationRejected) throw error;
      // eslint-disable-next-line preserve-caught-error -- Provider errors can contain credentials; never attach them.
      throw new Error('Slack delivery failed; check token, bot membership and API availability');
    }
  }
}

// Only native GitHub facts plus trusted SF provenance can produce notifications.
// No planner/model field selects the channel or supplies arbitrary message payloads.
export async function deliverNotifications(github: GitHubPort, config: Config, snapshot: Snapshot,
  sink: NotificationSink | undefined, correlationId: string, now: Date): Promise<string[]> {
  const settings = config.notifications.slack;
  if (!settings.enabled || !config.factory.enabled || config.execution.dryRun || config.autonomy.profile === 'advisory') return [];
  const errors: string[] = [];
  let attempts = 0;
  const events = (issue: number) => (snapshot.comments.get(issue) ?? []).flatMap(c => {
    const event = decodeEvent(c, config.manager.trustedActors); return event ? [event] : [];
  });
  const afterStart = (date: string | undefined) => !settings.since || (!!date && Date.parse(date) >= Date.parse(settings.since));
  const deliver = async (journal: number, notification: Notification) => {
    const rule = settings.events[notification.event];
    if (!rule.enabled) return;
    const channel = rule.channel ?? settings.channel;
    if (!channel || !sink) { errors.push(`Slack ${notification.event}: channel or connection missing`); return; }
    const deliveryId = hash({ repository: github.repository.toLowerCase(), event: notification.event, number: notification.number, channel });
    // Re-read to handle repeated manager runs and duplicate PR links across tasks.
    const deliveries = (await github.comments(journal)).flatMap(c => {
      const e = decodeEvent(c, config.manager.trustedActors);
      return e && 'deliveryId' in e.data && e.data.deliveryId === deliveryId ? [e] : [];
    });
    if (deliveries.some(e => e.data.type === 'notification_sent')) return;
    if (deliveries.at(-1)?.data.type === 'notification_attempt') {
      errors.push(`Slack ${notification.event} #${notification.number}: previous delivery unconfirmed; inspect Slack and reconcile journal #${journal}; automatic resend blocked`); return;
    }
    if (attempts >= settings.maxPerRun) return;
    attempts++;
    const event = (type: 'notification_attempt' | 'notification_rejected') => github.writeEvent(journal, {
      version: 1, key: `${type}:${deliveryId}`, at: now.toISOString(), correlationId, data: { type, deliveryId }
    });
    try {
      await event('notification_attempt');
    } catch (error) {
      errors.push(`Slack ${notification.event} #${notification.number}: cannot persist delivery attempt on #${journal}${httpStatus(error)}; nothing sent; check GitHub comment write permissions`); return;
    }
    let receipt;
    try { receipt = await sink.send(channel, notification); }
    catch (error) {
      if (error instanceof NotificationRejected) {
        try { await event('notification_rejected'); }
        catch (writeError) { errors.push(`Slack ${notification.event} #${notification.number}: rejection receipt failed${httpStatus(writeError)}; automatic resend blocked`); return; }
        errors.push(`Slack ${notification.event} #${notification.number}: provider rejected delivery; retry next manager run`);
      } else errors.push(`Slack ${notification.event} #${notification.number}: delivery unconfirmed; inspect Slack and reconcile journal #${journal}; automatic resend blocked`);
      return;
    }
    try {
      await github.writeEvent(journal, { version: 1, key: `notification:${deliveryId}`, at: now.toISOString(), correlationId,
        data: { type: 'notification_sent', deliveryId, channel: receipt.channel, timestamp: receipt.timestamp } });
    } catch (error) { errors.push(`Slack ${notification.event} #${notification.number}: Slack accepted delivery but receipt persistence failed${httpStatus(error)} on #${journal}; automatic resend blocked`); }
  };
  for (const parent of snapshot.issues) {
    const trusted = events(parent.number);
    if (settings.events.issue_created.enabled) for (const event of trusted) {
      if (event.data.type !== 'issue_creation_intent') continue;
      const intent = event.data;
      const created = snapshot.issues.find(i => i.authorType === 'Bot' && afterStart(i.createdAt) &&
        i.body.includes(`<!-- harness:followup:${intent.followupKey} -->`) &&
        i.body.includes(`Origin: #${parent.number}\nDecision: ${intent.actionId}\n`));
      if (created) await deliver(parent.number, { event: 'issue_created', number: created.number, title: created.title,
        actor: 'Software Factory', url: `https://github.com/${github.repository}/issues/${created.number}` });
    }
  }
  if (settings.events.pr_merged.enabled) for (const pr of snapshot.prs) {
    if (!pr.merged || pr.mergedBy?.type !== 'Bot' || !afterStart(pr.mergedAt) ||
      (settings.events.pr_merged.actors.length && !settings.events.pr_merged.actors.includes(pr.mergedBy.login))) continue;
    const nativeComments = await github.comments(pr.number);
    const mergedByFactory = nativeComments.some(c => {
      const e = decodeEvent(c, config.manager.trustedActors);
      return e?.data.type === 'merge_intent' && e.data.prNumber === pr.number && e.data.head === pr.headSha;
    });
    const parent = snapshot.issues.find(i => events(i.number).some(e => e.data.type === 'result' &&
      pr.headRefName === `sf/issue-${i.number}/${e.data.result.executionId}` &&
      e.data.result.artifacts.includes(`https://github.com/${github.repository}/pull/${pr.number}`)));
    const journal = mergedByFactory ? pr.number : parent?.number;
    if (journal !== undefined) await deliver(journal, { event: 'pr_merged', number: pr.number, title: pr.title ?? `PR #${pr.number}`,
      actor: pr.mergedBy.login, url: `https://github.com/${github.repository}/pull/${pr.number}` });
  }
  return errors;
}
