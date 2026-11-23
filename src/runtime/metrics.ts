import { analyticsLookbackDays, weekOf, type AnalyticsCall, type AnalyticsIssue, type AnalyticsStore } from './analytics.js';
import { outcomeClasses, waitMs, type Outcome } from './outcomes.js';
import { routerEvaluation, type RouterEvaluation } from './router-eval.js';

/**
 * Lead-time and flow metrics for software-factory-monitor's metrics page (Johannes, 2026-11-21). The lead time of an
 * issue runs from its intake (`harness:managed`, plus `harness:ready` where that is a person's grant) to the merge of
 * its pull request. Only issues that reached a merge count:
 *
 * - merged by the Factory: the full run through the automatic merge;
 * - merged by a person after the merge pass handed the pull request over (risk above the threshold, approval
 *   required): the lead time and, separately, how long the pull request waited for that person.
 *
 * Runs that never reached a merge are not measured. Everything comes from what the cost analytics already store
 * (factory_analytics_issues, the coding runs and broker calls): no GitHub request.
 */
export interface Distribution { count: number; meanMs: number | null; medianMs: number | null; p90Ms: number | null }
export interface MetricsItem {
  repository: string; issueNumber: number; title: string | null; url: string; prNumber: number | null;
  mergedBy: 'factory' | 'human'; qualifiedAt: string | null; handoverAt: string | null; mergedAt: string;
  /** Intake to merge; null without a known intake. */
  leadMs: number | null;
  /** Handover to the person's merge; null for Factory merges and without a recorded handover. */
  waitMs: number | null;
  /** Intake to the start of the first coding run. */
  pickupMs: number | null;
  codingRuns: number; failedCodingRuns: number; codingMs: number; reviews: number; costUsd: number;
  /** Outcome class (software-factory#239); null until it is derived from GitHub. */
  outcome: Outcome | null;
  /** Intake to merge minus the phases in which the issue waited for a person (union); null without intake or outcome. */
  netLeadMs: number | null;
  /** Summed wait phases (union, between intake and merge); null until the outcome is derived. */
  humanWaitMs: number | null;
}
export interface MetricsRepository {
  repository: string; merged: number; mergedByFactory: number; leadMedianMs: number | null; firstPassYield: number | null; costPerMergedUsd: number | null;
}
export interface MetricsView {
  generatedAt: string; from: string; to: string; repository: string | null; repositories: string[];
  leadTime: {
    /** Intake to the Factory's own merge. */
    factory: Distribution;
    /** Intake to a person's merge after a handover; `wait` is the handover to that merge. */
    human: Distribution & { wait: Distribution };
    /** Merges in the period whose intake was never seen (issues settled before intake was recorded). */
    unknownIntake: number;
    /**
     * Intake to merge net of the phases that waited for a person, over ALL merged issues (also a person's merge without a
     * recorded handover) whose outcome is derived; `byClass` per outcome class.
     */
    net: Distribution & { byClass: Record<Exclude<Outcome, 'abandoned'>, Distribution> };
    /** The summed wait phases of the same issues; `issuesWithWait` counts those with any wait. */
    humanWait: Distribution & { issuesWithWait: number };
  };
  flow: {
    merged: number; mergedByFactory: number; mergedByHuman: number;
    /** Share of merges the Factory did itself. */
    automationRate: number | null;
    /** Merged issues whose first coding run succeeded and needed no further run. */
    firstPassYield: number | null;
    codingRunsPerMerge: number | null;
    /** Coding runs in the period that ended without success. */
    failedCodingRuns: number; codingRuns: number;
    /** Issues closed in the period without a merge, with recorded Factory work. */
    closedWithoutMerge: number;
    /** Intake to the first coding run (queue and grant wait). */
    pickup: Distribution;
    /** Duration of one coding run, as its agent reported it. */
    codingRun: Distribution;
    /** Share of the lead time spent in coding runs (Factory merges). */
    codingShare: number | null;
    /** Merge reviews per merged issue. */
    reviewsPerMerge: number | null;
    /**
     * Outcome of every closed managed issue of the period (merged in it, or abandoned in it): `counts` per class,
     * `closed` their sum, `unclassified` merged issues whose outcome is not derived yet. `automationRate` is
     * (automatic + approved) / closed: an approval or a person's merge the configuration plans is no intervention. Unlike the legacy `automationRate` above (a share of merges only).
     */
    outcomes: { counts: Record<Outcome, number>; closed: number; unclassified: number; automationRate: number | null };
  };
  weekly: { week: string; merged: number; mergedByFactory: number; leadMedianMs: number | null }[];
  repositoryRows: MetricsRepository[];
  items: MetricsItem[];
  /** Jev's model choice against the outcome (router evaluation); set by loadMetrics. */
  router?: RouterEvaluation;
}

