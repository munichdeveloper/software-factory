import { expect, it, vi } from 'vitest';
import { config, clock, MemoryGitHub } from './helpers.js';
import { MergeManager } from '../src/merge/manager.js';
import type { MergeFacts, MergePort, MergeReview, ReviewChange, ReviewInput } from '../src/merge/contract.js';
import { combineReviews, contextLimitError, excerpt, partsLimitError, reviewBytes, reviewParts } from '../src/merge/parts.js';
import { classifyRisk, type RiskAssessor } from '../src/merge/risk.js';

const facts: MergeFacts = { number: 76, title: 'Großes Feature', body: '', head: 'a'.repeat(40), base: 'b'.repeat(40), headBranch: 'feature',
  baseBranch: 'main', state: 'open', draft: false, sameRepository: true, labels: ['sf:automerge'], mergeState: 'CLEAN', reviewDecision: null,
  unresolvedThreads: [], checks: ['test-backend', 'test-frontend', 'test-docker'].map(name => ({ name, state: 'success' })),
  strictChecks: true, nativeRequiredChecks: ['test-backend'], comments: [], mergeSha: null, mergeActorType: null };
const file = (path: string, kb: number): ReviewChange => ({ path, status: 'modified', patch: '@@ -1,1 +1,1 @@\n-old\n+new', content: 'x'.repeat(kb * 1000) });
const input = (changes: ReviewChange[]): ReviewInput => ({ facts, trustedScope: 'Community', trustedInstructions: 'Regeln', changes });

