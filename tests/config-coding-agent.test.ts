import { expect, it } from 'vitest';
import { configSchema } from '../src/config/index.js';

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
  expect(issues(base({ agents: [pair[0], pair[0]] }))).toEqual(['workers.coding.agents.1.agent: each agent may appear once']);
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
  expect(issues(base({ agents: first, retryAgents: [retry[0], retry[0]] }))).toEqual(['workers.coding.retryAgents.1.agent: each agent may appear once']);
  expect(issues(base({ agents: first, retryAgents: [{ agent: 'codex', model: 'claude-opus-5-5' }] }))).toEqual(['workers.coding.retryAgents.0.model: a Claude model needs agent claude']);
  expect(issues(base({ agent: 'codex', retryAgents: [{ agent: 'codex', model: 'gpt-6.1-sol' }] }, 'github-actions'))).toEqual(['workers.coding.retryAgents: retryAgents requires execution.engine temporal']);
});
