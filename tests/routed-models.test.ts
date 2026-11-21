import { describe, expect, it, vi } from 'vitest';
import { maxRouterState, ModelRouter, routeNoteDe, routeOutcome, Routing } from '../src/llm/router.js';
import { riskFromDecision, riskJevState, riskQuestion, routedAssessor, routedReviewer, reviewRouterState } from '../src/llm/routed-models.js';
import { routerSchema } from '../src/config/index.js';
import type { RiskAssessment, RiskInput } from '../src/merge/risk.js';
import type { MergeReview, ReviewInput } from '../src/merge/contract.js';
import { config } from './helpers.js';

const review: MergeReview = { decision: 'defer', reason: 'ok', findings: [] };
const input = { facts: { title: 'Fix login', body: 'Body', number: 1 } as ReviewInput['facts'], trustedScope: 's', trustedInstructions: 'i',
  changes: [{ path: 'src/a.ts', status: 'modified', patch: '+a\n-b', content: null }] } as ReviewInput;
const router = { enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5, review: { candidates: [
  { id: 'claude-medium', provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoningEffort: 'medium' as const, description: 'Small PRs' },
  { id: 'gpt-high', provider: 'openai' as const, model: 'gpt-6.1-sol', reasoningEffort: 'high' as const, description: 'Large PRs' }] } };

describe('routed merge review', () => {
  it('reviews with the routed Claude candidate, its model and effort', async () => {
    const cfg = config(); cfg.merge.review.provider = 'openai'; cfg.router = router;
    const claude = vi.fn(async () => review), configured = { review: vi.fn(async () => review) };
    const routing = new Routing(new ModelRouter('key', async () => Response.json({ answers: { route: { choice: 'claude-medium', confidence: 0.8 } } })));
    await routedReviewer({ routing, repository: 'o/r', claude: claude as never, openaiKey: '' }, cfg, configured).review(input);
    expect(claude).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'medium' }));
    expect(configured.review).not.toHaveBeenCalled();
  });
  it('reviews with the configured chain without a router key, and never routes a mock configuration', async () => {
    const cfg = config(); cfg.merge.review.provider = 'openai'; cfg.router = router;
    const configured = { review: vi.fn(async () => review) }, fetcher = vi.fn();
    await routedReviewer({ routing: new Routing(new ModelRouter(undefined, fetcher)), repository: 'o/r', claude: undefined, openaiKey: 'k' }, cfg, configured).review(input);
    expect(configured.review).toHaveBeenCalledTimes(1);
    const mock = config(); mock.router = router;
    expect(routedReviewer({ routing: new Routing(new ModelRouter('key', fetcher)), repository: 'o/r', claude: undefined, openaiKey: 'k' }, mock, configured)).toBe(configured);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('tells the router the size and files, not the patches', () => {
    const state = reviewRouterState(input);
    expect(state).toContain('1 changed files, 2 changed lines');
    expect(state).toContain('modified src/a.ts (+-2)');
    expect(state).not.toContain('+a');
  });
});

