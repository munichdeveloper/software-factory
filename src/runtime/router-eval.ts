import type { AnalyticsCall, AnalyticsIssue, AnalyticsVerdict } from './analytics.js';

/**
 * Router evaluation for the monitor's metrics page (Johannes, 2026-11-22: does Jev pick sensible models?). Every issue
 * whose first coding run started in the period is one case: Jev's choice for that first run (candidate, model, effort,
 * probability), or the configured model when the router was not asked or not followed, set against what happened next:
 * did the first run succeed, did the issue need further runs (rework after a successful run, a new attempt after a
 * failed one, an escalation), did the merge review reject the result, was it merged, at what cost and lead time.
 *
 * Two heuristic flags name single cases: a strong model (Opus, Fable) whose run went through without any further work
 * and was quick ("stark vermutlich unnötig"), and a cheaper model whose run needed further work ("zu schwach?"). They
 * are hints, not proof: a failed run can also be the infrastructure's fault.
 *
 * Review decisions are recorded since this evaluation exists (factory_analytics_verdicts); before that, rework after a
 * successful run is the trace a rejecting review leaves.
 */
export type ModelTier = 'cheap' | 'mid' | 'strong';
export interface RouterCase {
  repository: string; issueNumber: number; title: string | null; url: string;
  /** Jev's candidate id, or null when the configured model ran. */
  choice: string | null; routed: boolean; probability: number | null; model: string; effort: string | null; tier: ModelTier;
  status: 'merged' | 'closed' | 'open'; firstRunOk: boolean; codingRuns: number; reworks: number; retries: number; escalations: number;
  reviews: number; rejections: number; firstPass: boolean; firstRunMs: number | null; firstRunCostUsd: number | null; costUsd: number;
  leadMs: number | null; startedAt: string;
  flag: 'overkill' | 'underpowered' | null;
}
export interface RouterGroup {
  key: string; label: string; routed: boolean; tier: ModelTier; model: string | null; effort: string | null;
  issues: number; settled: number; merged: number;
  /** Share of settled issues merged after one successful run without a rejecting review. */
  firstPassYield: number | null;
  firstRunFailRate: number | null; reworkRate: number | null; escalationRate: number | null;
  reviews: number; rejections: number; rejectionRate: number | null;
  meanProbability: number | null; meanCostUsd: number | null; costPerMergedUsd: number | null;
  leadMedianMs: number | null; firstRunMedianMs: number | null;
  overkill: number; underpowered: number;
}
export interface RouterEvaluation {
  issues: number; routed: number; routedShare: number | null;
  /** Median duration of quick-enough runs: a strong first-pass run at or below it counts as "probably unnecessary". */
  overkillThresholdMs: number;
  overkill: number; overkillCostUsd: number; underpowered: number;
  /** First recorded review decision; reviews before it are not counted. */
  verdictsSince: string | null;
  choices: RouterGroup[]; tiers: RouterGroup[];
  /** Jev's probability for its choice against the outcome. */
  confidence: { bucket: string; issues: number; firstPassYield: number | null; troubleRate: number | null }[];
  cases: RouterCase[];
}

/** Haiku is cheap, Opus and Fable are strong, everything else (Sonnet, OpenAI models) sits in between. */
export function modelTier(model: string): ModelTier {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'cheap';
  if (/opus|fable|mythos/.test(m)) return 'strong';
  return 'mid';
}
/** Without enough cheaper first-pass runs to compare with, a strong run up to 15 minutes counts as quick. */
export const defaultOverkillThresholdMs = 15 * 60000;
const tierLabel: Record<ModelTier, string> = { cheap: 'Günstig (Haiku)', mid: 'Mittel (Sonnet, OpenAI)', strong: 'Stark (Opus, Fable)' };
const key = (repository: string, issue: number) => `${repository.toLowerCase()}#${issue}`;
const ratio = (part: number, whole: number) => whole > 0 ? Math.round((part / whole) * 1000) / 1000 : null;
const round = (value: number) => Math.round(value * 10000) / 10000;
/** Median of the known values, rounded; null without any. */
const median = (values: (number | null)[]) => {
  const sorted = values.filter((v): v is number => v !== null && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2);
};
const runStart = (c: AnalyticsCall) => new Date(Date.parse(c.at) - (c.durationMs ?? 0)).toISOString();
const ok = (c: AnalyticsCall) => c.outcome === 'success';

