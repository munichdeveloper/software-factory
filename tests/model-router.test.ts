import { describe, expect, it, vi } from 'vitest';
import { decisionsUrl, endpointModel, ModelRouter, routerEndpoint, typesafeUrl, RouterAlerts, routedCall, routeNoteDe, routeOutcome, Routing, type RouteRecord } from '../src/llm/router.js';
import { loadConfig } from '../src/config/index.js';

const settings = { model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 5 };
const options = [{ id: 'cheap', description: 'Small changes' }, { id: 'strong', description: 'Hard changes' }];
const answering = (body: unknown, status = 200) => vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => Response.json(body, { status }));

describe('ModelRouter', () => {
  it('asks TypeSafe directly with its own key and model name', async () => {
    const fetcher = answering({ model: 'jev-1.14.0', answers: { route: { type: 'choice', choice: 'cheap', confidence: 0.9, probabilities: { cheap: 0.9, strong: 0.1 } } }, usage: { input_tokens: 300, output_tokens: 5 } });
    const record = await new ModelRouter({ api: 'typesafe', key: 'ts-key' }, fetcher).route('review', 's', options, settings);
    expect(record).toEqual({ used: true, purpose: 'review', choice: 'cheap', confidence: 0.9, model: 'typesafe/jev-1.14' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(typesafeUrl);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ts-key');
    expect(JSON.parse(String(init.body)).model).toBe('jev-1.14.0');
  });
  it('chooses the endpoint from the environment and maps model names', () => {
    expect(routerEndpoint({})).toEqual({ api: 'openrouter', key: undefined });
    expect(routerEndpoint({ OPENROUTER_API_KEY: 'or' })).toEqual({ api: 'openrouter', key: 'or' });
    expect(routerEndpoint({ OPENROUTER_API_KEY: 'or', TYPESAFE_API_KEY: ' ts\n' })).toEqual({ api: 'typesafe', key: 'ts' });
    expect(routerEndpoint({ OPENROUTER_API_KEY: 'or', TYPESAFE_API_KEY: 'ts', FACTORY_ROUTER_API: 'openrouter' })).toEqual({ api: 'openrouter', key: 'or' });
    expect(routerEndpoint({ OPENROUTER_API_KEY: 'or', FACTORY_ROUTER_API: 'typesafe' })).toEqual({ api: 'typesafe', key: undefined });
    expect(() => routerEndpoint({ FACTORY_ROUTER_API: 'other' })).toThrow();
    expect(endpointModel('typesafe', 'typesafe/jev-1.14')).toBe('jev-1.14.0');
    expect(endpointModel('typesafe', 'jev-latest')).toBe('jev-latest');
    expect(endpointModel('typesafe', 'typesafe/jev-1.13.0')).toBe('jev-1.13.0');
    expect(endpointModel('openrouter', 'typesafe/jev-1.14')).toBe('typesafe/jev-1.14');
  });
  it('asks the OpenRouter Decisions API with one choice question and returns the choice', async () => {
    const fetcher = answering({ answers: { route: { type: 'choice', choice: 'strong', confidence: 0.82, probabilities: { cheap: 0.18, strong: 0.82 } } } });
    const record = await new ModelRouter('key', fetcher).route('coding', 'x'.repeat(20000), options, settings);
    expect(record).toEqual({ used: true, purpose: 'coding', choice: 'strong', confidence: 0.82, model: 'typesafe/jev-1.14' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(decisionsUrl);
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key');
    const body = JSON.parse(String(init.body));
    expect(body.state).toHaveLength(8000);
    expect(body.questions.route).toMatchObject({ type: 'choice', criteria: { cheap: 'Small changes', strong: 'Hard changes' } });
  });
  it('takes the probability of the choice when no confidence is given', async () => {
    const record = await new ModelRouter('key', answering({ answers: { route: { choice: 'cheap', probabilities: { cheap: 0.7, strong: 0.3 } } } })).route('review', 's', options, settings);
    expect(record).toMatchObject({ used: true, choice: 'cheap', confidence: 0.7 });
  });
  it('is not used without a key, below the minimum, on errors and on unknown answers, and never throws', async () => {
    const fetcher = vi.fn();
    expect(await new ModelRouter(undefined, fetcher).route('coding', 's', options, settings)).toMatchObject({ used: false, reason: 'no-key', code: null });
    expect(fetcher).not.toHaveBeenCalled();
    // Jev's confidence is (p - 1/n) / (1 - 1/n): with two candidates 0.32 means a 66 % lean, which clears 0.5 ...
    expect(await new ModelRouter('key', answering({ answers: { route: { choice: 'strong', confidence: 0.32 } } })).route('coding', 's', options, settings))
      .toMatchObject({ used: true, choice: 'strong', confidence: 0.66 });
    // ... the threshold applies to the chosen candidate's probability, given or recovered.
    expect(await new ModelRouter('key', answering({ answers: { route: { choice: 'strong', confidence: 0.4 } } })).route('coding', 's', options, { ...settings, minConfidence: 0.8 }))
      .toMatchObject({ used: false, reason: 'low-confidence', choice: 'strong', confidence: 0.7 });
    expect(await new ModelRouter('key', answering({ answers: { route: { choice: 'strong', confidence: 0.9, probabilities: { cheap: 0.4, strong: 0.6 } } } })).route('coding', 's', options, { ...settings, minConfidence: 0.65 }))
      .toMatchObject({ used: false, reason: 'low-confidence', confidence: 0.6 });
    expect(await new ModelRouter('key', answering({ error: { message: 'secret detail' } }, 503)).route('coding', 's', options, settings))
      .toEqual({ used: false, purpose: 'coding', reason: 'unavailable', code: 'HTTP_503', choice: null, confidence: null, model: 'typesafe/jev-1.14' });
    expect(await new ModelRouter('key', answering({ answers: { route: { choice: 'other', confidence: 0.9 } } })).route('coding', 's', options, settings))
      .toMatchObject({ used: false, reason: 'invalid-answer', code: 'UNKNOWN_CHOICE' });
    expect(await new ModelRouter('key', async () => { throw new Error('socket hang up'); }).route('coding', 's', options, settings))
      .toMatchObject({ used: false, reason: 'unavailable', code: 'TRANSPORT' });
    expect(await new ModelRouter('key', async () => new Response('not json')).route('coding', 's', options, settings))
      .toMatchObject({ used: false, reason: 'invalid-answer', code: 'INVALID_JSON' });
  });
});

describe('RouterAlerts', () => {
  const skipped: RouteRecord = { used: false, purpose: 'coding', reason: 'no-key', code: null, choice: null, confidence: null, model: 'typesafe/jev-1.14' };
  it('reports a run without the router at most once per repository, purpose and reason in six hours', async () => {
    let now = 0; const posts: string[] = [];
    const alerts = new RouterAlerts({ post: async (_channel, text) => { posts.push(text); } }, 'C123', () => now);
    await alerts.observe('owner/repo', skipped);
    await alerts.observe('owner/repo', skipped);
    await alerts.observe('owner/repo', { ...skipped, purpose: 'review' });
    await alerts.observe('owner/repo', { used: true, purpose: 'coding', choice: 'cheap', confidence: 0.9, model: 'm' });
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain('Coding in owner/repo lief ohne Router, direkt mit den konfigurierten Modellen.');
    expect(posts[0]).toContain('OPENROUTER_API_KEY');
    now = 6 * 3600000;
    await alerts.observe('owner/repo', skipped);
    expect(posts[2]).toContain('Seit der letzten Meldung 1-mal ohne eigene Nachricht.');
    await alerts.observe('owner/repo', { ...skipped, reason: 'low-confidence', choice: 'strong', confidence: 0.31 });
    expect(posts[3]).toContain('gewählt hätte er strong mit 31 %');
  });
});

describe('routedCall', () => {
  const router = { enabled: true, ...settings };
  const routing = (choice: string | null) => new Routing(new ModelRouter(choice ? 'key' : undefined, answering({ answers: { route: { choice, confidence: 0.9 } } })));
  const base = { repository: 'owner/repo', purpose: 'review' as const, state: () => 'pr', router, candidates: options };
  it('runs the routed candidate, and the configured models when there is none, it cannot run or it fails', async () => {
    const configured = vi.fn(async () => 'configured');
    expect(await routedCall({ ...base, routing: routing('strong'), configured, run: c => async () => `routed ${c.id}` })).toBe('routed strong');
    expect(await routedCall({ ...base, routing: routing(null), configured, run: c => async () => `routed ${c.id}` })).toBe('configured');
    expect(await routedCall({ ...base, routing: routing('strong'), configured, run: () => null })).toBe('configured');
    expect(await routedCall({ ...base, routing: routing('strong'), configured, run: () => async () => { throw new Error('HTTP 529'); } })).toBe('configured');
    expect(await routedCall({ ...base, routing: routing('strong'), configured, candidates: undefined, run: () => async () => 'routed' })).toBe('configured');
    expect(await routedCall({ ...base, routing: routing('strong'), configured, router: { ...router, enabled: false }, run: () => async () => 'routed' })).toBe('configured');
  });
  it('records which model did the work, for the merge comments', async () => {
    const candidates = [{ id: 'cheap', description: 'Small', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' },
      { id: 'strong', description: 'Hard', model: 'claude-opus-5-5', reasoningEffort: 'high' }];
    const result = () => ({ decision: 'merge' });
    const routedResult = await routedCall({ ...base, candidates, routing: routing('strong'), configured: async () => result(), run: () => async () => result() });
    expect(routeNoteDe(routeOutcome(routedResult))).toBe('Modellwahl: Der Model Router (Jev) wählte `strong` (claude-opus-5-5, high) mit 95 % Wahrscheinlichkeit.');
    const failed = await routedCall({ ...base, candidates, routing: routing('strong'), configured: async () => result(), run: () => async () => { throw new Error('HTTP 529'); } });
    expect(routeNoteDe(routeOutcome(failed))).toBe('Modellwahl: Der Model Router wählte `strong`, der Kandidat konnte nicht laufen; geprüft haben die konfigurierten Modelle.');
    const skipped = await routedCall({ ...base, candidates, routing: routing(null), configured: async () => result(), run: () => async () => result() });
    expect(routeNoteDe(routeOutcome(skipped))).toBe('Modellwahl: ohne Model Router (kein Jev-Schlüssel im Broker); geprüft haben die konfigurierten Modelle.');
    const unrouted = await routedCall({ ...base, candidates: undefined, routing: routing('strong'), configured: async () => result(), run: () => async () => result() });
    expect(routeNoteDe(routeOutcome(unrouted))).toBe('');
  });
  it('never retries a configuration guard with the configured models', async () => {
    const configured = vi.fn(async () => 'configured');
    await expect(routedCall({ ...base, routing: routing('cheap'), configured, fatal: e => e instanceof Error && e.message === 'guard',
      run: () => async () => { throw new Error('guard'); } })).rejects.toThrow('guard');
    expect(configured).not.toHaveBeenCalled();
  });
});

describe('router configuration', () => {
  const yaml = (router: string) => `version: 1\nfactory:\n  scope: x\nexecution:\n  engine: temporal\nworkers:\n  coding:\n    enabled: true\n    agent: codex\n${router}`;
  it('accepts candidates per purpose and defaults model, minimum confidence and timeout', () => {
    const config = loadConfig(yaml(`router:\n  coding:\n    candidates:\n      - { id: sonnet-medium, agent: claude, model: claude-sonnet-5-5, reasoningEffort: medium, description: Small changes }\n      - { id: opus-high, agent: claude, model: claude-opus-5-5, reasoningEffort: high, description: Hard changes }\n  review:\n    candidates:\n      - { id: gpt-medium, provider: openai, model: gpt-6.1-sol, reasoningEffort: medium, description: Small PRs }\n      - { id: opus-high, provider: claude, model: claude-opus-5-5, reasoningEffort: high, description: Large PRs }\n`));
    expect(config.router).toMatchObject({ enabled: true, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 10 });
    expect(config.router?.coding?.candidates).toHaveLength(2);
  });
  it('leaves configurations without a router unchanged', () => {
    expect(loadConfig(yaml('')).router).toBeUndefined();
  });
  it('refuses duplicate ids, mismatched models, a single candidate and router.coding outside Temporal', () => {
    const two = (a: string, b: string) => `router:\n  review:\n    candidates:\n      - ${a}\n      - ${b}\n`;
    expect(() => loadConfig(yaml(two('{ id: a, provider: openai, model: gpt-6.1-sol, reasoningEffort: low, description: d }', '{ id: a, provider: openai, model: gpt-6.1-sol, reasoningEffort: high, description: d }')))).toThrow('candidate ids must be unique');
    expect(() => loadConfig(yaml(two('{ id: a, provider: openai, model: claude-opus-5-5, reasoningEffort: low, description: d }', '{ id: b, provider: openai, model: gpt-6.1-sol, reasoningEffort: high, description: d }')))).toThrow('provider claude needs a Claude model');
    expect(() => loadConfig(yaml('router:\n  review:\n    candidates:\n      - { id: a, provider: openai, model: gpt-6.1-sol, reasoningEffort: low, description: d }\n'))).toThrow('router.review.candidates');
    expect(() => loadConfig(yaml('router:\n  coding:\n    candidates:\n      - { id: a, agent: codex, model: gpt-6.1-sol, reasoningEffort: low, description: d }\n      - { id: b, agent: codex, model: gpt-6.1-sol, reasoningEffort: high, description: d }\n').replace('  engine: temporal\n', '  engine: github-actions\n')))
      .toThrow('router.coding requires execution.engine temporal');
  });
});
