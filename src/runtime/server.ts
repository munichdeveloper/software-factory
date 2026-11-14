import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Manager } from '../manager/index.js';
import type { Planner } from '../llm/provider.js';
import type { Config } from '../config/index.js';
import { admissionSchema, executionKey, snapshotSchema } from './contract.js';
import { workerResultSchema } from '../workers/contract.js';
import { RuntimeController, type RuntimeRepository } from './controller.js';
import type { Registration, RuntimeStore } from './store.js';
import type { RuntimeMerge } from './merge.js';
import type { NotificationSink } from '../notifications/slack.js';
import type { SanityMonitor } from './sanity.js';

export interface RuntimeBinding { repository: RuntimeRepository; controller: RuntimeController;
  /** A planner, or a choice made from the repository configuration that is current at each reconciliation. */
  planner: Planner | ((config: Config) => Planner);
  /** Reviews and merges the Factory's validated pull requests after a reconciliation, where configured. */
  merge?: RuntimeMerge }
export interface ServerOptions { managerToken: string; workerToken: string; bindings: RuntimeBinding[]; store: RuntimeStore;
  /** Binds and persists a repository the SF Manager rolls out to Temporal; absent where the runtime takes no registrations. */
  register?: (registration: Registration) => Promise<RuntimeBinding>;
  /** Slack delivery for repositories whose configuration enables notifications (the broker's own bot token). */
  notifications?: NotificationSink;
  /** The broker's sanity check, told about every completed reconciliation. */
  monitor?: SanityMonitor }
const registrationSchema = z.strictObject({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), githubInstallationId: z.number().int().positive().safe() });
const secureEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const actorSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/);
async function read(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 300000) throw new Error('BODY_LIMIT'); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const send = (response: ServerResponse, code: number, body: unknown) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
/**
 * One reconciliation of a repository: picks up ready tasks, starts and advances runs, then the merge pass. Callers are the
 * broker's own schedule and, while it still sends them, the SF Manager. The actor of a Manager call never grants execution.
 */
export async function reconcileBinding(binding: RuntimeBinding, options: Pick<ServerOptions, 'store' | 'notifications' | 'monitor'>) {
  const config = await binding.repository.config();
  if (config.execution.engine !== 'temporal') throw new Error('TEMPORAL_NOT_ENABLED');
  const planner = typeof binding.planner === 'function' ? binding.planner(config) : binding.planner;
  const manager = new Manager(binding.repository.github, config, planner, { correlationId: `temporal:${binding.repository.repositoryId}`, workerRuntime: binding.controller,
    ...(options.notifications ? { notifications: options.notifications } : {}) });
  // A reconciliation still running answers the next request with BUSY instead of queueing it: callers retry on a
  // schedule and give up after their own timeout, so waiting requests would pile up and exhaust the database pool.
  const report = await options.store.tryLocked(binding.repository.repositoryId, 'manager', () => manager.run());
  if (manager.lastSnapshot) void binding.merge?.start(config, manager.lastSnapshot);
  // The merge pass runs after the response; what its last pass could not do is reported here.
  if (config.merge.enabled && binding.merge?.errors.length) report.errors.push(...binding.merge.errors);
  // One line per reconciliation that did or could not do something. Blockers and errors carry only
  // issue numbers and fixed codes, never repository content or external error text.
  const executed = report.decisions.filter(d => d.executed).map(d => `${d.action.kind}#${d.action.issueNumber}${d.action.status ? `:${d.action.status}` : ''}`);
  if (executed.length || report.errors.length || report.blockers.length) console.log(JSON.stringify({ event: 'factory-reconcile',
    repositoryId: binding.repository.repositoryId, outcome: report.outcome, executed, errors: report.errors, blockers: report.blockers }));
  await options.monitor?.observed(binding.repository.repositoryId, config, manager.lastSnapshot, report);
  return report;
}

