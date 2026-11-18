import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

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
    if (response.stop_reason === 'refusal') throw new ClaudeError('CLAUDE_REFUSED');
    if (response.stop_reason === 'max_tokens') throw new ClaudeError('CLAUDE_INCOMPLETE');
    if (response.parsed_output === null || response.parsed_output === undefined) throw new ClaudeError('CLAUDE_INVALID_OUTPUT');
    const parsed = request.schema.safeParse(response.parsed_output);
    if (!parsed.success) throw new ClaudeError('CLAUDE_INVALID_OUTPUT');
    return parsed.data;
  };
}

/** One log line when Claude failed and OpenAI was asked instead: fixed codes only. */
export function logFallback(role: 'planner' | 'review' | 'risk', error: unknown) {
  console.warn(JSON.stringify({ event: 'factory-llm-fallback', role, from: 'claude', to: 'openai', code: claudeCode(error) }));
}
