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
 *
 * Bounded by size, not only by count (software-factory#194, 2026-11-20): 3000 whole answers as live objects (issue
 * lists and timelines of 100 items with their bodies) filled the broker's 505 MB heap in about 4.5 hours, and it died
 * with "JavaScript heap out of memory" twice a day. Answers are kept as their JSON text, which is smaller than the
 * object graph and gives every hit a fresh copy; the least recently used ones go first once `maxBytes` is reached.
 * Binary answers (ArrayBuffer) and single answers above an eighth of the budget are not cached.
 */
export class ConditionalCache {
  private entries = new Map<string, { etag: string; json: string }>();
  private size = 0;
  constructor(private maxBytes = 64 * 1024 * 1024, private maxEntries = 3000) {}
  etag(key: string) { return this.entries.get(key)?.etag; }
  /** A copy, so callers (Octokit's paginate normalises list responses in place) never change the cached answer. */
  cached<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return JSON.parse(entry.json) as T;
  }
  store(key: string, etag: unknown, response: { data?: unknown }) {
    this.remove(key);
    if (typeof etag !== 'string' || !etag || !cacheable(response.data)) return;
    let json: string;
    try { json = JSON.stringify(response); } catch { return; }
    // String length counts UTF-16 units; V8 keeps Latin-1 text in one byte per unit, so this errs on the large side.
    const bytes = json.length;
    if (bytes > this.maxBytes / 8) return;
    while (this.entries.size && (this.size + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { etag, json }); this.size += bytes;
  }
  stats() { return { entries: this.entries.size, mb: Math.round(this.size / 104857.6) / 10 }; }
  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.size -= entry.json.length; this.entries.delete(key); }
  }
}
function cacheable(data: unknown) {
  return data === null || data === undefined || typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean' ||
    (typeof data === 'object' && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data) && !(data instanceof Blob));
}
function cacheBudget(value = process.env.FACTORY_GITHUB_CACHE_MB) {
  const mb = Number(value);
  return Number.isFinite(mb) && mb >= 1 && mb <= 512 ? mb * 1024 * 1024 : undefined;
}
const conditional = new ConditionalCache(cacheBudget());
/**
 * A full list page without a next link (controla#133, 2026-11-19): GitHub's ETag covers the page's items, not its Link
 * header. Cached when an issue had exactly 100 comments, page 1 stayed "unchanged" (304) after comment 101, the cached
 * answer named no next page, and pagination ended at 100: the broker never saw the newest intent (NO_MATCHING_INTENT)
 * and every later event on that issue. Such a page is never cached, so the next read sees the new Link header.
 */
export function openEndedPage(url: string, response: { data: unknown; headers: Record<string, unknown> }): boolean {
  if (!Array.isArray(response.data)) return false;
  const perPage = Number(new URL(url, 'https://api.github.com').searchParams.get('per_page') ?? 30);
  const link = typeof response.headers.link === 'string' ? response.headers.link : '';
  return response.data.length >= perPage && !/rel="next"/.test(link);
}
// The cache and the heap ride along, so a growing broker shows in its logs long before it runs out (software-factory#194).
setInterval(() => {
  const summary = usage.flush();
  if (summary) console.log(JSON.stringify({ ...summary, cache: conditional.stats(), heapMb: Math.round(process.memoryUsage().heapUsed / 1048576) }));
}, 60000).unref();
/** The App's installation on one repository, asked with the App's own JWT (no installation token is created). */
export async function appInstallationId(options: { appId: string; privateKey: string }, owner: string, repo: string, fetcher: typeof fetch = fetch): Promise<number> {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new Octokit({ authStrategy: createAppAuth, auth: { appId: options.appId, privateKey: options.privateKey.replaceAll('\\n', '\n') }, request: { timeout: 20000, fetch: fetcher }, log: silent });
  const { data } = await app.apps.getRepoInstallation({ owner, repo });
  return z.number().int().positive().safe().parse(data.id);
}
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
    // Streamed answers (artifact and log downloads, parseSuccessResponseBody: false) are neither cacheable nor clonable:
    // structuredClone of their ReadableStream threw DataCloneError, and every coding result failed as OPERATION_FAILED.
    const streamed = (parameters.request as { parseSuccessResponseBody?: boolean } | undefined)?.parseSuccessResponseBody === false;
    const key = parameters.method === 'GET' && !streamed ? `${options.repositoryId} ${scoped.request.endpoint(parameters).url}` : undefined;
    const etag = key ? conditional.etag(key) : undefined;
    if (etag) parameters.headers['if-none-match'] = etag;
    try {
      const response = await request(parameters); usage.record(route, response.headers);
      if (key && !openEndedPage(scoped.request.endpoint(parameters).url, response)) conditional.store(key, response.headers.etag, response);
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