export function runtimeServer(options: ServerOptions) {
  if (options.managerToken.length < 32 || options.workerToken.length < 32 || secureEqual(options.managerToken, options.workerToken)) throw new Error('SEPARATE_RUNTIME_TOKENS_REQUIRED');
  if (new Set(options.bindings.map(b => b.repository.repositoryId)).size !== options.bindings.length) throw new Error('DUPLICATE_REPOSITORY_BINDING');
  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname, token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (path === '/health' && request.method === 'GET') { send(response, 200, { service: 'factory-runtime', alive: true }); return; }
      const worker = path.startsWith('/v1/worker/');
      if (!secureEqual(token, worker ? options.workerToken : options.managerToken)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
      if (worker) {
        if (request.method !== 'POST') throw new Error('METHOD');
        const body = z.strictObject({ snapshot: snapshotSchema, binding: z.string().regex(/^[a-f0-9]{64}$/), result: workerResultSchema.optional() }).parse(await read(request));
        const binding = options.bindings.find(b => b.repository.repositoryId === body.snapshot.repositoryId);
        if (!binding) throw new Error('UNKNOWN_REPOSITORY');
        if (path === '/v1/worker/gate') send(response, 200, await binding.controller.gateApproved(body.snapshot, body.binding));
        else if (path === '/v1/worker/authorize') { await binding.controller.authorize(body.snapshot, body.binding); send(response, 200, { ok: true }); }
        else if (path === '/v1/worker/coding-execution') send(response, 200, await binding.controller.executeCoding(body.snapshot, body.binding));
        else if (path === '/v1/worker/publish' && body.result) send(response, 200, await binding.controller.publish(body.snapshot, body.binding, body.result));
        else throw new Error('UNKNOWN_OPERATION');
        return;
      }
      const registration = path.match(/^\/v1\/repositories\/([1-9][0-9]{0,15})\/registration$/);
      if (registration && request.method === 'PUT') {
        const input = registrationSchema.parse(await read(request)), repositoryId = Number(registration[1]);
        const existing = options.bindings.find(b => b.repository.repositoryId === repositoryId);
        if (existing) {
          if (existing.repository.repository.toLowerCase() !== input.repository.toLowerCase()) throw new Error('REGISTRATION_CONFLICT');
          send(response, 200, { repositoryId, registered: true }); return;
        }
        if (!options.register) throw new Error('REGISTRATION_UNSUPPORTED');
        // One registration at a time: a concurrent request for the same repository must not bind it twice.
        const binding = await options.store.locked(repositoryId, 'registration', async () =>
          options.bindings.find(b => b.repository.repositoryId === repositoryId) ?? await options.register!({ repositoryId, ...input }));
        if (!options.bindings.includes(binding)) options.bindings.push(binding);
        console.log(JSON.stringify({ event: 'factory-repository-registered', repositoryId }));
        send(response, 200, { repositoryId, registered: true }); return;
      }
      const match = path.match(/^\/v1\/repositories\/([1-9][0-9]*)\/(runs|observations|reconcile|deployment|findings)(?:\/([a-f0-9]{32})(?:\/(approve|revoke|cancel))?)?$/);
      if (!match) { send(response, 404, { code: 'NOT_FOUND' }); return; }
      const binding = options.bindings.find(b => b.repository.repositoryId === Number(match[1]));
      if (!binding) throw new Error('UNKNOWN_REPOSITORY');
      const [, , resource, id, action] = match;
      if (request.method === 'GET' && resource === 'deployment' && !id) {
        send(response, 200, await binding.controller.deployment()); return;
      }
      if (request.method === 'GET' && resource === 'findings' && !id) {
        send(response, 200, { findings: await options.store.findings(binding.repository.repositoryId) }); return;
      }
      if (request.method === 'GET' && resource === 'runs' && !id) {
        const rows = await options.store.list(binding.repository.repositoryId);
        send(response, 200, await binding.controller.observations(rows.map(r => r.snapshot.admission.input.executionId))); return;
      }
      if (request.method !== 'POST') throw new Error('METHOD');
      const body = await read(request);
      if (resource === 'observations' && !id) {
        const input = z.strictObject({ executionIds: executionKey.array().max(1000) }).parse(body);
        send(response, 200, await binding.controller.observations(input.executionIds)); return;
      }
      if (resource === 'runs' && !id) { send(response, 200, await binding.controller.start(admissionSchema.parse(body))); return; }
      if (resource === 'reconcile' && !id) {
        const input = z.strictObject({ actor: actorSchema }).parse(body);
        if (!await binding.repository.github.canApprove(input.actor)) throw new Error('ACTOR_NOT_AUTHORIZED');
        send(response, 200, await reconcileBinding(binding, options)); return;
      }
      if (resource === 'runs' && id && action === 'cancel') {
        // Machine callers are authorized by the scoped admission identity; UI additionally checks its actor.
        const input = z.strictObject({ actor: actorSchema.optional() }).parse(body);
        if (input.actor && !await binding.repository.github.canApprove(input.actor)) throw new Error('ACTOR_NOT_AUTHORIZED');
        await binding.controller.cancel(id); send(response, 200, { ok: true }); return;
      }
      if (resource === 'runs' && id && (action === 'approve' || action === 'revoke')) {
        const input = z.strictObject({ actor: actorSchema, binding: z.string().regex(/^[a-f0-9]{64}$/) }).parse(body);
        await binding.controller.gate(id, input.binding, input.actor, action === 'approve'); send(response, 200, { ok: true }); return;
      }
      throw new Error('NOT_FOUND');
    } catch (error) {
      console.warn(JSON.stringify({ event: 'factory-runtime-blocked', reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED',
        httpStatus: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined }));
      // Never serialize external API/PG errors, request bodies or connection strings.
      const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'INVALID_REQUEST' : 'RUNTIME_OPERATION_BLOCKED';
      send(response, code === 'INVALID_REQUEST' ? 400 : 409, { code });
    }
  });
}
