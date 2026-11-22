import type { Snapshot } from '../types.js';
import { hash } from '../state/identity.js';

/**
 * Cost analytics for software-factory-monitor (Johannes, 2026-11-19): what each issue cost until its pull request was
 * merged, cost per merged feature, cost per step (coding, review, risk, planner) and which models did the work, chosen
 * by the model router (Jev) or configured. Every attempt of an issue counts towards it, also discarded ones ("komplette
 * Kosten"); only inference cost is counted (Jev's routing requests and Actions minutes are not).
 *
 * Calls come from factory_runtime_usage (coding) and factory_analytics_calls (broker calls); titles and merges from the
 * snapshots each reconciliation already fetched (no extra GitHub request). The view is served at GET /v1/analytics to
 * the monitor token, like the job queue; it carries issue titles and is never sent to Slack or logs.
 */
export type AnalyticsStep = 'coding' | 'review' | 'risk' | 'planner';
export interface AnalyticsTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface AnalyticsCall {
  repository: string; step: AnalyticsStep; issueNumber: number | null; prNumber: number | null; executionId: string | null;
  selection: 'router' | 'configured' | 'escalation'; routerChoice: string | null; routerProbability: number | null;
  /** The coding agent (claude, codex, claude-subscription) or the broker's provider (claude, openai). */
  agent: string; model: string; effort: string | null; tokens: AnalyticsTokens | null; costUsd: number | null; outcome: string | null; at: string;
  /** Where the price came from: live (price list at the time of the call), table, configured, agent (the coding agent's own estimate); null for older rows. */
  priceSource?: string | null;
  /** How long a coding run took, as its agent reported it; null for broker calls and older rows. */
  durationMs?: number | null;
}
export interface AnalyticsIssue {
  issueNumber: number; title: string; state: 'open' | 'closed'; prNumber: number | null; mergedAt: string | null; mergedBy: 'factory' | 'human' | null;
  /**
   * When the Factory took the issue in (metrics page): `harness:managed` applied, and in a repository where
   * `harness:ready` is a person's grant also `harness:ready`, whichever came last. Null where the timeline was not read
   * (settled issues); the store keeps the earliest instant it ever saw.
   */
  qualifiedAt?: string | null;
  /** When the merge pass first handed the issue's pull request to a person (risk above the threshold, approval required). */
  handoverAt?: string | null;
}
/** A recorded merge review decision (factory_analytics_verdicts), for the router evaluation. */
export interface AnalyticsVerdict { repository: string; step: string; prNumber: number | null; issueNumber: number | null; decision: string; rejected: boolean; at: string }
export const tokensOf = (value: unknown): AnalyticsTokens | null => {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>, n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return { input: n(t.input), output: n(t.output), cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite) };
};

/** Merge pass steps at which a pull request waits for a person to merge or approve it. */
export const handoverSteps: ReadonlySet<string> = new Set(['handover', 'approval-required']);
/** When an issue counts as taken in: see AnalyticsIssue.qualifiedAt. */
export function qualifiedAt(issue: Snapshot['issues'][number], readyIsGrant: boolean): string | null {
  if (!issue.managedAt) return null;
  // Not taken in before the grant: an issue with only harness:managed waits for its person's harness:ready.
  if (!readyIsGrant) return issue.managedAt;
  return issue.readyAt ? (issue.readyAt > issue.managedAt ? issue.readyAt : issue.managedAt) : null;
}
/** The managed issues of a snapshot with the pull request that closed them, if one was merged. */
export function analyticsIssues(snapshot: Snapshot, mergeBot: (login: string) => boolean = login => login.endsWith('[bot]'),
  handovers: ReadonlyMap<number, string> = new Map()): AnalyticsIssue[] {
  return snapshot.issues.map(issue => {
    const closing = snapshot.prs.filter(p => p.closingIssues.includes(issue.number));
    const merged = closing.filter(p => p.merged).sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0];
    const handoverAt = closing.flatMap(p => handovers.get(p.number) ?? []).sort()[0] ?? null;
    return { issueNumber: issue.number, title: issue.title.slice(0, 300), state: issue.state, prNumber: merged?.number ?? null, mergedAt: merged?.mergedAt ?? null,
      mergedBy: merged ? (merged.mergedBy && mergeBot(merged.mergedBy.login) ? 'factory' : 'human') : null,
      qualifiedAt: qualifiedAt(issue, !!snapshot.readyIsGrant), handoverAt };
  });
}
export interface ObservedMerge { pullRequest: number; step: string; at: string }
export interface AnalyticsIssueStore { upsertAnalyticsIssues(repository: string, issues: AnalyticsIssue[]): Promise<void> }
/** Writes the issues of each reconciliation that changed since the last one this broker wrote. Never throws. */
export class AnalyticsIssueSync {
  private seen = new Map<string, string>();
  /** The first instant this broker saw each pull request handed to a person (merge progress `at` moves on every pass). */
  private handovers = new Map<string, Map<number, string>>();
  constructor(private store: AnalyticsIssueStore) {}
  async observed(repository: string, snapshot: Snapshot | undefined, merges?: ReadonlyMap<number, ObservedMerge>): Promise<void> {
    if (!snapshot) return;
    try {
      const handovers = this.handovers.get(repository) ?? new Map<number, string>();
      this.handovers.set(repository, handovers);
      for (const m of merges?.values() ?? []) if (handoverSteps.has(m.step) && !handovers.has(m.pullRequest)) handovers.set(m.pullRequest, m.at);
      const changed = analyticsIssues(snapshot, undefined, handovers).filter(i => this.seen.get(`${repository}#${i.issueNumber}`) !== hash(i));
      if (!changed.length) return;
      await this.store.upsertAnalyticsIssues(repository, changed);
      for (const i of changed) this.seen.set(`${repository}#${i.issueNumber}`, hash(i));
    } catch { console.warn(JSON.stringify({ event: 'factory-analytics', code: 'ISSUES_NOT_WRITTEN', repository })); }
  }
}

