import { expect, it } from 'vitest';
import { codingAgents, configSchema } from '../src/config/index.js';

const base = (coding: Record<string, unknown>, engine = 'temporal') =>
  ({ version: 1, factory: { scope: 'test' }, execution: { engine }, workers: { coding: { enabled: true, ...coding } } });
const issues = (input: unknown) => { const result = configSchema.safeParse(input); return result.success ? [] : result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`); };

it('keeps Codex as before and accepts Claude with a Claude model and effort up to max on Temporal', () => {
  const codex = configSchema.parse(base({ agent: 'codex' }, 'github-actions'));
  expect(codex.workers.coding).toMatchObject({ agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' });
  const claude = configSchema.parse(base({ agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'max' }));
  expect(claude.workers.coding).toMatchObject({ agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'max' });
});
it('refuses mismatched agents, models and efforts, and Claude outside the Temporal engine', () => {
  expect(issues(base({ agent: 'claude' }))).toEqual(['workers.coding.model: agent claude needs a Claude model, for example claude-opus-5-5']);
  expect(issues(base({ agent: 'codex', model: 'claude-opus-5-5' }))).toEqual(['workers.coding.model: a Claude model needs agent claude']);
  expect(issues(base({ agent: 'codex', reasoningEffort: 'max' }))).toEqual(['workers.coding.reasoningEffort: max is available for agent claude only']);
  expect(issues(base({ agent: 'claude', model: 'claude-opus-5-5' }, 'github-actions'))).toEqual(['workers.coding.agent: agent claude requires execution.engine temporal']);
  expect(issues(base({ agent: 'gemini' }))).toHaveLength(1);
});
it('accepts a priority list of agents on Temporal and keeps configurations without one unchanged', async () => {
  const { codingAgents } = await import('../src/config/index.js');
  const list = configSchema.parse(base({ agents: [{ agent: 'claude', model: 'claude-opus-5-5' }, { agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }] }));
  const coding = list.workers.coding as Exclude<typeof list.workers.coding, false>;
  expect(codingAgents(coding)).toEqual([{ agent: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' }, { agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }]);
  const single = configSchema.parse(base({ agent: 'codex' })).workers.coding as Exclude<typeof list.workers.coding, false>;
  expect(single).not.toHaveProperty('agents');
  expect(codingAgents(single)).toEqual([{ agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }]);
});
it('refuses a list with agent beside it, twice the same agent, mismatched models, or outside Temporal', () => {
  const pair = [{ agent: 'claude', model: 'claude-opus-5-5' }, { agent: 'codex', model: 'gpt-6.1-sol' }];
  expect(issues(base({ agent: 'codex', agents: pair }))).toEqual(['workers.coding.agent: name either agent or agents, not both']);
  expect(issues(base({}))).toEqual(['workers.coding.agent: name agent or agents']);
  expect(issues(base({ agents: [pair[0], pair[0]] }))).toEqual(['workers.coding.agents.1.agent: each agent may appear once (claude may appear once more with credential subscription)']);
  expect(issues(base({ agents: [{ agent: 'codex', model: 'claude-opus-5-5' }] }))).toEqual(['workers.coding.agents.0.model: a Claude model needs agent claude']);
  expect(issues(base({ agents: [{ agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }] }))).toEqual(['workers.coding.agents.0.reasoningEffort: max is available for agent claude only']);
  expect(issues(base({ agents: [] }))).toHaveLength(1);
  expect(issues(base({ agents: pair }, 'github-actions'))).toEqual(['workers.coding.agents: agents requires execution.engine temporal']);
});
it('accepts retryAgents for further attempts, Temporal only, and leaves configurations without it unchanged', async () => {
  const { attemptAgents } = await import('../src/config/index.js');
  const first = [{ agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }, { agent: 'codex', model: 'gpt-6.1-sol' }];
  const retry = [{ agent: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' }, { agent: 'codex', model: 'gpt-6.1-sol' }];
  const parsed = configSchema.parse(base({ agents: first, retryAgents: retry }));
  const coding = parsed.workers.coding as Exclude<typeof parsed.workers.coding, false>;
  expect(attemptAgents(coding, false)[0]).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' });
  expect(attemptAgents(coding, true)[0]).toEqual({ agent: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' });
  const plain = configSchema.parse(base({ agents: first })).workers.coding as Exclude<typeof parsed.workers.coding, false>;
  expect(plain).not.toHaveProperty('retryAgents');
  expect(attemptAgents(plain, true)).toEqual(attemptAgents(plain, false));
  expect(issues(base({ agents: first, retryAgents: [retry[0], retry[0]] }))).toEqual(['workers.coding.retryAgents.1.agent: each agent may appear once (claude may appear once more with credential subscription)']);
  expect(issues(base({ agents: first, retryAgents: [{ agent: 'codex', model: 'claude-opus-5-5' }] }))).toEqual(['workers.coding.retryAgents.0.model: a Claude model needs agent claude']);
  expect(issues(base({ agent: 'codex', retryAgents: [{ agent: 'codex', model: 'gpt-6.1-sol' }] }, 'github-actions'))).toEqual(['workers.coding.retryAgents: retryAgents requires execution.engine temporal']);
});
it('accepts the Claude subscription as a fallback of agent claude only, never first', () => {
  const sub = { agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium', credential: 'subscription' };
  const api = { agent: 'claude', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' };
  const parsed = configSchema.parse(base({ agents: [api, { agent: 'codex', model: 'gpt-6.1-sol' }, sub], retryAgents: [{ agent: 'claude', model: 'claude-opus-5-5' }, sub] }));
  const coding = parsed.workers.coding as Exclude<typeof parsed.workers.coding, false>;
  expect(codingAgents(coding)[2]).toEqual(sub);
  expect(codingAgents(coding)[0]).not.toHaveProperty('credential');
  expect(issues(base({ agents: [sub, api] }))).toEqual(['workers.coding.agents.0.credential: the subscription is a fallback: list an agent with its API key first']);
  expect(issues(base({ agents: [{ agent: 'codex', model: 'gpt-6.1-sol' }, { agent: 'codex', model: 'gpt-6.1-sol', credential: 'subscription' }] })))
    .toEqual(['workers.coding.agents.1.credential: credential subscription is available for agent claude only']);
  expect(issues(base({ agents: [api, sub, sub] }))).toEqual(['workers.coding.agents.2.agent: each agent may appear once (claude may appear once more with credential subscription)']);
});
