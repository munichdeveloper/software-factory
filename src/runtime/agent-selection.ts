import Anthropic from '@anthropic-ai/sdk';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { codingExecutionSchema, type CodingExecutionRequest, type CodingFallback } from './coding-contract.js';

/**
 * Agent selection for workers.coding.agents (software-factory#133). Neither Anthropic nor OpenAI publishes the
 * remaining prepaid credit of an API key, so the executor asks each provider with a minimal request, in priority
 * order, whether the key can still be used, and runs the first agent that can. Only a definite answer skips an agent
 * (credit used up, spend limit reached, key missing or refused); a transient failure (rate limit, overload, network)
 * keeps the agent, which then retries as usual.
 */
export type ProbeOutcome = 'available' | 'exhausted' | 'missing-key' | 'rejected';
export type Probe = (agent: CodingFallback) => Promise<ProbeOutcome>;
const agentSchema = z.strictObject({ worker: z.enum(['codex', 'claude']), model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  /** subscription: Claude Code with the Claude subscription's OAuth token instead of the API key. */
  credential: z.literal('subscription').optional() });
/** What the executor uploads as coding-agent-<executionId>; the broker names the agent and alerts from it. */
export const agentSelectionSchema = z.strictObject({ version: z.literal(1), executionId: z.string().regex(/^[a-f0-9]{32}$/),
  selected: agentSchema.nullable(),
  skipped: z.strictObject({ ...agentSchema.shape, reason: z.enum(['exhausted', 'missing-key', 'rejected']) }).array().max(3) });
export type AgentSelection = z.infer<typeof agentSelectionSchema>;

/**
 * Returns the plain request for the Harness (or null when no agent can run) and the record of the choice. The chosen
 * agent's credential is not part of the request: the executor hands the Harness the matching secret instead.
 */
export async function selectAgent(input: CodingExecutionRequest, probe: Probe): Promise<{ request: CodingExecutionRequest | null; selection: AgentSelection }> {
  const { fallbacks, ...plain } = input;
  const candidates: CodingFallback[] = [{ worker: plain.worker, model: plain.model, effort: plain.effort }, ...(fallbacks ?? [])];
  const skipped: AgentSelection['skipped'] = [];
  for (const candidate of candidates) {
    const outcome = await probe(candidate);
    if (outcome === 'available') {
      const request = codingExecutionSchema.parse({ ...plain, worker: candidate.worker, model: candidate.model, effort: candidate.effort });
      return { request, selection: { version: 1, executionId: plain.executionId, selected: candidate, skipped } };
    }
    skipped.push({ ...candidate, reason: outcome });
  }
  return { request: null, selection: { version: 1, executionId: plain.executionId, selected: null, skipped } };
}

const probeText = 'Reply with OK.';
const probeTimeout = 20000;

/** Anthropic: a one-line Messages request with the agent's own model, so a model the key cannot use also shows. */
export async function probeClaude(key: string | undefined, model: string, client?: Anthropic): Promise<ProbeOutcome> {
  if (!key) return 'missing-key';
  const anthropic = client ?? new Anthropic({ apiKey: key, maxRetries: 0, timeout: probeTimeout });
  try {
    await anthropic.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: probeText }] });
    return 'available';
  } catch (error) {
    // The monthly spend cap of the usage tier: a 429 that does not clear by waiting.
    if (error instanceof Anthropic.EnforcedSpendLimitReachedError) return 'exhausted';
    if (error instanceof Anthropic.RateLimitError) return /enforced_spend_limit_reached/.test(JSON.stringify(error.error ?? null)) ? 'exhausted' : 'available';
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return 'rejected';
    // A used-up prepaid balance, or the workspace/organization usage limit set in the Console (2026-11-23: "You have
    // reached your specified API usage limits. You will regain access on <date>"), both 400 invalid_request_error.
    if (error instanceof Anthropic.BadRequestError) return /credit balance|reached your specified API usage limits/i.test(error.message) ? 'exhausted' : 'available';
    if (error instanceof Anthropic.APIConnectionError) return 'available';
    if (error instanceof Anthropic.APIError && error.status === 402) return 'exhausted';
    return 'available';
  }
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
/** OpenAI: a minimal Responses request; insufficient_quota means the credit is used up. */
export async function probeCodex(key: string | undefined, model: string, fetcher: Fetcher = fetch): Promise<ProbeOutcome> {
  if (!key) return 'missing-key';
  let response: Response;
  try {
    response = await fetcher('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(probeTimeout),
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: probeText, max_output_tokens: 16, store: false }) });
  } catch { return 'available'; }
  if (response.ok) return 'available';
  if (response.status === 401 || response.status === 403) return 'rejected';
  let code = '';
  try { const body = await response.json() as { error?: { code?: unknown; type?: unknown } }; code = `${String(body.error?.code ?? '')} ${String(body.error?.type ?? '')}`; } catch { /* no body */ }
  return response.status === 429 && /insufficient_quota/.test(code) ? 'exhausted' : 'available';
}

export type CommandRunner = (command: string, args: string[], env: Record<string, string>, timeoutMs: number) => Promise<{ code: number; stdout: string }>;
const runCommand: CommandRunner = (command, args, env, timeoutMs) => new Promise(resolve => {
  const child = execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout) });
  });
  child.stdin?.end();
});
/**
 * A Claude subscription (OAuth token from `claude setup-token`): one minimal print-mode run of the pinned Claude Code
 * CLI, because subscription tokens are meant for Claude Code. A 429 means the subscription's usage limit is reached
 * (5-hour or weekly window), 401/403 a token that no longer works. Anything else, an install failure included, keeps the
 * agent: the run itself then decides. Without retries, and without the API key in the environment, which Claude Code
 * would otherwise prefer.
 */
export async function probeClaudeSubscription(token: string | undefined, model: string, version: string, run: CommandRunner = runCommand): Promise<ProbeOutcome> {
  if (!token) return 'missing-key';
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) return 'available';
  const home = await mkdtemp(join(tmpdir(), 'sf-claude-probe-'));
  try {
    const result = await run('npx', ['--yes', `@anthropic-ai/claude-code@${version}`, '--print', '--model', model, '--max-turns', '1',
      '--output-format', 'json', '--strict-mcp-config', probeText], {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CLAUDE_CODE_OAUTH_TOKEN: token, CLAUDE_CODE_MAX_RETRIES: '0',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}), ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {})
    }, 180000);
    let status: unknown = null;
    try { status = (JSON.parse(result.stdout.trim().split('\n').pop() ?? '') as { api_error_status?: unknown }).api_error_status; } catch { return 'available'; }
    if (status === 429) return 'exhausted';
    if (status === 401 || status === 403) return 'rejected';
    return 'available';
  } finally { await rm(home, { recursive: true, force: true }); }
}

export function providerProbe(env: Record<string, string | undefined>): Probe {
  return agent => agent.credential === 'subscription' ? probeClaudeSubscription(env.CLAUDE_CODE_OAUTH_TOKEN, agent.model, env.CLAUDE_CODE_VERSION ?? '')
    : agent.worker === 'claude' ? probeClaude(env.ANTHROPIC_API_KEY, agent.model) : probeCodex(env.OPENAI_API_KEY, agent.model);
}
