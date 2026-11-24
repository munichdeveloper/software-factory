import { describe, expect, it } from 'vitest';
import { costEvalPrompt, costEvalSettings, CostEvaluator, costMetrics, weeklyCostReport, type CostEvalInput, type CostEvalRow, type CostEvalStore, type CostJudgement, type CostReport } from '../src/runtime/cost-eval.js';
import type { UsageEntry, UsageRecord } from '../src/runtime/usage.js';
import type { ClaudeCall } from '../src/llm/claude.js';

const insight = {
  trace: [
    { turn: 1, tool: 'Read', target: 'src/a.ts', error: false }, { turn: 2, tool: 'Read', target: 'src/a.ts', error: false },
    { turn: 3, tool: 'Read', target: 'node_modules/next/dist/docs/routing.md', error: false }, { turn: 4, tool: 'Edit', target: 'src/a.ts', error: false },
    { turn: 5, tool: 'Bash', target: 'npm', error: true }, { turn: 6, tool: 'Bash', target: 'npx', error: false }, { turn: 7, tool: 'Grep', target: 'src', error: false }],
  traceTruncated: false, firstRequestInputTokens: 17000, outputTokensPerTurn: [10, 20],
  diff: [{ path: 'src/a.ts', added: 8, removed: 2 }], diffTruncated: false
};
const record = (over: Partial<UsageRecord> = {}): UsageRecord => ({ contractVersion: '1.0', executionId: 'a'.repeat(32), worker: 'claude', model: 'claude-opus-5-5', effort: 'high',
  source: 'proxy', requests: 26, tokens: { input: 100, output: 9000, cacheRead: 400000, cacheWrite: 40000 }, costUsd: 1.5, turns: 25, durationMs: 420000,
  outcome: 'success', budgetUsd: 10, budgetReached: false, insight, ...over });
const entry = (over: Partial<UsageRecord> = {}, billing: UsageEntry['billing'] = 'api'): UsageEntry => ({ repositoryId: 1, repository: 'owner/repo', issueNumber: 7, runId: 99,
  record: record(over), billing, task: { description: 'Rename the button label.', acceptanceCriteria: ['Label says Speichern'] } });
const judgement = (over: Partial<CostJudgement> = {}): CostJudgement => ({ verdict: 'wasteful', fairCostUsd: 0.3,
  waste: [{ category: 'model-too-strong', usd: 0.8, note: 'Opus high für eine Textänderung' }, { category: 'unnecessary-reads', usd: 0.2, note: 'src/a.ts zweimal gelesen' }],
  reason: 'Eine Textänderung hätte Haiku erledigt.', ...over });

class Store implements CostEvalStore {
  claims = new Set<string>(); rows: Omit<CostEvalRow, 'at'>[] = [];
  async claimCostEval(id: string, model: string) { const k = `${id}:${model}`; if (this.claims.has(k)) return false; this.claims.add(k); return true; }
  async saveCostEval(row: Omit<CostEvalRow, 'at'>) { this.rows.push(row); }
  async previousAttempts() { return [{ model: 'claude-sonnet-5-5', effort: 'medium', costUsd: 0.4, outcome: null }]; }
}
const settings = (over = {}) => ({ enabled: true, model: 'claude-sonnet-5-5', shadowModel: null, alertUsd: 1, ...over });

describe('cost metrics', () => {
  it('derives fixed metrics from the insight without a model', () => {
    expect(costMetrics(record())).toEqual({ costUsd: 1.5, requests: 26, turns: 25, durationMinutes: 7, fixedContextTokens: 442000,
      reads: 3, duplicateReads: 1, readsOutsideDiff: 1, edits: 1, testOrBuildCommands: 2, failedTools: 1, documentationReads: 1,
      changedFiles: 1, changedLines: 10, costPerChangedLine: 0.15, traceTruncated: false, traceMissing: false });
  });
  it('marks a run without insight', () => {
    const m = costMetrics(record({ insight: undefined }));
    expect(m).toMatchObject({ traceMissing: true, reads: 0, changedLines: null, fixedContextTokens: null, costPerChangedLine: null });
  });
});

