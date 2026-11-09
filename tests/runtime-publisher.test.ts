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
function fixture(selectedSnapshot = snapshot) {
  const store = new Store(), writes: { kind: string; body: Record<string, unknown> }[] = [];
  const blobs = new Map<string, string>();
  let branch: string | null = null, pr: Record<string, unknown> | null = null, comment: Record<string, unknown> | null = null;
  let lost: string | null = null, before: string | null = null, collision = false, duplicate = false, moved = false;
  const object = (body: unknown) => createHash('sha1').update(JSON.stringify(body)).digest('hex');
  const fetcher: typeof fetch = async (input, init) => {
    const path = decodeURIComponent(new URL(String(input)).pathname).replace('/repos/owner/target', ''), method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {}; let data: unknown, status = 200;
    let kind = '';
    if (method === 'POST') {
      kind = path === '/git/blobs' ? 'blob' : path === '/git/trees' ? 'tree' : path === '/git/commits' ? 'commit' : path === '/git/refs' ? 'branch' : path === '/pulls' ? 'draft-pr' : 'publication-comment';
      if (before === kind) { before = null; throw new Error('Request outcome unknown'); }
      writes.push({ kind, body });
    }
    if (path === '') data = { id: 42, default_branch: 'main' };
    else if (path === `/git/ref/heads/${selectedSnapshot.baseRef ?? 'main'}`) data = { object: { sha: moved ? '9'.repeat(40) : snapshot.baseSha } };
    else if (path === `/git/commits/${snapshot.baseSha}`) data = { tree: { sha: '4'.repeat(40) } };
    else if (path === `/git/trees/${'4'.repeat(40)}`) data = { truncated: false, tree: [] };
    else if (path.startsWith('/git/blobs/') && method === 'GET') { const sha = path.split('/').at(-1)!; data = blobs.has(sha) ? { sha, content: blobs.get(sha) } : {}; if (!blobs.has(sha)) status = 404; }
    else if (path === '/git/blobs') { const bytes = Buffer.from(body.content, 'base64'); const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); blobs.set(sha, body.content); data = { sha }; }
    else if (path === '/git/trees' || path === '/git/commits') data = { sha: object(body) };
    else if (path.startsWith('/git/ref/heads/sf/')) { data = { object: { sha: collision ? '8'.repeat(40) : branch } }; if (!branch && !collision) status = 404; }
    else if (path === '/git/refs') { branch = body.sha; data = { object: { sha: branch } }; }
    else if (path === '/pulls' && method === 'POST') { pr = { ...body, number: 9, html_url: 'https://github.com/owner/target/pull/9', head: { sha: branch }, user: { login: 'factory[bot]' }, state: 'open', merged_at: null }; data = pr; }
    else if (path === '/pulls') data = pr ? duplicate ? [pr, pr] : [pr] : [];
    else if (path === '/issues/2/comments' && method === 'POST') { comment = { id: 1, body: body.body, user: { login: 'factory[bot]' } }; data = comment; }
    else if (path === '/issues/2/comments') data = comment ? [comment] : [];
    else throw new Error(`Unexpected simulated API ${method} ${path}`);
    if (method === 'POST' && lost === kind) { lost = null; throw new Error('Response lost after acceptance'); }
    const response = Response.json(data, { status }); Object.defineProperty(response, 'url', { value: String(input) }); return response;
  };
  const api = new Octokit({ auth: 'test-only', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  const authorize = vi.fn(async () => {});
  const publisher = () => new RuntimeCodingPublisher(api, new RuntimeEffects(store, 42, snapshot.admission.input.executionId, hash(selectedSnapshot)), authorize, ['factory[bot]']);
  const publish = (source = artifact()) => publisher().publish(selectedSnapshot, source, '2026-11-09T13:00:00.000Z');
  return { store, writes, publish, authorize, lose: (key: string) => { lost = key; }, failBefore: (key: string) => { before = key; }, collide: () => { collision = true; }, duplicate: () => { duplicate = true; }, move: () => { moved = true; } };
}
it('serializes concurrent publishers, creates exactly one draft and reuses durable receipts', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.publish(), f.publish()]); expect(a).toEqual(b);
  expect(f.writes.filter(w => w.kind === 'draft-pr')).toHaveLength(1); expect(f.writes.filter(w => w.kind === 'publication-comment')).toHaveLength(1);
  const pr = f.writes.find(w => w.kind === 'draft-pr')!; expect(pr.body.draft).toBe(true); expect(pr.body.body).toContain('＠nobody &lt;untrusted&gt;');
  expect(f.writes.find(w => w.kind === 'commit')!.body.author).toMatchObject({ date: '2026-11-09T13:00:00.000Z' });
});
it('publishes canary changes only against the frozen integration branch', async () => {
  const f = fixture(snapshotSchema.parse({...snapshot,baseRef:'test/temporal-rc'})); await f.publish();
  expect(f.writes.find(w=>w.kind==='draft-pr')!.body.base).toBe('test/temporal-rc');
  const moved=fixture(snapshotSchema.parse({...snapshot,baseRef:'test/temporal-rc'}));moved.move();
  await expect(moved.publish()).rejects.toThrow('BASE_MOVED'); expect(moved.writes).toEqual([]);
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
