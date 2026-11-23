import { readFile, lstat } from 'node:fs/promises';
import { resolve, isAbsolute, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { codingArtifactSchema, validateChanges, type CodingArtifact } from '../workers/coding.js';
import { validationPlanSchema, type ValidationPlan } from './validation-contract.js';
import type { ValidationCommand } from './validation.js';

/** Seconds one regeneration command may run; the install gets the same. */
export const regenerateCommandSeconds = 300;
export const regenerationFailure = 'GENERATED_FILES_FAILED';
type Files = Map<string, { data: Buffer; mode: number }>;

async function regularFile(root: string, path: string) {
  const full = resolve(root, path), part = relative(root, full);
  if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('INVALID_REGENERATION_PATH');
  for (let current = dirname(full); current !== root; current = dirname(current)) if ((await lstat(current)).isSymbolicLink()) throw new Error('NON_REGULAR_REGENERATION_PATH');
  return full;
}
// Every file git would publish: tracked or untracked and not ignored (node_modules and build output stay out).
async function files(root: string): Promise<Files> {
  const listed = execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 50000000 });
  const result: Files = new Map();
  for (const path of listed.split('\0').filter(Boolean)) {
    try {
      const full = await regularFile(root, path), stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error('NON_REGULAR_REGENERATION_PATH');
      if (stat.isFile()) result.set(path, { data: await readFile(full), mode: stat.mode & 0o111 });
    } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; }
  }
  return result;
}
function changed(before: Files, after: Files) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => {
    const a = before.get(path), b = after.get(path); return !a || !b || !a.data.equals(b.data) || a.mode !== b.mode; }).sort();
}
const inside = (path: string, roots: string[]) => roots.some(root => path === root || path.startsWith(`${root}/`));
const list = (paths: string[]) => `${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', ...' : ''}`;

export interface Regeneration { artifact: CodingArtifact; regenerated: string[]; commands: string[]; failure: string | null }

/**
 * Reruns the generated outputs a repository declares for regeneration (`generated` entries with `regenerate: true`)
 * after the offline agent, on a checkout of the base with the artifact applied and the locked dependencies installed.
 * Only changes inside an entry's `paths` are adopted into the artifact; a change elsewhere, a failing or timed-out
 * command, or a result beyond the artifact limits adopts nothing and ends the result `blocked` (SF #281). The hosted
 * validation still reruns every entry as its `generated` check and restores the files.
 */
export async function regenerateCodingArtifact(options: { target: string; artifact: CodingArtifact; plan: ValidationPlan;
  command: ValidationCommand; log?: (line: string) => void }): Promise<Regeneration> {
  const plan = validationPlanSchema.parse(options.plan), original = codingArtifactSchema.parse(options.artifact), log = options.log ?? (() => undefined);
  const entries = (plan.generated ?? []).filter(e => e.regenerate);
  const unchanged: Regeneration = { artifact: original, regenerated: [], commands: [], failure: null };
  if (!entries.length || original.result.status !== 'success' || !original.changes.length) return unchanged;
  const root = resolve(options.target), environment = { ...plan.environment, CI: 'true' };
  const block = (reason: string): Regeneration => {
    log(`::warning::Generated files were not regenerated: ${reason}`);
    const note = `\n\nSoftware Factory: the declared generated files could not be regenerated after the run (${reason}). Nothing was adopted.`;
    return { artifact: codingArtifactSchema.parse({ ...original, result: { ...original.result, status: 'blocked',
      summary: `${original.result.summary.slice(0, 2000 - Math.min(note.length, 1000))}${note.slice(0, 1000)}`,
      error: `${regenerationFailure}: ${reason}`.slice(0, 2000) } }), regenerated: [], commands: [], failure: reason };
  };
  try {
    // An install that fails is the change's own problem: validation reports it and rework applies, so nothing is blocked here.
    const installed = await options.command('regenerate-install', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], regenerateCommandSeconds, environment).catch(() => -1);
    if (installed !== 0) { log('::warning::Installing the locked dependencies failed; generated files were not regenerated'); return unchanged; }
    const start = await files(root); let current = start;
    for (const entry of entries) {
      const exitCode = await options.command('regenerate', entry.command.split(' '), regenerateCommandSeconds, environment).catch(() => -1);
      if (exitCode !== 0) return block(`\`${entry.command}\` ${exitCode === 124 || exitCode === 137 ? `timed out after ${regenerateCommandSeconds} s` : `failed with exit code ${exitCode}`}`);
      const next = await files(root), outside = changed(current, next).filter(path => !inside(path, entry.paths));
      if (outside.length) return block(`\`${entry.command}\` changed files outside its declared paths: ${list(outside)}`);
      current = next;
    }
    const regenerated = changed(start, current);
    if (!regenerated.length) { log('Generated files were already up to date'); return { ...unchanged, commands: entries.map(e => e.command) }; }
    const changes = new Map(original.changes.map(c => [c.path, c]));
    for (const path of regenerated) {
      const file = current.get(path);
      changes.set(path, { path, content: file ? file.data.toString('base64') : null, mode: file && file.mode ? '100755' : '100644' });
    }
    const parsed = codingArtifactSchema.safeParse({ ...original, changes: [...changes.values()] });
    if (!parsed.success) return block(`the regenerated change exceeds the artifact limits (${changes.size} files)`);
    try { validateChanges(parsed.data); } catch (e) { return block(e instanceof Error ? e.message : 'invalid regenerated change'); }
    const note = `\n\nSoftware Factory regenerated after the run: ${entries.map(e => `\`${e.command}\``).join(', ')} (${list(regenerated)}).`;
    const summary = `${original.result.summary.slice(0, 2000 - Math.min(note.length, 1000))}${note.slice(0, 1000)}`;
    for (const path of regenerated) log(`Regenerated ${path}`);
    return { artifact: codingArtifactSchema.parse({ ...parsed.data, result: { ...parsed.data.result, summary } }), regenerated, commands: entries.map(e => e.command), failure: null };
  } catch (e) {
    return block(e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : 'the workspace could not be read');
  }
}
