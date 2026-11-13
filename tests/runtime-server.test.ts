import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import { config, MemoryGitHub } from './helpers.js';
import { MockPlanner } from '../src/llm/provider.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function fixture(merge?: { start: ReturnType<typeof vi.fn>; errors?: string[] }) {
  const cfg = config(), github = new MemoryGitHub(); cfg.execution.engine = 'temporal';
  const controller = { observations: vi.fn(async () => []), gateApproved: vi.fn(async () => false), authorize: vi.fn(async () => ({})),
    publish: vi.fn(), gate: vi.fn(async () => {}), cancel: vi.fn(async () => {}), start: vi.fn(), deployment: vi.fn(async () => ({ workerReady: true })) };
  const repository = { repositoryId: 42, github, config: async () => cfg };
  const store = { list: vi.fn(async () => []), locked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) };
  const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32);
  const server = runtimeServer({ managerToken, workerToken, bindings: [{ repository, controller, planner: new MockPlanner(), merge } as unknown as RuntimeBinding], store: store as unknown as RuntimeStore });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  const call = (path: string, body?: unknown, token = managerToken, method?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call, controller, managerToken, workerToken, cfg, store };
}
describe('private runtime HTTP boundaries', () => {
  it('exposes deployment readiness only to the manager and fails closed on probe errors', async () => {
    const f = await fixture();
    expect((await f.call('/v1/repositories/42/deployment', undefined, f.workerToken)).status).toBe(401);
    expect(await (await f.call('/v1/repositories/42/deployment')).json()).toEqual({ workerReady: true });
    f.controller.deployment.mockRejectedValueOnce(new Error('private Temporal connection error'));
    const blocked = await f.call('/v1/repositories/42/deployment'); expect(blocked.status).toBe(409);
    expect(await blocked.text()).not.toContain('private');
  });
  it('separates manager and worker capabilities; requires nontrivial distinct credentials', async () => {
    const f = await fixture();
    expect((await f.call('/v1/repositories/42/runs', undefined, '')).status).toBe(401);
    expect((await f.call('/v1/repositories/42/runs', undefined, f.workerToken)).status).toBe(401);
    expect((await f.call('/v1/worker/gate', {}, f.managerToken)).status).toBe(401);
    expect(() => runtimeServer({ managerToken: 'a'.repeat(32), workerToken: 'a'.repeat(32), bindings: [], store: f.store as unknown as RuntimeStore })).toThrow('SEPARATE_RUNTIME_TOKENS');
  });
  it('rejects unknown repositories, invalid commands and extra actor fields', async () => {
    const f = await fixture(); expect((await f.call('/v1/repositories/43/runs')).status).toBe(409);
    expect((await f.call('/not-a-route')).status).toBe(404);
    expect((await f.call('/v1/repositories/42/reconcile', { actor: 'attacker' })).status).toBe(409);
    expect((await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer', shell: 'id' })).status).toBe(400);
  });
  it('loads only repository-scoped observations and applies commands to exact bindings', async () => {
    const f = await fixture(); expect((await f.call('/v1/repositories/42/runs')).status).toBe(200);
    expect((await f.call('/v1/repositories/42/observations', { executionIds: ['a'.repeat(32)] })).status).toBe(200);
    expect(f.controller.observations).toHaveBeenLastCalledWith(['a'.repeat(32)]);
    expect((await f.call(`/v1/repositories/42/runs/${'a'.repeat(32)}/approve`, { actor: 'maintainer', binding: 'b'.repeat(64) })).status).toBe(200);
    expect(f.controller.gate).toHaveBeenCalledWith('a'.repeat(32), 'b'.repeat(64), 'maintainer', true);
    expect((await f.call(`/v1/repositories/42/runs/${'a'.repeat(32)}/revoke`, { actor: 'maintainer', binding: 'b'.repeat(64) })).status).toBe(200);
    expect(f.controller.gate).toHaveBeenLastCalledWith('a'.repeat(32), 'b'.repeat(64), 'maintainer', false);
  });
  it('serializes manager reconciliation and refuses a repository using another engine', async () => {
    const f = await fixture(); expect((await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer' })).status).toBe(200);
    expect(f.store.locked).toHaveBeenCalled(); f.cfg.execution.engine = 'github-actions';
    expect((await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer' })).status).toBe(409);
  });
  it('chooses the planner from the configuration that is current at each reconciliation', async () => {
    const cfg = config(), github = new MemoryGitHub(); cfg.execution.engine = 'temporal';
    const controller = { observations: vi.fn(async () => []) }, seen: string[] = [];
    const store = { locked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) };
    const planner = (current: typeof cfg) => { seen.push(current.llm.provider); return new MockPlanner(); };
    const server = runtimeServer({ managerToken: 'm'.repeat(32), workerToken: 'w'.repeat(32), store: store as unknown as RuntimeStore,
      bindings: [{ repository: { repositoryId: 42, github, config: async () => cfg }, controller, planner } as unknown as RuntimeBinding] });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    const reconcile = () => fetch(`http://127.0.0.1:${address.port}/v1/repositories/42/reconcile`, { method: 'POST',
      headers: { Authorization: `Bearer ${'m'.repeat(32)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: 'maintainer' }) });
    cfg.llm.provider = 'openai'; expect((await reconcile()).status).toBe(200);
    // The repository is migrated to the deterministic planner while the broker keeps running.
    cfg.llm.provider = 'mock'; expect((await reconcile()).status).toBe(200);
    expect(seen).toEqual(['openai', 'mock']);
  });
  it('does not expose upstream exceptions or accept oversized request bodies', async () => {
    const f = await fixture(); f.controller.gate.mockRejectedValueOnce(new Error('private database password'));
    const denied = await f.call(`/v1/repositories/42/runs/${'a'.repeat(32)}/approve`, { actor: 'maintainer', binding: 'b'.repeat(64) });
    expect(await denied.text()).not.toContain('password');
    const large = await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer', data: 'x'.repeat(300001) }); expect(large.ok).toBe(false);
  });
  it('validates cancellation actors before dispatching a cancellation', async () => {
    const f = await fixture(), path = `/v1/repositories/42/runs/${'a'.repeat(32)}/cancel`;
    expect((await f.call(path, { actor: 'attacker' })).status).toBe(409); expect(f.controller.cancel).not.toHaveBeenCalled();
    expect((await f.call(path, { actor: 'maintainer' })).status).toBe(200); expect(f.controller.cancel).toHaveBeenCalledWith('a'.repeat(32));
  });
});

it('starts the merge pass after a reconciliation with the state it reconciled, without waiting for it', async () => {
  const start = vi.fn(() => new Promise<void>(() => {})), f = await fixture({ start });
  expect((await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer' })).status).toBe(200);
  expect(start).toHaveBeenCalledTimes(1);
  const [cfg, snapshot] = start.mock.calls[0]! as unknown as [unknown, { issues: unknown[] }];
  expect(cfg).toBe(f.cfg); expect(Array.isArray(snapshot.issues)).toBe(true);
});
it('reports what the last merge pass could not do with the next reconciliation', async () => {
  const f = await fixture({ start: vi.fn(() => null), errors: ['Merge: PR #42: review/update/merge not confirmed (403); no unreviewed merge performed'] });
  f.cfg.merge.enabled = true;
  const report = await (await f.call('/v1/repositories/42/reconcile', { actor: 'maintainer' })).json() as { errors: string[] };
  expect(report.errors).toContain('Merge: PR #42: review/update/merge not confirmed (403); no unreviewed merge performed');
});