function group(key: string, label: string, list: RouterCase[], fixed: { routed: boolean; tier: ModelTier; model: string | null; effort: string | null }): RouterGroup {
  const settled = list.filter(c => c.status !== 'open'), merged = list.filter(c => c.status === 'merged');
  const probabilities = list.map(c => c.probability).filter((p): p is number => p !== null);
  const reviews = list.reduce((s, c) => s + c.reviews, 0), rejections = list.reduce((s, c) => s + c.rejections, 0);
  return { key, label, ...fixed, issues: list.length, settled: settled.length, merged: merged.length,
    firstPassYield: ratio(settled.filter(c => c.firstPass).length, settled.length),
    firstRunFailRate: ratio(list.filter(c => !c.firstRunOk).length, list.length),
    reworkRate: ratio(list.filter(c => c.reworks > 0).length, list.length),
    escalationRate: ratio(list.filter(c => c.escalations > 0).length, list.length),
    reviews, rejections, rejectionRate: ratio(rejections, reviews),
    meanProbability: probabilities.length ? Math.round(probabilities.reduce((s, p) => s + p, 0) / probabilities.length * 1000) / 1000 : null,
    meanCostUsd: list.length ? round(list.reduce((s, c) => s + c.costUsd, 0) / list.length) : null,
    costPerMergedUsd: merged.length ? round(merged.reduce((s, c) => s + c.costUsd, 0) / merged.length) : null,
    leadMedianMs: median(merged.map(c => c.leadMs)), firstRunMedianMs: median(list.map(c => c.firstRunMs)),
    overkill: list.filter(c => c.flag === 'overkill').length, underpowered: list.filter(c => c.flag === 'underpowered').length };
}

