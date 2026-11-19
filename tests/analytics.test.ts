import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { configurePrices, currentPrice, LivePriceList, modelKey, modelPrices, openaiTokens, parsePriceList, priceCall, priceOf, recordLlmCall, setLivePrices, setLlmCallSink, setLlmSubject, withLlmContext, type LlmCallRecord } from '../src/llm/analytics.js';
import { routedCall, Routing, type ModelRouter } from '../src/llm/router.js';
import { analyticsIssues, AnalyticsIssueSync, analyticsView, loadAnalytics, weekOf, type AnalyticsCall, type AnalyticsIssue } from '../src/runtime/analytics.js';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import type { Snapshot } from '../src/types.js';

const recorded: LlmCallRecord[] = [];
afterEach(() => { recorded.length = 0; setLlmCallSink(undefined); });
const sink = () => setLlmCallSink({ recordLlmCall: async r => { recorded.push(r); } });
const tokens = { input: 1000, output: 2000, cacheRead: 100000, cacheWrite: 0 };

describe('model prices', () => {
  it('prices a call from list prices and lets the environment add models', () => {
    // Opus 5.5: 4 $ in, 20 $ out, 0.20 $ cache read per million tokens.
    expect(priceOf('claude-opus-5-5', tokens)).toBeCloseTo((1000 * 4 + 2000 * 20 + 100000 * 0.2) / 1e6, 10);
    expect(priceOf('gpt-6.1-sol', tokens)).toBeNull();
    expect(priceOf('claude-opus-5-5', null)).toBeNull();
    const table = modelPrices({ FACTORY_MODEL_PRICES: '{"gpt-6.1-sol":[1,8,0.1,0],"bad":[1]}' });
    expect(priceOf('gpt-6.1-sol', tokens, table)).toBeCloseTo((1000 + 16000 + 10000) / 1e6, 10);
    expect(table.bad).toBeUndefined();
  });
  it('spells a model the same way in the configuration, the price list and the table', () => {
    for (const id of ['anthropic/claude-fable-5.2', 'claude-fable-5-2', 'claude-fable-5-2[1m]', 'Claude-Fable-5.2-20261101', 'anthropic/claude-fable-5.2:batch'])
      expect(modelKey(id)).toBe('claude-fable-5-2');
    expect(modelKey('openai/gpt-6.1')).toBe('gpt-6-1');
  });
  it('reads list prices per token from an OpenRouter-style model list', () => {
    const table = parsePriceList({ data: [
      { id: 'anthropic/claude-fable-5.2', pricing: { prompt: '0.000008', completion: '0.00004', input_cache_read: '0.0000002', input_cache_write: '0.00001' } },
      { id: 'anthropic/claude-fable-5.2:batch', pricing: { prompt: '0.000004', completion: '0.00002' } },
      { id: 'openai/gpt-6.1', pricing: { prompt: '0.000002', completion: '0.000016' } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } }, { id: 'free/model', pricing: { prompt: '0', completion: '0' } }, { id: 7 }] });
    expect(Object.keys(table).sort()).toEqual(['claude-fable-5-2', 'gpt-6-1']);
    expect(table['claude-fable-5-2']![0]).toBeCloseTo(8, 9); expect(table['claude-fable-5-2']![1]).toBeCloseTo(40, 9);
    expect(table['claude-fable-5-2']![2]).toBeCloseTo(0.2, 9); expect(table['claude-fable-5-2']![3]).toBeCloseTo(10, 9);
    // Without cache prices the input price applies.
    expect(table['gpt-6-1']![2]).toBeCloseTo(2, 9);
    expect(parsePriceList(null)).toEqual({});
  });
  it('keeps the live list for an hour, refreshes it in the background and keeps the last list when a refresh fails', async () => {
    let now = 0, calls = 0, fail = false, input = '0.000003';
    const fetcher = async () => { calls++; if (fail) throw new Error('down');
      return new Response(JSON.stringify({ data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: input, completion: '0.00001' } }] })); };
    const list = new LivePriceList('https://prices.example', fetcher, () => now);
    expect(list.price('claude-sonnet-5-5')).toBeNull(); // not loaded yet: the caller falls back to the table
    await list.refresh(); expect(calls).toBe(1);
    expect(list.price('claude-sonnet-5-5')![0]).toBeCloseTo(3, 9);
    now = 3599000; list.price('claude-sonnet-5-5'); expect(calls).toBe(1);
    input = '0.000004'; now = 3600000; list.price('claude-sonnet-5-5'); await list.refresh(); expect(calls).toBe(2);
    expect(list.price('claude-sonnet-5-5')![0]).toBeCloseTo(4, 9);
    fail = true; now = 7300000; list.price('claude-sonnet-5-5'); await new Promise(resolve => setImmediate(resolve));
    expect(list.price('claude-sonnet-5-5')![0]).toBeCloseTo(4, 9);
    const after = calls; now += 200000; list.price('claude-sonnet-5-5'); expect(calls).toBe(after); // retried after five minutes, not at once
  });
  it('prices with the override first, then the live list, then the table', () => {
    try {
      setLivePrices({ price: model => model === 'claude-sonnet-5-5' || model === 'gpt-6-1' ? [3, 12, 0.3, 3.75] : null });
      expect(currentPrice('claude-sonnet-5-5')?.source).toBe('live');
      expect(currentPrice('claude-opus-5-5')).toEqual({ price: [4, 20, 0.2, 5], source: 'table' });
      expect(currentPrice('unknown-model')).toBeNull();
      expect(priceCall('gpt-6.1', tokens)).toEqual({ costUsd: (1000 * 3 + 2000 * 12 + 100000 * 0.3) / 1e6, priceSource: 'live' });
      expect(priceCall('gpt-6.1', null)).toEqual({ costUsd: null, priceSource: null });
      expect(configurePrices({ FACTORY_MODEL_PRICES: '{"claude-sonnet-5.5":[1,1,1,1]}', FACTORY_PRICE_LIST_URL: 'off' })).toBeUndefined();
      expect(currentPrice('claude-sonnet-5-5')).toEqual({ price: [1, 1, 1, 1], source: 'configured' });
    } finally { configurePrices({ FACTORY_PRICE_LIST_URL: 'off' }); setLivePrices(undefined); }
  });
  it('reads OpenAI usage with the cached part split off', () => {
    expect(openaiTokens({ usage: { input_tokens: 5000, output_tokens: 300, input_tokens_details: { cached_tokens: 4000 } } }))
      .toEqual({ input: 1000, output: 300, cacheRead: 4000, cacheWrite: 0 });
    expect(openaiTokens({})).toBeNull();
  });
});

