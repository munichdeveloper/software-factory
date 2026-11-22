import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Cost analytics (Johannes, 2026-11-19: "Kosten pro gemergtem Feature", per GitHub issue, "welche Modelle verwendet
 * wurden … heruntergebrochen auf die einzelnen Schritte"). Coding runs are stored with their usage already
 * (factory_runtime_usage); this module records the broker's own model calls (merge review, risk assessment, planner)
 * with what they belong to: the repository, the pull request and its issue, the step, and whether the model router
 * chose the model. Only inference cost counts; Jev's routing requests and Actions minutes are not priced.
 *
 * The caller sets the context (setLlmSubject for the pull request, withLlmStep for the step); the provider call reports
 * its tokens through recordLlmCall. Without a context or a sink nothing is recorded, and recording never fails a call.
 */
export type LlmStep = 'review' | 'risk' | 'planner' | 'reconcile';
export type ModelSelection = 'router' | 'configured' | 'escalation';
export interface LlmCallContext {
  repository?: string; prNumber?: number | null; issueNumber?: number | null; step?: LlmStep;
  selection?: ModelSelection; routerChoice?: string | null; routerProbability?: number | null;
}
export interface LlmTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface LlmCallRecord {
  repository: string; step: LlmStep; prNumber: number | null; issueNumber: number | null;
  selection: ModelSelection; routerChoice: string | null; routerProbability: number | null;
  provider: 'claude' | 'openai'; model: string; effort: string | null; tokens: LlmTokens | null;
  costUsd: number | null; priceSource: PriceSource | null; outcome: 'success' | 'failed';
}
/** The verdict of a merge review (router evaluation: how often a review rejects what a routed coding model wrote). */
export interface LlmVerdictRecord { repository: string; step: LlmStep; prNumber: number | null; issueNumber: number | null; decision: string; rejected: boolean }
export interface LlmCallSink { recordLlmCall(record: LlmCallRecord): Promise<void>; recordLlmVerdict?(record: LlmVerdictRecord): Promise<void> }

const storage = new AsyncLocalStorage<LlmCallContext>();
let sink: LlmCallSink | undefined;
export const setLlmCallSink = (value: LlmCallSink | undefined) => { sink = value; };
export const llmContext = (): LlmCallContext | undefined => storage.getStore();
/** Runs `work` with the context extended by `values` (the step and the router's choice of a routed call). */
export const withLlmContext = <T>(values: LlmCallContext, work: () => Promise<T>): Promise<T> => storage.run({ ...storage.getStore(), ...values }, work);
/** Names the pull request (and its issue) the following calls of this async flow belong to: one per merge candidate. */
export const setLlmSubject = (values: LlmCallContext) => storage.enterWith({ ...storage.getStore(), ...values });
/** Updates the routing fields of the current context in place, so the calls of the running step see the router's outcome. */
export const noteLlmSelection = (selection: ModelSelection, routerChoice: string | null, routerProbability: number | null) => {
  const store = storage.getStore();
  if (store) Object.assign(store, { selection, routerChoice, routerProbability });
};

/**
 * Prices (Johannes, 2026-11-19: prices current at the time of each call, without anyone maintaining a table). The
 * broker reads a public price list (OpenRouter's model list: list prices per token for Anthropic's and OpenAI's models,
 * no key) and keeps it for an hour; every call is priced with the list it holds at that moment, and the price is stored
 * with the call, so earlier calls keep theirs. Order: FACTORY_MODEL_PRICES (explicit override), the live list, the table
 * below (fallback while the list is unreachable or lacks a model). Without a price the cost stays unknown.
 *
 * Fallback table: Anthropic list prices in USD per million tokens (platform.claude.com pricing, 2026-11): input,
 * output, cache read, cache write (5-minute writes: 1.25 × input).
 */
export type ModelPrice = [input: number, output: number, cacheRead: number, cacheWrite: number];
export type PriceSource = 'configured' | 'live' | 'table';
export const defaultModelPrices: Record<string, ModelPrice> = {
  'claude-fable-5-2': [8, 40, 0.2, 10], 'claude-fable-5-1': [10, 50, 1, 12.5], 'claude-fable-5': [10, 50, 1, 12.5],
  'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-opus-5': [5, 25, 0.5, 6.25], 'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-opus-4-7': [5, 25, 0.5, 6.25], 'claude-opus-4-6': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5], 'claude-sonnet-5': [2, 10, 0.2, 2.5], 'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125], 'claude-haiku-4-5': [1, 5, 0.1, 1.25]
};
/**
 * One spelling per model across the configuration, the price list and the table: lower case, without provider prefix
 * (anthropic/), variant (:batch), context suffix ([1m]) or date (-20261101), dots as hyphens (claude-fable-5.2 and
 * claude-fable-5-2 are one model).
 */
