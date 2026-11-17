import { describe, expect, it } from 'vitest';
import { failedBeforeAgent } from '../src/runtime/coding-executor.js';
import { statusComment } from '../src/manager/status.js';
import { freeInfrastructureFailures, infrastructureFailureCode, infrastructureFailureSummary, reconstruct } from '../src/state/reconstruct.js';
import { World } from './scenario-world.js';

const step = (name: string, conclusion: string | null) => ({ name, conclusion });
const ok = (name: string) => ({ name, conclusion: 'success', runner_id: 1, steps: [step('Set up job', 'success')] });
const code = (...steps: { name: string; conclusion: string | null }[]) => ({ name: 'code / code', conclusion: 'failure', runner_id: 2, steps });
const harness = (conclusion: string) => step('Run ./.runtime/harness', conclusion);
const setupFailed = [
  '##[end-action id=agent.prepare;outcome=success;conclusion=success;duration_ms=70]',
  "chmod: cannot access '/home/runner/work': No such file or directory",
  '##[end-action id=agent.account;outcome=failure;conclusion=failure;duration_ms=76]',
  '##[end-action id=agent.__openai_codex-action;outcome=skipped;conclusion=skipped;duration_ms=0]',
  '##[end-action id=agent.__run_6;outcome=skipped;conclusion=skipped;duration_ms=0]',
].join('\n');
const agentFailed = [
  '##[end-action id=agent.account;outcome=success;conclusion=success;duration_ms=76]',
  '##[end-action id=agent.__openai_codex-action;outcome=failure;conclusion=failure;duration_ms=90000]',
].join('\n');

describe('a coding run that failed before the agent started', () => {
  it('is recognized from a job GitHub never ran, a setup step before the harness, or a failed harness setup step', async () => {
    const never = async () => { throw new Error('log not needed'); };
    expect(await failedBeforeAgent([{ name: 'code / validate', conclusion: 'failure', runner_id: null, steps: [] }], never)).toBe(true);
    expect(await failedBeforeAgent([ok('code / validate'), code(step('Set up job', 'success'), step('Prepare locked npm dependencies', 'failure'), harness('skipped'))], never)).toBe(true);
    expect(await failedBeforeAgent([ok('code / validate'), code(step('Set up job', 'success'), harness('failure'))], async () => setupFailed)).toBe(true);
  });
  it('counts as an attempt whenever the agent ran or the evidence is missing', async () => {
    const run = [ok('code / validate'), code(step('Set up job', 'success'), harness('failure'))];
    expect(await failedBeforeAgent(run, async () => agentFailed)).toBe(false);
    expect(await failedBeforeAgent(run, async () => null)).toBe(false);
    expect(await failedBeforeAgent(run, async () => 'no markers at all')).toBe(false);
    expect(await failedBeforeAgent([ok('code / validate'), code(step('Set up job', 'success'), harness('success'), step('Run actions/upload-artifact', 'failure'))], async () => setupFailed)).toBe(false);
    expect(await failedBeforeAgent([{ ...ok('code / validate'), conclusion: 'failure', steps: [step('Validate immutable runtime references', 'failure')] }], async () => setupFailed)).toBe(false);
    expect(await failedBeforeAgent([ok('code / validate'), ok('code / code')], async () => setupFailed)).toBe(false);
  });
});

async function failures(count: number, error: string) {
  // A failed run is retried under the grant that admitted it, as long as the budget allows.
  const w = new World({ readyLabel: true }); w.open(1); w.grant(1); await w.tick();
  for (let i = 0; i < count; i++) {
    const id = w.running()[0]!.snapshot.admission.input.executionId;
    await w.finish(id, 'failed', error, infrastructureFailureSummary); await w.tick(); await w.tick();
  }
  const observations = await w.controller.observations([...w.store.rows.keys()]);
  return { w, task: reconstruct({ ...structuredClone(w.github.state), runtimeExecutions: observations, readyIsGrant: true }, w.cfg, w.now)[0]!, cfg: w.cfg };
}

describe('the retry budget', () => {
  it('spends no attempt on runs that failed before the agent started, up to the free allowance', async () => {
    const { task, cfg } = await failures(2, infrastructureFailureCode);
    const ended = task.executions.filter(e => e.result);
    expect(ended).toHaveLength(2);
    expect(ended.every(e => e.infrastructure)).toBe(true);
    // Only the third run, which is running now, is an attempt.
    expect(task.attemptsUsed).toBe(1);
    const text = statusComment({ ...task, executions: ended, latest: ended[1], attemptsUsed: 0 }, cfg, { repository: 'owner/target', readyIsGrant: true });
    expect(text).toContain(`The last run failed before the agent started (\`${infrastructureFailureCode}\`)`);
    expect(text).toContain('costs no attempt (0 of 3 used)');
  });
  it('starts again after each one, and counts them once the allowance is used up, so a setup step that always fails still ends', async () => {
    const { task, w } = await failures(freeInfrastructureFailures + 1, infrastructureFailureCode);
    expect(task.executions.filter(e => e.result)).toHaveLength(freeInfrastructureFailures + 1);
    expect(task.executions.filter(e => e.infrastructure)).toHaveLength(freeInfrastructureFailures);
    // The failure beyond the allowance and the run now started are attempts.
    expect(task.attemptsUsed).toBe(2);
    expect(w.status(1)).toEqual(['running']);
  });
  it('still counts every other failure', async () => {
    const { task } = await failures(3, 'Inspect the scoped executor run');
    expect(task.attemptsUsed).toBe(3);
    expect(task.desiredStatus).toBe('failed');
  });
});
