import type { Config } from '../config/index.js';
import type { SshTarget } from './transport.js';

const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9a-fA-F:.]+\]?$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Connection settings: values in the configuration win; otherwise the Actions
 * secrets/variables DEPLOY_HOST, DEPLOY_USER and DEPLOY_PORT are used. The key
 * (DEPLOY_SSH_KEY) and the pinned host key (DEPLOY_KNOWN_HOSTS) are always secrets.
 * Returns the names of missing settings instead of a target when incomplete.
 */
export function resolveTarget(config: Config, env: NodeJS.ProcessEnv = process.env): SshTarget | { missing: string[] } {
  const deploy = config.deploy;
  const host = deploy.host ?? env.DEPLOY_HOST?.trim() ?? '';
  const user = deploy.user ?? env.DEPLOY_USER?.trim() ?? '';
  const port = deploy.port ?? (env.DEPLOY_PORT?.trim() ? Number(env.DEPLOY_PORT.trim()) : 22);
  const privateKey = env.DEPLOY_SSH_KEY ?? '';
  const knownHosts = env.DEPLOY_KNOWN_HOSTS ?? '';
  const missing = [
    ...(host ? [] : ['DEPLOY_HOST']), ...(user ? [] : ['DEPLOY_USER']),
    ...(privateKey.trim() ? [] : ['DEPLOY_SSH_KEY']), ...(knownHosts.trim() ? [] : ['DEPLOY_KNOWN_HOSTS'])
  ];
  if (missing.length) return { missing };
  if (!HOST.test(host)) throw new Error('Deployment host is invalid');
  if (!USER.test(user)) throw new Error('Deployment user is invalid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Deployment port is invalid');
  if (!/PRIVATE KEY-----/.test(privateKey)) throw new Error('Deployment SSH key must be an unencrypted OpenSSH/PEM private key');
  return { host, user, port, privateKey, knownHosts };
}
