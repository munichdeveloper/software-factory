import { createHash } from 'node:crypto';
import { Octokit } from '@octokit/rest';
import { Pool, type PoolClient } from 'pg';
import { expect, it, vi } from 'vitest';
import { RuntimeEffects } from '../src/runtime/effects.js';
import { RuntimeStore } from '../src/runtime/store.js';
import { RuntimeCodingPublisher } from '../src/runtime/publisher.js';
import { snapshotSchema } from '../src/runtime/contract.js';
import { hash } from '../src/state/identity.js';
import type { CodingArtifact } from '../src/workers/coding.js';
import { defaultValidationPlan, type ValidationReport } from '../src/runtime/validation-contract.js';
import { reportFor } from './validation-fixtures.js';

class Store extends RuntimeStore {
  effects = new Map<string, { payload_hash: string; phase: string; receipt: unknown }>();
  private tail = Promise.resolve();
  loseReceipt: string | null = null;
  constructor() { super(new Pool()); }
  override async locked<T>(_repo: number, _id: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const previous = this.tail; let unlock!: () => void; this.tail = new Promise(resolve => { unlock = resolve; }); await previous;
    try { return await work({ query: async (sql: string, args: unknown[]) => {
      const key = String(args[2]);
      if (sql.startsWith('SELECT')) return { rows: this.effects.has(key) ? [this.effects.get(key)] : [] };
      if (sql.startsWith('INSERT')) this.effects.set(key, { payload_hash: String(args[3]), phase: String(args[4]), receipt: null });
      if (sql.startsWith('UPDATE')) {
        if (this.loseReceipt === key) { this.loseReceipt = null; throw new Error('Lost database receipt'); }
        Object.assign(this.effects.get(key)!, { phase: args[3], receipt: JSON.parse(String(args[4])) });
      }
      return { rows: [] };
    } } as unknown as PoolClient); } finally { unlock(); }
  }
}
const snapshot = snapshotSchema.parse({ version: 1, repositoryId: 42, repository: 'owner/target',
  release: { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-publisher', buildId: 'v1', taskQueue: 'sf-publisher', schemaVersion: 1 },
  admission: { actionId: 'd'.repeat(64), policyHash: 'e'.repeat(64), input: { contractVersion: '1.0', repository: 'owner/target', issueNumber: 2, taskVersion: 'f'.repeat(64),
    description: 'Implement a safe change', acceptanceCriteria: ['Tests pass'], contextReferences: [], executionId: '1'.repeat(32), allowedActions: ['publish_result'],
    limits: { timeoutMinutes: 5, maxOutputBytes: 16000 }, operation: 'sha256', worker: 'codex' } },
  baseSha: '2'.repeat(40), specHash: 'f'.repeat(64), configHash: '3'.repeat(64), requireHumanGate: true });
const artifact = (): CodingArtifact => ({ contractVersion: '3.0', baseSha: snapshot.baseSha,
  result: { contractVersion: '2.0', executionId: snapshot.admission.input.executionId, taskId: 'github:owner/target#2', taskVersion: snapshot.specHash,
    status: 'success', summary: 'Implemented and tested; @nobody <untrusted>', artifacts: [], error: null },
  changes: [{ path: 'result.txt', content: Buffer.from('verified').toString('base64'), mode: '100644' }] });
const previousAttempt = '7'.repeat(32);
function fixture(selectedSnapshot = snapshot) {
  const store = new Store(), writes: { kind: string; body: Record<string, unknown> }[] = [];
  const blobs = new Map<string, string>();
  let branch: string | null = null, pr: Record<string, unknown> | null = null, comment: Record<string, unknown> | null = null;
  let lost: string | null = null, before: string | null = null, collision = false, duplicate = false, moved: false | 'forward' | 'rewritten' = false;
  const closed: number[] = [];
  const object = (body: unknown) => createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const fetcher: typeof fetch = async (input, init) => {
    const path = decodeURIComponent(new URL(String(input)).pathname).replace('/repos/owner/target', ''), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {}; let data: unknown, status = 200;
    let kind = '';
    if (method === 'POST') {
      kind = path === '/git/blobs' ? 'blob' : path === '/git/trees' ? 'tree' : path === '/git/commits' ? 'commit' : path === '/git/refs' ? 'branch' : path === '/pulls' ? 'draft-pr' : path === '/issues/2/comments' ? 'publication-comment' : 'superseded-comment';
      if (before === kind) { before = null; throw new Error('Request outcome unknown'); }
      writes.push({ kind, body });
    }
    if (path === '') data = { id: 42, default_branch: 'main' };
    else if (path === `/git/ref/heads/${selectedSnapshot.baseRef ?? 'main'}`) data = { object: { sha: moved ? '9'.repeat(40) : snapshot.baseSha } };
    else if (path.startsWith(`/compare/${snapshot.baseSha}...`)) data = moved === 'forward' ? { status: 'ahead', merge_base_commit: { sha: snapshot.baseSha } } : { status: 'diverged', merge_base_commit: { sha: '1'.repeat(40) } };
    else if (path === `/git/commits/${snapshot.baseSha}`) data = { tree: { sha: '4'.repeat(40) } };
    else if (path === `/git/trees/${'4'.repeat(40)}`) data = { truncated: false, tree: [] };
    else if (path.startsWith('/git/blobs/') && method === 'GET') { const sha = path.split('/').at(-1)!; data = blobs.has(sha) ? { sha, content: blobs.get(sha) } : {}; if (!blobs.has(sha)) status = 404; }
    else if (path === '/git/blobs') { const bytes = Buffer.from(body.content, 'base64'); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); blobs.set(sha, body.content); data = { sha }; }
    else if (path === '/git/trees' || path === '/git/commits') data = { sha: object(body) };
    else if (path.startsWith('/git/ref/heads/sf/')) { data = { object: { sha: collision ? '8'.repeat(40) : branch } }; if (!branch && !collision) status = 404; }
    else if (path === '/git/refs') { branch = body.sha; data = { object: { sha: branch } }; }
    else if (path === '/pulls' && method === 'POST') { pr = { ...body, number: 9, html_url: 'https://github.com/owner/target/pull/9', head: { sha: branch }, user: { login: 'factory[bot]' }, state: 'open', merged_at: null }; data = pr; }
    else if (path === '/pulls' && new URL(String(input)).searchParams.get('head') === `owner:sf/issue-2/${previousAttempt}`) data = new URL(String(input)).searchParams.get('state') === 'open'
      ? [{ number: 5, user: { login: 'factory[bot]' } }, { number: 6, user: { login: 'stranger' } }].filter(p => !closed.includes(p.number)) : [];
    else if (path === '/pulls') data = pr ? duplicate ? [pr, pr] : [pr] : [];
    else if (/^\/issues\/[56]\/comments$/.test(path) && method === 'POST') data = { id: 2 };
    else if (/^\/pulls\/[56]$/.test(path) && method === 'PATCH') { closed.push(Number(path.split('/').at(-1))); writes.push({ kind: 'close-pr', body: { ...body, number: Number(path.split('/').at(-1)) } }); data = {}; }
    else if (path === '/issues/2/comments' && method === 'POST') { comment = { id: 1, body: body.body, user: { login: 'factory[bot]' } }; data = comment; }
    else if (path === '/issues/2/comments') data = comment ? [comment] : [];
    else throw new Error(`Unexpected simulated API ${method} ${path}`);
    if (method === 'POST' && lost === kind) { lost = null; throw new Error('Response lost after acceptance'); }
    const response = Response.json(data, { status }); Object.defineProperty(response, 'url', { value: String(input) }); return response;
  };
  const api = new Octokit({ auth: 'test-only', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  const authorize = vi.fn(async () => {});
  const publisher = () => new RuntimeCodingPublisher(api, new RuntimeEffects(store, 42, snapshot.admission.input.executionId, hash(selectedSnapshot)), authorize, ['factory[bot]']);
  const publish = (source = artifact(), validation?: ValidationReport) => publisher().publish(selectedSnapshot, source, '2026-11-09T13:00:00.000Z', validation);
  return { store, writes, publish, authorize, lose: (key: string) => { lost = key; }, failBefore: (key: string) => { before = key; }, collide: () => { collision = true; }, duplicate: () => { duplicate = true; }, move: (how: 'forward' | 'rewritten' = 'rewritten') => { moved = how; } };
}
it('serializes concurrent publishers, creates exactly one draft and reuses durable receipts', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.publish(), f.publish()]); expect(a).toEqual(b);
  expect(f.writes.filter(w => w.kind === 'draft-pr')).toHaveLength(1); expect(f.writes.filter(w => w.kind === 'publication-comment')).toHaveLength(1);
  const pr = f.writes.find(w => w.kind === 'draft-pr')!; expect(pr.body.draft).toBe(true); expect(pr.body.body).toContain('＠nobody &lt;untrusted&gt;');
  expect(f.writes.find(w => w.kind === 'commit')!.body.author).toMatchObject({ date: '2026-11-09T13:00:00.000Z' });
});
it('keeps original blocked status and separate validation visible while reconciling a lost review-PR response', async()=>{
  const plan=defaultValidationPlan(),selected=snapshotSchema.parse({...snapshot,validationPlan:plan}),source=artifact();source.result.status='blocked';const validation=reportFor(source,plan);
  const f=fixture(selected);f.lose('draft-pr');await expect(f.publish(source,validation)).rejects.toThrow();await f.publish(source,validation);
  const prs=f.writes.filter(w=>w.kind==='draft-pr');expect(prs).toHaveLength(1);expect(prs[0]!.body.draft).toBe(true);expect(prs[0]!.body.title).toContain('Review');
  expect(prs[0]!.body.body).toContain('Original model status: **blocked**');expect(prs[0]!.body.body).toContain('validation: **passed**');expect(source.result.status).toBe('blocked');
});
it('requires exact independent evidence and marks failed checks as review-required without changing the model result', async()=>{
  const plan=defaultValidationPlan(),selected=snapshotSchema.parse({...snapshot,validationPlan:plan}),source=artifact(),f=fixture(selected);
  await expect(f.publish(source)).rejects.toThrow('VALIDATION_REPORT_REQUIRED');expect(f.writes).toEqual([]);
  const report=reportFor(source,plan,'failed');await f.publish(source,report);const pr=f.writes.find(w=>w.kind==='draft-pr')!;
  expect(pr.body.title).toContain('Review');expect(pr.body.body).toContain('validation: **failed**');expect(source.result.status).toBe('success');
  const forged=fixture(selected);await expect(forged.publish(source,{...report,artifactHash:'f'.repeat(64)})).rejects.toThrow('UNRELATED_VALIDATION_REPORT');expect(forged.writes).toEqual([]);
});
it('replaces the draft of the attempt a rework continues, and no pull request of anybody else', async () => {
  const rework = snapshotSchema.parse({ ...snapshot, admission: { ...snapshot.admission, input: { ...snapshot.admission.input, contextReferences: [`urn:sf-rework:${previousAttempt}`] } } });
  const f = fixture(rework); await f.publish(); await f.publish();
  expect(f.writes.filter(w => w.kind === 'draft-pr')).toHaveLength(1);
  expect(f.writes.filter(w => w.kind === 'close-pr').map(w => w.body)).toEqual([{ state: 'closed', number: 5 }]);
  expect(f.writes.filter(w => w.kind === 'superseded-comment').map(w => w.body.body)).toEqual(['Superseded by #9: a further attempt that continues these changes after the failed validation.']);
  const plain = fixture(); await plain.publish();
  expect(plain.writes.some(w => w.kind === 'close-pr')).toBe(false);
});
it('publishes canary changes only against the frozen integration branch', async () => {
  const f = fixture(snapshotSchema.parse({...snapshot,baseRef:'test/temporal-rc'})); await f.publish();
  expect(f.writes.find(w=>w.kind==='draft-pr')!.body.base).toBe('test/temporal-rc');
  const moved=fixture(snapshotSchema.parse({...snapshot,baseRef:'test/temporal-rc'}));moved.move('forward');
  await expect(moved.publish()).rejects.toThrow('BASE_MOVED'); expect(moved.writes).toEqual([]);
});
it('cannot publish a model change outside the frozen canary path scope', async () => {
  const f=fixture(snapshotSchema.parse({...snapshot,allowedPaths:['docs/canary.md']}));
  await expect(f.publish()).rejects.toThrow('ARTIFACT_OUTSIDE_RUNTIME_SCOPE');expect(f.writes).toEqual([]);
  const allowed=fixture(snapshotSchema.parse({...snapshot,allowedPaths:['result.txt']}));await allowed.publish();
  expect(allowed.writes.filter(w=>w.kind==='draft-pr')).toHaveLength(1);
});
it.each(['blob', 'tree', 'commit', 'branch', 'draft-pr', 'publication-comment'])('reconciles lost %s response across a fresh publisher instance', async key => {
  const f = fixture(); f.lose(key); await expect(f.publish()).rejects.toThrow();
  const result = await f.publish(); expect(result.number).toBe(9);
  for (const operation of ['branch', 'draft-pr', 'publication-comment']) expect(f.writes.filter(w => w.kind === operation)).toHaveLength(1);
});
it.each(['branch', 'draft-pr', 'publication-comment'])('recovers GitHub acceptance before the %s database receipt', async key => {
  const f = fixture(); f.store.loseReceipt = key; await expect(f.publish()).rejects.toThrow('Lost database receipt'); await f.publish();
  expect(f.writes.filter(w => w.kind === key)).toHaveLength(1);
});
it('blocks an ambiguous PR request without evidence rather than sending again', async () => {
  const f = fixture(); f.failBefore('draft-pr'); await expect(f.publish()).rejects.toThrow();
  await expect(f.publish()).rejects.toThrow('EFFECT_UNCERTAIN'); expect(f.writes.filter(w => w.kind === 'draft-pr')).toHaveLength(0);
});
it('publishes after the default branch moved forward, but not after it was rewritten', async () => {
  const forward = fixture(); forward.move('forward'); await forward.publish();
  expect(forward.writes.find(w => w.kind === 'commit')!.body.parents).toEqual([snapshot.baseSha]);
  expect(forward.writes.find(w => w.kind === 'draft-pr')!.body.base).toBe('main');
  const rewritten = fixture(); rewritten.move('rewritten'); await expect(rewritten.publish()).rejects.toThrow('BASE_MOVED'); expect(rewritten.writes).toEqual([]);
});
it('rejects changed artifacts, protected paths, base changes, branch collisions and duplicate PR evidence', async () => {
  const f = fixture(); await f.publish(); const changed = artifact(); changed.changes[0]!.content = 'eA=='; await expect(f.publish(changed)).rejects.toThrow('EFFECT_PAYLOAD_CONFLICT');
  const protectedArtifact = artifact(); protectedArtifact.changes[0]!.path = '.github/workflows/unsafe.yml'; const p = fixture(); await expect(p.publish(protectedArtifact)).rejects.toThrow('Protected'); expect(p.writes).toEqual([]);
  const moved = fixture(); moved.move(); await expect(moved.publish()).rejects.toThrow('BASE_MOVED'); expect(moved.writes).toEqual([]);
  const collision = fixture(); collision.collide(); await expect(collision.publish()).rejects.toThrow('EXECUTION_BRANCH_CONFLICT');
  const duplicate = fixture(); duplicate.lose('draft-pr'); await expect(duplicate.publish()).rejects.toThrow(); duplicate.duplicate(); await expect(duplicate.publish()).rejects.toThrow('MULTIPLE_EXECUTION_PRS');
});
it('reauthorizes before every new external effect and never writes after revocation', async () => {
  const f = fixture(); f.authorize.mockRejectedValue(new Error('APPROVAL_REVOKED')); await expect(f.publish()).rejects.toThrow('APPROVAL_REVOKED'); expect(f.writes).toEqual([]);
});
