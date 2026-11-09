import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';

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
    return request(parameters);
  });
  return scoped;
}