export function modelKey(model: string): string {
  return model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/^.*\//, '').replace(/:.*$/, '').replace(/-\d{8}$/, '').replace(/\./g, '-');
}
const validPrice = (value: unknown): value is ModelPrice =>
  Array.isArray(value) && value.length === 4 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
/** The explicit overrides of FACTORY_MODEL_PRICES ({"model": [in, out, cacheRead, cacheWrite]} per million tokens). */
export function configuredModelPrices(env: Record<string, string | undefined>): Record<string, ModelPrice> {
  const prices: Record<string, ModelPrice> = {};
  if (!env.FACTORY_MODEL_PRICES) return prices;
  try {
    const parsed = JSON.parse(env.FACTORY_MODEL_PRICES) as Record<string, unknown>;
    for (const [model, value] of Object.entries(parsed)) if (validPrice(value)) prices[modelKey(model)] = value;
  } catch { console.warn(JSON.stringify({ event: 'factory-analytics', code: 'INVALID_MODEL_PRICES' })); }
  return prices;
}
/** The default table with the overrides, keyed by modelKey. */
export function modelPrices(env: Record<string, string | undefined>): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(defaultModelPrices)) table[modelKey(model)] = price;
  return { ...table, ...configuredModelPrices(env) };
}

/** OpenRouter's public model list (no key); FACTORY_PRICE_LIST_URL=off turns the live prices off. */
export const defaultPriceListUrl = 'https://openrouter.ai/api/v1/models';
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
/** Prices per million tokens from an OpenRouter-style list ({data: [{id, pricing: {prompt, completion, input_cache_read, input_cache_write}}]}, USD per token). */
export function parsePriceList(body: unknown): Record<string, ModelPrice> {
  const table: Record<string, ModelPrice> = {};
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return table;
  for (const entry of data as { id?: unknown; pricing?: Record<string, unknown> }[]) {
    if (typeof entry?.id !== 'string' || entry.id.includes(':') || !entry.pricing) continue; // :batch, :free … are variants
    const perToken = (key: string) => { const v = entry.pricing![key]; const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN; return Number.isFinite(n) && n >= 0 ? n * 1e6 : null; };
    const input = perToken('prompt'), output = perToken('completion');
    if (input === null || output === null || (input === 0 && output === 0)) continue; // free or variable-price entries are no list price
    const price: ModelPrice = [input, output, perToken('input_cache_read') ?? input, perToken('input_cache_write') ?? input];
    table[modelKey(entry.id)] ??= price;
  }
  return table;
}
/**
 * The live price list, refreshed in the background when older than an hour (after a failure: retried after five
 * minutes, keeping the last list). price() never waits for the network: until the first list arrives the table applies.
 */