describe('cost evaluator', () => {
  it('judges a run once per model, stores it and alerts on an expensive wasteful run', async () => {
    const store = new Store(), posts: string[] = [], asked: { model: string; input: string }[] = [];
    const claude = (async request => { asked.push({ model: request.model, input: request.input }); return judgement(); }) as ClaudeCall;
    const evaluator = new CostEvaluator(store, claude, settings({ shadowModel: 'claude-haiku-5-5' }), { post: async (_c, text) => { posts.push(text); } }, 'C1');
    await evaluator.evaluate(entry(), entry().task!);
    await evaluator.evaluate(entry(), entry().task!);
    expect(asked.map(a => a.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(asked[0]!.input).toContain('Rename the button label.');
    expect(asked[0]!.input).toContain('2 Read src/a.ts');
    expect(asked[0]!.input).toContain('5 Bash npm (error)');
    expect(asked[0]!.input).toContain('Earlier attempts at this issue: claude-sonnet-5-5/medium 0.40 $ no result');
    expect(store.rows.map(r => [r.evalModel, r.shadow, r.judgement?.verdict])).toEqual([['claude-sonnet-5-5', false, 'wasteful'], ['claude-haiku-5-5', true, 'wasteful']]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('verschwenderischer Lauf in owner/repo#7');
    expect(posts[0]).toContain('• zu starkes Modell: 0.80 $');
  });
  it('stays quiet for appropriate, cheap or subscription runs and stores a failed evaluation', async () => {
    const posts: string[] = [];
    const sink = { post: async (_c: string, text: string) => { posts.push(text); } };
    await new CostEvaluator(new Store(), (async () => judgement({ verdict: 'appropriate' })) as ClaudeCall, settings(), sink, 'C1').evaluate(entry(), null);
    await new CostEvaluator(new Store(), (async () => judgement()) as ClaudeCall, settings({ alertUsd: 5 }), sink, 'C1').evaluate(entry(), null);
    await new CostEvaluator(new Store(), (async () => judgement()) as ClaudeCall, settings(), sink, 'C1').evaluate(entry({}, 'subscription'), null);
    expect(posts).toEqual([]);
    const store = new Store();
    await new CostEvaluator(store, (async () => { throw new Error('CLAUDE_HTTP_529'); }) as ClaudeCall, settings(), sink, 'C1').evaluate(entry(), null);
    expect(store.rows[0]).toMatchObject({ judgement: null, error: 'CLAUDE_HTTP_529' });
  });
  it('does nothing when turned off or without the broker key', async () => {
    const store = new Store();
    await new CostEvaluator(store, (async () => judgement()) as ClaudeCall, settings({ enabled: false })).evaluate(entry(), null);
    await new CostEvaluator(store, undefined, settings()).evaluate(entry(), null);
    expect(store.rows).toEqual([]);
  });
  it('keeps task text inside its block and tells the model when no trace exists', () => {
    const input: CostEvalInput = { entry: entry({ insight: undefined }), task: null, previous: [] };
    const prompt = costEvalPrompt(input, costMetrics(input.entry.record));
    expect(prompt).toContain('(not available)');
    expect(prompt).toContain('No trace was recorded');
  });
  it('reads its settings from the environment', () => {
    expect(costEvalSettings({})).toEqual({ enabled: true, model: 'claude-sonnet-5-5', shadowModel: null, alertUsd: 3 });
    expect(costEvalSettings({ FACTORY_COST_EVAL: 'off', FACTORY_COST_EVAL_SHADOW_MODEL: 'claude-haiku-5-5', FACTORY_COST_EVAL_ALERT_USD: '5' }))
      .toEqual({ enabled: false, model: 'claude-sonnet-5-5', shadowModel: 'claude-haiku-5-5', alertUsd: 5 });
    expect(() => costEvalSettings({ FACTORY_COST_EVAL_MODEL: 'gpt-5' })).toThrow();
  });
});

describe('weekly cost report', () => {
  const row = (over: Partial<CostEvalRow> = {}): CostEvalRow => ({ repository: 'owner/repo', issueNumber: 7, executionId: 'a'.repeat(32), model: 'claude-opus-5-5', effort: 'high',
    costUsd: 1.5, outcome: 'success', metrics: costMetrics(record()), judgement: judgement(), evalModel: 'claude-sonnet-5-5', shadow: false, error: null, at: '2026-11-25T10:00:00.000Z', ...over });
  const report: CostReport = { summary: 'Opus für Textänderungen.', patterns: [{ category: 'model-too-strong', usd: 0.8, runs: 1, evidence: 'owner/repo#7', proposal: 'Router-Schwelle anheben.' }] };
  it('runs once on Monday morning over last week\'s main verdicts and posts it', async () => {
    const claims = new Set<string>(), saved: unknown[] = [], posts: string[] = [], inputs: string[] = [];
    const store = { claimUsageAlert: async (key: string) => { if (claims.has(key)) return false; claims.add(key); return true; },
      costEvals: async () => [row(), row({ shadow: true }), row({ judgement: null }), row({ at: '2026-12-01T10:00:00.000Z' })],
      saveCostReport: async (...args: unknown[]) => { saved.push(args); } };
    const claude = (async request => { inputs.push(request.input); return report; }) as ClaudeCall;
    const sink = { post: async (_c: string, text: string) => { posts.push(text); } };
    expect(await weeklyCostReport(store, claude, new Date('2026-11-30T05:00:00Z'), undefined, sink, 'C1')).toBe(false);
    expect(await weeklyCostReport(store, claude, new Date('2026-12-01T07:00:00Z'), undefined, sink, 'C1')).toBe(false);
    expect(await weeklyCostReport(store, claude, new Date('2026-11-30T07:00:00Z'), undefined, sink, 'C1')).toBe(true);
    expect(await weeklyCostReport(store, claude, new Date('2026-11-30T08:00:00Z'), undefined, sink, 'C1')).toBe(false);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.split('\n')).toHaveLength(1);
    expect(saved).toEqual([['2026-11-23', 'claude-opus-5-5', report, null]]);
    expect(posts[0]).toContain('SF Kosten-Eval Woche ab 2026-11-23: 1 Läufe, 1.50 $ ausgegeben, angemessen wären etwa 0.30 $.');
    expect(posts[0]).toContain('• zu starkes Modell: 0.80 $ in 1 Läufen. Router-Schwelle anheben.');
  });
});