it('keeps a context under the limit as one unchanged review', () => {
  const small = input([file('src/a.ts', 5)]);
  expect(reviewParts(small, 50000, 4)).toEqual([small]);
});
it('splits a large context into parts under the limit, keeps a module with its test and lists every other file', () => {
  const big = input([file('src/a.ts', 20), file('tests/a.test.ts', 10), file('src/b.ts', 25), file('src/c.ts', 25)]);
  const parts = reviewParts(big, 50000, 4);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    expect(reviewBytes(part)).toBeLessThanOrEqual(50000);
    expect(part.part!.total).toBe(parts.length);
    const own = part.changes.map(c => c.path);
    expect([...own, ...part.part!.otherFiles.map(f => f.path)].sort()).toEqual(big.changes.map(c => c.path).sort());
  }
  const withModule = parts.find(p => p.changes.some(c => c.path === 'src/a.ts'))!;
  expect(withModule.changes.map(c => c.path)).toContain('tests/a.test.ts');
  expect(parts.flatMap(p => p.changes.map(c => c.path)).sort()).toEqual(big.changes.map(c => c.path).sort());
});
it('refuses more parts than maxParts and a context that never fits without parts', () => {
  const big = input([file('src/a.ts', 40), file('src/b.ts', 40), file('src/c.ts', 40)]);
  expect(() => reviewParts(big, 50000, 2)).toThrow(partsLimitError);
  expect(() => reviewParts(big, 50000, 1)).toThrow(contextLimitError);
});
it('reviews a file too large for one part by an excerpt that contains every changed line', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'y'.repeat(30)}`);
  const huge: ReviewChange = { path: 'src/huge.ts', status: 'modified', patch: '@@ -1500,1 +1500,1 @@\n-old\n+line 1500', content: lines.join('\n') };
  const text = excerpt(huge)!;
  expect(text).toContain('line 1500 '); expect(text).toContain('line 1300 '); expect(text).toContain('line 1700 ');
  expect(text).not.toContain('line 1299 '); expect(text).toContain('[… Zeilen 1–1299 nicht enthalten …]');
  const parts = reviewParts(input([huge, file('src/b.ts', 5)]), 50000, 4);
  expect(parts.flatMap(p => p.changes).find(c => c.path === 'src/huge.ts')!.contentScope).toBe('excerpt');
  expect(excerpt({ ...huge, patch: 'Binary' })).toBeNull();
});
it('approves only when every part approves; any rejection holds for the whole pull request', () => {
  const ok: MergeReview = { decision: 'merge', reason: 'Gut.', findings: [] };
  expect(combineReviews([ok, ok], 2)).toMatchObject({ decision: 'merge', reason: expect.stringContaining('KI-Review in 2 Teilen, alle freigegeben.') });
  const no: MergeReview = { decision: 'request_changes', reason: 'Fehler.', findings: [{ path: 'src/b.ts', severity: 'blocking', explanation: 'Auth fehlt' }] };
  const combined = combineReviews([ok, no], 3);
  expect(combined.decision).toBe('request_changes');
  expect(combined.findings[0]!.explanation).toBe('Teil 2/3: Auth fehlt');
  expect(combined.reason).toContain('die übrigen wurden nicht mehr geprüft');
});

function managerFixture(changes: ReviewChange[], decide: (part: ReviewInput) => MergeReview['decision'] = () => 'merge') {
  const cfg = config(); cfg.merge.enabled = true; cfg.autonomy.overrides.merge_pr = 'allow'; cfg.llm.provider = 'openai';
  cfg.merge.review.maxContextBytes = 50000;
  const f = structuredClone(facts);
  const reviewer = { review: vi.fn(async (part: ReviewInput) => ({ decision: decide(part), reason: 'Geprüft.', findings: [] }) as MergeReview) };
  const api: MergePort = { repository: 'owner/target',
    candidates: vi.fn(async () => [76]), facts: vi.fn(async () => structuredClone(f)),
    context: vi.fn(async current => ({ facts: current, trustedScope: 'Community', trustedInstructions: 'Regeln', changes: structuredClone(changes) })),
    comment: vi.fn(async (_n, body) => { f.comments.push({ id: f.comments.length + 1, body, author: 'github-actions[bot]', createdAt: clock.toISOString() }); }),
    update: vi.fn(async () => f.head), merge: vi.fn(async () => { f.state = 'closed'; f.mergeSha = 'd'.repeat(40); f.mergeActorType = 'Bot'; return f.mergeSha; }),
    dispatch: vi.fn(async () => {}), workflowAvailable: vi.fn(async () => true), canApprove: vi.fn(async () => false) };
  const run = () => new MergeManager(api, cfg, reviewer, 'test').run(structuredClone(new MemoryGitHub().state));
  return { cfg, f, api, reviewer, run };
}
const large = [file('src/a.ts', 30), file('src/b.ts', 30), file('src/c.ts', 30)];
it('reviews a pull request above the limit in parts and merges when all parts approve', async () => {
  const x = managerFixture(large);
  expect((await x.run()).merged).toBe(1);
  expect(x.reviewer.review).toHaveBeenCalledTimes(3);
  expect(x.api.context).toHaveBeenCalledWith(expect.anything(), 60, 50000 * 4);
  expect(x.f.comments.some(c => c.body.includes('KI-Review in 3 Teilen, alle freigegeben.'))).toBe(true);
});
it('rejects the pull request when one part rejects and stops reviewing further parts', async () => {
  const x = managerFixture(large, part => part.part!.index === 1 ? 'request_changes' : 'merge');
  await x.run();
  expect(x.api.merge).not.toHaveBeenCalled(); expect(x.reviewer.review).toHaveBeenCalledTimes(1);
});
it('keeps the rejection with a hint to smaller pull requests above maxParts', async () => {
  const x = managerFixture(large); x.cfg.merge.review.maxParts = 2;
  await x.run();
  expect(x.reviewer.review).not.toHaveBeenCalled(); expect(x.api.merge).not.toHaveBeenCalled();
  expect(x.f.comments.at(-1)!.body).toContain('mehr als 2 Teile');
});
it('assesses risk per part and keeps the highest class', async () => {
  const cfg = config(); const risk = { ...cfg.merge.risk, enabled: true };
  const classes = ['low', 'high'] as const; let call = 0;
  const assessor: RiskAssessor = { assess: vi.fn(async () => ({ class: classes[call++]!, reason: 'ok', factors: [] })) };
  const changes = [file('src/a.ts', 1), file('src/b.ts', 1)];
  const record = await classifyRisk(changes, risk, assessor, [[changes[0]!], [changes[1]!]]);
  expect(assessor.assess).toHaveBeenCalledTimes(2); expect(record.class).toBe('high'); expect(record.reason).toContain('Bewertung in 2 Teilen');
});
