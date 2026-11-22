import { describe, expect, it, vi } from 'vitest';
import { ModelRouter, Routing } from '../src/llm/router.js';
import { routedReviewer, reviewRouterState } from '../src/llm/routed-models.js';
import { routerSchema } from '../src/config/index.js';
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

describe('merge risk is not routed (0.26.0)', () => {
  it('still accepts router.risk from older configurations', () => {
    expect(routerSchema.parse({ risk: { candidates: router.review.candidates } }).risk?.candidates).toHaveLength(2);
    expect(routerSchema.parse({ risk: { certainty: 0.8 } }).risk?.certainty).toBe(0.8);
  });
});
