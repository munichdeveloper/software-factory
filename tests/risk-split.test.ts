import { describe, expect, it, vi } from 'vitest';
import { Manager } from '../src/manager/index.js';
import { JevPlanner, readinessQuestion, riskReadinessQuestion } from '../src/llm/jev-planner.js';
import { ModelRouter, Routing } from '../src/llm/router.js';
import { StaticPlanner } from '../src/llm/provider.js';
import { CachedRiskSplitter, FallbackRiskSplitter, RiskSplitPlanner, splitPartMarker, type RiskSplit, type RiskSplitter } from '../src/llm/risk-split.js';
import { scopeGuidance } from '../src/workers/coding.js';
import { clock, config, issue, MemoryGitHub, finishedAttempt } from './helpers.js';

type Answer = { choice: string; probabilities: Record<string, number> };
const mixed = (): Answer => ({ choice: 'mixed-risk', probabilities: { ready: 0.1, unclear: 0.02, 'too-large': 0.03, 'mixed-risk': 0.85 } });
const ready = (): Answer => ({ choice: 'ready', probabilities: { ready: 0.9, unclear: 0.05, 'too-large': 0.05 } });
/** Jev for tests: answers every readiness question with the given function and records which question was asked. */
function jev(readiness: (state: string, risk: boolean) => Answer) {
  const asked: { risk: boolean; options: string[] }[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), question = body.questions.route, options = Object.keys(question.criteria);
    if (question.instructions !== readinessQuestion && question.instructions !== riskReadinessQuestion) throw new Error('unexpected question');
    const risk = question.instructions === riskReadinessQuestion;
    asked.push({ risk, options });
    return Response.json({ answers: { route: readiness(body.state, risk) } });
  });
  return { asked, routing: new Routing(new ModelRouter('key', fetcher)) };
}
const twoParts: RiskSplit = { split: true, reason: 'Die Rollenprüfung lässt sich vom Export trennen.', riskyBuildsOnRoutine: true,
  routine: { title: 'CSV-Export der Rechnungsliste', goal: 'Die Liste lässt sich als CSV exportieren.', acceptanceCriteria: ['Export enthält alle Spalten'] },
  risky: { title: 'Export nur für Admins', goal: 'Nur Admins dürfen exportieren.', acceptanceCriteria: ['Andere Rollen erhalten 403'] } };
function splitter(answer: () => RiskSplit | Promise<RiskSplit>) {
  const inner: RiskSplitter = { split: vi.fn(async () => answer()) };
  return { inner, cached: new CachedRiskSplitter(inner) };
}
function setup(routing: Routing, split: CachedRiskSplitter, risk = true) {
  const github = new MemoryGitHub(), cfg = config('autonomous');
  cfg.llm.provider = 'jev'; cfg.execution.maxParallelWorkers = 1; cfg.merge.risk.enabled = risk;
  const planner = new RiskSplitPlanner(new JevPlanner(routing, github.repository, new StaticPlanner(), split), split);
  const run = () => new Manager(github, cfg, planner, { correlationId: 'risk-split-test', now: () => clock }).run();
  return { github, cfg, run };
}
const parts = (github: MemoryGitHub) => github.state.issues.filter(i => i.body.includes(splitPartMarker));

