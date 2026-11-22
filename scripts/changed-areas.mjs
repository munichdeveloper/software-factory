// Decides which CI areas a change touches (software-factory#234). CI runs this before any heavy job; a job whose
// area is untouched is skipped via its `if:`, which GitHub and the merge manager count as passed. When in doubt
// (no usable base, git error, empty diff) every area runs. Plain Node without dependencies: it runs before npm ci.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Documentation only: never affects build, tests, images or the deployed runtime. prompts/ is read at runtime. */
export const isDocumentation = path =>
  path.startsWith('.claude/') || path.startsWith('docs/') || (path.endsWith('.md') && !path.startsWith('prompts/'));

/** Changes that may alter what CI itself does: every area runs. */
export const forcesAll = path =>
  path.startsWith('.github/') || ['action.yml', 'package.json', 'package-lock.json', 'scripts/changed-areas.mjs'].includes(path);

const ALL = { code: true, runner: true };

/** files: changed paths, or null when they could not be determined. */
export function classify(files) {
  if (!files || files.length === 0 || files.some(forcesAll)) return { ...ALL };
  return {
    code: files.some(path => !isDocumentation(path)),
    runner: files.some(path => path.startsWith('operations/runner/') && !isDocumentation(path))
  };
}

const SHA = /^[a-f0-9]{40}$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Changed paths for this event, or null. A pull request is checked out as its merge commit, whose first parent is the base. */
export function changedFiles(env = process.env, run = git) {
  try {
    const head = run('rev-parse', 'HEAD');
    const base = env.EVENT === 'pull_request' ? run('rev-parse', 'HEAD^1') : env.BASE ?? '';
    if (!SHA.test(base) || /^0+$/.test(base) || base === head) return null;
    return run('diff', '--name-only', '--no-renames', base, head).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = changedFiles();
  const areas = classify(files);
  const lines = Object.entries(areas).map(([name, value]) => `${name}=${value}`);
  process.stdout.write((files === null ? 'Changed files unknown: every area runs.' : `${files.length} changed file(s):\n${files.join('\n')}`) + '\n');
  process.stdout.write(lines.join('\n') + '\n');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = Object.entries(areas).map(([name, value]) => `| ${name} | ${value ? 'runs' : 'skipped'} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['| Area | CI |', '|---|---|', ...rows, ''].join('\n'));
  }
}