export class LivePriceList {
  private table: Record<string, ModelPrice> | null = null;
  private loadedAt = -Infinity;
  private pending: Promise<void> | null = null;
  constructor(private url: string, private fetcher: Fetcher = fetch, private now: () => number = Date.now, private ttlMs = 3600000) {}
  price(model: string): ModelPrice | null {
    if (this.now() - this.loadedAt >= this.ttlMs) void this.refresh();
    return this.table?.[modelKey(model)] ?? null;
  }
  refresh(): Promise<void> {
    this.pending ??= (async () => {
      try {
        const response = await this.fetcher(this.url, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const table = parsePriceList(await response.json());
        if (!Object.keys(table).length) throw new Error('EMPTY_PRICE_LIST');
        this.table = table; this.loadedAt = this.now();
        console.log(JSON.stringify({ event: 'factory-analytics', code: 'PRICE_LIST_LOADED', models: Object.keys(table).length }));
      } catch (error) {
        this.loadedAt = this.now() - this.ttlMs + 300000;
        console.warn(JSON.stringify({ event: 'factory-analytics', code: 'PRICE_LIST_FAILED', reason: error instanceof Error ? error.message.slice(0, 80) : 'unknown', kept: this.table !== null }));
      } finally { this.pending = null; }
    })();
    return this.pending;
  }
}

let configured: Record<string, ModelPrice> = {};
let fallback: Record<string, ModelPrice> = modelPrices({});
let live: { price(model: string): ModelPrice | null } | undefined;
/** Sets the prices from the broker's environment and starts the live list; returns it (undefined when turned off). */
export function configurePrices(env: Record<string, string | undefined>, fetcher: Fetcher = fetch): LivePriceList | undefined {
  configured = configuredModelPrices(env); fallback = modelPrices(env);
  const url = env.FACTORY_PRICE_LIST_URL?.trim() || defaultPriceListUrl;
  const list = url === 'off' ? undefined : new LivePriceList(url, fetcher);
  live = list; void list?.refresh();
  return list;
}
/** For tests: replaces the live list. */
export const setLivePrices = (value: { price(model: string): ModelPrice | null } | undefined) => { live = value; };
/** The cost of tokens at a price per million tokens. */
export const costAt = (price: ModelPrice, tokens: LlmTokens) =>
  (tokens.input * price[0] + tokens.output * price[1] + tokens.cacheRead * price[2] + tokens.cacheWrite * price[3]) / 1e6;
/** The current price of a model and where it came from, or null when no source knows it. */
export function currentPrice(model: string): { price: ModelPrice; source: PriceSource } | null {
  const key = modelKey(model);
  if (configured[key]) return { price: configured[key], source: 'configured' };
  const fromList = live?.price(key);
  if (fromList) return { price: fromList, source: 'live' };
  return fallback[key] ? { price: fallback[key], source: 'table' } : null;
}
/** The cost of a call at the current price; costUsd null when the tokens or the price are unknown. */
export function priceCall(model: string, tokens: LlmTokens | null): { costUsd: number | null; priceSource: PriceSource | null } {
  const current = tokens ? currentPrice(model) : null;
  return current && tokens ? { costUsd: costAt(current.price, tokens), priceSource: current.source } : { costUsd: null, priceSource: null };
}
/** The list price of a call in a given table (keyed by modelKey), or null when the model has no price. */
export function priceOf(model: string, tokens: LlmTokens | null, table: Record<string, ModelPrice> = modelPrices({})): number | null {
  const price = table[modelKey(model)];
  return price && tokens ? costAt(price, tokens) : null;
}

/** Called by every broker provider call with its tokens (null when the provider did not report them). Never throws. */
export function recordLlmCall(provider: LlmCallRecord['provider'], model: string, effort: string | null | undefined, tokens: LlmTokens | null, outcome: LlmCallRecord['outcome'] = 'success') {
  try {
    const context = storage.getStore();
    if (!sink || !context?.repository || !context.step) return;
    const record: LlmCallRecord = { repository: context.repository, step: context.step, prNumber: context.prNumber ?? null, issueNumber: context.issueNumber ?? null,
      selection: context.selection ?? 'configured', routerChoice: context.routerChoice ?? null, routerProbability: context.routerProbability ?? null,
      provider, model, effort: effort ?? null, tokens, ...priceCall(model, tokens), outcome };
    void sink.recordLlmCall(record).catch(() => console.warn(JSON.stringify({ event: 'factory-analytics', code: 'RECORD_FAILED', step: record.step })));
  } catch { /* analytics never fails a call */ }
}
/** Called once per fresh merge review with its decision, inside the pull request's context. Never throws. */
export function recordLlmVerdict(step: LlmStep, decision: string, rejected: boolean) {
  try {
    const context = storage.getStore();
    if (!sink?.recordLlmVerdict || !context?.repository) return;
    const record: LlmVerdictRecord = { repository: context.repository, step, prNumber: context.prNumber ?? null, issueNumber: context.issueNumber ?? null, decision, rejected };
    void sink.recordLlmVerdict(record).catch(() => console.warn(JSON.stringify({ event: 'factory-analytics', code: 'VERDICT_NOT_RECORDED', step })));
  } catch { /* analytics never fails a review */ }
}
/** Tokens of an OpenAI Responses API answer (usage.input_tokens includes the cached ones). */
export function openaiTokens(body: unknown): LlmTokens | null {
  const usage = (body as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | null)?.usage;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, usage.input_tokens - cached), output: usage.output_tokens, cacheRead: cached, cacheWrite: 0 };
}
