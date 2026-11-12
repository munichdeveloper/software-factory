import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';

/**
 * What the broker asks GitHub for, per route template, and what GitHub reports about the installation's limit.
 * The limit is shared with every other user of the same App installation, so an exhausted limit stops task
 * reconciliation; without these numbers the consumer can only be guessed. One line per minute with requests.
 */
export class GitHubUsage {
  private routes = new Map<string, number>(); private failures = new Map<number, number>();
  private limits = new Map<string, { used: number; remaining: number }>();
  record(route: string, headers: Record<string, unknown>, failedStatus?: number) {
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
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
      failures: Object.fromEntries(this.failures), limits: Object.fromEntries(this.limits) };
    this.routes.clear(); this.failures.clear(); this.limits.clear();
    return summary;
  }
}
const usage = new GitHubUsage();
setInterval(() => { const summary = usage.flush(); if (summary) console.log(JSON.stringify(summary)); }, 60000).unref();
/** The App key stays in the broker; EVERY installation token is limited to one numeric repository. */
export function scopedRuntimeGitHub(options: { appId: string; privateKey: string; installationId: number; repositoryId: number }, fetcher: typeof fetch = fetch): Octokit {
  if (!Number.isSafeInteger(options.installationId) || options.installationId <= 0 || !Number.isSafeInteger(options.repositoryId) || options.repositoryId <= 0) throw new Error('INVALID_APP_SCOPE');
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const app = new Octokit({ authStrategy: createAppAuth, auth: { appId: options.appId, privateKey: options.privateKey.replaceAll('\\n', '\n') }, request: { timeout: 20000, fetch: fetcher }, log: silent });
  const scoped = new Octokit({ request: { timeout: 20000, fetch: fetcher }, log: silent });
  scoped.hook.wrap('request', async (request, parameters) => {
    const authentication = z.object({ token: z.string().min(1) }).parse(await app.auth({
      type: 'installation', installationId: options.installationId, repositoryIds: [options.repositoryId],
      permissions: { contents: 'write', issues: 'write', pull_requests: 'write', actions: 'write' },
    }));
    // Hooks share the original options object; inner hooks may ignore a replacement object.
    parameters.headers.authorization = `token ${authentication.token}`;
    const route = `${parameters.method} ${parameters.url}`;
    try { const response = await request(parameters); usage.record(route, response.headers); return response; }
    catch (error) {
      const failed = error as { status?: unknown; response?: { headers?: Record<string, unknown> } };
      usage.record(route, failed.response?.headers ?? {}, typeof failed.status === 'number' ? failed.status : 0);
      throw error;
    }
  });
  return scoped;
}
