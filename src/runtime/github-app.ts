import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';

/**
 * What the broker asks GitHub for, per route template, and what GitHub reports about the installation's limit.
 * The limit is shared with every other user of the same App installation, so an exhausted limit stops task
 * reconciliation; without these numbers the consumer can only be guessed. One line per minute with requests.
 */
export class GitHubUsage {
  private routes = new Map<string, number>(); private failures = new Map<number, number>(); private notModified = 0;
  private limits = new Map<string, { used: number; remaining: number }>();
  record(route: string, headers: Record<string, unknown>, failedStatus?: number, unchanged = false) {
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
    if (unchanged) this.notModified++;
    if (failedStatus !== undefined) this.failures.set(failedStatus, (this.failures.get(failedStatus) ?? 0) + 1);
    const used = Number(headers['x-ratelimit-used']), remaining = Number(headers['x-ratelimit-remaining']), reset = Number(headers['x-ratelimit-reset']);
    // GitHub reports more than one window for an installation; they differ by their reset time.
    if (Number.isFinite(used) && Number.isFinite(remaining) && Number.isFinite(reset)) this.limits.set(`${String(headers['x-ratelimit-resource'] ?? 'core')}@${new Date(reset * 1000).toISOString().slice(11, 16)}`, { used, remaining });
  }
  /** The numbers since the last call, or null when nothing was requested. */
  flush() {
    if (!this.routes.size) return null;
    const total = [...this.routes.values()].reduce((a, b) => a + b, 0);
    const summary = { event: 'github-requests', total, routes: Object.fromEntries([...this.routes].sort((a, b) => b[1] - a[1]).slice(0, 8)),
      notModified: this.notModified, failures: Object.fromEntries(this.failures), limits: Object.fromEntries(this.limits) };
    this.routes.clear(); this.failures.clear(); this.limits.clear(); this.notModified = 0;
    return summary;
  }
}
const usage = new GitHubUsage();

/**
 * Conditional GET requests (software-factory, 2026-11-18): every reconciliation reads the same repository, configuration,
 * issues, timelines and permissions again, and one pass over six repositories cost about 450 requests, so the broker
 * alone used the installation's 5000 per hour. GitHub answers an unchanged resource with 304 when the request names its
 * ETag, and a 304 does not count against the limit. The cache keeps the last answer per URL and repository.
 */
export class ConditionalCache {
  private entries = new Map<string, { etag: string; response: unknown }>();
  constructor(private maxEntries = 3000) {}
  etag(key: string) { return this.entries.get(key)?.etag; }
  /** A copy, so callers (Octokit's paginate normalises list responses in place) never change the cached answer. */
  cached<T>(key: string): T | undefined { const entry = this.entries.get(key); return entry ? structuredClone(entry.response) as T : undefined; }
  store(key: string, etag: unknown, response: unknown) {
    if (typeof etag !== 'string' || !etag) return;
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { etag, response: structuredClone(response) });
  }
}
const conditional = new ConditionalCache();
setInterval(() => { const summary = usage.flush(); if (summary) console.log(JSON.stringify(summary)); }, 60000).unref();
/** The App key stays in the broker; EVERY installation token is limited to one numeric repository. */
/** What the broker's coding, publishing and merge paths ask for. Other uses name their own, narrower permissions. */
export const runtimePermissions = { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write' } as const;
export function scopedRuntimeGitHub(options: { appId: string; privateKey: string; installationId: number; repositoryId: number;
  permissions?: Record<string, 'read' | 'write'> }, fetcher: typeof fetch = fetch): Octokit {
  if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0 || !Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0) throw new Error('INVALID_APP_SCOPE');
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new Octokit({ authStrategy: createAppAuth, auth: { appId: options.appId, privateKey: options.privateKey.replaceAll('\\n', '\n') }, request: { timeout: 20000, fetch: fetcher }, log: silent });
  const scoped = new Octokit({ request: { timeout: 20000, fetch: fetcher }, log: silent });
  scoped.hook.wrap('request', async (request, parameters) => {
    const authentication = z.object({ token: z.string().min(1) }).parse(await app.auth({
      type: 'installation', installationId: options.installationId, repositoryIds: [options.repositoryId],
      permissions: options.permissions ?? runtimePermissions,
    }));
    // Hooks share the original options object; inner hooks may ignore a replacement object.
    parameters.headers.authorization = `token ${authentication.token}`;
    const route = `${parameters.method} ${parameters.url}`;
    const key = parameters.method === 'GET' ? `${options.repositoryId} ${scoped.request.endpoint(parameters).url}` : undefined;
    const etag = key ? conditional.etag(key) : undefined;
    if (etag) parameters.headers['if-none-match'] = etag;
    try {
      const response = await request(parameters); usage.record(route, response.headers);
      if (key) conditional.store(key, response.headers.etag, response);
      return response;
    } catch (error) {
      const failed = error as { status?: unknown; response?: { headers?: Record<string, unknown> } };
      const cached = key && failed.status === 304 ? conditional.cached<Awaited<ReturnType<typeof request>>>(key) : undefined;
      if (cached) { usage.record(route, failed.response?.headers ?? {}, undefined, true); return cached; }
      usage.record(route, failed.response?.headers ?? {}, typeof failed.status === 'number' ? failed.status : 0);
      throw error;
    }
  });
  return scoped;
}

/**
 * The commit identity GitHub attributes to this App's bot user (`<id>+<slug>[bot]@users.noreply.github.com`), resolved
 * once per process: the slug from the App itself, the bot user's id from the public user record. A Factory commit
 * then shows the App as its author, not a stranger's account that happens to own a guessed noreply address.
 */
let commitIdentity: Promise<{ name: string; email: string }> | undefined;
export function appCommitIdentity(appId: string, privateKey: string, api: Octokit, fetcher: typeof fetch = fetch) {
  commitIdentity ??= (async () => {
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const app = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey: privateKey.replaceAll('\\n', '\n') }, request: { timeout: 20000, fetch: fetcher }, log: silent });
    const { slug } = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/) }).parse((await app.request('GET /app')).data);
    const login = `${slug}[bot]`;
    const { id } = z.object({ id: z.number().int().positive() }).parse((await api.users.getByUsername({ username: login })).data);
    return { name: login, email: `${id}+${login}@users.noreply.github.com` };
  })();
  // A failed lookup is tried again on the next publication.
  commitIdentity.catch(() => { commitIdentity = undefined; });
  return commitIdentity;
}
