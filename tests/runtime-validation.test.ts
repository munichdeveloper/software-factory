import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codingExecutionSchema } from '../src/runtime/coding-contract.js';
import { materializeCodingArtifact, runCodingValidation } from '../src/runtime/validation.js';
import { bindValidation, defaultValidationPlan, validationPlanSchema } from '../src/runtime/validation-contract.js';
import type { CodingArtifact } from '../src/workers/coding.js';
import { reportFor } from './validation-fixtures.js';
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) { if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('sf-validation-')) throw new Error('Unsafe fixture cleanup'); await rm(path, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(resolve(tmpdir()), 'sf-validation-')); directories.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', `core.hooksPath=${root}/.git/no-hooks`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs', build: 'node build.mjs' } }));
  await writeFile(join(root, 'package-lock.json'), '{}'); await writeFile(join(root, 'source.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: sha, result: { contractVersion: '2.0', executionId: 'a'.repeat(32), taskId: 'github:owner/target#1', taskVersion: 'b'.repeat(64), status: 'blocked', summary: 'Implementation ready; human acceptance remains open.', artifacts: [], error: null }, changes: [{ path: 'source.txt', mode: '100644', content: Buffer.from('implemented').toString('base64') }] };
  const request = codingExecutionSchema.parse({ contractVersion: '3.0', executionId: artifact.result.executionId, worker: 'codex', task: { id: artifact.result.taskId, version: artifact.result.taskVersion, description: 'Implement task', acceptanceCriteria: ['Tests pass'], contextReferences: [] }, baseSha: sha, allowedActions: ['edit_workspace', 'run_commands'], model: 'test-model', effort: 'high', limits: { timeoutMinutes: 5, maxFiles: 100, maxPatchBytes: 5000000 } });
  return { root, git, artifact, request };
}
it('validates a blocked implementation without changing its original result and passes only real required stages', async () => {
  const f = await fixture(), plan = defaultValidationPlan(); const original = JSON.stringify(f.artifact.result);
  await materializeCodingArtifact(f.root, f.artifact, f.request); const commands: string[] = [];
  const report = await runCodingValidation({ target: f.root, artifact: f.artifact, plan, workflowRunId: 12, hosted: false,
    command: async (name, _args, _seconds, environment) => { commands.push(name); expect(environment).toEqual({ CI: 'true', COMPOSE_PROJECT_NAME: 'sf-validation-12' }); return 0; } });
  expect(report.status).toBe('passed'); expect(commands).toEqual(['install', 'test', 'build']); expect(JSON.stringify(f.artifact.result)).toBe(original);
  expect(bindValidation(report, f.artifact, plan, 12)).toEqual(report); expect(await readFile(join(f.root, 'source.txt'), 'utf8')).toBe('implemented');
});
it('preserves failed checks, still attempts independent stages and always tears down the isolated Docker project', async () => {
  const f = await fixture(), plan = validationPlanSchema.parse({ profile: 'npm-docker', composeProjectPrefix: 'application-ci' }); await materializeCodingArtifact(f.root, f.artifact, f.request);
  const commands: string[] = [];
  const report = await runCodingValidation({ target: f.root, artifact: f.artifact, plan, workflowRunId: 15, hosted: true,
    command: async (name, args, _seconds, env) => { commands.push(name); expect(env.COMPOSE_PROJECT_NAME).toBe('application-ci-15'); if (name === 'docker-start') { expect(args).toContain('--project-name'); return 1; } return name === 'test' ? 1 : 0; } });
  expect(report.status).toBe('failed'); expect(commands).toEqual(['install', 'test', 'build', 'compose-config', 'docker-start', 'docker-stop']);
  expect(report.checks.find(c => c.name === 'docker-stop')?.status).toBe('passed');
});
it('never reports a passing artifact after a command changes source, even if every command exits zero', async () => {
  const f = await fixture(); await materializeCodingArtifact(f.root, f.artifact, f.request);
  const report = await runCodingValidation({ target: f.root, artifact: f.artifact, plan: defaultValidationPlan(), workflowRunId: 12, hosted: false,
    command: async name => { if (name === 'build') await writeFile(join(f.root, 'source.txt'), 'untested replacement'); return 0; } });
  expect(report.status).toBe('failed'); expect(report.reason).toBe('SOURCE_CHANGED'); expect(report.workspaceUnchanged).toBe(false);
});
it('rejects foreign artifacts, dirty bases and protected changes before running target commands', async () => {
  const f = await fixture(); await expect(materializeCodingArtifact(f.root, { ...f.artifact, baseSha: 'f'.repeat(40) }, f.request)).rejects.toThrow('UNRELATED');
  await expect(materializeCodingArtifact(f.root, { ...f.artifact, changes: [{ path: '.github/workflows/escape.yml', mode: '100644', content: 'eA==' }] }, f.request)).rejects.toThrow('Protected');
  await writeFile(join(f.root, 'source.txt'), 'uncommitted'); await expect(materializeCodingArtifact(f.root, f.artifact, f.request)).rejects.toThrow('VALIDATION_BASE_MISMATCH');
});
it.skipIf(process.platform === 'win32')('rejects symlink destinations without writing through them', async () => {
  const f = await fixture(), outside = await mkdtemp(join(resolve(tmpdir()), 'sf-validation-')); directories.push(outside);
  await symlink(outside, join(f.root, 'link')); f.git('add', '.'); f.git('commit', '-qm', 'link'); f.artifact.baseSha = f.git('rev-parse', 'HEAD'); f.request.baseSha = f.artifact.baseSha;
  f.artifact.changes = [{ path: 'link/file.txt', mode: '100644', content: 'eA==' }]; await expect(materializeCodingArtifact(f.root, f.artifact, f.request)).rejects.toThrow('NON_REGULAR');
});
it('rejects credential/control environment injection, production-like Compose names and forged validation evidence', async () => {
  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'PATH', 'DOCKER_HOST', 'COMPOSE_PROJECT_NAME']) expect(() => validationPlanSchema.parse({ environment: { [key]: 'untrusted' } })).toThrow();
  expect(() => validationPlanSchema.parse({ composeProjectPrefix: 'production' })).toThrow();
  const f = await fixture(), plan = defaultValidationPlan(), report = reportFor(f.artifact, plan);
  for (const changed of [{ artifactHash: 'c'.repeat(64) }, { planHash: 'd'.repeat(64) }, { workflowRunId: 13 }, { sourceRunId: 13 }]) expect(() => bindValidation({ ...report, ...changed }, f.artifact, plan, 12)).toThrow('UNRELATED');
  expect(() => bindValidation({ ...report, checks: report.checks.filter(c => c.name !== 'build') }, f.artifact, plan)).toThrow('INCONSISTENT');
  expect(() => bindValidation({ ...report, modelSecretPresent: true } as unknown as typeof report, f.artifact, plan)).toThrow();
});
