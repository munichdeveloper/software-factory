import { z } from 'zod';
import type { RunSnapshot } from './contract.js';
import { priceCall, type PriceSource } from '../llm/analytics.js';

/**
 * Token usage of coding runs (Johannes, 2026-11-19: "Ich möchte genau wissen, wenn wir irgendwo Lecks haben und Aufrufe
 * unerwartet viele Tokens verbrauchen"). The harness records every run in usage.json (dev-agent-harness src/usage.ts):
 * tokens measured by the Claude credential proxy or read from the Codex session, Claude Code's own dollar estimate and
 * outcome. The executor uploads it as coding-usage-<executionId> for every run that reached the agent, also failed ones;
 * the broker stores it, logs it and reports runs that cost too much.
 */
const count = z.number().int().min(0).max(1e12);
const tokensSchema = z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count });
/**
 * What the run did (dev-agent-harness src/insight.ts, harness #19), for the cost evaluation (#231): the tool trace
 * without inputs or outputs, the fixed context of the first request, output tokens per turn and the change size. Optional,
 * so records of older harness releases stay valid.
 */
const pathPattern = /^[A-Za-z0-9._@+/-]{1,300}$/;
export const insightSchema = z.strictObject({
  trace: z.array(z.strictObject({ turn: count, tool: z.string().regex(/^[A-Za-z0-9_.-]{1,60}$/), target: z.string().regex(pathPattern).nullable(),
    error: z.boolean() })).max(1000),
  traceTruncated: z.boolean(), firstRequestInputTokens: count.nullable(), outputTokensPerTurn: z.array(count).max(1000),
  diff: z.array(z.strictObject({ path: z.string().min(1).max(500), added: count.nullable(), removed: count.nullable() })).max(200).nullable(),
  diffTruncated: z.boolean()
});
export type UsageInsight = z.infer<typeof insightSchema>;
export const usageRecordSchema = z.strictObject({
  contractVersion: z.literal('1.0'), executionId: z.string().regex(/^[a-f0-9]{32}$/), worker: z.enum(['codex', 'claude']),
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  source: z.enum(['proxy', 'codex-session']).nullable(), requests: count.nullable(), tokens: tokensSchema.nullable(),
  costUsd: z.number().min(0).max(100000).nullable(), turns: count.nullable(), durationMs: count.nullable(),
  outcome: z.string().regex(/^[a-z_]{1,60}$/).nullable(),
  budgetUsd: z.number().positive().max(1000).nullable(), budgetReached: z.boolean(),
  insight: insightSchema.optional()
});
export type UsageRecord = z.infer<typeof usageRecordSchema>;

/** Spend cap per coding attempt when workers.coding.maxCostUsd is not set (Claude Code --max-budget-usd). */
export const defaultCodingBudgetUsd = 10;

/**
 * One stored run with where it belongs. billing subscription: the run used the Claude subscription (OAuth token), so its
 * costUsd is Claude Code's list-price estimate, not a charge; spend sums and daily thresholds leave it out.
 */
export interface UsageEntry {
  repositoryId: number; repository: string; issueNumber: number; runId: number; record: UsageRecord; billing: 'api' | 'subscription';
  /** Where record.costUsd comes from: the price of the run's tokens at recording time (live list, table, configured) or agent (the agent's own estimate). */
  priceSource?: PriceSource | 'agent' | null;
  /** The agent's own estimate (Claude Code), kept when the tokens were priced instead. */
  agentEstimateUsd?: number | null;
  /** The task of the run, for the cost evaluation (#231); not stored with the usage. */
  task?: { description: string; acceptanceCriteria: string[] };
}

/** Thresholds of the usage alerts; from the broker's environment, so no repository configuration hash changes. */
export interface UsageThresholds { runUsd: number; dayUsd: number; runOutputTokens: number }
export const usageThresholds = (env: Record<string, string | undefined>): UsageThresholds => ({
  runUsd: z.coerce.number().positive().max(1000).parse(env.FACTORY_USAGE_RUN_ALERT_USD ?? '6'),
  dayUsd: z.coerce.number().positive().max(100000).parse(env.FACTORY_USAGE_DAY_ALERT_USD ?? '30'),
  runOutputTokens: z.coerce.number().int().positive().parse(env.FACTORY_USAGE_RUN_ALERT_OUTPUT_TOKENS ?? '200000')
});

export interface UsageStore {
  /** Stores the record once; false when this execution was already recorded (a repeated poll). */
  recordUsage(entry: UsageEntry): Promise<boolean>;
  /** Sum of the known dollar cost and number of runs billed to an API key of a repository on one UTC day (YYYY-MM-DD). */
  usageDay(repositoryId: number, day: string): Promise<{ costUsd: number; runs: number; unknownCost: number }>;
  /** Claims one alert of this kind for the key; false when it was already sent. */
  claimUsageAlert(key: string, kind: string): Promise<boolean>;
}
export interface UsageAlertSink { post(channel: string, text: string): Promise<void> }

