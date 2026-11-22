import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { changedFiles, classify } from '../scripts/changed-areas.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), PARENT = 'c'.repeat(40);

describe('classify', () => {
  it('skips everything for documentation and Claude skills only', () => {
    expect(classify(['.claude/skills/software-factory/SKILL.md', 'docs/deploy.md', 'docs/evidence/x/result.json', 'README.md', 'operations/runner/README.md']))
      .toEqual({ code: false, runner: false });
  });
  it('keeps prompts, which the runtime reads', () => {
    expect(classify(['prompts/planner.md'])).toEqual({ code: true, runner: false });
  });
  it('runs code checks for source, tests and runtime operations', () => {
    expect(classify(['docs/a.md', 'src/deploy/index.ts'])).toEqual({ code: true, runner: false });
    expect(classify(['tests/deploy.test.ts'])).toEqual({ code: true, runner: false });
    expect(classify(['operations/temporal-runtime/canary.sh'])).toEqual({ code: true, runner: false });
  });
  it('builds the runner image only when its files change', () => {
    expect(classify(['operations/runner/Dockerfile'])).toEqual({ code: true, runner: true });
  });
  it('runs everything when workflows, the action, dependencies or this filter change', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/software-factory.yml', 'action.yml', 'package.json', 'package-lock.json', 'scripts/changed-areas.mjs']) {
      expect(classify(['docs/a.md', path])).toEqual({ code: true, runner: true });
    }
  });
  it('runs everything when the changes are unknown or empty', () => {
    expect(classify(null)).toEqual({ code: true, runner: true });
    expect(classify([])).toEqual({ code: true, runner: true });
  });
});

describe('changedFiles', () => {
  const git = (calls: string[][]) => (...args: string[]) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? HEAD : PARENT;
    return 'docs/a.md\nsrc/b.ts\n';
  };
  it('diffs a push against the commit before it', () => {
    const calls: string[][] = [];
    expect(changedFiles({ EVENT: 'push', BASE }, git(calls))).toEqual(['docs/a.md', 'src/b.ts']);
    expect(calls.at(-1)).toEqual(['diff', '--name-only', '--no-renames', BASE, HEAD]);
  });
  it('diffs a pull request merge commit against its first parent', () => {
    const calls: string[][] = [];
    changedFiles({ EVENT: 'pull_request', BASE }, git(calls));
    expect(calls.at(-1)).toEqual(['diff', '--name-only', '--no-renames', PARENT, HEAD]);
  });
  it('returns null without a usable base or when git fails', () => {
    expect(changedFiles({ EVENT: 'push', BASE: '0'.repeat(40) }, git([]))).toBeNull();
    expect(changedFiles({ EVENT: 'push' }, git([]))).toBeNull();
    expect(changedFiles({ EVENT: 'workflow_dispatch', BASE: 'not-a-sha' }, git([]))).toBeNull();
    expect(changedFiles({ EVENT: 'push', BASE: HEAD }, git([]))).toBeNull();
    expect(changedFiles({ EVENT: 'push', BASE }, () => { throw new Error('no history'); })).toBeNull();
  });
});
