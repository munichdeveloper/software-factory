import { describe, expect, it, vi } from 'vitest';
import { config } from './helpers.js';
import { classifyRisk, builtinCriticalPaths } from '../src/merge/risk.js';

const base = `name: Test
on:
  pull_request:
permissions:
  contents: read
jobs:
  test-backend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${'a'.repeat(40)}
      - run: npm test
      - run: npm run lint
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: echo docs
`;
const wf = (head: string, path = '.github/workflows/test.yml', before = base, status = 'modified') =>
  ({ path, status, patch: '+x\n-y', content: head, baseContent: before });
const assessor = () => ({ assess: vi.fn(async () => ({ class: 'low' as const, reason: 'x', factors: [] })) });
const classify = (head: string, extra: Partial<ReturnType<typeof wf>> = {}) =>
  classifyRisk([{ ...wf(head), ...extra }], config().merge.risk, assessor(), undefined, { requiredChecks: ['test-backend'], validationWorkflow: 'test.yml' });

describe('workflow risk by content', () => {
  it('no longer lists the workflow folder as a built-in critical path', () => {
    expect(builtinCriticalPaths.some(p => p.includes('workflows'))).toBe(false);
  });
  it('rates four neutral env lines (letterflow #46) medium', async () => {
    const head = base.replace('    runs-on: ubuntu-latest\n    steps:\n      - uses', '    runs-on: ubuntu-latest\n    env:\n      A: "1"\n      B: "2"\n      C: "3"\n      D: "4"\n    steps:\n      - uses');
    const a = assessor();
    const record = await classifyRisk([wf(head)], config().merge.risk, a, undefined, { requiredChecks: ['test-backend'], validationWorkflow: 'test.yml' });
    expect(record).toMatchObject({ class: 'medium', source: 'ai' });
  });
  it('allows a move between pinned commits of the same action and added steps', async () => {
    const head = base.replace('a'.repeat(40), 'b'.repeat(40)).replace('  docs:', '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n  docs:');
    expect((await classify(head)).class).toBe('medium');
  });
  it.each([
    ['on changed', base.replace('  pull_request:', '  pull_request_target:'), 'on geändert in test.yml'],
    ['permissions widened', base.replace('contents: read', 'contents: write'), 'permissions geändert in test.yml'],
    ['permissions removed', base.replace('permissions:\n  contents: read\n', ''), 'permissions geändert in test.yml'],
    ['job permissions new', base.replace('  docs:\n    runs-on: ubuntu-latest', '  docs:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write'), 'permissions geändert in test.yml'],
    ['new secret', base.replace('echo docs', 'echo ${{ secrets.TOKEN_X }}'), 'secrets.TOKEN_X'],
    ['new uses', base.replace('  docs:\n    runs-on: ubuntu-latest\n    steps:', '  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: evil/action@v1'), 'uses geändert in test.yml'],
    ['uses to tag', base.replace('actions/checkout@' + 'a'.repeat(40), 'actions/checkout@v4'), 'uses geändert in test.yml'],
    ['required job removed', base.replace(/ {2}test-backend:[\s\S]*?(?= {2}docs:)/, ''), 'Pflicht-Check-Job test-backend'],
    ['required job if', base.replace('  test-backend:\n    runs-on', '  test-backend:\n    if: false\n    runs-on'), 'if/continue-on-error'],
    ['required job continue-on-error', base.replace('  test-backend:\n    runs-on', '  test-backend:\n    continue-on-error: true\n    runs-on'), 'if/continue-on-error'],
    ['required run changed', base.replace('npm test', 'npm test || true'), 'run-Befehl'],
    ['required run removed', base.replace('      - run: npm run lint\n', ''), 'run-Befehl'],
    ['run in validation workflow job', base.replace('echo docs', 'echo changed'), 'run-Befehl']
  ])('is critical: %s', async (_name, head, reason) => {
    const a = assessor();
    const record = await classifyRisk([wf(head)], config().merge.risk, a, undefined, { requiredChecks: ['test-backend'], validationWorkflow: 'test.yml' });
    expect(record).toMatchObject({ class: 'critical', source: 'builtin' });
    expect(record.reason).toContain(reason);
    expect(a.assess).not.toHaveBeenCalled();
  });
  it('does not guard a run change in a job outside the required checks of another workflow', async () => {
    const record = await classifyRisk([wf(base.replace('echo docs', 'echo changed'), '.github/workflows/other.yml')], config().merge.risk, assessor(), undefined,
      { requiredChecks: ['test-backend'], validationWorkflow: 'test.yml' });
    expect(record.class).toBe('medium');
  });
  it('is critical for a Factory wrapper, even for a neutral change', async () => {
    const wrapper = 'name: m\non: workflow_dispatch\njobs:\n  m:\n    uses: munichdeveloper/software-factory/.github/workflows/manager.yml@v1\n';
    const record = await classify(wrapper + '    with:\n      a: 1\n', { path: '.github/workflows/factory-manager.yml', baseContent: wrapper });
    expect(record).toMatchObject({ class: 'critical', source: 'builtin' });
    expect(record.reason).toContain('factory-manager.yml');
  });
  it.each(['added', 'removed', 'renamed'])('is critical for a %s workflow file', async status => {
    expect((await classify(base, { status })).class).toBe('critical');
  });
  it('is critical for unreadable YAML or a missing base', async () => {
    expect((await classify('jobs: [unclosed')).class).toBe('critical');
    expect((await classify(base, { baseContent: 'a: b: c: [' })).class).toBe('critical');
    expect((await classify(base, { baseContent: null })).class).toBe('critical');
  });
  it('keeps the other control files always critical', async () => {
    for (const path of ['.github/actions/x/action.yml', '.github/software-factory.yml', '.github/software-factory.validation.json', 'AGENTS.md', 'CODEOWNERS'])
      expect((await classifyRisk([{ path, status: 'modified', patch: '+a', content: 'x' }], config().merge.risk, assessor())).class).toBe('critical');
  });
});
