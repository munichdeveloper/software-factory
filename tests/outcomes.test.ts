import { describe, expect, it } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { AnalyticsIssueSync, type AnalyticsIssue } from '../src/runtime/analytics.js';
import { metricsView } from '../src/runtime/metrics.js';
import { deriveOutcome, GitHubOutcomeReader, waitMs, type OutcomeFacts, type OutcomeResult, type PendingOutcome } from '../src/runtime/outcomes.js';
import type { Snapshot } from '../src/types.js';

const hour = 3600000;
const at = (h: number) => new Date(Date.parse('2026-11-18T00:00:00Z') + h * hour).toISOString();
const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({ merged: true, end: at(10), mergedByFactory: true, openedByFactory: true, humanCommit: false,
  prNeedsHuman: [], prNeedsHumanNow: false, issueNeedsHuman: [], gate: [], approvals: [], handoverAt: null, hadRun: true, ...over });
const approval = 'a'.repeat(64);

describe('outcome classes', () => {
  it('is automatic for a Factory merge of a Factory pull request nobody touched', () => {
    expect(deriveOutcome(facts())).toEqual({ outcome: 'automatic', waits: [] });
  });
  it('is approved after a /harness approve, or after the Manager approval gate', () => {
    expect(deriveOutcome(facts({ approvals: [at(6)], handoverAt: at(4) }))).toEqual({ outcome: 'approved',
      waits: [{ kind: 'handover', startedAt: at(4), endedAt: at(6) }] });
    expect(deriveOutcome(facts({ gate: [{ at: at(2), labeled: true }, { at: at(3), labeled: false }] }))).toEqual({ outcome: 'approved',
      waits: [{ kind: 'approval-gate', startedAt: at(2), endedAt: at(3) }] });
    // An approval after the merge does not make the merge an approved one.
    expect(deriveOutcome(facts({ approvals: [at(11)] })).outcome).toBe('automatic');
  });
  it('is a replacement when the merged pull request was not opened by the Factory (sf:automerge)', () => {
    expect(deriveOutcome(facts({ openedByFactory: false, humanCommit: true })).outcome).toBe('replacement');
    // Also after an approval: replacement outranks approved.
    expect(deriveOutcome(facts({ openedByFactory: false, approvals: [at(5)] })).outcome).toBe('replacement');
  });
  it('is approved, not a human merge, when a person merges a Factory pull request nobody else touched', () => {
    // Automerge off or a risk above the threshold: the configuration plans the person's merge.
    expect(deriveOutcome(facts({ mergedByFactory: false, handoverAt: null }))).toEqual({ outcome: 'approved', waits: [] });
    expect(deriveOutcome(facts({ mergedByFactory: false, handoverAt: at(4) })).outcome).toBe('approved');
  });
  it('is a human merge when sf:needs-human was ever on the pull request, or a person committed to a Factory branch', () => {
    const labeled = [{ at: at(1), labeled: true }, { at: at(2), labeled: false }];
    expect(deriveOutcome(facts({ prNeedsHuman: labeled })).outcome).toBe('human-merge');
    expect(deriveOutcome(facts({ prNeedsHumanNow: true })).outcome).toBe('human-merge');
    expect(deriveOutcome(facts({ humanCommit: true })).outcome).toBe('human-merge');
    // The label on the task issue alone is a wait, not a class.
    expect(deriveOutcome(facts({ issueNeedsHuman: labeled })).outcome).toBe('automatic');
  });
  it('is abandoned for an issue closed without a merge after a Factory run, and unclassified without one', () => {
    expect(deriveOutcome(facts({ merged: false, mergedByFactory: false, openedByFactory: null })).outcome).toBe('abandoned');
    expect(deriveOutcome(facts({ merged: false, hadRun: false })).outcome).toBeNull();
  });
  it('applies the precedence abandoned > human-merge > replacement > approved > automatic', () => {
    const all = { approvals: [at(5)], openedByFactory: false, mergedByFactory: false, prNeedsHumanNow: true };
    expect(deriveOutcome(facts(all)).outcome).toBe('human-merge');
    expect(deriveOutcome(facts({ ...all, merged: false })).outcome).toBe('abandoned');
    expect(deriveOutcome(facts({ ...all, prNeedsHumanNow: false, mergedByFactory: true })).outcome).toBe('replacement');
    expect(deriveOutcome(facts({ ...all, prNeedsHumanNow: false, mergedByFactory: true, openedByFactory: true })).outcome).toBe('approved');
  });
});

