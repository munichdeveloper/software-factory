import { describe, expect, it } from 'vitest';
import { untrustedEdit } from '../src/state/content-trust.js';
import { authorizeReadyLabel } from '../src/runtime/ready-approval.js';
import { evaluate } from '../src/policies/engine.js';
import { reconstruct } from '../src/state/reconstruct.js';
import { Manager } from '../src/manager/index.js';
import { MockPlanner, proposal } from '../src/llm/provider.js';
import { clock, config, issue, MemoryGitHub } from './helpers.js';
import type { Issue } from '../src/types.js';

const at = (minutes: number) => new Date(clock.getTime() + minutes * 60000).toISOString();
const approved = (edits: Issue['contentEdits'], labels?: string[]): Issue => ({ ...issue(1, labels), managedAt: at(0), contentEdits: edits });
const stranger = (minutes: number) => ({ actor: 'stranger', at: at(minutes), trusted: false });
const maintainer = (minutes: number) => ({ actor: 'maintainer', at: at(minutes), trusted: true });

describe('approved task text', () => {
  it('ignores edits before the approval and by people with write access', () => {
    expect(untrustedEdit(approved([stranger(-5), maintainer(5)]))).toBeUndefined();
    expect(untrustedEdit(approved([maintainer(5), stranger(6)]))).toEqual(stranger(6));
    // Without any known approval time, every foreign change counts.
    expect(untrustedEdit({ ...issue(), contentEdits: [stranger(-60)] })).toEqual(stranger(-60));
    expect(untrustedEdit(issue())).toBeUndefined();
  });
  it('a ready grant does not cover text a stranger changed after it', async () => {
    const grant = { id: 7, event: 'labeled' as const, actor: 'maintainer', createdAt: at(10) };
    const permission = async (actor: string) => actor === 'maintainer';
    // The maintainer applied harness:managed again after reading the stranger's change.
    expect(await authorizeReadyLabel({ ...approved([stranger(5)]), managedAt: at(6) }, [grant], permission, [])).toMatchObject({ eventId: 7 });
    await expect(authorizeReadyLabel({ ...approved([stranger(11)]) }, [grant], permission, [])).rejects.toThrow('READY_CONTENT_CHANGED');
    await expect(authorizeReadyLabel({ ...approved([stranger(5)]) }, [grant], permission, [])).rejects.toThrow('READY_CONTENT_CHANGED');
    expect(await authorizeReadyLabel(approved([maintainer(11)]), [grant], permission, [])).toMatchObject({ eventId: 7 });
  });
  it('the policy denies work on changed text but still allows cancelling a worker', () => {
    const cfg = config(), github = new MemoryGitHub(); github.state.issues.push(approved([stranger(5)]));
    const task = reconstruct(github.state, cfg, clock)[0]!, ctx = { config: cfg, task, budget: { actions: 0, newIssues: 0, activeWorkers: 0 }, source: 'planner' as const };
    for (const kind of ['start_worker', 'approve_task'] as const) expect(evaluate(proposal(task, kind, 'go'), ctx)).toMatchObject({ outcome: 'deny', reason: expect.stringContaining('@stranger') });
    expect(evaluate(proposal(task, 'cancel_worker', 'stop'), ctx).reason).not.toContain('@stranger');
  });
});
describe('Manager withdraws approval of changed text', () => {
  const run = (github: MemoryGitHub, cfg = config()) => new Manager(github, cfg, new MockPlanner(), { correlationId: 'content', now: () => clock }).run();
  it('removes harness:managed and the ready grant, explains it and starts nothing', async () => {
    const github = new MemoryGitHub(); github.state.issues.push(approved([stranger(5)], ['harness:managed', 'harness:ready', 'bug']));
    const report = await run(github);
    expect(github.state.issues[0]!.labels).toEqual(['bug']);
    expect(github.dispatches).toBe(0);
    expect(github.state.comments.get(1)!.some(c => c.body.includes('approval withdrawn') && c.body.includes('@stranger'))).toBe(true);
    expect(report.blockers.join()).toContain('@stranger');
  });
  it('keeps working on text a maintainer changed', async () => {
    const github = new MemoryGitHub(); github.state.issues.push(approved([maintainer(5)]));
    await run(github); expect(github.dispatches).toBe(1);
  });
  it('only reports in a dry run', async () => {
    const github = new MemoryGitHub(), cfg = config(); cfg.execution.dryRun = true;
    github.state.issues.push(approved([stranger(5)]));
    const report = await run(github, cfg);
    expect(github.state.issues[0]!.labels).toContain('harness:managed'); expect(github.mutations).toEqual([]);
    expect(report.blockers.join()).toContain('@stranger');
  });
});
