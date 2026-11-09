import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import { config, MemoryGitHub } from './helpers.js';
import { MockPlanner } from '../src/llm/provider.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function fixture() {
  const cfg = config(), github = new MemoryGitHub(); cfg.execution.engine = 'temporal';
  const controller = { observations: vi.fn(async () => []), gateApproved: vi.fn(async () => false), authorize: vi.fn(async () => ({})),
    publish: vi.fn(), gate: vi.fn(async () => {}), cancel: vi.fn(async () => {}), start: vi.fn() };
  const repository = { repositoryId: 42, github, config: async () => cfg };
  const store = { list: vi.fn(async () => []), locked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) };
  const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32);
  const server = runtimeServer({ managerToken, workerToken, bindings: [{ repository, controller, planner: new MockPlanner() } as unknown as RuntimeBinding], store: store as unknown as RuntimeStore });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  const call = (path: string, body?: unknown, token = managerToken, method?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { call, controller, managerToken, workerToken, cfg, store };
}
describe('private runtime HTTP boundaries', () => {
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
