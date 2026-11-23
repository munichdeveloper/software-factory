import type { Octokit } from '@octokit/rest';

/**
 * Outcome classes and wait phases of closed managed issues (software-factory#239). The automation rate needs its own
 * base (every closed managed issue, not only merged ones) and the lead time must not count the phases in which an issue
 * waited for a person. Both are derived from GitHub data read ONCE when an issue is found closed (never on every
 * reconcile pass) and stored with the issue (factory_analytics_issues.outcome, factory_analytics_waits).
 */
export const outcomeClasses = ['automatic', 'approved', 'replacement', 'human-merge', 'abandoned'] as const;
export type Outcome = typeof outcomeClasses[number];
export type WaitKind = 'handover' | 'needs-human' | 'approval-gate';
export interface WaitPhase { kind: WaitKind; startedAt: string; endedAt: string }
export interface LabelEvent { at: string; labeled: boolean }

/** What was read from GitHub (and from the store) about one closed issue. */
export interface OutcomeFacts {
  merged: boolean;
  /** The end of everything that can still wait: the merge, else the close. */
  end: string;
  /** The merge was done by the Factory's bot account. */
  mergedByFactory: boolean;
  /** The closing PR was opened by the Factory (its bot, on an `sf/issue-N/…` branch); null without a pull request. */
  openedByFactory: boolean | null;
  /** A person committed to the PR branch. */
  humanCommit: boolean;
  /** `sf:needs-human` events of the pull request (a label still on it counts as applied at any time). */
  prNeedsHuman: LabelEvent[]; prNeedsHumanNow: boolean;
  /** `sf:needs-human` events of the task issue. */
  issueNeedsHuman: LabelEvent[];
  /** `harness:awaiting-approval` events of the task issue (the Manager approval gate). */
  gate: LabelEvent[];
  /** Instants of `/harness approve` comments on the pull request and the issue. */
  approvals: string[];
  /** When the merge pass handed the pull request to a person (recorded by the broker); null where unknown. */
  handoverAt: string | null;
  /** The Factory ran at least once for the issue. */
  hadRun: boolean;
}
export interface DerivedOutcome { outcome: Outcome | null; waits: WaitPhase[] }

const ms = (at: string) => Date.parse(at);
/** Intervals from a label's applied/removed events; a label still on at `end` waits until `end`. */
function labelIntervals(events: LabelEvent[], end: string): [string, string][] {
  const out: [string, string][] = [];
  let open: string | null = null;
  for (const e of [...events].sort((a, b) => ms(a.at) - ms(b.at))) {
    if (e.labeled) open ??= e.at;
    else if (open !== null) { out.push([open, e.at]); open = null; }
  }
  if (open !== null) out.push([open, end]);
  return out;
}
/** Outcome class and wait phases of a closed issue; see the table in software-factory#239. */
export function deriveOutcome(f: OutcomeFacts): DerivedOutcome {
  const approvals = [...f.approvals].sort((a, b) => ms(a) - ms(b));
  const decidedAfter = (start: string, end: string) => { const a = approvals.find(at => ms(at) >= ms(start)); return a !== undefined && ms(a) < ms(end) ? a : end; };
  const waits: WaitPhase[] = [];
  const add = (kind: WaitKind, startedAt: string, endedAt: string) => {
    const e = ms(endedAt) > ms(f.end) ? f.end : endedAt;
    if (ms(e) > ms(startedAt)) waits.push({ kind, startedAt, endedAt: e });
  };
  if (f.handoverAt) add('handover', f.handoverAt, decidedAfter(f.handoverAt, f.end));
  for (const [s, e] of [...labelIntervals(f.prNeedsHuman, f.end), ...labelIntervals(f.issueNeedsHuman, f.end)]) add('needs-human', s, e);
  for (const [s, e] of labelIntervals(f.gate, f.end)) add('approval-gate', s, decidedAfter(s, e));
  waits.sort((a, b) => ms(a.startedAt) - ms(b.startedAt) || a.kind.localeCompare(b.kind));

  if (!f.merged) return { outcome: f.hadRun ? 'abandoned' : null, waits };
  const needsHuman = f.prNeedsHumanNow || f.prNeedsHuman.some(e => e.labeled);
  // A person's commit on a Factory pull request is a human intervention too; on a replacement PR commits are expected.
  if (!f.mergedByFactory || needsHuman || (f.openedByFactory === true && f.humanCommit)) return { outcome: 'human-merge', waits };
  if (f.openedByFactory === false) return { outcome: 'replacement', waits };
  const approved = f.gate.some(e => e.labeled) || approvals.some(at => ms(at) <= ms(f.end));
  return { outcome: approved ? 'approved' : 'automatic', waits };
}