export function routerEvaluation(calls: AnalyticsCall[], issues: (AnalyticsIssue & { repository: string })[], verdicts: AnalyticsVerdict[],
  options: { from: Date; to: Date; repository?: string | null }): RouterEvaluation {
  const repo = options.repository?.toLowerCase() ?? null;
  const mine = calls.filter(c => !repo || c.repository.toLowerCase() === repo);
  const info = new Map(issues.map(i => [key(i.repository, i.issueNumber), i]));
  const inRange = (at: string) => { const t = Date.parse(at); return t >= options.from.getTime() && t < options.to.getTime(); };
  const byIssue = new Map<string, AnalyticsCall[]>();
  for (const c of mine) if (c.issueNumber !== null) byIssue.set(key(c.repository, c.issueNumber), [...byIssue.get(key(c.repository, c.issueNumber)) ?? [], c]);
  const reviews = verdicts.filter(v => v.step === 'review' && (!repo || v.repository.toLowerCase() === repo));

  const cases: RouterCase[] = [];
  for (const [k, list] of byIssue) {
    const coding = list.filter(c => c.step === 'coding').sort((a, b) => runStart(a).localeCompare(runStart(b)));
    const first = coding[0];
    if (!first || !inRange(runStart(first))) continue;
    const issue = info.get(k);
    const until = issue?.mergedAt ?? null;
    const own = until ? list.filter(c => c.at <= until) : list;
    const runs = until ? coding.filter(c => runStart(c) <= until) : coding;
    let reworks = 0, retries = 0;
    runs.forEach((c, i) => { if (i === 0 || c.selection === 'escalation') return; if (ok(runs[i - 1]!)) reworks++; else retries++; });
    const prNumber = issue?.prNumber ?? null;
    const theirs = reviews.filter(v => v.repository.toLowerCase() === first.repository.toLowerCase() &&
      (v.issueNumber === first.issueNumber || (prNumber !== null && v.prNumber === prNumber)) && (!until || v.at <= until));
    const status = issue?.mergedAt ? 'merged' : issue?.state === 'closed' ? 'closed' : 'open';
    const rejections = theirs.filter(v => v.rejected).length;
    const routed = first.selection === 'router';
    cases.push({ repository: issue?.repository ?? first.repository, issueNumber: first.issueNumber!, title: issue?.title || null,
      url: `https://github.com/${issue?.repository ?? first.repository}/issues/${first.issueNumber}`,
      choice: routed ? first.routerChoice : null, routed, probability: routed ? first.routerProbability : null,
      model: first.model, effort: first.effort, tier: modelTier(first.model), status, firstRunOk: ok(first), codingRuns: runs.length, reworks, retries,
      escalations: runs.filter(c => c.selection === 'escalation').length, reviews: theirs.length, rejections,
      firstPass: status === 'merged' && runs.length === 1 && ok(first) && rejections === 0,
      firstRunMs: first.durationMs ?? null, firstRunCostUsd: first.costUsd, costUsd: round(own.reduce((s, c) => s + (c.costUsd ?? 0), 0)),
      leadMs: issue?.mergedAt && issue.qualifiedAt ? Math.max(0, Date.parse(issue.mergedAt) - Date.parse(issue.qualifiedAt)) : null,
      startedAt: runStart(first), flag: null });
  }

  // Quick means: no slower than the median first-pass run of the cheaper tiers (with at least three of them).
  const cheaperQuick = cases.filter(c => c.tier !== 'strong' && c.firstPass && c.firstRunMs !== null).map(c => c.firstRunMs);
  const overkillThresholdMs = cheaperQuick.length >= 3 ? median(cheaperQuick)! : defaultOverkillThresholdMs;
  for (const c of cases) {
    if (c.tier === 'strong' && c.firstPass && c.firstRunMs !== null && c.firstRunMs <= overkillThresholdMs) c.flag = 'overkill';
    else if (c.tier !== 'strong' && (!c.firstRunOk || c.reworks > 0 || c.escalations > 0 || c.rejections > 0)) c.flag = 'underpowered';
  }
  cases.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const choices = new Map<string, RouterCase[]>();
  for (const c of cases) { const k = c.routed ? `jev:${c.choice ?? '?'}` : `config:${c.model}|${c.effort ?? ''}`; choices.set(k, [...choices.get(k) ?? [], c]); }
  const choiceRows = [...choices.entries()].map(([k, list]) => {
    const f = list[0]!;
    return group(k, f.routed ? (f.choice ?? 'unbekannt') : `konfiguriert: ${f.model}${f.effort ? ` ${f.effort}` : ''}`, list,
      { routed: f.routed, tier: f.tier, model: f.model, effort: f.effort });
  }).sort((a, b) => b.issues - a.issues || a.label.localeCompare(b.label));
  const tierRows = (['cheap', 'mid', 'strong'] as ModelTier[]).map(t => group(t, tierLabel[t], cases.filter(c => c.tier === t), { routed: true, tier: t, model: null, effort: null }))
    .filter(r => r.issues > 0);

  const buckets: [string, number, number][] = [['unter 40 %', 0, 0.4], ['40–60 %', 0.4, 0.6], ['60–80 %', 0.6, 0.8], ['ab 80 %', 0.8, 1.01]];
  const routedCases = cases.filter(c => c.routed && c.probability !== null);
  const trouble = (c: RouterCase) => !c.firstRunOk || c.reworks > 0 || c.retries > 0 || c.escalations > 0 || c.rejections > 0;
  const overkill = cases.filter(c => c.flag === 'overkill');
  const since = reviews.map(v => v.at).sort()[0] ?? null;
  return {
    issues: cases.length, routed: cases.filter(c => c.routed).length, routedShare: ratio(cases.filter(c => c.routed).length, cases.length),
    overkillThresholdMs, overkill: overkill.length, overkillCostUsd: round(overkill.reduce((s, c) => s + c.costUsd, 0)),
    underpowered: cases.filter(c => c.flag === 'underpowered').length, verdictsSince: since,
    choices: choiceRows, tiers: tierRows,
    confidence: buckets.map(([bucket, low, high]) => {
      const list = routedCases.filter(c => c.probability! >= low && c.probability! < high), settled = list.filter(c => c.status !== 'open');
      return { bucket, issues: list.length, firstPassYield: ratio(settled.filter(c => c.firstPass).length, settled.length), troubleRate: ratio(list.filter(trouble).length, list.length) };
    }),
    cases: cases.slice(0, 400)
  };
}
