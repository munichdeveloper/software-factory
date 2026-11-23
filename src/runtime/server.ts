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
import type { RuntimeEvents } from './events.js';
import type { QueueBoard } from './queue.js';
import { loadAnalytics, type AnalyticsIssueSync } from './analytics.js';
import type { OutcomeReader } from './outcomes.js';
import { loadMetrics } from './metrics.js';

export interface RuntimeBinding { repository: RuntimeRepository; controller: RuntimeController;
  /** A planner, or a choice made from the repository configuration that is current at each reconciliation. */
  planner: Planner | ((config: Config) => Planner);
  /** Reviews and merges the Factory's validated pull requests after a reconciliation, where configured. */
  merge?: RuntimeMerge;
  /** Reads the GitHub side of an issue's outcome class and wait phases (cost analytics); absent where nothing is derived. */
  outcomes?: OutcomeReader }
export interface ServerOptions { managerToken: string; workerToken: string; bindings: RuntimeBinding[]; store: RuntimeStore;
  /** Binds and persists a repository the SF Manager rolls out to Temporal; absent where the runtime takes no registrations. */
  register?: (registration: Registration) => Promise<RuntimeBinding>;
  /** Slack delivery for repositories whose configuration enables notifications (the broker's own bot token). */
  notifications?: NotificationSink;
  /** The broker's sanity check, told about every completed reconciliation. */
  monitor?: SanityMonitor;
  /** The job queue view, told about every reconciliation; served at GET /v1/queue. */
  queue?: QueueBoard;
  /** Read-only credential for GET /v1/queue and GET /v1/analytics (software-factory-monitor); it grants nothing else. */
  monitorToken?: string;
  /** Keeps issue titles and merges for the cost analytics, told about every reconciliation. */
  analytics?: AnalyticsIssueSync;
  /** Runtime events (validation_failed, start_refused …), derived from every reconciliation; served at GET …/events. */
  events?: RuntimeEvents;
  /** Asks the schedule for a reconciliation soon (POST …/nudge, GitHub webhooks through the SF Manager); see ReconcileSchedule. */
  nudge?: (repositoryId: number) => boolean }
/** `since` of an events request: an ISO time, default the last 24 hours, never more than 30 days back. */
function eventsSince(url: string | undefined): Date {
  const value = new URL(url ?? '/', 'http://localhost').searchParams.get('since');
  const floor = Date.now() - 30 * 86400000;
  const since = value === null ? Date.now() - 86400000 : Date.parse(z.iso.datetime({ offset: true }).parse(value));
  return new Date(Math.max(since, floor));
}
const registrationSchema = z.strictObject({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), githubInstallationId: z.number().int().positive().safe() });
const secureEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const actorSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}(?:\[bot\])?$/);
async function read(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 300000) throw new Error('BODY_LIMIT'); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
/**
 * The fixed code that names why an operation was blocked: an error code of our own, the HTTP status of a GitHub call
 * that failed (for example 403 when the App installation's rate limit is used up), or OPERATION_FAILED.
 */
