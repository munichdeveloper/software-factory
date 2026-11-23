import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { probeClaude, probeClaudeSubscription, probeCodex, providerProbe, selectAgent, type CommandRunner, type ProbeOutcome } from '../src/runtime/agent-selection.js';
import { codingExecutionSchema, type CodingExecutionRequest } from '../src/runtime/coding-contract.js';

const request = (fallbacks?: CodingExecutionRequest['fallbacks']): CodingExecutionRequest => codingExecutionSchema.parse({
  contractVersion: '3.0', executionId: 'a'.repeat(32), worker: 'claude', model: 'claude-opus-5-5', effort: 'high',
  task: { id: 'github:o/r#1', version: 'b'.repeat(64), description: 'Do it', acceptanceCriteria: ['done'], contextReferences: [] },
  baseSha: 'c'.repeat(40), allowedActions: ['edit_workspace', 'run_commands'], limits: { timeoutMinutes: 30, maxFiles: 100, maxPatchBytes: 5000000 },
  ...(fallbacks ? { fallbacks } : {}) });
const codex = { worker: 'codex' as const, model: 'gpt-6.1-sol', effort: 'high' as const };

describe('selectAgent', () => {
  it('runs the first agent whose provider has credit and hands the Harness a plain request', async () => {
    const asked: string[] = [];
    const result = await selectAgent(request([codex]), async agent => { asked.push(agent.worker); return 'available'; });
    expect(asked).toEqual(['claude']);
    expect(result.request).toEqual(request());
    expect(result.request).not.toHaveProperty('fallbacks');
    expect(result.selection).toEqual({ version: 1, executionId: 'a'.repeat(32), selected: { worker: 'claude', model: 'claude-opus-5-5', effort: 'high' }, skipped: [] });
  });
  it('falls back in order when a provider reports used-up credit or refuses the key', async () => {
    const outcomes: Record<string, ProbeOutcome> = { claude: 'exhausted', codex: 'available' };
    const result = await selectAgent(request([codex]), async agent => outcomes[agent.worker]!);
    expect(result.request).toMatchObject({ worker: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(result.selection.skipped).toEqual([{ worker: 'claude', model: 'claude-opus-5-5', effort: 'high', reason: 'exhausted' }]);
    const none = await selectAgent(request([codex]), async agent => agent.worker === 'claude' ? 'missing-key' : 'exhausted');
    expect(none.request).toBeNull();
    expect(none.selection.selected).toBeNull();
    expect(none.selection.skipped.map(s => s.reason)).toEqual(['missing-key', 'exhausted']);
  });
  it('records the subscription credential in the choice but hands the Harness a plain request', async () => {
    const sub = { worker: 'claude' as const, model: 'claude-sonnet-5-5', effort: 'medium' as const, credential: 'subscription' as const };
    const result = await selectAgent(request([codex, sub]), async agent => agent.credential ? 'available' : 'exhausted');
    expect(result.request).toMatchObject({ worker: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(result.request).not.toHaveProperty('credential');
    expect(result.selection.selected).toEqual(sub);
    expect(result.selection.skipped.map(s => s.worker)).toEqual(['claude', 'codex']);
  });
});
describe('probeClaudeSubscription', () => {
  const runner = (stdout: string, seen?: { args: string[]; env: Record<string, string> }[]): CommandRunner => async (_c, args, env) => { seen?.push({ args, env }); return { code: 0, stdout }; };
  it('runs the pinned Claude Code with only the OAuth token and reads the API status of its result', async () => {
    const seen: { args: string[]; env: Record<string, string> }[] = [];
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', '2.1.318', runner('{"is_error":false,"api_error_status":null}', seen))).toBe('available');
    expect(seen[0]!.args.slice(0, 2)).toEqual(['--yes', '@anthropic-ai/claude-code@2.1.318']);
    expect(seen[0]!.args).toContain('claude-sonnet-5-5');
    expect(seen[0]!.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: 'tok', CLAUDE_CODE_MAX_RETRIES: '0' });
    expect(seen[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(await probeClaudeSubscription(undefined, 'claude-sonnet-5-5', '2.1.318')).toBe('missing-key');
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', '2.1.318', runner('{"is_error":true,"api_error_status":429}'))).toBe('exhausted');
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', '2.1.318', runner('{"is_error":true,"api_error_status":401}'))).toBe('rejected');
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', '2.1.318', runner('{"is_error":true,"api_error_status":529}'))).toBe('available');
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', '2.1.318', runner('npm ERR! network'))).toBe('available');
    expect(await probeClaudeSubscription('tok', 'claude-sonnet-5-5', 'latest', runner('{"api_error_status":429}'))).toBe('available');
  });
  it('probes the subscription only with the OAuth token', async () => {
    const probe = providerProbe({ ANTHROPIC_API_KEY: 'k' });
    expect(await probe({ worker: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', credential: 'subscription' })).toBe('missing-key');
  });
});

const fakeClaude = (error?: unknown) => ({ messages: { create: async () => { if (error) throw error; return {}; } } }) as unknown as Anthropic;
const apiError = (status: number, body: unknown) => Anthropic.APIError.generate(status, body, JSON.stringify(body), new Headers());
describe('probeClaude', () => {
  it('tells used-up credit, spend caps and refused keys from transient failures', async () => {
    expect(await probeClaude(undefined, 'claude-opus-5-5')).toBe('missing-key');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude())).toBe('available');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } })))).toBe('exhausted');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.' } })))).toBe('exhausted');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(402, { type: 'error', error: { type: 'billing_error', message: 'Billing' } })))).toBe('exhausted');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'cap', details: { error_code: 'enforced_spend_limit_reached' } } })))).toBe('exhausted');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } })))).toBe('rejected');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })))).toBe('available');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(apiError(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } })))).toBe('available');
    expect(await probeClaude('k', 'claude-opus-5-5', fakeClaude(new Error('boom')))).toBe('available');
  });
});
describe('probeCodex', () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
  it('sends a minimal Responses request with the agent model and reads insufficient_quota as used-up credit', async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', async (url, init) => { sent = { url, init }; return new Response('{}', { status: 200 }); })).toBe('available');
    expect(sent!.url).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(String(sent!.init.body))).toMatchObject({ model: 'gpt-6.1-sol', max_output_tokens: 16 });
    expect(await probeCodex(undefined, 'gpt-6.1-sol')).toBe('missing-key');
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', reply(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } }))).toBe('exhausted');
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', reply(429, { error: { code: 'rate_limit_exceeded' } }))).toBe('available');
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', reply(401, { error: { code: 'invalid_api_key' } }))).toBe('rejected');
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', reply(500, {}))).toBe('available');
    expect(await probeCodex('sk-x', 'gpt-6.1-sol', async () => { throw new Error('network'); })).toBe('available');
  });
});
