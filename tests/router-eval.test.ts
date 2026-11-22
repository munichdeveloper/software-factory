import { describe, expect, it } from 'vitest';
import type { AnalyticsCall, AnalyticsIssue, AnalyticsVerdict } from '../src/runtime/analytics.js';
import { defaultOverkillThresholdMs, modelTier, routerEvaluation } from '../src/runtime/router-eval.js';
import { loadMetrics } from '../src/runtime/metrics.js';

const min = 60000;
const call = (over: Partial<AnalyticsCall>): AnalyticsCall => ({ repository: 'owner/repo', step: 'coding', issueNumber: 1, prNumber: null, executionId: null,
  selection: 'router', routerChoice: 'sonnet-medium', routerProbability: 0.7, agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', tokens: null,
  costUsd: 1, outcome: 'success', at: '2026-11-18T10:00:00.000Z', durationMs: 10 * min, ...over });
const issue = (over: Partial<AnalyticsIssue & { repository: string }>): AnalyticsIssue & { repository: string } => ({ repository: 'owner/repo', issueNumber: 1,
  title: 'Feature', state: 'closed', prNumber: 20, mergedAt: '2026-11-18T12:00:00.000Z', mergedBy: 'factory', qualifiedAt: '2026-11-18T09:00:00.000Z', handoverAt: null, ...over });
const verdict = (over: Partial<AnalyticsVerdict>): AnalyticsVerdict => ({ repository: 'owner/repo', step: 'review', prNumber: 20, issueNumber: 1,
  decision: 'merge', rejected: false, at: '2026-11-18T11:00:00.000Z', ...over });
const from = new Date('2026-11-10T00:00:00Z'), to = new Date('2026-11-20T00:00:00Z');

