import { describe, expect, it, vi } from 'vitest';
import { ModelRouter, routeOutcome, Routing } from '../src/llm/router.js';
import { routedAssessor, routedReviewer, reviewRouterState } from '../src/llm/routed-models.js';
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

describe('merge risk without Jev (Haiku assesses, 2026-11-22)', () => {
  const riskInput: RiskInput = { changes: [{ path: 'src/auth/session.ts', status: 'modified', patch: '+check(token)\n-skip()', content: 'full file' }],
    touchedAreas: [], metrics: { files: 1, lines: 2, directories: ['src'], testsChanged: false }, guidance: null };
  const configured = () => ({ assess: vi.fn(async (): Promise<RiskAssessment> => ({ class: 'medium', reason: 'model', factors: [] })) });

  it('runs the configured assessor and never asks Jev, even with router.risk configured', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json({ answers: { route: { choice: 'low', probabilities: { low: 1 } } } }));
    const routing = new Routing(new ModelRouter('key', fetcher));
    const cfg = config(); cfg.merge.risk.assessor.provider = 'openai';
    cfg.router = { enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5, risk: { certainty: 0.8, candidates: router.review.candidates } };
    const assessor = configured();
    const result = await routedAssessor({ routing, repository: 'o/r', claude: undefined, openaiKey: '' }, cfg, assessor).assess(riskInput);
    expect(result.class).toBe('medium');
    expect(assessor.assess).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(routeOutcome(result)).toBeUndefined();
  });
  it('still accepts router.risk in configurations', () => {
    expect(routerSchema.parse({ risk: { candidates: router.review.candidates, certainty: 0.8 } }).risk?.candidates).toHaveLength(2);
  });
});