export function blockedReason(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) return error.message;
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
  return status && Number.isInteger(status) && status >= 100 && status < 600 ? `GITHUB_HTTP_${status}` : 'OPERATION_FAILED';
}
const send = (response: ServerResponse, code: number, body: unknown) => { response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
/**
 * One reconciliation of a repository: picks up ready tasks, starts and advances runs, then the merge pass. Callers are the
 * broker's own schedule and, while it still sends them, the SF Manager. The actor of a Manager call never grants execution.
 */
/** Observations as the HTTP API answers them: without the broker-internal routing decision (see observationSchema). */
const wire = <T extends { route?: unknown; usage?: unknown }>(observation: T): Omit<T, 'route' | 'usage'> => { const { route: _route, usage: _usage, ...rest } = observation; void _route; void _usage; return rest; };
export async function reconcileBinding(binding: RuntimeBinding, options: Pick<ServerOptions, 'store' | 'notifications' | 'monitor' | 'queue' | 'analytics' | 'events'>) {
  const config = await binding.repository.config();
  if (config.execution.engine !== 'temporal') throw new Error('TEMPORAL_NOT_ENABLED');
  // Runs the previous release still serves end after their retention, so the planner can retry them on this release.
  const expired = await binding.controller.expireRetained?.() ?? [];
  if (expired.length) console.log(JSON.stringify({ event: 'factory-retained-release-expired', repositoryId: binding.repository.repositoryId, executions: expired }));
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
  await options.monitor?.observed(binding.repository, config, manager.lastSnapshot, report);
  await options.events?.observed(binding.repository, config, manager.lastSnapshot, manager.lastPreflightRefusals);
  options.queue?.observed(binding.repository, config, manager.settledSnapshot, report, manager.lastRejections, binding.merge?.progress());
  await options.analytics?.observed(binding.repository.repository, manager.settledSnapshot, binding.merge?.progress(), binding.outcomes);
  return report;
}

export function runtimeServer(options: ServerOptions) {
  if (options.managerToken.length < 32 || options.workerToken.length < 32 || secureEqual(options.managerToken, options.workerToken)) throw new Error('SEPARATE_RUNTIME_TOKENS_REQUIRED');
  if (new Set(options.bindings.map(b => b.repository.repositoryId)).size !== options.bindings.length) throw new Error('DUPLICATE_REPOSITORY_BINDING');
  const monitorToken = options.monitorToken || undefined;
  if (monitorToken && (monitorToken.length < 32 || secureEqual(monitorToken, options.managerToken) || secureEqual(monitorToken, options.workerToken))) throw new Error('SEPARATE_RUNTIME_TOKENS_REQUIRED');
  return createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname, token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (path === '/health' && request.method === 'GET') { send(response, 200, { service: 'factory-runtime', alive: true }); return; }
      if (path === '/v1/queue') {
        // Read-only: the monitor token opens this view and nothing else; the manager token opens it as well.
        if (!(monitorToken && secureEqual(token, monitorToken)) && !secureEqual(token, options.managerToken)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
        if (request.method !== 'GET') throw new Error('METHOD');
        if (!options.queue) { send(response, 404, { code: 'NOT_FOUND' }); return; }
        send(response, 200, options.queue.view(options.bindings.map(b => b.repository))); return;
      }
      if (path === '/v1/events') {
        // Read-only, like the queue: the runtime events of all repositories since a point in time (monitor, subscribers).
        if (!(monitorToken && secureEqual(token, monitorToken)) && !secureEqual(token, options.managerToken)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
        if (request.method !== 'GET') throw new Error('METHOD');
        send(response, 200, { events: await options.store.events(null, eventsSince(request.url)) }); return;
      }
      if (path === '/v1/analytics') {
        // Read-only, like the queue: cost per issue, step and model (software-factory-monitor's analytics page).
        if (!(monitorToken && secureEqual(token, monitorToken)) && !secureEqual(token, options.managerToken)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
        if (request.method !== 'GET') throw new Error('METHOD');
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
        if (query.get('repository') && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(query.get('repository')!)) { send(response, 400, { code: 'INVALID_REPOSITORY' }); return; }
        send(response, 200, await loadAnalytics(options.store, query)); return;
      }
      if (path === '/v1/metrics') {
        // Read-only, like the analytics: lead time from intake to merge and flow metrics (software-factory-monitor's metrics page).
        if (!(monitorToken && secureEqual(token, monitorToken)) && !secureEqual(token, options.managerToken)) { send(response, 401, { code: 'UNAUTHORIZED' }); return; }
        if (request.method !== 'GET') throw new Error('METHOD');
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
        if (query.get('repository') && !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(query.get('repository')!)) { send(response, 400, { code: 'INVALID_REPOSITORY' }); return; }
        send(response, 200, await loadMetrics(options.store, query)); return;
      }
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
      // A webhook nudge (software-factory#197): answered at once, the reconciliation runs in the background. It needs no
      // actor and no GitHub request, because it decides nothing: the reconciliation reads the state from GitHub itself.
      const nudge = path.match(/^\/v1\/repositories\/([1-9][0-9]{0,15})\/nudge$/);
      if (nudge) {
        if (request.method !== 'POST') throw new Error('METHOD');
        const input = z.strictObject({ event: z.string().regex(/^[a-z_]{1,40}(?:\.[a-z_]{1,40})?$/).optional() }).parse(await read(request));
        const repositoryId = Number(nudge[1]);
        if (!options.nudge) { send(response, 404, { code: 'NOT_FOUND' }); return; }
        if (!options.nudge(repositoryId)) throw new Error('UNKNOWN_REPOSITORY');
        console.log(JSON.stringify({ event: 'factory-nudge', repositoryId, ...(input.event ? { trigger: input.event } : {}) }));
        send(response, 202, { repositoryId, accepted: true }); return;
      }
      const match = path.match(/^\/v1\/repositories\/([1-9][0-9]*)\/(runs|observations|reconcile|deployment|findings|events)(?:\/([a-f0-9]{32})(?:\/(approve|revoke|cancel))?)?$/);
      if (!match) { send(response, 404, { code: 'NOT_FOUND' }); return; }
      const binding = options.bindings.find(b => b.repository.repositoryId === Number(match[1]));
      if (!binding) throw new Error('UNKNOWN_REPOSITORY');
      const [, , resource, id, action] = match;
      if (request.method === 'GET' && resource === 'deployment' && !id) {
        send(response, 200, await binding.controller.deployment()); return;
      }
      if (request.method === 'GET' && resource === 'events' && !id) {
        send(response, 200, { events: await options.store.events(binding.repository.repositoryId, eventsSince(request.url)) }); return;
      }
      if (request.method === 'GET' && resource === 'findings' && !id) {
        send(response, 200, { findings: await options.store.findings(binding.repository.repositoryId) }); return;
      }
      if (request.method === 'GET' && resource === 'runs' && !id) {
        const rows = await options.store.list(binding.repository.repositoryId);
        send(response, 200, (await binding.controller.observations(rows.map(r => r.snapshot.admission.input.executionId))).map(wire)); return;
      }
      if (request.method !== 'POST') throw new Error('METHOD');
      const body = await read(request);
      if (resource === 'observations' && !id) {
        const input = z.strictObject({ executionIds: executionKey.array().max(1000) }).parse(body);
        send(response, 200, (await binding.controller.observations(input.executionIds)).map(wire)); return;
      }
      if (resource === 'runs' && !id) { send(response, 200, wire(await binding.controller.start(admissionSchema.parse(body)))); return; }
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
      const reason = blockedReason(error);
      console.warn(JSON.stringify({ event: 'factory-runtime-blocked', reason,
        // Only the error's class (e.g. ZodError, DataCloneError, TypeError), never its message: an untyped failure stays traceable.
        ...(reason === 'OPERATION_FAILED' && error instanceof Error ? { errorType: error.name.slice(0, 64) } : {}),
        httpStatus: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined }));
      // Never serialize external API/PG errors, request bodies or connection strings.
      const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'INVALID_REQUEST' : 'RUNTIME_OPERATION_BLOCKED';
      // The worker carries the fixed reason code into its Temporal failure, so a failed run can say why it failed
      // (software-factory#93). Only the code leaves the broker, never the error text.
      const worker = (request.url ?? '').startsWith('/v1/worker/');
      send(response, code === 'INVALID_REQUEST' ? 400 : 409, { code, ...(worker ? { reason } : {}) });
    }
  });
}