describe('router evaluation', () => {
  it('sets Jev\'s choice of the first run against rework, review and merge', () => {
    const calls = [
      // 1: Opus high, through on the first run and quick: probably unnecessary.
      call({ issueNumber: 1, routerChoice: 'opus-high', model: 'claude-opus-5-5', effort: 'high', routerProbability: 0.85, durationMs: 5 * min, costUsd: 3 }),
      call({ issueNumber: 1, step: 'review', prNumber: 20, at: '2026-11-18T11:00:00.000Z', durationMs: null, costUsd: 0.5 }),
      // 2: Haiku, review rejects, rework, then merged: too weak.
      call({ issueNumber: 2, routerChoice: 'haiku-low', model: 'claude-haiku-5-5', effort: 'low', routerProbability: 0.35, at: '2026-11-17T10:00:00.000Z' }),
      call({ issueNumber: 2, selection: 'configured', routerChoice: null, at: '2026-11-17T12:00:00.000Z' }),
      // 3: Sonnet fails, the escalation (Opus) succeeds; the issue is still open.
      call({ issueNumber: 3, outcome: 'failed', at: '2026-11-16T10:00:00.000Z' }),
      call({ issueNumber: 3, selection: 'escalation', routerChoice: null, model: 'claude-opus-5-5', effort: 'high', at: '2026-11-16T11:00:00.000Z' }),
      // 4: no router (configured), first run before the period: not a case.
      call({ issueNumber: 4, at: '2026-11-01T10:00:00.000Z' }),
      // 5: configured model, merged first pass.
      call({ issueNumber: 5, selection: 'configured', routerChoice: null, routerProbability: null, at: '2026-11-15T10:00:00.000Z' })
    ];
    const issues = [issue({}), issue({ issueNumber: 2, prNumber: 21, mergedAt: '2026-11-17T14:00:00.000Z', qualifiedAt: '2026-11-17T09:00:00.000Z' }),
      issue({ issueNumber: 3, state: 'open', prNumber: null, mergedAt: null, mergedBy: null }), issue({ issueNumber: 5, prNumber: 23, mergedAt: '2026-11-15T12:00:00.000Z' })];
    const verdicts = [verdict({}), verdict({ issueNumber: 2, prNumber: 21, decision: 'request_changes', rejected: true, at: '2026-11-17T11:00:00.000Z' }),
      verdict({ issueNumber: 2, prNumber: 21, at: '2026-11-17T13:00:00.000Z' })];
    const view = routerEvaluation(calls, issues, verdicts, { from, to });

    expect(view.issues).toBe(4);
    expect(view.routed).toBe(3);
    const byIssue = Object.fromEntries(view.cases.map(c => [c.issueNumber, c]));
    expect(byIssue[1]).toMatchObject({ choice: 'opus-high', tier: 'strong', firstPass: true, flag: 'overkill', costUsd: 3.5, reviews: 1, rejections: 0, leadMs: 3 * 60 * min });
    expect(byIssue[2]).toMatchObject({ choice: 'haiku-low', tier: 'cheap', reworks: 1, rejections: 1, reviews: 2, firstPass: false, flag: 'underpowered', status: 'merged' });
    expect(byIssue[3]).toMatchObject({ firstRunOk: false, escalations: 1, retries: 0, status: 'open', flag: 'underpowered' });
    expect(byIssue[5]).toMatchObject({ routed: false, choice: null, firstPass: true, flag: null });
    expect(view.overkillThresholdMs).toBe(defaultOverkillThresholdMs);
    expect(view.overkill).toBe(1);
    expect(view.overkillCostUsd).toBe(3.5);
    expect(view.verdictsSince).toBe('2026-11-17T11:00:00.000Z');

    const haiku = view.choices.find(c => c.key === 'jev:haiku-low')!;
    expect(haiku).toMatchObject({ issues: 1, merged: 1, firstPassYield: 0, reworkRate: 1, rejectionRate: 0.5, underpowered: 1 });
    expect(view.choices.find(c => !c.routed)?.label).toBe('konfiguriert: claude-sonnet-5-5 medium');
    expect(view.tiers.map(t => t.key)).toEqual(['cheap', 'mid', 'strong']);
    expect(view.confidence.find(b => b.bucket === 'ab 80 %')).toMatchObject({ issues: 1, firstPassYield: 1, troubleRate: 0 });
    expect(view.confidence.find(b => b.bucket === 'unter 40 %')).toMatchObject({ issues: 1, firstPassYield: 0, troubleRate: 1 });
  });
  it('compares strong runs with the median first-pass run of the cheaper models when there are enough', () => {
    const calls = [6, 7, 8].map(n => call({ issueNumber: n, durationMs: 4 * min }))
      .concat([call({ issueNumber: 9, model: 'claude-opus-5-5', routerChoice: 'opus-high', durationMs: 6 * min })]);
    const issues = [6, 7, 8, 9].map(n => issue({ issueNumber: n, prNumber: 30 + n }));
    const view = routerEvaluation(calls, issues, [], { from, to });
    expect(view.overkillThresholdMs).toBe(4 * min);
    expect(view.cases.find(c => c.issueNumber === 9)?.flag).toBeNull();
  });
  it('filters by repository and classifies models', () => {
    expect(routerEvaluation([call({})], [issue({})], [], { from, to, repository: 'owner/other' }).issues).toBe(0);
    expect(['claude-haiku-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'claude-opus-5-5', 'claude-fable-5-2'].map(modelTier)).toEqual(['cheap', 'mid', 'mid', 'strong', 'strong']);
  });
  it('is part of the metrics view, with and without recorded verdicts', async () => {
    const store = { analyticsCalls: async () => [call({})], analyticsIssues: async () => [issue({})] };
    const now = new Date('2026-11-19T00:00:00Z');
    expect((await loadMetrics(store, new URLSearchParams(), now)).router?.issues).toBe(1);
    const withVerdicts = { ...store, analyticsVerdicts: async () => [verdict({ rejected: true, decision: 'request_changes' })] };
    expect((await loadMetrics(withVerdicts, new URLSearchParams(), now)).router?.cases[0]?.rejections).toBe(1);
  });
});
