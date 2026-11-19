import { describe, expect, it, vi } from 'vitest';
import { dailyUsageReport, UsageAlerts, usageEntry, usageNoteEn, usageReportText, usageThresholds, type UsageEntry, type UsageRecord, type UsageStore } from '../src/runtime/usage.js';
import { LlmCallMeter, countLlmCall, setLlmCallMeter } from '../src/llm/meter.js';
import { routedCall } from '../src/llm/router.js';
import { snapshotSchema } from '../src/runtime/contract.js';

const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({ contractVersion: '1.0', executionId: 'a'.repeat(32), worker: 'claude', model: 'claude-opus-5-5', effort: 'high',
  source: 'proxy', requests: 40, tokens: { input: 1000, output: 30000, cacheRead: 900000, cacheWrite: 50000 }, costUsd: 3.4, turns: 39, durationMs: 700000,
  outcome: 'success', budgetUsd: 10, budgetReached: false, ...over });
const entry = (over: Partial<UsageRecord> = {}): UsageEntry => ({ repositoryId: 1, repository: 'owner/repo', issueNumber: 7, runId: 99, record: record(over) });
class Store implements UsageStore {
  rows: UsageEntry[] = []; alerts = new Set<string>();
  async recordUsage(e: UsageEntry) { if (this.rows.some(r => r.record.executionId === e.record.executionId)) return false; this.rows.push(e); return true; }
  async usageDay() { const known = this.rows.filter(r => r.record.costUsd !== null);
    return { costUsd: known.reduce((s, r) => s + r.record.costUsd!, 0), runs: this.rows.length, unknownCost: this.rows.length - known.length }; }
  async claimUsageAlert(key: string, kind: string) { const k = `${kind}:${key}`; if (this.alerts.has(k)) return false; this.alerts.add(k); return true; }
  async usageReport() { return [{ repository: 'owner/repo', runs: 3, costUsd: 12.5, unknownCost: 1, maxCostUsd: 6.1, budgetStops: 1 }]; }
}
const thresholds = { runUsd: 6, dayUsd: 30, runOutputTokens: 200000 };
const setup = () => { const store = new Store(), posts: string[] = [];
  const alerts = new UsageAlerts(store, { post: async (_c, text) => { posts.push(text); } }, 'C1', thresholds, () => new Date('2026-11-19T12:00:00Z'));
  return { store, posts, alerts }; };

