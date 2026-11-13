import { afterEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { Registration, RuntimeStore } from '../src/runtime/store.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
const binding = (repositoryId: number, repository: string) => ({ repository: { repositoryId, repository },
  controller: { deployment: vi.fn(async () => ({ repositoryId, repository })) } }) as unknown as RuntimeBinding;
async function fixture(register?: (r: Registration) => Promise<RuntimeBinding>) {
  const bindings = [binding(42, 'owner/static')];
  const store = { locked: vi.fn(async (_r: number, _id: string, work: () => Promise<unknown>) => work()) };
  const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32);
  const server = runtimeServer({ managerToken, workerToken, bindings, store: store as unknown as RuntimeStore, ...(register ? { register } : {}) });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
  const call = (path: string, method: string, body?: unknown, token = managerToken) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { call, bindings, workerToken };
}
it('binds a repository the Manager registers and serves it right away, only for the manager credential', async () => {
  const register = vi.fn(async (r: Registration) => binding(r.repositoryId, r.repository));
  const f = await fixture(register), body = { repository: 'owner/controla', githubInstallationId: 7 };
  expect((await f.call('/v1/repositories/77/registration', 'PUT', body, f.workerToken)).status).toBe(401);
  expect((await f.call('/v1/repositories/77/deployment', 'GET')).status).toBe(409);
  const response = await f.call('/v1/repositories/77/registration', 'PUT', body);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ repositoryId: 77, registered: true });
  expect(register).toHaveBeenCalledWith({ repositoryId: 77, repository: 'owner/controla', githubInstallationId: 7 });
  expect(await (await f.call('/v1/repositories/77/deployment', 'GET')).json()).toEqual({ repositoryId: 77, repository: 'owner/controla' });
  // Repeating it is idempotent and binds nothing twice.
  expect((await f.call('/v1/repositories/77/registration', 'PUT', body)).status).toBe(200);
  expect(register).toHaveBeenCalledTimes(1); expect(f.bindings).toHaveLength(2);
});
it('refuses another name for a bound ID, malformed input and runtimes without registration', async () => {
  const register = vi.fn(async () => { throw new Error('INSTALLATION_NOT_ALLOWLISTED'); });
  const f = await fixture(register);
  expect((await f.call('/v1/repositories/42/registration', 'PUT', { repository: 'owner/other', githubInstallationId: 7 })).status).toBe(409);
  expect((await f.call('/v1/repositories/42/registration', 'PUT', { repository: 'owner/static', githubInstallationId: 7 })).status).toBe(200);
  expect((await f.call('/v1/repositories/77/registration', 'PUT', { repository: 'owner/x', githubInstallationId: 7, extra: 1 })).status).toBe(400);
  const blocked = await f.call('/v1/repositories/77/registration', 'PUT', { repository: 'owner/x', githubInstallationId: 7 });
  expect(blocked.status).toBe(409); expect(f.bindings).toHaveLength(1);
  const none = await fixture();
  expect((await none.call('/v1/repositories/77/registration', 'PUT', { repository: 'owner/x', githubInstallationId: 7 })).status).toBe(409);
});
it('serves a registered repository through the factory-manager.yml wrapper the SF Manager rolls out', async () => {
  const { registeredItem } = await import('../src/runtime/main.js');
  const release = { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-worker',
    buildId: 'build-1', taskQueue: 'sf-tasks', schemaVersion: 1 };
  const item = registeredItem({ repositoryId: 7, repository: 'owner/app', githubInstallationId: 9 }, release);
  expect(item).toMatchObject({ repositoryId: 7, repository: 'owner/app', githubInstallationId: 9, release,
    executorWorkflow: 'factory-manager.yml', approvalMode: 'ready-label', requireHumanGate: false, validateCoding: true,
    configPath: '.github/software-factory.yml', retainedReleases: [] });
});
