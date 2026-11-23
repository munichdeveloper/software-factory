import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codingExecutionSchema } from '../src/runtime/coding-contract.js';
import { materializeCodingArtifact, runCodingValidation, type ValidationCommand } from '../src/runtime/validation.js';
import { regenerateCodingArtifact } from '../src/runtime/regenerate.js';
import { validationPlanSchema } from '../src/runtime/validation-contract.js';
import type { CodingArtifact } from '../src/workers/coding.js';
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) { if (dirname(path) !== resolve(tmpdir()) || !basename(path).startsWith('sf-regenerate-')) throw new Error('Unsafe fixture cleanup'); await rm(path, { recursive: true, force: true }); } });
async function fixture(status: CodingArtifact['result']['status'] = 'success', materialize = true) {
  const root = await mkdtemp(join(resolve(tmpdir()), 'sf-regenerate-')); directories.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', `core.hooksPath=${root}/.git/no-hooks`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  git('init', '-q'); await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node test.mjs', build: 'node build.mjs' } }));
  await writeFile(join(root, 'package-lock.json'), '{}'); await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await mkdir(join(root, 'src')); await writeFile(join(root, 'src/index.ts'), 'base');
  await mkdir(join(root, 'bundle')); await writeFile(join(root, 'bundle/factory.cjs'), 'bundle of base'); git('add', '.'); git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: sha, result: { contractVersion: '2.0', executionId: 'a'.repeat(32), taskId: 'github:owner/target#1', taskVersion: 'b'.repeat(64), status, summary: 'Implemented the change.', artifacts: [], error: null }, changes: [{ path: 'src/index.ts', mode: '100644', content: Buffer.from('implemented').toString('base64') }] };
  const request = codingExecutionSchema.parse({ contractVersion: '3.0', executionId: artifact.result.executionId, worker: 'claude', task: { id: artifact.result.taskId, version: artifact.result.taskVersion, description: 'Implement task', acceptanceCriteria: ['Tests pass'], contextReferences: [] }, baseSha: sha, allowedActions: ['edit_workspace', 'run_commands'], model: 'claude-sonnet-5-5', effort: 'medium', limits: { timeoutMinutes: 5, maxFiles: 100, maxPatchBytes: 5000000 } });
  if (materialize) await materializeCodingArtifact(root, artifact, request);
  return { root, artifact, request };
}
const plan = (regenerate = true) => validationPlanSchema.parse({ generated: [{ command: 'npm run bundle', paths: ['bundle'], ...(regenerate ? { regenerate: true } : {}) }, { command: 'npm run lint', paths: ['src'] }] });
const bundling = (root: string, extra?: () => Promise<void>): ValidationCommand => async (name, args) => {
  if (name === 'regenerate' && args.join(' ') === 'npm run bundle') { await writeFile(join(root, 'bundle/factory.cjs'), 'bundle of implemented'); await extra?.(); }
  if (name === 'regenerate-install') await mkdir(join(root, 'node_modules/x'), { recursive: true }).then(() => writeFile(join(root, 'node_modules/x/index.js'), ''));
  return 0;
};

it('adopts regenerated files inside the declared paths, names them in the summary and then passes validation', async () => {
  const f = await fixture(), calls: string[] = [];
  const command: ValidationCommand = async (name, args, seconds, env) => { calls.push(`${name}:${args.join(' ')}`); expect(seconds).toBe(300); expect(env.CI).toBe('true'); return bundling(f.root)(name, args, seconds, env); };
  const result = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), command });
  // Only the entry marked for regeneration runs; the lint entry stays a validation check.
  expect(calls).toEqual(['regenerate-install:npm ci --ignore-scripts --no-audit --no-fund', 'regenerate:npm run bundle']);
  expect(result.failure).toBeNull(); expect(result.regenerated).toEqual(['bundle/factory.cjs']);
  expect(result.artifact.result.status).toBe('success');
  expect(result.artifact.changes.map(c => c.path)).toEqual(['src/index.ts', 'bundle/factory.cjs']);
  expect(Buffer.from(result.artifact.changes[1]!.content!, 'base64').toString()).toBe('bundle of implemented');
  expect(result.artifact.result.summary).toContain('Software Factory regenerated after the run: `npm run bundle` (bundle/factory.cjs)');
  // The independent validation on a fresh checkout finds the outputs up to date.
  const v = await fixture(); await materializeCodingArtifact(join(v.root, '..', basename(v.root)), { ...result.artifact, baseSha: v.artifact.baseSha }, v.request).catch(() => undefined);
  const fresh = await fixture(); const applied = { ...result.artifact, baseSha: fresh.artifact.baseSha };
  execFileSync('git', ['-c', `safe.directory=${fresh.root}`, 'checkout', '-q', '--', '.'], { cwd: fresh.root });
  await materializeCodingArtifact(fresh.root, applied, fresh.request);
  const report = await runCodingValidation({ target: fresh.root, artifact: applied, plan: plan(), workflowRunId: 12, hosted: false,
    command: async (name, args) => { if (name === 'generated' && args.join(' ') === 'npm run bundle') await writeFile(join(fresh.root, 'bundle/factory.cjs'), 'bundle of implemented'); return 0; } });
  expect(report.checks.find(c => c.name === 'generated')?.status).toBe('passed'); expect(report.status).toBe('passed');
});

