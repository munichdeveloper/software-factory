import { readFile, writeFile, mkdir, lstat, realpath, unlink, chmod } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { codingArtifactSchema, validateChanges, type CodingArtifact } from '../workers/coding.js';
import { codingExecutionSchema } from './coding-contract.js';
import { hash } from '../state/identity.js';
import { validationPlanSchema, validationReportSchema, type ValidationPlan, type ValidationReport } from './validation-contract.js';

async function regularPath(root: string, path: string) {
  const full = resolve(root, path), part = relative(root, full);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('INVALID_VALIDATION_PATH');
  for (let current = full; current !== root; current = dirname(current)) {
    try { const stat = await lstat(current); if (stat.isSymbolicLink() || current !== full && !stat.isDirectory()) throw new Error('NON_REGULAR_VALIDATION_PATH'); }
    catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; }
  }
  return full;
}
export async function materializeCodingArtifact(target: string, source: unknown, request: unknown): Promise<CodingArtifact> {
  const artifact = codingArtifactSchema.parse(source), input = codingExecutionSchema.parse(request); validateChanges(artifact);
  if (artifact.baseSha !== input.baseSha || artifact.result.executionId !== input.executionId || artifact.result.taskId !== input.task.id || artifact.result.taskVersion !== input.task.version) throw new Error('UNRELATED_CODING_ARTIFACT');
  const root = await realpath(resolve(target));
  const current = execFileSync('git', ['-c', `safe.directory=${root}`, 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-c', `safe.directory=${root}`, 'status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
  if (current !== input.baseSha || dirty) throw new Error('VALIDATION_BASE_MISMATCH');
  for (const change of artifact.changes) {
    const full = await regularPath(root, change.path);
    try { if (!(await lstat(full)).isFile()) throw new Error('NON_REGULAR_VALIDATION_PATH'); }
    catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; }
    if (change.content === null) await unlink(full);
    else { await mkdir(dirname(full), { recursive: true }); await writeFile(full, Buffer.from(change.content, 'base64')); await chmod(full, change.mode === '100755' ? 0o755 : 0o644); }
  }
  return artifact;
}
// Runs a write of the validator itself. On a hosted runner the tree belongs to sf-validator, so the runner user
// takes it over for the write and hands it back afterwards (hostedWritable).
export type Writable = (work: () => Promise<void>) => Promise<void>;
export function hostedWritable(target: string): Writable {
  return async work => {
    execFileSync('sudo', ['-n', 'chown', '-R', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, target]);
    try { await work(); } finally { execFileSync('sudo', ['-n', 'chown', '-R', 'sf-validator:sf-validator', target]); }
  };
}
export type ValidationCommand = (name: string, args: string[], seconds: number, environment: Record<string, string>) => Promise<number>;
async function fingerprint(root: string, paths: string[]) {
  const entries = [];
  for (const path of [...new Set(paths)].sort()) {
    const full = await regularPath(root, path);
    try { const stat = await lstat(full); if (!stat.isFile()) throw new Error('NON_REGULAR_VALIDATION_PATH'); entries.push([path, hash((await readFile(full)).toString('base64')), stat.mode & 0o111]); }
    catch (e) { if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') entries.push([path, null]); else throw e; }
  }
  return hash(entries);
}
type Snapshot = Map<string, { data: Buffer; mode: number }>;
async function snapshot(root: string, paths: string[]): Promise<Snapshot> {
  const listed = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], { cwd: root, encoding: 'utf8', maxBuffer: 10000000 });
  const files: Snapshot = new Map();
  for (const path of listed.split('\0').filter(Boolean)) {
    const full = await regularPath(root, path);
    try { const stat = await lstat(full); if (stat.isFile()) files.set(path, { data: await readFile(full), mode: stat.mode & 0o111 }); }
    catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; }
  }
  return files;
}
// The generating step only checks: a difference is reported and the files are put back, never adopted.
async function restore(root: string, before: Snapshot, after: Snapshot) {
  for (const path of after.keys()) if (!before.has(path)) await unlink(await regularPath(root, path));
  for (const [path, file] of before) {
    const now = after.get(path);
    if (now && now.data.equals(file.data) && now.mode === file.mode) continue;
    const full = await regularPath(root, path); await mkdir(dirname(full), { recursive: true }); await writeFile(full, file.data); await chmod(full, file.mode ? 0o755 : 0o644);
  }
}
// Postgres bound to loopback on a free port, empty, with a fixed test user that needs no password (trust auth on a
// container only this host can reach). Removed with its volumes by `database-stop`.
const databaseUser = 'test', databaseName = 'test';
async function freeLoopbackPort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer(); server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? done(address.port) : fail(new Error('NO_PORT'))); });
  });
}
async function startDatabase(name: string, service: { version: number; env: string }, environment: Record<string, string>,
  run: (args: string[], limit: number) => Promise<number>): Promise<number> {
  let port: number;
  try { port = await freeLoopbackPort(); } catch { return -1; }
  const start = await run(['docker', 'run', '--detach', '--name', name, '--publish', `127.0.0.1:${port}:5432`, '--env', `POSTGRES_USER=${databaseUser}`, '--env', `POSTGRES_DB=${databaseName}`,
    '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', `postgres:${service.version}`], 300);
  if (start !== 0) return start;
  // Probing over TCP: the image's initialisation server listens on its socket only.
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await run(['docker', 'exec', name, 'pg_isready', '--host', '127.0.0.1', '--username', databaseUser, '--dbname', databaseName], 10) === 0) {
      environment[service.env] = `postgresql://${databaseUser}@127.0.0.1:${port}/${databaseName}`; return 0;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return 1;
}
export async function runCodingValidation(options: { target: string; artifact: CodingArtifact; plan: ValidationPlan; workflowRunId: number; sourceRunId?: number;
  command: ValidationCommand; hosted: boolean; note?: (name: string, text: string) => Promise<void>; writable?: Writable }): Promise<ValidationReport> {
  const { artifact, command } = options, plan = validationPlanSchema.parse(options.plan), root = await realpath(resolve(options.target));
  const report: ValidationReport = { version: 1, executionId: artifact.result.executionId, taskId: artifact.result.taskId, taskVersion: artifact.result.taskVersion,
    baseSha: artifact.baseSha, artifactHash: hash(artifact), planHash: hash(plan), workflowRunId: options.workflowRunId, sourceRunId: options.sourceRunId ?? options.workflowRunId, runAttempt: 1,
    status: 'invalid', checks: [], reason: 'VALIDATION_SETUP_FAILED', modelSecretPresent: false, workspaceUnchanged: false };
  if (!['success', 'blocked'].includes(artifact.result.status) || !artifact.changes.length) return { ...report, status: 'unsupported', reason: 'NO_PUBLISHABLE_CHANGES' };
  const started = Date.now(), budget = plan.timeoutMinutes * 60;
  const check = async (name: ValidationReport['checks'][number]['name'], args: string[], limit = 300) => {
    const remaining = Math.floor(budget - (Date.now() - started) / 1000);
    const exitCode = remaining > 0 ? await command(name, args, Math.min(limit, remaining), environment).catch(() => -1) : -1;
    report.checks.push({ name, status: exitCode === 0 ? 'passed' : 'failed', exitCode }); return exitCode === 0;
  };
  const environment = { ...plan.environment, CI: 'true', COMPOSE_PROJECT_NAME: `${plan.composeProjectPrefix}-${options.workflowRunId}` };
  let paths: string[] = [], before = '', docker = false, database = '';
  try {
    if (plan.services?.postgres && !options.hosted) return { ...report, status: 'unsupported', reason: 'UNSUPPORTED_PROJECT' };
    if (plan.profile === 'npm-docker' && !options.hosted) return { ...report, status: 'unsupported', reason: 'UNSUPPORTED_PROJECT' };
    if (plan.profile === 'maven') {
      if (!(await lstat(join(root, 'pom.xml'))).isFile()) return { ...report, status: 'unsupported', reason: 'UNSUPPORTED_PROJECT' };
      // The project's own wrapper pins its Maven version; without one the runner's Maven is used.
      const wrapper = await lstat(join(root, 'mvnw')).then(s => s.isFile() && (s.mode & 0o100) !== 0, () => false);
      const mvn = [wrapper ? './mvnw' : 'mvn', '--batch-mode', '--no-transfer-progress'];
      const listed = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1000000 });
      paths = [...listed.split('\0').filter(Boolean), ...artifact.changes.map(c => c.path)]; before = await fingerprint(root, paths);
      report.status = 'failed'; report.reason = 'CHECK_FAILED';
      // validate resolves the project model; package builds every module without tests; verify runs unit and
      // integration tests (Testcontainers reach the disposable runner's Docker).
      if (await check('install', [...mvn, 'validate'], 600)) {
        await check('build', [...mvn, '-DskipTests', 'package'], 1200);
        await check('test', [...mvn, 'verify'], 1500);
      }
    } else {
      const packageFile = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
      await lstat(join(root, 'package-lock.json'));
      if (!packageFile.scripts?.test || !packageFile.scripts?.build) return { ...report, status: 'unsupported', reason: 'UNSUPPORTED_PROJECT' };
      const listed = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1000000 });
      paths = [...listed.split('\0').filter(Boolean), ...artifact.changes.map(c => c.path)]; before = await fingerprint(root, paths);
      report.status = 'failed'; report.reason = 'CHECK_FAILED';
      // The test database starts before install and test; a failed start is its own check and ends the run as a
      // test-infrastructure failure, which is not the change's fault and never triggers rework.
      let databaseReady = true;
      if (plan.services?.postgres) {
        database = `${plan.composeProjectPrefix}-${options.workflowRunId}-postgres`;
        const exitCode = await startDatabase(database, plan.services.postgres, environment, (args, limit) => {
          const remaining = Math.floor(budget - (Date.now() - started) / 1000);
          return remaining > 0 ? command('database-start', args, Math.min(limit, remaining), environment).catch(() => -1) : Promise.resolve(-1);
        });
        databaseReady = exitCode === 0; report.checks.push({ name: 'database-start', status: databaseReady ? 'passed' : 'failed', exitCode });
        if (!databaseReady) report.reason = 'TEST_INFRASTRUCTURE_FAILED';
      }
      const installed = databaseReady && await check('install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']);
      if (installed) {
        await check('test', ['npm', 'test']);
        const built = await check('build', ['npm', 'run', 'build']);
        if (packageFile.scripts['test:e2e']) {
          if (built) {
            try { await lstat(join(root, 'node_modules/playwright/cli.js')); await check('browser-install', ['node', 'node_modules/playwright/cli.js', 'install', 'chromium'], 180); } catch { /* Other browser runners prepare through their project script. */ }
            await check('browser', ['npm', 'run', 'test:e2e']);
          }
          else report.checks.push({ name: 'browser', status: 'skipped', exitCode: null });
        } else report.checks.push({ name: 'browser', status: 'skipped', exitCode: null });
        if (plan.profile === 'npm-docker') {
          const compose = ['docker', 'compose', '--file', 'compose.yaml', '--project-name', environment.COMPOSE_PROJECT_NAME];
          if (await check('compose-config', [...compose, 'config', '--quiet'], 60)) {
            docker = true;
            if (await check('docker-start', [...compose, 'up', '--build', '-d', '--wait', '--wait-timeout', '180'], 600)) await check('docker-smoke', ['node', 'tests/docker-smoke.mjs'], 300);
          }
        }
      }
    }
    if (plan.generated?.length && report.status === 'failed' && report.checks.length && report.checks.every(c => c.status !== 'failed')) {
      const messages: string[] = []; let ok = true;
      for (const entry of plan.generated) {
        const was = await snapshot(root, entry.paths), remaining = Math.floor(budget - (Date.now() - started) / 1000);
        const exitCode = remaining > 0 ? await command('generated', entry.command.split(' '), Math.min(600, remaining), environment).catch(() => -1) : -1;
        const now = await snapshot(root, entry.paths), changed = [...new Set([...was.keys(), ...now.keys()])].filter(path => {
          const a = was.get(path), b = now.get(path); return !a || !b || !a.data.equals(b.data) || a.mode !== b.mode; }).sort();
        if (changed.length) {
          messages.push(`generated files out of date: run \`${entry.command}\` (${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', ...' : ''})`);
          // A failed restore leaves the tree changed, so source integrity still fails; the note above survives it.
          await (options.writable ?? (work => work()))(() => restore(root, was, now)).catch(() => { messages.push('generated files could not be restored'); });
        }
        if (exitCode !== 0) messages.push(`generated command \`${entry.command}\` failed with exit code ${exitCode}`);
        if (exitCode !== 0 || changed.length) ok = false;
      }
      report.checks.push({ name: 'generated', status: ok ? 'passed' : 'failed', exitCode: ok ? 0 : 1 });
      if (!ok) await options.note?.('generated', messages.join('\n') + '\n').catch(() => undefined);
    }
  } catch { report.status = 'unsupported'; report.reason = 'UNSUPPORTED_PROJECT'; }
  finally {
    if (database) {
      const exitCode = await command('database-stop', ['docker', 'rm', '--force', '--volumes', database], 60, environment).catch(() => -1);
      report.checks.push({ name: 'database-stop', status: exitCode === 0 ? 'passed' : 'failed', exitCode });
    }
    if (docker) {
      const exitCode = await command('docker-stop', ['docker', 'compose', '--file', 'compose.yaml', '--project-name', environment.COMPOSE_PROJECT_NAME, 'down', '--volumes', '--remove-orphans'], 60, environment).catch(() => -1);
      report.checks.push({ name: 'docker-stop', status: exitCode === 0 ? 'passed' : 'failed', exitCode });
    }
    if (before) {
      try { report.workspaceUnchanged = await fingerprint(root, paths) === before; } catch { report.workspaceUnchanged = false; }
      report.checks.push({ name: 'source-integrity', status: report.workspaceUnchanged ? 'passed' : 'failed', exitCode: report.workspaceUnchanged ? 0 : 1 });
      if (!report.workspaceUnchanged) { report.status = 'failed'; report.reason = 'SOURCE_CHANGED'; }
    }
  }
  if (report.status === 'failed' && report.workspaceUnchanged && report.checks.length && report.checks.every(c => c.status !== 'failed')) { report.status = 'passed'; report.reason = 'CHECKS_COMPLETED'; }
  return validationReportSchema.parse(report);
}
// A slot of the Factory's runner pool has no Docker socket: its jobs reach the slot's daemon over loopback TCP, named
// by the runner's DOCKER_HOST (docs/self-hosted-runners.md). The validation account starts with an empty environment,
// so without this its Docker checks cannot reach any daemon there. Only that loopback form is passed on, taken from
// the runner and never from the plan; a hosted runner sets nothing and its account uses the default socket.
export function runnerDockerHost(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return /^tcp:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(env.DOCKER_HOST ?? '') ? env.DOCKER_HOST : undefined;
}
export function hostedValidationCommand(target: string, logs: string): ValidationCommand {
  return async (name, args, seconds, values) => {
    await mkdir(logs, { recursive: true });
    const docker = runnerDockerHost();
    // The JDK and Maven the validator job prepared (maven profile); absolute paths only, never from the plan.
    const tool = (value: string | undefined) => value && /^\/[\w./-]+$/.test(value) && !value.includes('..') ? value : undefined;
    const java = tool(process.env.JAVA_HOME), maven = tool(process.env.SF_MAVEN_HOME);
    const path = [java && `${java}/bin`, maven && `${maven}/bin`, dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
    return new Promise<number>(resolveExit => {
      const child = spawn('sudo', ['-n', '-u', 'sf-validator', '--', 'env', '-i', 'HOME=/home/sf-validator', `PATH=${path}`, ...(java ? [`JAVA_HOME=${java}`] : []),
        ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ...(docker ? [`DOCKER_HOST=${docker}`] : []), 'timeout', '--kill-after=5s', `${seconds}s`, ...args],
      { cwd: target, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '', size = 0;
      const consume = (chunk: Buffer) => { if (size < 64000) text += chunk.subarray(0, 64000 - size).toString(); size += chunk.length; };
      child.stdout.on('data', consume); child.stderr.on('data', consume);
      child.once('error', () => resolveExit(-1));
      child.once('exit', code => { void writeFile(join(logs, `${name}.log`), text).finally(() => resolveExit(code ?? -1)); });
    });
  };
}