describe('recording broker calls', () => {
  it('records nothing outside a step context or without a sink', async () => {
    recordLlmCall('claude', 'claude-opus-5-5', 'high', tokens);
    sink(); recordLlmCall('claude', 'claude-opus-5-5', 'high', tokens);
    await withLlmContext({ repository: 'owner/repo' }, async () => { recordLlmCall('claude', 'claude-opus-5-5', 'high', tokens); });
    expect(recorded).toEqual([]);
  });
  it('names the pull request, issue, step and the routed model', async () => {
    sink();
    const router = { route: async () => ({ used: true, purpose: 'review', choice: 'sonnet', confidence: 0.8, model: 'typesafe/jev-1.14' }) } as unknown as ModelRouter;
    const routing = new Routing(router);
    const candidates = [{ id: 'sonnet', provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoningEffort: 'medium', description: 'cheap' },
      { id: 'opus', provider: 'claude' as const, model: 'claude-opus-5-5', reasoningEffort: 'high', description: 'strong' }];
    await withLlmContext({}, async () => {
      setLlmSubject({ repository: 'owner/repo', prNumber: 12, issueNumber: 7 });
      await routedCall({ routing, repository: 'owner/repo', purpose: 'review', state: () => 'x', router: { enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5 },
        candidates, configured: async () => 'configured',
        run: c => async () => { recordLlmCall('claude', c.model, c.reasoningEffort, tokens); return 'routed'; } });
      // Router off: the configured model runs and is recorded as configured.
      await routedCall({ routing: undefined, repository: 'owner/repo', purpose: 'risk', state: () => 'x', router: undefined, candidates: undefined,
        configured: async () => { recordLlmCall('openai', 'gpt-6.1-sol', 'high', tokens, 'failed'); return 'configured'; }, run: () => null });
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(recorded).toEqual([
      { repository: 'owner/repo', step: 'review', prNumber: 12, issueNumber: 7, selection: 'router', routerChoice: 'sonnet', routerProbability: 0.8,
        provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', tokens, costUsd: priceOf('claude-sonnet-5-5', tokens), priceSource: 'table', outcome: 'success' },
      { repository: 'owner/repo', step: 'risk', prNumber: 12, issueNumber: 7, selection: 'configured', routerChoice: null, routerProbability: null,
        provider: 'openai', model: 'gpt-6.1-sol', effort: 'high', tokens, costUsd: null, priceSource: null, outcome: 'failed' }]);
  });
});

const call = (over: Partial<AnalyticsCall>): AnalyticsCall => ({ repository: 'owner/repo', step: 'coding', issueNumber: 7, prNumber: null, executionId: null,
  selection: 'router', routerChoice: 'sonnet', routerProbability: 0.7, agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', tokens,
  costUsd: 1, outcome: 'success', at: '2026-11-18T10:00:00.000Z', ...over });
const issue = (over: Partial<AnalyticsIssue & { repository: string }>): AnalyticsIssue & { repository: string } => ({ repository: 'owner/repo', issueNumber: 7,
  title: 'Feature', state: 'closed', prNumber: 20, mergedAt: '2026-11-18T12:00:00.000Z', mergedBy: 'factory', ...over });

describe('analytics view', () => {
  const from = new Date('2026-11-10T00:00:00Z'), to = new Date('2026-11-20T00:00:00Z');
  it('adds every attempt of a feature, also before the period, and reports cost per merged feature', () => {
    const calls = [
      call({ costUsd: 3, outcome: 'error_max_turns', selection: 'router', at: '2026-11-01T10:00:00.000Z' }),
      call({ costUsd: 4, selection: 'escalation', model: 'claude-opus-5-5', effort: 'high' }),
      call({ step: 'review', agent: 'claude', prNumber: 20, costUsd: 0.5, at: '2026-11-18T11:00:00.000Z' }),
      call({ step: 'risk', agent: 'openai', model: 'gpt-6.1-sol', selection: 'configured', costUsd: null, at: '2026-11-18T11:05:00.000Z' }),
      call({ issueNumber: 8, costUsd: 2, at: '2026-11-15T10:00:00.000Z' }),
      call({ issueNumber: 9, costUsd: 1.5, outcome: 'success', at: '2026-11-16T10:00:00.000Z' }),
      call({ step: 'planner', issueNumber: null, agent: 'claude', costUsd: 0.1, at: '2026-11-16T10:00:00.000Z' }),
      call({ repository: 'owner/other', issueNumber: 1, costUsd: 9 })
    ];
    const issues = [issue({}), issue({ issueNumber: 8, mergedAt: '2026-11-15T12:00:00.000Z', prNumber: 21 }),
      issue({ issueNumber: 9, state: 'closed', mergedAt: null, prNumber: null, mergedBy: null })];
    const view = analyticsView(calls, issues, { from, to, repository: 'owner/repo', now: to });
    expect(view.totals).toEqual({ costUsd: 8.1, calls: 6, unknownCostCalls: 1, lostCostUsd: 1.5, mergedFeatures: 2,
      costPerMergedFeature: { mean: 4.75, median: 4.75 } });
    const seven = view.features.find(f => f.issueNumber === 7)!;
    expect(seven).toMatchObject({ state: 'merged', prNumber: 20, title: 'Feature', costUsd: 7.5, costInRange: 4.5, codingRuns: 2, failedCodingRuns: 1,
      unknownCostCalls: 1, steps: { coding: 7, review: 0.5, risk: 0, planner: 0 }, url: 'https://github.com/owner/repo/issues/7' });
    expect(seven.calls[0]).toMatchObject({ lost: true, outcome: 'error_max_turns' });
    expect(view.features.find(f => f.issueNumber === 9)).toMatchObject({ state: 'closed', costUsd: 1.5 });
    expect(view.steps).toEqual([{ step: 'coding', costUsd: 7.5, calls: 3 }, { step: 'review', costUsd: 0.5, calls: 1 }, { step: 'risk', costUsd: 0, calls: 1 }, { step: 'planner', costUsd: 0.1, calls: 1 }]);
    expect(view.models[0]).toMatchObject({ step: 'coding', model: 'claude-opus-5-5', selection: 'escalation', calls: 1, costUsd: 4 });
    expect(view.models.find(m => m.step === 'risk')).toMatchObject({ unknownCostCalls: 1, costUsd: 0 });
    expect(view.repositories).toEqual(['owner/other', 'owner/repo']);
    expect(view.weekly).toContainEqual({ week: '2026-11-16', step: 'coding', costUsd: 5.5 });
  });
  it('weeks start on Monday (UTC)', () => {
    expect(weekOf('2026-11-22T23:00:00.000Z')).toBe('2026-11-16');
    expect(weekOf('2026-11-16T00:00:00.000Z')).toBe('2026-11-16');
  });
  it('loads with bounded days and a checked repository', async () => {
    let since: Date | undefined;
    const store = { analyticsCalls: async (s: Date) => { since = s; return [call({})]; }, analyticsIssues: async () => [issue({})] };
    const view = await loadAnalytics(store, new URLSearchParams('days=9999'), new Date('2026-11-19T00:00:00Z'));
    expect(view.from).toBe('2025-11-19T00:00:00.000Z');
    expect(since!.toISOString()).toBe('2025-07-22T00:00:00.000Z');
    await expect(loadAnalytics(store, new URLSearchParams('repository=a b/c'))).rejects.toThrow('INVALID_REPOSITORY');
  });
});

describe('issues for the analytics', () => {
  const snapshot = { issues: [{ number: 7, title: 'Feature', body: '', state: 'closed', labels: [], updatedAt: '' }, { number: 8, title: 'Open', body: '', state: 'open', labels: [], updatedAt: '' }],
    prs: [{ number: 20, state: 'closed', merged: true, mergedAt: '2026-11-18T12:00:00Z', closingIssues: [7], referencedIssues: [], mergedBy: { login: 'sf-app[bot]', type: 'Bot' } },
      { number: 19, state: 'closed', merged: false, closingIssues: [8], referencedIssues: [] }] } as unknown as Snapshot;
  it('names the merged pull request and who merged it', () => {
    expect(analyticsIssues(snapshot)).toEqual([
      { issueNumber: 7, title: 'Feature', state: 'closed', prNumber: 20, mergedAt: '2026-11-18T12:00:00Z', mergedBy: 'factory' },
      { issueNumber: 8, title: 'Open', state: 'open', prNumber: null, mergedAt: null, mergedBy: null }]);
  });
  it('writes only what changed since the last pass', async () => {
    const writes: number[][] = [];
    const sync = new AnalyticsIssueSync({ upsertAnalyticsIssues: async (_r, issues) => { writes.push(issues.map(i => i.issueNumber)); } });
    await sync.observed('owner/repo', snapshot);
    await sync.observed('owner/repo', snapshot);
    await sync.observed('owner/repo', { ...snapshot, issues: [{ ...snapshot.issues[1]!, title: 'Renamed' }] } as Snapshot);
    await sync.observed('owner/repo', undefined);
    expect(writes).toEqual([[7, 8], [8]]);
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
describe('GET /v1/analytics', () => {
  it('serves the monitor and manager tokens only', async () => {
    const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32), monitorToken = 'q'.repeat(32);
    const store = { analyticsCalls: async () => [call({})], analyticsIssues: async () => [issue({})] } as unknown as RuntimeStore;
    const server = runtimeServer({ managerToken, workerToken, monitorToken, bindings: [] as RuntimeBinding[], store });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    const get = (path: string, token: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const ok = await get('/v1/analytics?days=30', monitorToken);
    expect(ok.status).toBe(200);
    expect((await ok.json() as { features: unknown[] }).features).toHaveLength(1);
    expect((await get('/v1/analytics', managerToken)).status).toBe(200);
    expect((await get('/v1/analytics', workerToken)).status).toBe(401);
    expect((await get('/v1/analytics?repository=a%20b/c', monitorToken)).status).toBe(400);
  });
});