const usd = (value: number) => `${value.toFixed(2)} $`;
const thousands = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)} Mio.` : value >= 1e3 ? `${Math.round(value / 1e3)} Tsd.` : String(value);
export function tokenSummary(record: UsageRecord): string {
  if (!record.tokens) return 'Tokens unbekannt';
  const t = record.tokens;
  return `${thousands(t.input + t.cacheRead + t.cacheWrite)} Eingabe-Tokens (davon ${thousands(t.cacheRead)} aus dem Cache), ${thousands(t.output)} Ausgabe-Tokens in ${record.requests ?? '?'} Anfragen`;
}
/** One log line per recorded run: ids and numbers only. */
export function logUsage(entry: UsageEntry, inserted: boolean) {
  const r = entry.record;
  console.log(JSON.stringify({ event: 'factory-usage', repository: entry.repository, issue: entry.issueNumber, executionId: r.executionId, runId: entry.runId,
    worker: r.worker, model: r.model, effort: r.effort, requests: r.requests, tokens: r.tokens, costUsd: r.costUsd, turns: r.turns,
    durationMs: r.durationMs, outcome: r.outcome, budgetUsd: r.budgetUsd, budgetReached: r.budgetReached, priceSource: entry.priceSource ?? null,
    agentEstimateUsd: entry.agentEstimateUsd ?? null, repeated: !inserted }));
}

/**
 * Slack messages about runs that used unexpectedly much: a run above the cost or output-token threshold, a run stopped
 * by its spend cap, a run that used tokens but ended without a result (killed or crashed: cost unknown), and a
 * repository whose spend of the day crossed the daily threshold (once per day). Every message names the run.
 */
export class UsageAlerts {
  constructor(private store: UsageStore, private sink: UsageAlertSink | undefined, private channel: string | undefined,
    private thresholds: UsageThresholds, private now: () => Date = () => new Date()) {}
  async observe(entry: UsageEntry): Promise<void> {
    const inserted = await this.store.recordUsage(entry);
    logUsage(entry, inserted);
    if (!inserted || !this.sink || !this.channel) return;
    const r = entry.record, link = `https://github.com/${entry.repository}/actions/runs/${entry.runId}`;
    const subscription = entry.billing === 'subscription';
    const where = `${entry.repository}#${entry.issueNumber} (${r.worker}${subscription ? ' über das Claude-Abo' : ''}, ${r.model}, ${r.effort})`;
    const cost = r.costUsd === null ? 'Kosten unbekannt' : subscription ? `rechnerisch ${usd(r.costUsd)} (Abo, nicht abgerechnet)` : usd(r.costUsd);
    const facts = `${cost}, ${tokenSummary(r)}${r.turns === null ? '' : `, ${r.turns} Runden`}${r.durationMs === null ? '' : `, ${Math.round(r.durationMs / 60000)} min`}.`;
    const reasons: string[] = [];
    if (r.budgetReached) reasons.push(`Der Kostendeckel von ${usd(r.budgetUsd ?? 0)} hat den Lauf gestoppt.`);
    else if (r.costUsd !== null && r.costUsd >= this.thresholds.runUsd) reasons.push(`Der Lauf liegt über der Alarmschwelle von ${usd(this.thresholds.runUsd)}.`);
    if (r.tokens && r.tokens.output >= this.thresholds.runOutputTokens) reasons.push(`Ungewöhnlich viele Ausgabe-Tokens (Schwelle ${thousands(this.thresholds.runOutputTokens)}).`);
    if (r.outcome === null && (r.requests ?? 0) > 0) reasons.push('Der Agent hat Tokens verbraucht, aber kein Ergebnis gemeldet (abgebrochen, Zeitlimit oder Absturz).');
    if (reasons.length && await this.store.claimUsageAlert(r.executionId, 'run'))
      await this.sink.post(this.channel, [`SF Verbrauch: auffälliger Lauf in ${where}`, ...reasons, facts, link].join('\n'));
    if (subscription) return; // not billed: the daily spend threshold counts API runs only
    const day = this.now().toISOString().slice(0, 10), total = await this.store.usageDay(entry.repositoryId, day);
    if (total.costUsd >= this.thresholds.dayUsd && await this.store.claimUsageAlert(`${entry.repositoryId}:${day}`, 'day'))
      await this.sink.post(this.channel, [`SF Verbrauch: ${entry.repository} hat heute (UTC) schon ${usd(total.costUsd)} für ${total.runs} Coding-Läufe ausgegeben` +
        `${total.unknownCost ? ` (dazu ${total.unknownCost} Läufe mit unbekannten Kosten)` : ''}.`,
        `Tagesschwelle ${usd(this.thresholds.dayUsd)}; die nächste Meldung für dieses Repository kommt morgen.`].join('\n'));
  }
}