describe('wait phases', () => {
  it('ends a handover at the approval comment, a needs-human phase at its removal, and keeps open ones until the merge', () => {
    const d = deriveOutcome(facts({ handoverAt: at(1), approvals: [at(3)], prNeedsHuman: [{ at: at(2), labeled: true }, { at: at(5), labeled: false }],
      issueNeedsHuman: [{ at: at(8), labeled: true }] }));
    expect(d.waits).toEqual([{ kind: 'handover', startedAt: at(1), endedAt: at(3) }, { kind: 'needs-human', startedAt: at(2), endedAt: at(5) },
      { kind: 'needs-human', startedAt: at(8), endedAt: at(10) }]);
  });
  it('counts overlapping phases once', () => {
    const d = deriveOutcome(facts({ handoverAt: at(1), prNeedsHuman: [{ at: at(2), labeled: true }, { at: at(6), labeled: false }],
      gate: [{ at: at(4), labeled: true }, { at: at(9), labeled: false }] }));
    // 1-10 h overlapped by three phases: 9 h, not the 16 h their lengths add up to.
    expect(waitMs(d.waits, at(0), at(10))).toBe(9 * hour);
    expect(waitMs(d.waits, at(5), at(7))).toBe(2 * hour);
    expect(waitMs([], null, at(10))).toBe(0);
  });
});

const issue = (over: Partial<AnalyticsIssue & { repository: string }>): AnalyticsIssue & { repository: string } => ({ repository: 'owner/repo', issueNumber: 1, title: 'T', state: 'closed',
  prNumber: 10, mergedAt: at(10), mergedBy: 'factory', qualifiedAt: at(0), handoverAt: null, outcome: 'automatic', closedAt: at(10), waits: [], ...over });
describe('metrics outcomes', () => {
  const from = new Date(at(-24)), to = new Date(at(48));
  it('measures every closed managed issue, with a person\'s merge counted although no handover was recorded', () => {
    const issues = [
      issue({}),
      issue({ issueNumber: 2, outcome: 'approved', handoverAt: at(4), waits: [{ kind: 'handover', startedAt: at(4), endedAt: at(7) }] }),
      issue({ issueNumber: 3, mergedBy: 'human', outcome: 'human-merge', waits: [{ kind: 'needs-human', startedAt: at(-5), endedAt: at(2) }, { kind: 'needs-human', startedAt: at(1), endedAt: at(4) }] }),
      issue({ issueNumber: 4, outcome: 'replacement' }),
      issue({ issueNumber: 5, mergedAt: null, mergedBy: null, prNumber: null, outcome: 'abandoned', closedAt: at(12) }),
      issue({ issueNumber: 6, outcome: null })
    ];
    const view = metricsView([], issues, { from, to, now: to });
    expect(view.flow.outcomes).toEqual({ counts: { automatic: 1, approved: 1, replacement: 1, 'human-merge': 1, abandoned: 1 }, closed: 5, unclassified: 1, automationRate: 0.4 });
    // Legacy fields: the person's merge without a handover stays out.
    expect(view.flow.merged).toBe(4);
    expect(view.items.map(i => i.issueNumber).sort()).toEqual([1, 2, 4, 6]);
    expect(view.leadTime.net).toMatchObject({ count: 4, medianMs: 8.5 * hour });
    expect(view.leadTime.net.byClass['human-merge']).toMatchObject({ count: 1, medianMs: 6 * hour });
    expect(view.leadTime.net.byClass.approved.medianMs).toBe(7 * hour);
    expect(view.leadTime.humanWait).toMatchObject({ count: 4, issuesWithWait: 2 });
    expect(view.items.find(i => i.issueNumber === 2)).toMatchObject({ outcome: 'approved', humanWaitMs: 3 * hour, netLeadMs: 7 * hour });
    expect(view.items.find(i => i.issueNumber === 6)).toMatchObject({ outcome: null, humanWaitMs: null, netLeadMs: null });
  });
  it('leaves issues closed outside the period out', () => {
    const view = metricsView([], [issue({ mergedAt: at(-100) }), issue({ issueNumber: 2, mergedAt: null, mergedBy: null, outcome: 'abandoned', closedAt: at(-100) })], { from, to });
    expect(view.flow.outcomes).toMatchObject({ closed: 0, automationRate: null });
  });
});