it('refuses changes outside the declared paths, adopts nothing and ends the result blocked', async () => {
  const f = await fixture();
  const result = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), command: bundling(f.root, () => writeFile(join(f.root, 'src/index.ts'), 'rewritten')) });
  expect(result.failure).toContain('changed files outside its declared paths: src/index.ts');
  expect(result.artifact.result.status).toBe('blocked'); expect(result.artifact.result.error).toMatch(/^GENERATED_FILES_FAILED: /);
  expect(result.artifact.changes).toEqual(f.artifact.changes); expect(result.regenerated).toEqual([]);
  expect(result.artifact.result.summary).toContain('Nothing was adopted');
});

it('returns the artifact unchanged without blocking when a regeneration command fails', async () => {
  const f = await fixture(), lines: string[] = [];
  const result = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), log: l => lines.push(l), command: async (name, args, seconds, env) => {
    if (name === 'regenerate') { await bundling(f.root)(name, args, seconds, env); return 2; } return 0; } });
  expect(result.artifact).toEqual(f.artifact); expect(result.artifact.result.status).toBe(f.artifact.result.status);
  expect(result.failure).toBe('`npm run bundle` failed with exit code 2'); expect(result.regenerated).toEqual([]);
  expect(lines).toContain('::warning::Generated files were not regenerated: `npm run bundle` failed with exit code 2; validation decides');
});

it('ends the result blocked and adopts nothing when a regeneration command times out', async () => {
  for (const [exitCode, text] of [[124, 'timed out after 300 s'], [137, 'timed out after 300 s']] as const) {
    const f = await fixture();
    const result = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), command: async (name, args, seconds, env) => {
      if (name === 'regenerate') { await bundling(f.root)(name, args, seconds, env); return exitCode; } return 0; } });
    expect(result.failure).toBe(`\`npm run bundle\` ${text}`); expect(result.artifact.result.status).toBe('blocked');
    expect(result.artifact.changes).toEqual(f.artifact.changes);
  }
});

it('leaves the artifact unchanged without regenerate entries, for unsuccessful results and when the install fails', async () => {
  const f = await fixture(); let called = false;
  const spy: ValidationCommand = async () => { called = true; return 0; };
  expect((await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(false), command: spy })).artifact).toEqual(f.artifact);
  const blocked = await fixture('blocked');
  expect((await regenerateCodingArtifact({ target: blocked.root, artifact: blocked.artifact, plan: plan(), command: spy })).artifact).toEqual(blocked.artifact);
  expect(called).toBe(false);
  const install = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), command: async name => name === 'regenerate-install' ? 1 : 0 });
  expect(install.artifact).toEqual(f.artifact); expect(install.failure).toBeNull();
});

it('keeps an up-to-date output as it is', async () => {
  const f = await fixture();
  const result = await regenerateCodingArtifact({ target: f.root, artifact: f.artifact, plan: plan(), command: async () => 0 });
  expect(result.artifact).toEqual(f.artifact); expect(result.regenerated).toEqual([]); expect(result.commands).toEqual(['npm run bundle']);
});

it('accepts regenerate only on npm plans with unprotected paths and keeps plans without it unchanged', () => {
  expect(JSON.stringify(validationPlanSchema.parse({ generated: [{ command: 'npm run bundle', paths: ['bundle'] }] }))).not.toContain('regenerate');
  for (const paths of [['.github/workflows'], ['docs/AGENTS.md'], ['CODEOWNERS'], ['.claude']]) expect(() => validationPlanSchema.parse({ generated: [{ command: 'npm run x', paths, regenerate: true }] })).toThrow();
  expect(() => validationPlanSchema.parse({ generated: [{ command: 'npm run x', paths: ['.github/x'] }] })).not.toThrow();
  expect(() => validationPlanSchema.parse({ profile: 'maven', generated: [{ command: 'mvn x', paths: ['gen'], regenerate: true }] })).toThrow();
  expect(() => validationPlanSchema.parse({ generated: [{ command: 'npm run x', paths: ['gen'], regenerate: false }] })).toThrow();
});
