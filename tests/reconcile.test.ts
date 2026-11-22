import { Octokit } from '@octokit/rest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectFacts, noteEntries, overlapEntries, overlapping, Reconciler, reconcileModel, taskPaths, type SurveyFacts } from '../src/runtime/reconcile.js';
import { llmContext } from '../src/llm/analytics.js';
import type { ClaudeCall } from '../src/llm/claude.js';

const target = { owner: 'owner', repo: 'target' };
const input = { issueNumber: 7, description: 'Change `src/app/page.tsx` and the helpers in src/lib/.\n\nDepends on: #3', acceptanceCriteria: ['Test in tests/page.test.ts passes'] };

function github(options: { fail?: boolean } = {}) {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (request) => {
    const url = new URL(String(request)), path = url.pathname.replace('/repos/owner/target', ''), state = url.searchParams.get('state');
    calls.push(`${path}${state ? `?${state}` : ''}`);
    if (options.fail) return Response.json({ message: 'boom' }, { status: 502 });
    let data: unknown;
    if (path === '/pulls' && state === 'closed') data = [
      { number: 40, title: 'Older merge', merged_at: '2026-11-20T10:00:00Z', body: 'Closes #30', head: { ref: 'feature/a' } },
      { number: 41, title: 'Closed without merge', merged_at: null, body: '', head: { ref: 'feature/b' } },
      { number: 42, title: 'Newest merge', merged_at: '2026-11-22T10:00:00Z', body: null, head: { ref: 'sf/issue-31/abc' } }];
    else if (path === '/pulls' && state === 'open') data = [
      { number: 46, title: 'Same page', head: { ref: 'sf/issue-45/x' } },
      { number: 47, title: 'Earlier attempt of this task', head: { ref: 'sf/issue-7/y' } },
      { number: 48, title: 'Elsewhere', head: { ref: 'feature/c' } }];
    else if (path === '/pulls/46/files') data = [{ filename: 'src/app/page.tsx' }, { filename: 'src/lib/util.ts' }, { filename: 'README.md' }];
    else if (path === '/pulls/48/files') data = [{ filename: 'docs/other.md' }];
    else if (path === '/issues') data = [
      { number: 3, title: 'Prerequisite', body: '' },
      { number: 7, title: 'This task', body: '' },
      { number: 8, title: 'Follow-up', body: 'Depends on: #7' },
      { number: 9, title: 'Mentions it', body: 'See #7 for context' },
      { number: 10, title: 'Unrelated', body: 'Nothing' },
      { number: 46, title: 'A pull request', body: '', pull_request: {} }];
    else throw new Error(`Unexpected ${path}`);
    return Response.json(data);
  };
  return { api: new Octokit({ request: { fetch: fetcher } }), calls };
}

describe('survey before a coding run (SF #255)', () => {
  afterEach(() => vi.restoreAllMocks());
  it('finds the paths a task names, without URLs or version numbers', () => {
    expect(taskPaths('Edit src/a.ts, `page.tsx` and docs/ (see https://example.com/x/y and 1.2/3); not ../etc/passwd; Status-/Fehlerinformation')).toEqual(['src/a.ts', 'docs', 'page.tsx']);
  });
  it('marks overlaps by equal path, directory or file name', () => {
    expect(overlapping(['src/a.ts', 'src/lib/b.ts', 'x/page.tsx', 'other.ts'], ['src/a.ts', 'src/lib', 'page.tsx'])).toEqual(['src/a.ts', 'src/lib/b.ts', 'x/page.tsx']);
  });
  it('collects merged and open pull requests and linked issues with a bounded number of requests', async () => {
    const { api, calls } = github();
    const facts = await collectFacts(api, target, input);
    expect(facts.merged.map(m => [m.number, m.issues])).toEqual([[42, [31]], [40, [30]]]);
    expect(facts.openPulls.map(p => p.number)).toEqual([46, 48]);
    expect(facts.openPulls[0]!.overlap).toEqual(['src/app/page.tsx', 'src/lib/util.ts']);
    expect(facts.issues.map(i => [i.number, i.relation])).toEqual([[3, 'depends-on'], [8, 'dependent'], [9, 'references'], [10, 'open']]);
    expect(calls).toHaveLength(5);
    expect(overlapEntries(facts)).toEqual(['sf-context reconcile-overlap #46: the open pull request "Same page" (branch sf/issue-45/x) changes files this task names: src/app/page.tsx, src/lib/util.ts']);
  });
  it('asks Haiku once in the analytics context of the issue and returns its notes before the overlap facts', async () => {
    const { api } = github(); let seen: unknown; vi.spyOn(console, 'log').mockImplementation(() => {});
    const claude = vi.fn(async (request: Parameters<ClaudeCall>[0]) => {
      seen = llmContext(); expect(request.model).toBe(reconcileModel); expect(request.input).toContain('"number":46');
      return { notes: ['PR #46 changes the same page; coordinate.\nSecond line'], related: [{ number: 46, kind: 'same-files' }] };
    }) as unknown as ClaudeCall;
    const outcome = await new Reconciler(api, claude).survey('owner/target', target, input);
    expect(seen).toMatchObject({ repository: 'owner/target', issueNumber: 7, step: 'reconcile' });
    expect(outcome.model).toBe('used');
    expect(outcome.entries[0]).toMatch(/^sf-context reconcile 1\/1: Survey of this repository .* PR #46 changes the same page; coordinate\. Second line$/);
    expect(outcome.entries[1]).toMatch(/^sf-context reconcile-overlap #46:/);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"event":"factory-reconcile"'));
  });
  it('keeps only the overlap facts when Haiku fails and nothing when GitHub fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const failing = (async () => { throw Object.assign(new Error('x'), { code: 'CLAUDE_INVALID_OUTPUT' }); }) as unknown as ClaudeCall;
    const partial = await new Reconciler(github().api, failing).survey('owner/target', target, input);
    expect(partial).toMatchObject({ model: 'failed', error: 'CLAUDE_INVALID_OUTPUT' });
    expect(partial.entries).toHaveLength(1);
    const none = await new Reconciler(github({ fail: true }).api, failing).survey('owner/target', target, input);
    expect(none).toMatchObject({ entries: [], model: 'none', error: 'HTTP_502' });
  });
  it('bounds and labels the notes', () => {
    const facts: SurveyFacts = { issueNumber: 1, taskPaths: [], merged: [], openPulls: [], issues: [] };
    expect(overlapEntries(facts)).toEqual([]);
    expect(noteEntries({ notes: ['', '  '], related: [] })).toEqual([]);
    const entries = noteEntries({ notes: ['a'.repeat(900), 'b'], related: [] });
    expect(entries.every(e => e.length <= 1000)).toBe(true);
    expect(entries[1]).toBe('sf-context reconcile 2/2: b');
  });
});
