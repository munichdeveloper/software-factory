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
export type LlmStep = 'review' | 'risk' | 'planner';
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
  costUsd: number | null; outcome: 'success' | 'failed';
}
export interface LlmCallSink { recordLlmCall(record: LlmCallRecord): Promise<void> }

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
 * Anthropic list prices in USD per million tokens (platform.claude.com pricing, 2026-11): input, output, cache read,
 * cache write (5-minute writes: 1.25 × input). OpenAI models are priced only through FACTORY_MODEL_PRICES; without a
 * price the call keeps its tokens and its cost stays unknown.
 */
export type ModelPrice = [input: number, output: number, cacheRead: number, cacheWrite: number];
export const defaultModelPrices: Record<string, ModelPrice> = {
  'claude-fable-5-2': [8, 40, 0.2, 10], 'claude-fable-5-1': [10, 50, 1, 12.5], 'claude-fable-5': [10, 50, 1, 12.5],
  'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-opus-5': [5, 25, 0.5, 6.25], 'claude-opus-4-8': [5, 25, 0.5, 6.25],
  'claude-opus-4-7': [5, 25, 0.5, 6.25], 'claude-opus-4-6': [5, 25, 0.5, 6.25],
  'claude-sonnet-5-5': [2, 10, 0.1, 2.5], 'claude-sonnet-5': [2, 10, 0.2, 2.5], 'claude-sonnet-4-6': [3, 15, 0.3, 3.75],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125], 'claude-haiku-4-5': [1, 5, 0.1, 1.25]
};
/** Prices from the default table, overridden or extended by FACTORY_MODEL_PRICES ({"model": [in, out, cacheRead, cacheWrite]}). */
export function modelPrices(env: Record<string, string | undefined>): Record<string, ModelPrice> {
  const prices = { ...defaultModelPrices };
  if (!env.FACTORY_MODEL_PRICES) return prices;
  try {
    const parsed = JSON.parse(env.FACTORY_MODEL_PRICES) as Record<string, unknown>;
    for (const [model, value] of Object.entries(parsed))
      if (Array.isArray(value) && value.length === 4 && value.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) prices[model] = value as ModelPrice;
  } catch { console.warn(JSON.stringify({ event: 'factory-analytics', code: 'INVALID_MODEL_PRICES' })); }
  return prices;
}
let prices = defaultModelPrices;
export const setModelPrices = (value: Record<string, ModelPrice>) => { prices = value; };
/** The list price of a call, or null when the model has no price. */
export function priceOf(model: string, tokens: LlmTokens | null, table: Record<string, ModelPrice> = prices): number | null {
  const price = table[model];
  if (!price || !tokens) return null;
  return (tokens.input * price[0] + tokens.output * price[1] + tokens.cacheRead * price[2] + tokens.cacheWrite * price[3]) / 1e6;
}

/** Called by every broker provider call with its tokens (null when the provider did not report them). Never throws. */
export function recordLlmCall(provider: LlmCallRecord['provider'], model: string, effort: string | null | undefined, tokens: LlmTokens | null, outcome: LlmCallRecord['outcome'] = 'success') {
  try {
    const context = storage.getStore();
    if (!sink || !context?.repository || !context.step) return;
    const record: LlmCallRecord = { repository: context.repository, step: context.step, prNumber: context.prNumber ?? null, issueNumber: context.issueNumber ?? null,
      selection: context.selection ?? 'configured', routerChoice: context.routerChoice ?? null, routerProbability: context.routerProbability ?? null,
      provider, model, effort: effort ?? null, tokens, costUsd: priceOf(model, tokens), outcome };
    void sink.recordLlmCall(record).catch(() => console.warn(JSON.stringify({ event: 'factory-analytics', code: 'RECORD_FAILED', step: record.step })));
  } catch { /* analytics never fails a call */ }
}
/** Tokens of an OpenAI Responses API answer (usage.input_tokens includes the cached ones). */
export function openaiTokens(body: unknown): LlmTokens | null {
  const usage = (body as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } } | null)?.usage;
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  return { input: Math.max(0, usage.input_tokens - cached), output: usage.output_tokens, cacheRead: cached, cacheWrite: 0 };
}
