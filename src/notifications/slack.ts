import type { Config } from '../config/index.js';
import type { GitHubPort } from '../github/port.js';
import type { Snapshot } from '../types.js';
import { decodeEvent } from '../state/events.js';
import { hash } from '../state/identity.js';
import { infrastructureFailureSummary } from '../state/reconstruct.js';

export interface Notification { event: 'run_started' | 'issue_created' | 'pr_merged' | 'approval_required' | 'grant_required'; number: number; title: string; actor: string; url: string;
  /** Shown in the message; run starts name their repository because one channel can collect several. */
  repository?: string;
  /** A task can start several runs (retries, rework); each start is its own delivery. */
  executionId?: string;
  /** One approval request of a risk gate; a new head or base asks again and is announced again. */
  approvalId?: string;
  /** A task waits for a grant before its first run, or again after the run named here; each wait is its own delivery. */
  after?: string;
  /** Trusted, Factory-generated detail line (never PR or issue content). */
  detail?: string }
const labels: Record<Notification['event'], string> = {
  run_started: 'SF: Factory-Lauf gestartet', issue_created: 'SF: Issue autonom angelegt', pr_merged: 'SF: PR durch Bot gemergt',
  approval_required: 'SF: PR wartet auf Freigabe (Risiko über Schwelle)', grant_required: 'SF: Issue wartet auf Freigabe (harness:ready)' };
/**
 * A task the Manager's status comment of this reconciliation describes as waiting for nothing but a person's
 * `harness:ready` grant (ready-label repositories). `after` names the run a further attempt follows, if any.
 */
export interface GrantWait { number: number; title: string; after?: string }
// A run start is news only shortly after it happened; older starts are never announced, even without `since`.
const runStartWindowMs = 24 * 60 * 60 * 1000;
// A start this much older than the pass that announces it is a catch-up (first pass after enabling, broker downtime).
const lateStartMs = 10 * 60 * 1000;
type TrustedEvent = NonNullable<ReturnType<typeof decodeEvent>>;
const failureCode = /^[A-Z][A-Z0-9_]{1,79}$/;
const ago = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60000)), hours = Math.floor(minutes / 60);
  return hours ? `${hours} Std.${minutes % 60 ? ` ${minutes % 60} Min.` : ''}` : `${minutes} Min.`;
};
/** How the run before ended, from the Factory's own fields only: status, fixed summaries and fixed error codes (never worker text). */
function previousOutcome(event: TrustedEvent): string {
  if (event.data.type === 'admission_rejected') return `der vorige Start von der Runtime abgelehnt wurde (${event.data.code})`;
  if (event.data.type !== 'result') return 'der vorige Lauf endete';
  const { status, summary, error } = event.data.result;
  const code = error && failureCode.test(error) ? ` (${error})` : '';
  if (summary === infrastructureFailureSummary) return `der vorige Lauf vor dem Start des Agenten scheiterte${code}`;
  if (status === 'failed' && summary.startsWith('Temporal execution ended without a committed worker result')) return 'der vorige Lauf ohne Ergebnis endete';
  return {
    failed: `der vorige Lauf gescheitert ist${code}`, blocked: `der vorige Lauf blockiert war${code}`, cancelled: 'der vorige Lauf abgebrochen wurde',
    needs_approval: 'der vorige Lauf auf eine Freigabe wartete', success: 'der vorige Lauf ein Ergebnis lieferte, das nachgebessert wird'
  }[status];
}
/**
 * Why this run started and whether the message comes late, from trusted journal events of the task only. The detail does
 * not enter the delivery id, so starts announced before this line existed are not announced again.
 */