describe('risk isolation by splitting tasks (SF #210)', () => {
  it('splits a mixed-risk task before its run into a routine and a risky follow-up and blocks the original', async () => {
    const { routing, asked } = jev(mixed), s = splitter(() => twoParts);
    const { github, run } = setup(routing, s.cached); github.state.issues.push(issue(1));
    expect((await run()).errors).toEqual([]);
    expect(asked[0]).toEqual({ risk: true, options: ['ready', 'unclear', 'too-large', 'mixed-risk'] });
    expect(github.dispatches).toBe(0);
    expect(github.state.issues[0]!.labels).toContain('harness:blocked');
    const [routine, risky] = parts(github);
    expect(routine!.title).toBe('CSV-Export der Rechnungsliste'); expect(risky!.title).toBe('Export nur für Admins');
    expect(routine!.body).toContain('Aus der Risikoaufteilung von #1'); expect(routine!.body).toContain('Origin: #1');
    expect(risky!.body).toContain('Baut auf dem Routineteil auf'); expect(risky!.body).toContain('- Andere Rollen erhalten 403');
    // Repeated reconciliations neither split again nor create more issues.
    await run(); await run();
    expect(parts(github)).toHaveLength(2); expect(s.inner.split).toHaveBeenCalledTimes(1);
  });
  it('never splits a split part again: its readiness is asked without the mixed-risk option', async () => {
    const { routing, asked } = jev((_s, risk) => risk ? mixed() : ready()), s = splitter(() => twoParts);
    const { github, run } = setup(routing, s.cached);
    const part = issue(5); part.body = `Aus der Risikoaufteilung von #1\n\n${part.body}\n\n${splitPartMarker}`; github.state.issues.push(part);
    await run();
    expect(asked[0]!.risk).toBe(false); expect(github.dispatches).toBe(1); expect(s.inner.split).not.toHaveBeenCalled();
  });
  it('starts the task as it is when the splitter says the risky part cannot be separated', async () => {
    const { routing } = jev(mixed), s = splitter(() => ({ split: false, reason: 'Nur der riskante Teil.', routine: null, risky: null, riskyBuildsOnRoutine: false }));
    const { github, run } = setup(routing, s.cached); github.state.issues.push(issue(1));
    await run();
    expect(github.dispatches).toBe(1); expect(parts(github)).toHaveLength(0);
  });
  it('blocks with the mixed-risk reason when the splitter fails', async () => {
    const { routing } = jev(mixed), s = splitter(() => { throw new Error('provider down'); });
    const { github, run } = setup(routing, s.cached); github.state.issues.push(issue(1));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await run();
    expect(github.dispatches).toBe(0); expect(parts(github)).toHaveLength(0);
    expect(github.state.issues[0]!.labels).toContain('harness:blocked');
    expect(JSON.stringify([...github.state.comments.values()])).not.toContain('provider down');
  });
  it('asks the plain readiness question and never splits without enforced risk-based merging', async () => {
    const { routing, asked } = jev(ready), s = splitter(() => twoParts);
    const { github, run } = setup(routing, s.cached, false); github.state.issues.push(issue(1));
    await run();
    expect(asked[0]!.risk).toBe(false); expect(asked[0]!.options).not.toContain('mixed-risk'); expect(github.dispatches).toBe(1);
  });
  it('splits a task whose run ended blocked with the agent\'s "Risk split:" summary', async () => {
    const s = splitter(() => twoParts), github = new MemoryGitHub(), cfg = config('autonomous'); cfg.merge.risk.enabled = true;
    github.state.issues.push(issue(1));
    await finishedAttempt(github, 1, 'blocked', 0, 'Risk split: routine part is the CSV export; risky part is the admin-only check.');
    const planner = new RiskSplitPlanner(new StaticPlanner(), s.cached);
    const run = () => new Manager(github, cfg, planner, { correlationId: 'risk-split-test', now: () => clock }).run();
    expect((await run()).errors).toEqual([]);
    expect(parts(github)).toHaveLength(2);
    expect(s.inner.split).toHaveBeenCalledWith(expect.objectContaining({ workerSummary: expect.stringContaining('Risk split:') }), cfg);
    await run(); expect(parts(github)).toHaveLength(2); expect(s.inner.split).toHaveBeenCalledTimes(1);
  });
  it('leaves an ordinary blocked result alone', async () => {
    const s = splitter(() => twoParts), github = new MemoryGitHub(), cfg = config('autonomous'); cfg.merge.risk.enabled = true;
    github.state.issues.push(issue(1)); await finishedAttempt(github, 1, 'blocked');
    await new Manager(github, cfg, new RiskSplitPlanner(new StaticPlanner(), s.cached), { correlationId: 't', now: () => clock }).run();
    expect(s.inner.split).not.toHaveBeenCalled(); expect(parts(github)).toHaveLength(0);
  });
  it('falls back to the second splitter when the first fails', async () => {
    const failing: RiskSplitter = { split: async () => { throw new Error('x'); } }, second: RiskSplitter = { split: async () => twoParts };
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await new FallbackRiskSplitter(failing, second).split({ title: 't', body: 'b', workerSummary: null, guidance: null }, config('autonomous'))).toEqual(twoParts);
  });
  it('tells the coding agent to report a separable risky part instead of building it, only with risk-based merging', () => {
    const cfg = config('autonomous');
    cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null, loopback: false, smallPullRequests: true };
    expect(scopeGuidance(cfg)).not.toContain('Risk split:');
    cfg.merge.risk.enabled = true;
    expect(scopeGuidance(cfg)).toContain('Risk split:');
    cfg.merge.risk.mode = 'observe'; expect(scopeGuidance(cfg)).not.toContain('Risk split:'); cfg.merge.risk.mode = 'enforce';
    expect(scopeGuidance(cfg).length).toBeLessThanOrEqual(2000);
  });
});