describe('merge risk assessed by Jev directly (router.risk)', () => {
  const riskInput: RiskInput = { changes: [{ path: 'src/auth/session.ts', status: 'modified', patch: '+check(token)\n-skip()', content: 'full file' }],
    touchedAreas: [], metrics: { files: 1, lines: 2, directories: ['src'], testsChanged: false }, guidance: 'Billing lives in src/billing.' };
  const configured = () => ({ assess: vi.fn(async (): Promise<RiskAssessment> => ({ class: 'medium', reason: 'model', factors: [] })) });
  const riskConfig = (risk: { certainty?: number; candidates?: never } = {}) => {
    const cfg = config(); cfg.merge.risk.assessor.provider = 'openai';
    cfg.router = { enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5, risk }; return cfg;
  };
  const jev = (answer: unknown) => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ answers: { route: answer } }));
    return { fetcher, routing: new Routing(new ModelRouter('key', fetcher)) };
  };

  it('asks Jev for the class itself, with the patches, and never runs a model', async () => {
    const { fetcher, routing } = jev({ choice: 'high', probabilities: { low: 0.02, medium: 0.08, high: 0.85, critical: 0.05 } });
    const assessor = configured();
    const result = await routedAssessor({ routing, repository: 'o/r', claude: undefined, openaiKey: '' }, riskConfig(), assessor).assess(riskInput);
    expect(result.class).toBe('high');
    expect(result.reason).toContain('Jev hat die Risikoklasse direkt bestimmt');
    expect(result.factors).toEqual([]);
    expect(assessor.assess).not.toHaveBeenCalled();
    const body = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(Object.keys(body.questions.route.criteria)).toEqual(['low', 'medium', 'high', 'critical']);
    expect(body.questions.route.instructions).toBe(riskQuestion);
    expect(body.state).toContain('+check(token)');
    expect(body.state).toContain('Billing lives in src/billing.');
    expect(routeNoteDe(routeOutcome(result))).toBe('Bewertung: Jev (typesafe/jev-1.14) hat die Risikoklasse direkt bestimmt.');
  });
  it('leans to the higher class when Jev is split', async () => {
    const { routing } = jev({ choice: 'low', probabilities: { low: 0.55, medium: 0.3, high: 0.1, critical: 0.05 } });
    const models = { routing, repository: 'o/r', claude: undefined, openaiKey: '' };
    expect((await routedAssessor(models, riskConfig(), configured()).assess(riskInput)).class).toBe('medium');
    expect((await routedAssessor(models, riskConfig({ certainty: 0.9 }), configured()).assess(riskInput)).class).toBe('high');
    expect((await routedAssessor(models, riskConfig({ certainty: 0.5 }), configured()).assess(riskInput)).class).toBe('low');
  });
  it('falls back to the configured assessor without a usable answer', async () => {
    const unsure = jev({ choice: 'medium', confidence: 0.2 }), assessor = configured();
    const result = await routedAssessor({ routing: unsure.routing, repository: 'o/r', claude: undefined, openaiKey: '' }, riskConfig(), assessor).assess(riskInput);
    expect(assessor.assess).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('model');
    expect(routeNoteDe(routeOutcome(result))).toMatch(/^Bewertung: ohne Jev \(Jev zu unsicher, \d+ %\); bewertet haben die konfigurierten Modelle\.$/);
    const offline = configured();
    const routing = new Routing(new ModelRouter('key', async () => new Response('', { status: 503 })));
    await routedAssessor({ routing, repository: 'o/r', claude: undefined, openaiKey: '' }, riskConfig(), offline).assess(riskInput);
    expect(offline.assess).toHaveBeenCalledTimes(1);
  });
  it('keeps the configured assessor without router.risk, and accepts old candidate lists', async () => {
    const { fetcher, routing } = jev({ choice: 'low', probabilities: { low: 1 } });
    const cfg = riskConfig(); delete cfg.router!.risk;
    const assessor = configured();
    expect(routedAssessor({ routing, repository: 'o/r', claude: undefined, openaiKey: '' }, cfg, assessor)).toBe(assessor);
    expect(fetcher).not.toHaveBeenCalled();
    expect(routerSchema.parse({ risk: { candidates: router.review.candidates } }).risk?.candidates).toHaveLength(2);
  });
  it('fits a large change into the state limit, every file with a share of its patch', () => {
    const changes = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts`, status: 'modified', patch: `+${'x'.repeat(5000)}`, content: null }));
    const state = riskJevState({ ...riskInput, changes, metrics: { ...riskInput.metrics, files: 5 } });
    expect(state.length).toBeLessThanOrEqual(maxRouterState);
    for (let i = 0; i < 5; i++) expect(state).toContain(`--- modified src/f${i}.ts`);
  });
  it('derives the class from probabilities or a sure choice only', () => {
    const used = { used: true as const, purpose: 'risk' as const, choice: 'medium', confidence: 0.9, model: 'm' };
    expect(riskFromDecision({ record: used, probabilities: null }, 0.8)).toBe('medium');
    expect(riskFromDecision({ record: { ...used, confidence: 0.6 }, probabilities: null }, 0.8)).toBeNull();
    expect(riskFromDecision({ record: used, probabilities: { low: 0.7, medium: 0.2, high: 0.1 } }, 0.8)).toBe('medium');
  });
});