/** Length of the union of the phases, limited to [from, to]: overlapping phases count once. */
export function waitMs(waits: readonly { startedAt: string; endedAt: string }[], from: string | null, to: string): number {
  const lo = from === null ? -Infinity : ms(from), hi = ms(to);
  const spans = waits.map(w => [Math.max(ms(w.startedAt), lo), Math.min(ms(w.endedAt), hi)] as const).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0, cursor = -Infinity;
  for (const [s, e] of spans) { const start = Math.max(s, cursor); if (e > start) { total += e - start; cursor = e; } }
  return total;
}

/** An issue closed and not yet derived, as the store holds it. */
export interface PendingOutcome {
  issueNumber: number; prNumber: number | null; mergedAt: string | null; mergedBy: 'factory' | 'human' | null; handoverAt: string | null; hadRun: boolean;
}
export interface OutcomeResult extends DerivedOutcome { closedAt: string | null; requests: number }
export interface OutcomeReader { read(issue: PendingOutcome): Promise<OutcomeResult> }

const approveComment = /^\/harness approve [a-f0-9]{64}$/;
const isBot = (login: string | undefined | null, type?: string | null) => type === 'Bot' || !!login?.endsWith('[bot]');
/** Reads the GitHub side of an issue's outcome: at most 2 + 4 lists of `maxPages` pages (default 2) of 100, usually 6 requests. */
export class GitHubOutcomeReader implements OutcomeReader {
  constructor(private api: Octokit, private owner: string, private repo: string, private maxPages = 2, private now: () => Date = () => new Date()) {}
  async read(issue: PendingOutcome): Promise<OutcomeResult> {
    let requests = 0;
    const target = { owner: this.owner, repo: this.repo };
    const take = async <T>(pages: AsyncIterable<{ data: T[] }>): Promise<T[]> => {
      const out: T[] = []; let n = 0;
      for await (const page of pages) { requests++; out.push(...page.data); if (++n >= this.maxPages) break; }
      return out;
    };
    const labelEvents = (events: { event: string; created_at: string; label?: { name?: string } | null }[], label: string): LabelEvent[] =>
      events.filter(e => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === label).map(e => ({ at: e.created_at, labeled: e.event === 'labeled' }));
    const issueEvents = await take(this.api.paginate.iterator(this.api.issues.listEvents, { ...target, issue_number: issue.issueNumber, per_page: 100 }));
    const issueComments = await take(this.api.paginate.iterator(this.api.issues.listComments, { ...target, issue_number: issue.issueNumber, per_page: 100 }));
    const approvals = (comments: { body?: string; created_at: string }[]) => comments.filter(c => approveComment.test((c.body ?? '').trim())).map(c => c.created_at);
    const closedAt = issueEvents.filter(e => e.event === 'closed').map(e => e.created_at).sort().at(-1) ?? null;
    const merged = issue.mergedAt !== null;
    let pr: { openedByFactory: boolean; humanCommit: boolean; events: LabelEvent[]; now: boolean; approvals: string[] } | null = null;
    if (issue.prNumber !== null && merged) {
      const data = (await this.api.pulls.get({ ...target, pull_number: issue.prNumber })).data; requests++;
      const commits = await take(this.api.paginate.iterator(this.api.pulls.listCommits, { ...target, pull_number: issue.prNumber, per_page: 100 }));
      const events = await take(this.api.paginate.iterator(this.api.issues.listEvents, { ...target, issue_number: issue.prNumber, per_page: 100 }));
      const comments = await take(this.api.paginate.iterator(this.api.issues.listComments, { ...target, issue_number: issue.prNumber, per_page: 100 }));
      pr = { openedByFactory: isBot(data.user?.login, data.user?.type) && data.head.ref.startsWith('sf/issue-'),
        // A commit without a linked GitHub account counts as a person's unless its name says it is a bot.
        humanCommit: commits.some(c => c.author ? !isBot(c.author.login, c.author.type) : !isBot(c.commit.author?.name)),
        events: labelEvents(events, 'sf:needs-human'), now: data.labels.some(l => (typeof l === 'string' ? l : l.name) === 'sf:needs-human'), approvals: approvals(comments) };
    }
    const end = issue.mergedAt ?? closedAt ?? this.now().toISOString();
    const derived = deriveOutcome({ merged, end, mergedByFactory: issue.mergedBy === 'factory', openedByFactory: pr?.openedByFactory ?? null,
      humanCommit: pr?.humanCommit ?? false, prNeedsHuman: pr?.events ?? [], prNeedsHumanNow: pr?.now ?? false,
      issueNeedsHuman: labelEvents(issueEvents, 'sf:needs-human'), gate: labelEvents(issueEvents, 'harness:awaiting-approval'),
      approvals: [...approvals(issueComments), ...pr?.approvals ?? []], handoverAt: issue.handoverAt, hadRun: issue.hadRun });
    return { ...derived, closedAt: merged ? issue.mergedAt : closedAt, requests };
  }
}
