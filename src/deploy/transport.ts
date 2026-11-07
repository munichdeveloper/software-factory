import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { bashCommand } from './remote.js';

export type RemoteResult = { code: number; stdout: string; stderr: string };
/** Runs a bash script with arguments on the deployment target. */
export interface Transport {
  run(script: string, args: string[], stdin?: Readable, timeoutMs?: number): Promise<RemoteResult>;
  close(): Promise<void>;
}
export type SshTarget = { host: string; port: number; user: string; privateKey: string; knownHosts: string };

const limit = (text: string) => text.length > 20000 ? text.slice(-20000) : text;

/** Spawns a process, optionally piping a stream into it, and collects bounded output. */
export function runProcess(command: string, args: string[], stdin?: Readable, timeoutMs = 600000, env?: NodeJS.ProcessEnv): Promise<RemoteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = limit(stdout + chunk); });
    child.stderr.on('data', chunk => { stderr = limit(stderr + chunk); });
    const timer = setTimeout(() => { stderr += '\nTimed out'; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => { /* The remote side may exit early; its exit code reports the failure. */ });
    if (stdin) {
      stdin.on('error', error => { child.stdin.destroy(); stderr += `\nInput failed: ${error.message}`; });
      stdin.pipe(child.stdin);
    } else child.stdin.end();
  });
}

/**
 * OpenSSH transport with a pinned host key: never trusts unknown hosts and never
 * uses an agent or other identities. The key only exists in a private temp dir.
 */
export class SshTransport implements Transport {
  private files?: Promise<{ dir: string; key: string; hosts: string }>;
  constructor(private target: SshTarget) {}
  private prepare() {
    this.files ??= (async () => {
      const dir = await mkdtemp(join(tmpdir(), 'sf-deploy-'));
      await chmod(dir, 0o700);
      const key = join(dir, 'id'), hosts = join(dir, 'known_hosts');
      // Secrets are often stored without the trailing newline OpenSSH requires.
      await writeFile(key, this.target.privateKey.replace(/\r\n/g, '\n').trimEnd() + '\n', { mode: 0o600 });
      await writeFile(hosts, this.target.knownHosts.replace(/\r\n/g, '\n').trimEnd() + '\n', { mode: 0o600 });
      return { dir, key, hosts };
    })();
    return this.files;
  }
  async run(script: string, args: string[], stdin?: Readable, timeoutMs?: number) {
    const { key, hosts } = await this.prepare();
    return runProcess('ssh', [
      '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${hosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8',
      '-p', String(this.target.port), '-l', this.target.user, '--', this.target.host, bashCommand(script, args)
    ], stdin, timeoutMs, { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? tmpdir() });
  }
  async close() {
    if (this.files) await rm((await this.files).dir, { recursive: true, force: true });
  }
}
