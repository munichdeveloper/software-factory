import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { recordLlmCall } from './analytics.js';

/**
 * Claude as the broker's first model provider (Johannes, 2026-11-18): planner, merge review and risk assessment ask
 * Claude first and fall back to OpenAI, in the order the coding agents use. The repository configuration still names
 * OpenAI models; the Claude models come from the broker's environment, so no configuration hash changes.
 */
export interface ClaudeModels { planner: string; review: string; risk: string }
export const claudeModels = (env: Record<string, string | undefined>): ClaudeModels => ({
  planner: env.FACTORY_CLAUDE_PLANNER_MODEL || 'claude-opus-5-5',
  review: env.FACTORY_CLAUDE_REVIEW_MODEL || 'claude-opus-5-5',
  risk: env.FACTORY_CLAUDE_RISK_MODEL || 'claude-opus-5-5'
});
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** OpenAI effort names onto Claude's; no effort configured means the model's own default. */
export const claudeEffort = (effort: string | null | undefined): ClaudeEffort | undefined =>
  !effort ? undefined : ['none', 'minimal', 'low'].includes(effort) ? 'low' : (effort as ClaudeEffort);

/** A failed Claude call with a fixed code only; the provider's own text never leaves this module. */
export class ClaudeError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(`Claude ${code}`); }
}
export function claudeCode(error: unknown): string {
  if (error instanceof ClaudeError) return error.code;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return 'CLAUDE_TIMEOUT';
  if (error instanceof Anthropic.APIConnectionError) return 'CLAUDE_TRANSPORT';
  if (error instanceof Anthropic.APIError && error.status) return `CLAUDE_HTTP_${error.status}`;
  return 'CLAUDE_FAILED';
}

export interface StructuredRequest<T extends z.ZodType> {
  model: string; effort?: ClaudeEffort | undefined; maxTokens: number; timeoutMs: number;
  system: string; input: string; schema: T;
}
export type ClaudeCall = <T extends z.ZodType>(request: StructuredRequest<T>) => Promise<z.infer<T>>;

/** One structured-output request. Throws ClaudeError (or the SDK's typed errors) when no valid answer came back. */
export function claudeStructured(key: string, client?: Anthropic): ClaudeCall {
  return async request => {
    if (!key && !client) throw new ClaudeError('CLAUDE_KEY_MISSING');
    // No SDK retries: the caller falls back to OpenAI instead of waiting, and the next reconciliation asks again.
    const anthropic = client ?? new Anthropic({ apiKey: key, maxRetries: 0 });
    const response = await anthropic.messages.parse({
      model: request.model, max_tokens: request.maxTokens, system: request.system,
      messages: [{ role: 'user', content: request.input }],
      output_config: { ...(request.effort ? { effort: request.effort } : {}), format: zodOutputFormat(request.schema) }
    }, { timeout: request.timeoutMs });
    // Tokens of every broker call, for the usage review (no text, ids and numbers only).
    const usage = response.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined;
    console.log(JSON.stringify({ event: 'factory-llm-usage', provider: 'claude', model: request.model, input: usage?.input_tokens ?? null,
      output: usage?.output_tokens ?? null, cacheRead: usage?.cache_read_input_tokens ?? null, cacheWrite: usage?.cache_creation_input_tokens ?? null }));
    const tokens = usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
      ? { input: usage.input_tokens, output: usage.output_tokens, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 } : null;
    const parsed = request.schema.safeParse(response.parsed_output);
    const failure = response.stop_reason === 'refusal' ? 'CLAUDE_REFUSED' : response.stop_reason === 'max_tokens' ? 'CLAUDE_INCOMPLETE'
      : response.parsed_output === null || response.parsed_output === undefined || !parsed.success ? 'CLAUDE_INVALID_OUTPUT' : null;
    recordLlmCall('claude', request.model, request.effort, tokens, failure ? 'failed' : 'success');
    if (failure || !parsed.success) throw new ClaudeError(failure ?? 'CLAUDE_INVALID_OUTPUT');
    return parsed.data;
  };
}

/** One log line when Claude failed and OpenAI was asked instead: fixed codes only. */
export function logFallback(role: 'planner' | 'review' | 'risk', error: unknown) {
  console.warn(JSON.stringify({ event: 'factory-llm-fallback', role, from: 'claude', to: 'openai', code: claudeCode(error) }));
}
