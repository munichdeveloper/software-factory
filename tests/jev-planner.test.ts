import { describe, expect, it, vi } from 'vitest';
import { Manager } from '../src/manager/index.js';
import { JevPlanner, orderQuestion, readinessQuestion } from '../src/llm/jev-planner.js';
import { ModelRouter, Routing } from '../src/llm/router.js';
import { configSchema } from '../src/config/index.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';

type Answer = { choice: string; probabilities: Record<string, number> };
/** Jev for tests: answers the readiness and order questions from the given functions, records every question. */
function jev(readiness: (state: string) => Answer, order: (options: string[]) => Answer = options => ({ choice: options[0]!, probabilities: Object.fromEntries(options.map(o => [o, 1 / options.length])) })) {
  const asked: { kind: 'readiness' | 'order'; state: string; options: string[] }[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)), question = body.questions.route, options = Object.keys(question.criteria);
    const kind = question.instructions === readinessQuestion ? 'readiness' : question.instructions === orderQuestion ? 'order' : null;
    if (!kind) throw new Error('unexpected question');
    asked.push({ kind, state: body.state, options });
    return Response.json({ answers: { route: kind === 'readiness' ? readiness(body.state) : order(options) } });
  });
  return { asked, routing: new Routing(new ModelRouter('key', fetcher)) };
}
const ready = (): Answer => ({ choice: 'ready', probabilities: { ready: 0.9, unclear: 0.05, 'too-large': 0.05 } });
function setup(routing: Routing) {
  const github = new MemoryGitHub(), cfg = config('autonomous'), planner = new JevPlanner(routing, github.repository);
  cfg.llm.provider = 'jev'; cfg.execution.maxParallelWorkers = 1;
  const run = () => new Manager(github, cfg, planner, { correlationId: 'jev-test', now: () => clock }).run();
  return { github, cfg, run };
}
const started = (github: MemoryGitHub) => github.state.issues.filter(i => i.labels.includes('harness:running')).map(i => i.number);

describe('llm.provider jev (SF #203)', () => {
  it('is a valid planner provider', () => {
    expect(configSchema.parse({ version: 1, factory: { scope: 'x' }, llm: { provider: 'jev' } }).llm.provider).toBe('jev');
  });
  it('starts the task Jev ranks first instead of the lowest issue number', async () => {
    const { asked, routing } = jev(ready, () => ({ choice: 'issue-3', probabilities: { 'issue-1': 0.1, 'issue-2': 0.2, 'issue-3': 0.7 } }));
    const { github, run } = setup(routing); github.state.issues.push(issue(1), issue(2), issue(3));
    expect((await run()).errors).toEqual([]);
    expect(started(github)).toEqual([3]);
    expect(asked.map(a => a.kind)).toEqual(['order', 'readiness']);
    expect(asked[0]!.options).toEqual(['issue-1', 'issue-2', 'issue-3']);
  });
  it('keeps a priority label ahead of Jev\'s order', async () => {
    const { routing } = jev(ready, () => ({ choice: 'issue-3', probabilities: { 'issue-1': 0.1, 'issue-2': 0.2, 'issue-3': 0.7 } }));
    const { github, run } = setup(routing); github.state.issues.push(issue(1), issue(2, ['harness:managed', 'harness:ready', 'harness:priority-high']), issue(3));
    await run(); expect(started(github)).toEqual([2]);
  });
  it('blocks an unclear task for its text, starts the next one, and asks again only for a revised text', async () => {
    const { asked, routing } = jev(state => state.startsWith('#1 ') ? { choice: 'unclear', probabilities: { ready: 0.2, unclear: 0.75, 'too-large': 0.05 } } : ready());
    const { github, run } = setup(routing); github.state.issues.push(issue(1), issue(2));
    await run();
    expect(github.state.issues[0]!.labels).toContain('harness:blocked');
    expect(started(github)).toEqual([2]);
    const questions = asked.length;
    await run(); expect(asked).toHaveLength(questions);
    expect(github.state.issues[0]!.labels).toContain('harness:blocked');
  });
  it('a person who removes the planner block overrides Jev for that text', async () => {
    const { routing } = jev(() => ({ choice: 'too-large', probabilities: { ready: 0.1, unclear: 0.1, 'too-large': 0.8 } }));
    const { github, run } = setup(routing); github.state.issues.push(issue(1));
    await run(); expect(github.state.issues[0]!.labels).toContain('harness:blocked'); expect(github.dispatches).toBe(0);
    const task = github.state.issues[0]!; task.labels = task.labels.filter(l => l !== 'harness:blocked'); github.labelBlock(1, false);
    await run(); expect(github.dispatches).toBe(1);
  });
  it('a revised text lifts the planner block and is judged again', async () => {
    let verdict: Answer = { choice: 'unclear', probabilities: { ready: 0.1, unclear: 0.8, 'too-large': 0.1 } };
    const { asked, routing } = jev(() => verdict);
    const { github, run } = setup(routing); github.state.issues.push(issue(1));
    await run(); expect(github.state.issues[0]!.labels).toContain('harness:blocked');
    verdict = ready(); github.state.issues[0]!.body += '\nThe export contains the columns time, instance and severity.';
    await run(); await run();
    expect(github.state.issues[0]!.labels).not.toContain('harness:blocked'); expect(github.dispatches).toBe(1);
    expect(asked.filter(a => a.kind === 'readiness')).toHaveLength(2);
  });
  it('plans like static when Jev is too uncertain, unreachable or has no key', async () => {
    const uncertain = jev(() => ({ choice: 'unclear', probabilities: { ready: 0.3, unclear: 0.4, 'too-large': 0.3 } }));
    const a = setup(uncertain.routing); a.github.state.issues.push(issue(1)); await a.run();
    expect(a.github.dispatches).toBe(1); expect(a.github.state.issues[0]!.labels).not.toContain('harness:blocked');

    const failing = new Routing(new ModelRouter('key', async () => new Response('', { status: 503 })));
    const b = setup(failing); b.github.state.issues.push(issue(1), issue(2)); await b.run(); expect(started(b.github)).toEqual([1]);

    const fetcher = vi.fn(async () => Response.json({}));
    const c = setup(new Routing(new ModelRouter(undefined, fetcher))); c.github.state.issues.push(issue(1), issue(2)); await c.run();
    expect(started(c.github)).toEqual([1]); expect(fetcher).not.toHaveBeenCalled();
  });
  it('asks nothing when no worker slot is free or the router is disabled', async () => {
    const { asked, routing } = jev(ready);
    const { github, cfg, run } = setup(routing); cfg.router = { enabled: false, model: 'typesafe/jev-1.14', minConfidence: 0.5, timeoutSeconds: 10 };
    github.state.issues.push(issue(1)); await run();
    expect(github.dispatches).toBe(1); expect(asked).toEqual([]);
  });
});
