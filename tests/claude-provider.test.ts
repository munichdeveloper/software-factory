import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { claudeEffort, claudeModels, claudeStructured, type ClaudeCall } from '../src/llm/claude.js';
import { ClaudePlanner, FallbackPlanner, planningCode, type Planner } from '../src/llm/provider.js';
import { ClaudeMergeReviewer, FallbackMergeReviewer } from '../src/merge/reviewer.js';
import { ClaudeRiskAssessor, FallbackRiskAssessor, type RiskAssessment, type RiskInput } from '../src/merge/risk.js';
import type { MergeReview, MergeReviewer, ReviewInput } from '../src/merge/contract.js';
import { planSchema } from '../src/types.js';
import { config } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); });
const plan = { version: 1 as const, actions: [] };
const failing = (code: string): Planner => ({ plan: vi.fn(async () => { throw Object.assign(new Error('x'), { code }); }) });

describe('Claude structured calls', () => {
  it('maps the configuration onto Claude and reads models from the broker environment', () => {
    expect(claudeEffort(null)).toBeUndefined(); expect(claudeEffort('minimal')).toBe('low'); expect(claudeEffort('xhigh')).toBe('xhigh');
    expect(claudeModels({})).toEqual({ planner: 'claude-opus-5-5', review: 'claude-opus-5-5', risk: 'claude-opus-5-5' });
    expect(claudeModels({ FACTORY_CLAUDE_PLANNER_MODEL: 'claude-haiku-5-5' }).planner).toBe('claude-haiku-5-5');
  });
  it('returns the parsed output and turns refusals, cut-off and invalid answers into fixed codes', async () => {
    const parse = vi.fn();
    const call = claudeStructured('', { messages: { parse } } as unknown as Anthropic);
    const request = { model: 'claude-opus-5-5', effort: 'low' as const, maxTokens: 4000, timeoutMs: 1000, system: 's', input: 'i', schema: planSchema };
    parse.mockResolvedValueOnce({ stop_reason: 'end_turn', parsed_output: plan });
    expect(await call(request)).toEqual(plan);
    expect(parse.mock.calls[0]![0]).toMatchObject({ model: 'claude-opus-5-5', system: 's', output_config: { effort: 'low', format: { type: 'json_schema' } } });
    expect(parse.mock.calls[0]![1]).toEqual({ timeout: 1000 });
    parse.mockResolvedValueOnce({ stop_reason: 'refusal', parsed_output: null });
    await expect(call(request)).rejects.toMatchObject({ code: 'CLAUDE_REFUSED' });
    parse.mockResolvedValueOnce({ stop_reason: 'max_tokens', parsed_output: null });
    await expect(call(request)).rejects.toMatchObject({ code: 'CLAUDE_INCOMPLETE' });
    parse.mockResolvedValueOnce({ stop_reason: 'end_turn', parsed_output: { version: 2 } });
    await expect(call(request)).rejects.toMatchObject({ code: 'CLAUDE_INVALID_OUTPUT' });
    await expect(claudeStructured('')(request)).rejects.toMatchObject({ code: 'CLAUDE_KEY_MISSING' });
  });
});

describe('planner order', () => {
  it('plans with Claude first and asks OpenAI only when Claude fails, logging fixed codes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = vi.fn(async () => plan) as unknown as ClaudeCall, openai = { plan: vi.fn(async () => plan) };
    expect(await new FallbackPlanner(new ClaudePlanner(call, 'claude-opus-5-5'), openai).plan([], config())).toEqual(plan);
    expect(openai.plan).not.toHaveBeenCalled();
    const broken = vi.fn(async () => { throw new Error('secret provider text'); }) as unknown as ClaudeCall;
    expect(await new FallbackPlanner(new ClaudePlanner(broken, 'claude-opus-5-5'), openai).plan([], config())).toEqual(plan);
    expect(warn.mock.calls.map(c => c[0])).toEqual([JSON.stringify({ event: 'factory-llm-fallback', role: 'planner', from: 'claude', to: 'openai', code: 'CLAUDE_FAILED' })]);
  });
  it('reports the last provider\'s code when both fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secondary: Planner = { plan: async () => { const { PlanningError } = await import('../src/llm/provider.js'); throw new PlanningError('x', 'LLM_HTTP_429'); } };
    const error = await new FallbackPlanner(failing('CLAUDE_HTTP_529'), secondary).plan([], config()).catch((e: unknown) => e);
    expect(planningCode(error)).toBe('LLM_HTTP_429');
  });
});

describe('merge review and risk order', () => {
  const review: MergeReview = { decision: 'defer', reason: 'Checks laufen.', findings: [] };
  const assessment: RiskAssessment = { class: 'low', reason: 'Doku.', factors: [] };
  const input = { facts: { comments: [] }, trustedScope: 's', trustedInstructions: 'i', changes: [] } as unknown as ReviewInput;
  const riskInput: RiskInput = { changes: [], touchedAreas: [], metrics: { files: 0, lines: 0, directories: [], testsChanged: false }, guidance: null };
  it('reviews with Claude first, falls back to OpenAI, and never bypasses the mock configuration guard', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = config(); cfg.llm.provider = 'openai';
    const openai: MergeReviewer = { review: vi.fn(async () => review) };
    const call = vi.fn(async () => review) as unknown as ClaudeCall;
    expect(await new FallbackMergeReviewer(new ClaudeMergeReviewer(call, 'claude-opus-5-5', cfg), openai).review(input)).toEqual(review);
    expect(openai.review).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-5-5', effort: 'high', timeoutMs: 120000 }));
    const broken = vi.fn(async () => { throw new Error('overloaded'); }) as unknown as ClaudeCall;
    expect(await new FallbackMergeReviewer(new ClaudeMergeReviewer(broken, 'claude-opus-5-5', cfg), openai).review(input)).toEqual(review);
    expect(openai.review).toHaveBeenCalledTimes(1);
    const mock = config();
    await expect(new FallbackMergeReviewer(new ClaudeMergeReviewer(call, 'claude-opus-5-5', mock), openai).review(input)).rejects.toThrow('real OpenAI');
    expect(openai.review).toHaveBeenCalledTimes(1);
  });
  it('assesses risk with Claude first and OpenAI second', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = config(); cfg.llm.provider = 'openai';
    const openai = { assess: vi.fn(async () => assessment) };
    const call = vi.fn(async () => assessment) as unknown as ClaudeCall;
    expect(await new FallbackRiskAssessor(new ClaudeRiskAssessor(call, 'claude-opus-5-5', cfg), openai).assess(riskInput)).toEqual(assessment);
    expect(openai.assess).not.toHaveBeenCalled();
    const broken = vi.fn(async () => { throw new Error('credit'); }) as unknown as ClaudeCall;
    expect(await new FallbackRiskAssessor(new ClaudeRiskAssessor(broken, 'claude-opus-5-5', cfg), openai).assess(riskInput)).toEqual(assessment);
    await expect(new FallbackRiskAssessor(new ClaudeRiskAssessor(call, 'claude-opus-5-5', config()), openai).assess(riskInput)).rejects.toThrow('real OpenAI');
  });
});