const key = (repository: string, issue: number) => `${repository.toLowerCase()}#${issue}`;
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q, low = Math.floor(at), high = Math.ceil(at);
  return Math.round(sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low));
};
export function distribution(values: (number | null)[]): Distribution {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return { count: sorted.length, meanMs: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : null,
    medianMs: quantile(sorted, 0.5), p90Ms: quantile(sorted, 0.9) };
}
const ratio = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
const between = (from: string | null | undefined, to: string) => {
  if (!from) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
/** The start of a coding run: the usage row is written when the run ends. */
const runStart = (c: AnalyticsCall) => new Date(Date.parse(c.at) - (c.durationMs ?? 0)).toISOString();

export function metricsView(calls: AnalyticsCall[], issues: (AnalyticsIssue & { repository: string })[],
  options: { from: Date; to: Date; repository?: string | null; now?: Date }): MetricsView {
  const repo = options.repository?.toLowerCase() ?? null;
  const mine = calls.filter(c => !repo || c.repository.toLowerCase() === repo);
  const ownIssues = issues.filter(i => !repo || i.repository.toLowerCase() === repo);
  const inRange = (at: string | null | undefined) => { if (!at) return false; const t = Date.parse(at); return t >= options.from.getTime() && t < options.to.getTime(); };
  const callsOf = new Map<string, AnalyticsCall[]>();
  for (const c of mine) if (c.issueNumber !== null) { const k = key(c.repository, c.issueNumber); callsOf.set(k, [...callsOf.get(k) ?? [], c]); }

  const items: MetricsItem[] = [], merged: MetricsItem[] = [];
  for (const issue of ownIssues) {
    if (!issue.mergedAt || !inRange(issue.mergedAt)) continue;
    const own = (callsOf.get(key(issue.repository, issue.issueNumber)) ?? []).filter(c => c.at <= issue.mergedAt!);
    const coding = own.filter(c => c.step === 'coding').sort((a, b) => runStart(a).localeCompare(runStart(b)));
    const first = coding[0];
    const leadMs = between(issue.qualifiedAt, issue.mergedAt), outcome = issue.outcome ?? null;
    const humanWaitMs = outcome ? waitMs(issue.waits ?? [], issue.qualifiedAt ?? null, issue.mergedAt) : null;
    const item: MetricsItem = { repository: issue.repository, issueNumber: issue.issueNumber, title: issue.title || null,
      url: `https://github.com/${issue.repository}/issues/${issue.issueNumber}`, prNumber: issue.prNumber, mergedBy: issue.mergedBy ?? 'human',
      qualifiedAt: issue.qualifiedAt ?? null, handoverAt: issue.handoverAt ?? null, mergedAt: issue.mergedAt,
      leadMs, waitMs: issue.mergedBy === 'human' ? between(issue.handoverAt, issue.mergedAt) : null,
      pickupMs: first ? between(issue.qualifiedAt, runStart(first)) : null,
      codingRuns: coding.length, failedCodingRuns: coding.filter(c => c.outcome !== 'success').length,
      codingMs: coding.reduce((s, c) => s + (c.durationMs ?? 0), 0), reviews: own.filter(c => c.step === 'review').length,
      costUsd: Math.round(own.reduce((s, c) => s + (c.costUsd ?? 0), 0) * 10000) / 10000,
      outcome, humanWaitMs, netLeadMs: leadMs !== null && humanWaitMs !== null ? Math.max(0, leadMs - humanWaitMs) : null };
    merged.push(item);
    // The legacy items and counts: a person's merge counts only after the merge pass handed the pull request over; one
    // merged before the Factory reached its merge step is not a run that waited for a person. The outcome fields below
    // do not depend on that.
    if (issue.mergedBy && !(issue.mergedBy === 'human' && !issue.handoverAt)) items.push(item);
  }
  const counts = Object.fromEntries(outcomeClasses.map(c => [c, merged.filter(i => i.outcome === c).length])) as Record<Outcome, number>;
  counts.abandoned = ownIssues.filter(i => i.outcome === 'abandoned' && inRange(i.closedAt)).length;
  const closed = outcomeClasses.reduce((sum, c) => sum + counts[c], 0);
  const classified = merged.filter(i => i.outcome !== null);
  items.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));

  const byFactory = items.filter(i => i.mergedBy === 'factory'), byHuman = items.filter(i => i.mergedBy === 'human');
  const firstPass = (list: MetricsItem[]) => ratio(list.filter(i => i.codingRuns === 1 && i.failedCodingRuns === 0).length, list.filter(i => i.codingRuns > 0).length);
  const codingInPeriod = mine.filter(c => c.step === 'coding' && inRange(c.at));
  const timed = byFactory.filter(i => i.leadMs);
  const weekly = new Map<string, MetricsItem[]>();
  for (const i of items) weekly.set(weekOf(i.mergedAt), [...weekly.get(weekOf(i.mergedAt)) ?? [], i]);
  const repositories = new Map<string, MetricsItem[]>();
  for (const i of items) repositories.set(i.repository, [...repositories.get(i.repository) ?? [], i]);

  return {
    generatedAt: (options.now ?? new Date()).toISOString(), from: options.from.toISOString(), to: options.to.toISOString(), repository: options.repository ?? null,
    repositories: [...new Set([...calls.map(c => c.repository), ...issues.map(i => i.repository)])].sort(),
    leadTime: {
      factory: distribution(byFactory.map(i => i.leadMs)),
      human: { ...distribution(byHuman.map(i => i.leadMs)), wait: distribution(byHuman.map(i => i.waitMs)) },
      unknownIntake: items.filter(i => i.leadMs === null).length,
      net: { ...distribution(classified.map(i => i.netLeadMs)), byClass: Object.fromEntries(outcomeClasses.filter(c => c !== 'abandoned')
        .map(c => [c, distribution(classified.filter(i => i.outcome === c).map(i => i.netLeadMs))])) as Record<Exclude<Outcome, 'abandoned'>, Distribution> },
      humanWait: { ...distribution(classified.map(i => i.humanWaitMs)), issuesWithWait: classified.filter(i => (i.humanWaitMs ?? 0) > 0).length }
    },
    flow: {
      merged: items.length, mergedByFactory: byFactory.length, mergedByHuman: byHuman.length,
      automationRate: ratio(byFactory.length, items.length), firstPassYield: firstPass(items),
      codingRunsPerMerge: items.length ? Math.round(items.reduce((s, i) => s + i.codingRuns, 0) / items.length * 100) / 100 : null,
      failedCodingRuns: codingInPeriod.filter(c => c.outcome !== 'success').length, codingRuns: codingInPeriod.length,
      closedWithoutMerge: ownIssues.filter(i => i.state === 'closed' && !i.mergedAt && callsOf.has(key(i.repository, i.issueNumber)) &&
        (callsOf.get(key(i.repository, i.issueNumber)) ?? []).some(c => inRange(c.at))).length,
      pickup: distribution(items.map(i => i.pickupMs)),
      codingRun: distribution(codingInPeriod.map(c => c.durationMs ?? null)),
      codingShare: ratio(timed.reduce((s, i) => s + i.codingMs, 0), timed.reduce((s, i) => s + i.leadMs!, 0)),
      outcomes: { counts, closed, unclassified: merged.length - classified.length, automationRate: ratio(counts.automatic + counts.approved, closed) },
      reviewsPerMerge: items.length ? Math.round(items.reduce((s, i) => s + i.reviews, 0) / items.length * 100) / 100 : null
    },
    weekly: [...weekly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, list]) => ({ week, merged: list.length,
      mergedByFactory: list.filter(i => i.mergedBy === 'factory').length, leadMedianMs: distribution(list.filter(i => i.mergedBy === 'factory').map(i => i.leadMs)).medianMs })),
    repositoryRows: [...repositories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([repository, list]) => ({ repository, merged: list.length,
      mergedByFactory: list.filter(i => i.mergedBy === 'factory').length,
      leadMedianMs: distribution(list.filter(i => i.mergedBy === 'factory').map(i => i.leadMs)).medianMs, firstPassYield: firstPass(list),
      costPerMergedUsd: Math.round(list.reduce((s, i) => s + i.costUsd, 0) / list.length * 10000) / 10000 })),
    items: items.slice(0, 500)
  };
}

/** The view for GET /v1/metrics?days=N&repository=owner/name (days 1..365, default 30). */
export async function loadMetrics(store: AnalyticsStore, query: URLSearchParams, now = new Date()): Promise<MetricsView> {
  const days = Math.min(365, Math.max(1, Number.parseInt(query.get('days') ?? '30', 10) || 30));
  const repository = query.get('repository');
  if (repository && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw new Error('INVALID_REPOSITORY');
  const from = new Date(now.getTime() - days * 86400000);
  const calls = await store.analyticsCalls(new Date(from.getTime() - analyticsLookbackDays * 86400000));
  const issues = await store.analyticsIssues(), to = new Date(now.getTime() + 1);
  const verdicts = store.analyticsVerdicts ? await store.analyticsVerdicts(from) : [];
  return { ...metricsView(calls, issues, { from, to, repository: repository || null, now }),
    router: routerEvaluation(calls, issues, verdicts, { from, to, repository: repository || null }) };
}