export interface FeatureCall extends Omit<AnalyticsCall, 'repository' | 'issueNumber'> { lost: boolean }
export interface AnalyticsFeature {
  repository: string; issueNumber: number; title: string | null; url: string; state: 'merged' | 'open' | 'closed';
  prNumber: number | null; mergedAt: string | null; mergedBy: 'factory' | 'human' | null;
  /** All recorded cost of the issue, every attempt included; `costInRange` only the part inside the period. */
  costUsd: number; costInRange: number; unknownCostCalls: number;
  steps: Record<AnalyticsStep, number>; codingRuns: number; failedCodingRuns: number; lastActivity: string;
  calls: FeatureCall[];
}
export interface AnalyticsModelRow {
  step: AnalyticsStep; agent: string; model: string; effort: string | null; selection: AnalyticsCall['selection'];
  calls: number; costUsd: number; unknownCostCalls: number; failed: number;
}
export interface AnalyticsView {
  generatedAt: string; from: string; to: string; repository: string | null; repositories: string[];
  totals: { costUsd: number; calls: number; unknownCostCalls: number; lostCostUsd: number; mergedFeatures: number;
    costPerMergedFeature: { mean: number | null; median: number | null }; };
  steps: { step: AnalyticsStep; costUsd: number; calls: number }[];
  weekly: { week: string; step: AnalyticsStep; costUsd: number }[];
  models: AnalyticsModelRow[];
  features: AnalyticsFeature[];
}
const steps: AnalyticsStep[] = ['coding', 'review', 'risk', 'planner'];
const round = (value: number) => Math.round(value * 10000) / 10000;
/** Monday (UTC) of the week of an instant, as YYYY-MM-DD. */
export function weekOf(at: string): string {
  const d = new Date(at), day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const key = (repository: string, issue: number) => `${repository.toLowerCase()}#${issue}`;

/**
 * The analytics of a period. `calls` should reach back far enough for complete per-issue totals (all attempts of a
 * feature merged in the period); only the calls inside [from, to) count for the period's totals, steps and models.
 */
export function analyticsView(calls: AnalyticsCall[], issues: (AnalyticsIssue & { repository: string })[],
  options: { from: Date; to: Date; repository?: string | null; now?: Date }): AnalyticsView {
  const repo = options.repository?.toLowerCase() ?? null;
  const mine = calls.filter(c => !repo || c.repository.toLowerCase() === repo);
  const issueInfo = new Map(issues.filter(i => !repo || i.repository.toLowerCase() === repo).map(i => [key(i.repository, i.issueNumber), i]));
  const inRange = (at: string) => { const t = Date.parse(at); return t >= options.from.getTime() && t < options.to.getTime(); };
  const closedUnmerged = (c: AnalyticsCall) => { const info = c.issueNumber === null ? undefined : issueInfo.get(key(c.repository, c.issueNumber));
    return !!info && info.state === 'closed' && !info.mergedAt; };
  // Lost: a coding run without a successful result, and every call of an issue closed without a merge.
  const lost = (c: AnalyticsCall) => (c.step === 'coding' && c.outcome !== 'success') || closedUnmerged(c);
  const period = mine.filter(c => inRange(c.at));

  const stepRows = steps.map(step => { const of = period.filter(c => c.step === step);
    return { step, costUsd: round(of.reduce((s, c) => s + (c.costUsd ?? 0), 0)), calls: of.length }; }).filter(r => r.calls);
  const weekly = new Map<string, number>();
  for (const c of period) weekly.set(`${weekOf(c.at)}|${c.step}`, (weekly.get(`${weekOf(c.at)}|${c.step}`) ?? 0) + (c.costUsd ?? 0));
  const models = new Map<string, AnalyticsModelRow>();
  for (const c of period) {
    const k = [c.step, c.agent, c.model, c.effort, c.selection].join('|');
    const row = models.get(k) ?? { step: c.step, agent: c.agent, model: c.model, effort: c.effort, selection: c.selection, calls: 0, costUsd: 0, unknownCostCalls: 0, failed: 0 };
    row.calls++; row.costUsd += c.costUsd ?? 0; if (c.costUsd === null) row.unknownCostCalls++;
    if (c.outcome !== 'success') row.failed++;
    models.set(k, row);
  }

  const features = new Map<string, AnalyticsFeature>();
  for (const c of mine) {
    if (c.issueNumber === null) continue;
    const k = key(c.repository, c.issueNumber), info = issueInfo.get(k);
    const f = features.get(k) ?? { repository: info?.repository ?? c.repository, issueNumber: c.issueNumber, title: info?.title ?? null,
      url: `https://github.com/${info?.repository ?? c.repository}/issues/${c.issueNumber}`,
      state: info?.mergedAt ? 'merged' : info?.state === 'closed' ? 'closed' : 'open', prNumber: info?.prNumber ?? null, mergedAt: info?.mergedAt ?? null,
      mergedBy: info?.mergedBy ?? null, costUsd: 0, costInRange: 0, unknownCostCalls: 0, steps: { coding: 0, review: 0, risk: 0, planner: 0 },
      codingRuns: 0, failedCodingRuns: 0, lastActivity: c.at, calls: [] } satisfies AnalyticsFeature;
    f.costUsd += c.costUsd ?? 0; if (inRange(c.at)) f.costInRange += c.costUsd ?? 0;
    if (c.costUsd === null) f.unknownCostCalls++;
    f.steps[c.step] += c.costUsd ?? 0;
    if (c.step === 'coding') { f.codingRuns++; if (c.outcome !== 'success') f.failedCodingRuns++; }
    if (c.at > f.lastActivity) f.lastActivity = c.at;
    const { repository: _r, issueNumber: _i, ...call } = c; void _r; void _i;
    f.calls.push({ ...call, lost: lost(c) });
    features.set(k, f);
  }
  const listed = [...features.values()]
    .filter(f => f.calls.some(c => inRange(c.at)) || (f.mergedAt !== null && inRange(f.mergedAt)))
    .map(f => ({ ...f, costUsd: round(f.costUsd), costInRange: round(f.costInRange),
      steps: Object.fromEntries(Object.entries(f.steps).map(([s, v]) => [s, round(v)])) as Record<AnalyticsStep, number>,
      calls: f.calls.slice(-200) }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  const merged = listed.filter(f => f.mergedAt !== null && inRange(f.mergedAt)).map(f => f.costUsd);
  const total = period.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  return {
    generatedAt: (options.now ?? new Date()).toISOString(), from: options.from.toISOString(), to: options.to.toISOString(), repository: options.repository ?? null,
    repositories: [...new Set([...calls.map(c => c.repository), ...issues.map(i => i.repository)])].sort(),
    totals: { costUsd: round(total), calls: period.length, unknownCostCalls: period.filter(c => c.costUsd === null).length,
      lostCostUsd: round(period.filter(lost).reduce((s, c) => s + (c.costUsd ?? 0), 0)), mergedFeatures: merged.length,
      costPerMergedFeature: { mean: merged.length ? round(merged.reduce((s, v) => s + v, 0) / merged.length) : null, median: (() => { const m = median(merged); return m === null ? null : round(m); })() } },
    steps: stepRows,
    weekly: [...weekly.entries()].map(([k, cost]) => { const [week, step] = k.split('|') as [string, AnalyticsStep]; return { week, step, costUsd: round(cost) }; })
      .sort((a, b) => a.week.localeCompare(b.week) || steps.indexOf(a.step) - steps.indexOf(b.step)),
    models: [...models.values()].map(r => ({ ...r, costUsd: round(r.costUsd) })).sort((a, b) => b.costUsd - a.costUsd),
    features: listed
  };
}

export interface AnalyticsStore {
  analyticsCalls(since: Date): Promise<AnalyticsCall[]>;
  analyticsIssues(): Promise<(AnalyticsIssue & { repository: string })[]>;
  /** Merge review decisions since `since`; optional (stores before the router evaluation have none). */
  analyticsVerdicts?(since: Date): Promise<AnalyticsVerdict[]>;
}
/** How far back calls are read for the per-issue totals of a period: a feature's earlier attempts belong to it. */
export const analyticsLookbackDays = 120;
/** The view for GET /v1/analytics?days=N&repository=owner/name (days 1..365, default 30). */
export async function loadAnalytics(store: AnalyticsStore, query: URLSearchParams, now = new Date()): Promise<AnalyticsView> {
  const days = Math.min(365, Math.max(1, Number.parseInt(query.get('days') ?? '30', 10) || 30));
  const repository = query.get('repository');
  if (repository && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('INVALID_REPOSITORY');
  const from = new Date(now.getTime() - days * 86400000);
  const calls = await store.analyticsCalls(new Date(from.getTime() - analyticsLookbackDays * 86400000));
  return analyticsView(calls, await store.analyticsIssues(), { from, to: new Date(now.getTime() + 1), repository: repository || null, now });
}