export function runStartDetail(journal: TrustedEvent[], executionId: string, startedAt: string, now: Date, maxRetries: number): string | undefined {
  const intentOf = (id: string) => journal.find(e => e.data.type === 'intent' && e.data.input.executionId === id);
  const intent = intentOf(executionId), started = Date.parse(startedAt);
  const previous = journal.filter(e => Date.parse(e.at) <= started &&
    ((e.data.type === 'result' && e.data.result.executionId !== executionId) || (e.data.type === 'admission_rejected' && e.data.executionId !== executionId))).at(-1);
  const lines: string[] = [];
  if (intent?.data.type === 'intent') {
    const attempt = intent.data.attempt, version = intent.data.input.taskVersion;
    const previousId = previous?.data.type === 'result' ? previous.data.result.executionId : previous?.data.type === 'admission_rejected' ? previous.data.executionId : undefined;
    const before = previousId ? intentOf(previousId) : undefined;
    const beforeIntent = before?.data.type === 'intent' ? before.data : undefined;
    if (!previous) lines.push('Grund: erster Lauf dieser Aufgabe.');
    else if (beforeIntent && beforeIntent.input.taskVersion !== version) lines.push(`Grund: neuer Lauf für die geänderte Aufgabe, nachdem ${previousOutcome(previous)}.`);
    else if (attempt > 0 && (!beforeIntent || beforeIntent.attempt < attempt)) lines.push(`Grund: Versuch ${attempt + 1} von ${maxRetries + 1}, weil ${previousOutcome(previous)}.`);
    else lines.push(`Grund: neuer Start, weil ${previousOutcome(previous)}${beforeIntent && beforeIntent.attempt === attempt ? ' (zählt nicht als Versuch)' : ''}.`);
  }
  if (now.getTime() - started > lateStartMs) lines.push(`Nachmeldung: Der Lauf startete bereits vor ${ago(now.getTime() - started)}`);
  return lines.length ? lines.join('\n') : undefined;
}
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
    // Titles are untrusted. Plain text and disabled parsing prevent @channel / link injection.
    const text = `${labels[notification.event]}\n${notification.repository ? `Repository: ${notification.repository}\n` : ''}${notification.url}\n` +
      `#${notification.number}: ${notification.title.slice(0, 300)}\n${notification.detail ? `${notification.detail}\n` : ''}Akteur: ${notification.actor}`;
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
  sink: NotificationSink | undefined, correlationId: string, now: Date, grantWaits: GrantWait[] = []): Promise<string[]> {
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
    if (!rule?.enabled) return;
    const channel = rule.channel ?? settings.channel;
    if (!channel || !sink) { errors.push(`Slack ${notification.event}: channel or connection missing`); return; }
    const deliveryId = hash({ repository: github.repository.toLowerCase(), event: notification.event, number: notification.number, channel,
      ...(notification.executionId ? { executionId: notification.executionId } : {}),
      ...(notification.approvalId ? { approvalId: notification.approvalId } : {}),
      ...(notification.event === 'grant_required' ? { after: notification.after ?? null } : {}) });
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
  // A run has started once the runtime (or, legacy, the Actions dispatch) confirmed it with a trusted receipt on its Issue.
  // Intents alone never count: a start can still be refused or fail.
  if (settings.events.run_started?.enabled) for (const task of snapshot.issues) for (const event of events(task.number)) {
    if ((event.data.type !== 'temporal_receipt' && event.data.type !== 'receipt') || !afterStart(event.at) ||
      now.getTime() - Date.parse(event.at) > runStartWindowMs) continue;
    await deliver(task.number, { event: 'run_started', number: task.number, title: task.title, actor: 'Software Factory',
      url: `https://github.com/${github.repository}/issues/${task.number}`, repository: github.repository, executionId: event.data.executionId,
      detail: runStartDetail(events(task.number), event.data.executionId, event.at, now, config.execution.maxRetries) });
  }
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
  // A risk gate asked for `/harness approve` on an open PR. Only the current head counts: a PR that moved on, was
  // merged or closed meanwhile no longer waits for that approval. Approval itself is not checked; a notice for a
  // request that was approved within the same pass is harmless, a missed one is not.
  if (settings.events.approval_required?.enabled) for (const pr of snapshot.prs) {
    if (pr.state !== 'open' || !pr.headSha) continue;
    let comments;
    // An issue-scoped runtime may not read pull requests outside its scope; those cannot carry its approvals.
    try { comments = await github.comments(pr.number); }
    catch (error) { if (error instanceof Error && error.message === 'ISSUE_OUTSIDE_RUNTIME_SCOPE') continue; throw error; }
    for (const c of comments) {
      const e = decodeEvent(c, config.manager.trustedActors);
      if (e?.data.type !== 'merge_approval_required' || e.data.prNumber !== pr.number || e.data.head !== pr.headSha || !afterStart(e.at)) continue;
      await deliver(pr.number, { event: 'approval_required', number: pr.number, title: pr.title ?? `PR #${pr.number}`, actor: 'Software Factory',
        url: `https://github.com/${github.repository}/pull/${pr.number}`, repository: github.repository, approvalId: e.data.approvalId,
        detail: `Risiko ${e.data.riskClass} liegt über der Schwelle ${e.data.autoMergeUpTo}. Freigabe im PR: /harness approve ${e.data.approvalId}` });
    }
  }
  // A task that waits only for a person's `harness:ready` (software-factory#127). The wait is the Manager's own finding of
  // this reconciliation, the same one its status comment states. Each wait is announced once: before the first run, and
  // again only when a further attempt after a run waits for a new grant. No `since` cutoff: a wait is current by definition.
  if (settings.events.grant_required?.enabled) for (const wait of grantWaits) {
    await deliver(wait.number, { event: 'grant_required', number: wait.number, title: wait.title, actor: 'Software Factory',
      url: `https://github.com/${github.repository}/issues/${wait.number}`, repository: github.repository, after: wait.after,
      detail: wait.after ? 'Ein weiterer Versuch wartet nur noch auf die Freigabe: eine berechtigte Person setzt das Label harness:ready.'
        : 'Bereit zum Start, es fehlt nur die Freigabe: eine berechtigte Person setzt das Label harness:ready.' });
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
