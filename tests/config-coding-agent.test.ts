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