describe('reading an issue from GitHub', () => {
  type Row = Record<string, unknown>;
  const fake = (data: { issueEvents?: Row[]; issueComments?: Row[]; prEvents?: Row[]; prComments?: Row[]; commits?: Row[]; pr?: Row }) => {
    const calls: string[] = [];
    const list = (name: string, rows: Row[] | undefined) => Object.assign(async () => ({ data: rows ?? [] }), { name });
    const api = {
      issues: { listEvents: 'events', listComments: 'comments' }, pulls: { get: async () => { calls.push('pulls.get'); return { data: data.pr ?? { user: { login: 'sf-app[bot]', type: 'Bot' }, head: { ref: 'sf/issue-1/x' }, labels: [] } }; }, listCommits: 'commits' },
      paginate: { iterator: (route: string, p: { issue_number?: number; pull_number?: number }) => {
        calls.push(`${route}:${p.issue_number ?? p.pull_number}`);
        const pr = p.issue_number === 10 || p.pull_number === 10;
        const rows = route === 'events' ? (pr ? data.prEvents : data.issueEvents) : route === 'comments' ? (pr ? data.prComments : data.issueComments) : data.commits;
        return (async function* () { yield { data: rows ?? [] }; })();
      } }
    };
    void list;
    return { reader: new GitHubOutcomeReader(api as unknown as Octokit, 'owner', 'repo', 2, () => new Date(at(20))), calls };
  };
  const pending = (over: Partial<PendingOutcome> = {}): PendingOutcome => ({ issueNumber: 1, prNumber: 10, mergedAt: at(10), mergedBy: 'factory', handoverAt: null, hadRun: true, ...over });
  const label = (name: string, event: string, h: number) => ({ event, created_at: at(h), label: { name } });

  it('classifies a Factory merge after /harness approve and reads a bounded number of lists', async () => {
    const { reader, calls } = fake({ issueComments: [{ body: `/harness approve ${approval}`, created_at: at(6) }], issueEvents: [label('harness:awaiting-approval', 'labeled', 2), label('harness:awaiting-approval', 'unlabeled', 6)],
      commits: [{ author: { login: 'sf-app[bot]', type: 'Bot' }, commit: { author: { name: 'sf-app[bot]' } } }] });
    const result = await reader.read(pending());
    expect(result).toMatchObject({ outcome: 'approved', closedAt: at(10), requests: 6, waits: [{ kind: 'approval-gate', startedAt: at(2), endedAt: at(6) }] });
    expect(calls).toHaveLength(6);
  });
  it('classifies a Claude replacement PR with sf:automerge and a person\'s commits', async () => {
    const { reader } = fake({ pr: { user: { login: 'someone', type: 'User' }, head: { ref: 'claude/fix' }, labels: [{ name: 'sf:automerge' }] },
      commits: [{ author: { login: 'someone', type: 'User' }, commit: { author: { name: 'Someone' } } }] });
    expect((await reader.read(pending())).outcome).toBe('replacement');
  });
  it('does not count merge commits, Claude sessions or unlinked commits as a person\'s', async () => {
    const { reader } = fake({ commits: [
      { author: { login: 'sf-app[bot]', type: 'Bot' }, commit: { author: { name: 'sf-app[bot]' } } },
      { parents: [{}, {}], author: { login: 'someone', type: 'User' }, commit: { author: { name: 'Someone' } } },
      { author: null, commit: { author: { name: 'Claude', email: 'noreply@anthropic.com' } } },
      { author: null, commit: { author: { name: 'Unlinked', email: 'unlinked@example.com' } } }] });
    expect((await reader.read(pending())).outcome).toBe('automatic');
  });
  it('counts a linked person\'s own commit on a Factory PR as human-merge', async () => {
    const { reader } = fake({ commits: [{ author: { login: 'someone', type: 'User' }, commit: { author: { name: 'Someone', email: 'someone@example.com' } } }] });
    expect((await reader.read(pending())).outcome).toBe('human-merge');
  });
  it('finds a person\'s merge with sf:needs-human, and an issue closed without a merge', async () => {
    const human = fake({ prEvents: [label('sf:needs-human', 'labeled', 3), label('sf:needs-human', 'unlabeled', 5), label('other', 'labeled', 1)] });
    expect(await human.reader.read(pending({ mergedBy: 'human' }))).toMatchObject({ outcome: 'human-merge', waits: [{ kind: 'needs-human', startedAt: at(3), endedAt: at(5) }] });
    const abandoned = fake({ issueEvents: [{ event: 'closed', created_at: at(12) }] });
    const result = await abandoned.reader.read(pending({ prNumber: null, mergedAt: null, mergedBy: null }));
    expect(result).toMatchObject({ outcome: 'abandoned', closedAt: at(12), requests: 2 });
    expect(abandoned.calls).not.toContain('pulls.get');
  });
});

describe('deriving once', () => {
  const snapshot = { issues: [{ number: 1, title: 'T', body: '', state: 'closed', labels: [], updatedAt: '' }], prs: [] } as unknown as Snapshot;
  it('derives each pending issue once per batch and does not retry a failed one on the next pass', async () => {
    const saved: [number, OutcomeResult][] = [], excluded: number[][] = [];
    const queue: PendingOutcome[] = [{ issueNumber: 1, prNumber: null, mergedAt: null, mergedBy: null, handoverAt: null, hadRun: true },
      { issueNumber: 2, prNumber: null, mergedAt: null, mergedBy: null, handoverAt: null, hadRun: true }];
    const store = { upsertAnalyticsIssues: async () => {}, saveAnalyticsOutcome: async (_r: string, n: number, r: OutcomeResult) => { saved.push([n, r]); queue.splice(queue.findIndex(q => q.issueNumber === n), 1); },
      pendingAnalyticsOutcomes: async (_r: string, _l: number, exclude: number[]) => { excluded.push(exclude); return queue.filter(q => !exclude.includes(q.issueNumber)); } };
    const reader = { read: async (i: PendingOutcome) => { if (i.issueNumber === 1) throw new Error('boom'); return { outcome: 'abandoned' as const, waits: [], closedAt: null, requests: 2 }; } };
    const sync = new AnalyticsIssueSync(store);
    await sync.observed('owner/repo', snapshot, undefined, reader);
    await sync.observed('owner/repo', snapshot, undefined, reader);
    expect(saved.map(([n]) => n)).toEqual([2]);
    expect(excluded).toEqual([[], [1]]);
  });
});