describe('usage alerts', () => {
  it('stores and logs an ordinary run without a message', async () => {
    const { store, posts, alerts } = setup(), log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await alerts.observe(entry());
    expect(store.rows).toHaveLength(1); expect(posts).toEqual([]);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ event: 'factory-usage', repository: 'owner/repo', costUsd: 3.4, repeated: false });
    log.mockRestore();
  });
  it('reports an expensive run once, a capped run, many output tokens and tokens without a result', async () => {
    const { posts, alerts } = setup(); vi.spyOn(console, 'log').mockImplementation(() => {});
    await alerts.observe(entry({ costUsd: 7.25 })); await alerts.observe(entry({ costUsd: 7.25 }));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('auffälliger Lauf in owner/repo#7 (claude, claude-opus-5-5, high)');
    expect(posts[0]).toContain('über der Alarmschwelle von 6.00 $'); expect(posts[0]).toContain('7.25 $');
    expect(posts[0]).toContain('https://github.com/owner/repo/actions/runs/99');
    await alerts.observe(entry({ executionId: 'b'.repeat(32), costUsd: 10.02, budgetReached: true, outcome: 'error_max_budget_usd' }));
    expect(posts[1]).toContain('Kostendeckel von 10.00 $ hat den Lauf gestoppt');
    await alerts.observe(entry({ executionId: 'c'.repeat(32), costUsd: null, outcome: null, turns: null, durationMs: null, tokens: { input: 1, output: 250000, cacheRead: 0, cacheWrite: 0 } }));
    expect(posts[2]).toContain('kein Ergebnis gemeldet'); expect(posts[2]).toContain('Ungewöhnlich viele Ausgabe-Tokens'); expect(posts[2]).toContain('Kosten unbekannt');
    vi.restoreAllMocks();
  });
  it('reports the daily spend of a repository once per day', async () => {
    const { posts, alerts } = setup(); vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const [i, cost] of [5, 5.5, 5.9, 5.9, 5.9, 5.9].entries()) await alerts.observe(entry({ executionId: String(i).repeat(32), costUsd: cost }));
    expect(posts).toHaveLength(1); expect(posts[0]).toContain('owner/repo hat heute (UTC) schon 34.10 $ für 6 Coding-Läufe');
    vi.restoreAllMocks();
  });
  it('stays quiet without a channel and reads thresholds from the environment', async () => {
    const store = new Store(); vi.spyOn(console, 'log').mockImplementation(() => {});
    await new UsageAlerts(store, undefined, undefined, thresholds).observe(entry({ costUsd: 50 }));
    expect(store.rows).toHaveLength(1);
    expect(usageThresholds({})).toEqual(thresholds);
    expect(usageThresholds({ FACTORY_USAGE_RUN_ALERT_USD: '4', FACTORY_USAGE_DAY_ALERT_USD: '20', FACTORY_USAGE_RUN_ALERT_OUTPUT_TOKENS: '1000' })).toEqual({ runUsd: 4, dayUsd: 20, runOutputTokens: 1000 });
    vi.restoreAllMocks();
  });
});
describe('usage records and reports', () => {
  const snapshot = snapshotSchema.parse({ version: 1, repositoryId: 42, repository: 'owner/target',
    release: { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-coding', buildId: 'v1', taskQueue: 'sf-coding', schemaVersion: 1 },
    admission: { actionId: 'd'.repeat(64), policyHash: 'e'.repeat(64), input: { contractVersion: '1.0', repository: 'owner/target', issueNumber: 2, taskVersion: 'f'.repeat(64),
      description: 'x', acceptanceCriteria: ['y'], contextReferences: [], executionId: 'a'.repeat(32), allowedActions: ['publish_result'],
      limits: { timeoutMinutes: 5, maxOutputBytes: 16000 }, operation: 'sha256', worker: 'codex' } },
    baseSha: '2'.repeat(40), specHash: 'f'.repeat(64), configHash: '3'.repeat(64), requireHumanGate: true });
  it('accepts only a valid record of the polled execution', () => {
    expect(usageEntry(snapshot, 5, record())).toEqual({ repositoryId: 42, repository: 'owner/target', issueNumber: 2, runId: 5, record: record() });
    expect(usageEntry(snapshot, 5, record({ executionId: 'b'.repeat(32) }))).toBeNull();
    expect(usageEntry(snapshot, 5, { ...record(), extra: 1 })).toBeNull();
  });
  it('writes the status line and the daily report', async () => {
    expect(usageNoteEn(record())).toBe('**Usage:** $3.40, 951k input / 30k output tokens, 39 turns.');
    expect(usageNoteEn(record({ costUsd: 10.01, budgetReached: true }))).toContain('(stopped at the $10.00 cap)');
    expect(usageNoteEn(record({ costUsd: null, tokens: null, turns: null }))).toBe('**Usage:** cost unknown.');
    expect(usageReportText('2026-11-18', [])).toBe('SF Verbrauch 2026-11-18 (UTC): keine Coding-Läufe.');
    const store = new Store(), posts: string[] = [], sink = { post: async (_c: string, t: string) => { posts.push(t); } };
    expect(await dailyUsageReport(store, sink, 'C1', new Date('2026-11-19T05:59:00Z'))).toBe(false);
    expect(await dailyUsageReport(store, sink, 'C1', new Date('2026-11-19T06:05:00Z'))).toBe(true);
    expect(await dailyUsageReport(store, sink, 'C1', new Date('2026-11-19T07:05:00Z'))).toBe(false);
    expect(posts).toEqual(['SF Verbrauch 2026-11-18 (UTC): 12.50 $ für 3 Coding-Läufe.\n• owner/repo: 12.50 $ in 3 Läufen, teuerster 6.10 $, 1 ohne Kostenangabe, 1× Kostendeckel']);
  });
});
describe('broker model call counting', () => {
  it('reports a loop once per repository and purpose', async () => {
    let now = 0; const posts: string[] = []; vi.spyOn(console, 'warn').mockImplementation(() => {});
    const meter = new LlmCallMeter({ post: async (_c, t) => { posts.push(t); } }, 'C1', 3, () => now);
    for (let i = 0; i < 5; i++) { meter.observe('owner/repo', 'review'); now += 60000; }
    await Promise.resolve();
    expect(posts).toHaveLength(1); expect(posts[0]).toContain('Merge-Review in owner/repo hat in der letzten Stunde 3 Modellaufrufe');
    now += 3600000; expect(meter.observe('owner/repo', 'review')).toBe(1);
    vi.restoreAllMocks();
  });
  it('counts every broker call that goes through routedCall', async () => {
    const meter = new LlmCallMeter(undefined, undefined, 100); setLlmCallMeter(meter);
    await routedCall({ routing: undefined, repository: 'owner/repo', purpose: 'planner', state: () => '', router: undefined, candidates: undefined, run: () => null, configured: async () => 1 });
    countLlmCall('owner/repo', 'planner');
    expect(meter.observe('owner/repo', 'planner')).toBe(3);
    setLlmCallMeter(undefined);
  });
});