/**
 * The usage entry of a polled run: the record must belong to the execution of the snapshot. Its cost is the price of its
 * tokens at this moment (same prices as the broker's own calls); the agent's estimate stays as the fallback and is kept.
 */
export function usageEntry(snapshot: RunSnapshot, runId: number, value: unknown, billing: UsageEntry['billing'] = 'api'): UsageEntry | null {
  const parsed = usageRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.executionId !== snapshot.admission.input.executionId) return null;
  const priced = priceCall(parsed.data.model, parsed.data.tokens);
  const record = priced.costUsd === null ? parsed.data : { ...parsed.data, costUsd: Math.min(100000, Math.round(priced.costUsd * 1e6) / 1e6) };
  return { repositoryId: snapshot.repositoryId, repository: snapshot.repository, issueNumber: snapshot.admission.input.issueNumber, runId, record, billing,
    priceSource: priced.priceSource ?? (parsed.data.costUsd === null ? null : 'agent'), agentEstimateUsd: parsed.data.costUsd,
    task: { description: snapshot.admission.input.description, acceptanceCriteria: snapshot.admission.input.acceptanceCriteria } };
}

/** One English line for the status comment: what the latest attempt cost. */
export function usageNoteEn(record: UsageRecord): string {
  const cost = record.costUsd === null ? 'cost unknown' : `$${record.costUsd.toFixed(2)}`;
  const tokens = record.tokens ? `, ${thousandsEn(record.tokens.input + record.tokens.cacheRead + record.tokens.cacheWrite)} input / ${thousandsEn(record.tokens.output)} output tokens` : '';
  const turns = record.turns === null ? '' : `, ${record.turns} turns`;
  const stop = record.budgetReached ? ` (stopped at the $${(record.budgetUsd ?? 0).toFixed(2)} cap)` : '';
  return `**Usage:** ${cost}${tokens}${turns}${stop}.`;
}
const thousandsEn = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${Math.round(value / 1e3)}k` : String(value);

/** The daily Slack report: spend per repository of the previous UTC day. */
export function usageReportText(day: string, rows: Awaited<ReturnType<UsageReportStore['usageReport']>>): string {
  if (!rows.length) return `SF Verbrauch ${day} (UTC): keine Coding-Läufe.`;
  const total = rows.reduce((sum, r) => sum + r.costUsd, 0), runs = rows.reduce((sum, r) => sum + r.runs - r.subscriptionRuns, 0);
  const abo = rows.reduce((sum, r) => sum + r.subscriptionRuns, 0), aboCost = rows.reduce((sum, r) => sum + r.subscriptionCostUsd, 0);
  return [`SF Verbrauch ${day} (UTC): ${usd(total)} für ${runs} Coding-Läufe.` +
    (abo ? ` Dazu ${abo} Läufe über das Claude-Abo (rechnerisch ${usd(aboCost)}, nicht abgerechnet).` : ''),
    ...rows.map(r => `• ${r.repository}: ${usd(r.costUsd)} in ${r.runs - r.subscriptionRuns} Läufen, teuerster ${usd(r.maxCostUsd)}` +
      `${r.unknownCost ? `, ${r.unknownCost} ohne Kostenangabe` : ''}${r.budgetStops ? `, ${r.budgetStops}× Kostendeckel` : ''}` +
      `${r.subscriptionRuns ? `, ${r.subscriptionRuns} über das Abo` : ''}`)].join('\n');
}
export interface UsageReportStore {
  /** runs counts every run; costUsd, unknownCost and maxCostUsd only those billed to an API key. */
  usageReport(from: Date, to: Date): Promise<{ repository: string; runs: number; costUsd: number; unknownCost: number; maxCostUsd: number; budgetStops: number; subscriptionRuns: number; subscriptionCostUsd: number }[]>;
  claimUsageAlert(key: string, kind: string): Promise<boolean>;
}
/** Posts yesterday's report once, at the first check after `hourUtc` o'clock UTC. */
export async function dailyUsageReport(store: UsageReportStore, sink: UsageAlertSink, channel: string, now: Date, hourUtc = 6): Promise<boolean> {
  if (now.getUTCHours() < hourUtc) return false;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), yesterday = new Date(today.getTime() - 86400000);
  const day = yesterday.toISOString().slice(0, 10);
  if (!await store.claimUsageAlert(`report:${day}`, 'report')) return false;
  await sink.post(channel, usageReportText(day, await store.usageReport(yesterday, today)));
  return true;
}
