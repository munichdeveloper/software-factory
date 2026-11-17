import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refusedForBilling, RunnerDispenser, RunnerFallback, runnerLabel, type RunnerJob, type RunnerRepositoryPort, type RunnerRun } from '../src/runtime/runners.js';

const refusedJob = (runId: number): RunnerJob => ({ id: runId * 10, runId, status: 'completed', conclusion: 'failure', labels: ['ubuntu-latest'],
  runnerId: null, steps: 0, startedAt: '2026-11-17T15:08:58Z', completedAt: '2026-11-17T15:09:00Z' });
const failedTest = (runId: number): RunnerJob => ({ ...refusedJob(runId), runnerId: 7, steps: 5, completedAt: '2026-11-17T15:12:00Z' });

class FakeRepo implements RunnerRepositoryPort {
  variableValue: { value: string; updatedAt: string } | null = null;
  reruns: number[] = []; sets: (string | null)[] = []; configs = 0;
  runList: RunnerRun[] = []; jobList = new Map<number, RunnerJob[]>(); queued: RunnerRun[] = [];
  constructor(public repositoryId: number, public repository: string, private privateRepo = true, private now = () => new Date()) {}
  async isPrivate() { return this.privateRepo; }
  async variable() { this.variableCalls++; return this.variableValue; }
  async setVariable(value: string | null) { this.sets.push(value); this.variableValue = value === null ? null : { value, updatedAt: this.now().toISOString() }; }
  variableCalls = 0; runsCalls = 0;
  async runs(_since: Date, status?: string) { this.runsCalls++; return status === 'completed' ? this.runList : status === undefined ? [...this.queued, ...this.runList] : []; }
  async jobs(runId: number) { return this.jobList.get(runId) ?? []; }
  async rerunFailedJobs(runId: number) { this.reruns.push(runId); }
  async jitConfig(name: string) { this.configs++; return `jit:${this.repository}:${name}`; }
}
const quiet = { log: () => {} };

describe('refusedForBilling', () => {
  it('recognises a job GitHub never started', () => {
    expect(refusedForBilling(refusedJob(1))).toBe(true);
    expect(refusedForBilling(failedTest(1))).toBe(false);
    expect(refusedForBilling({ ...refusedJob(1), status: 'queued', conclusion: null })).toBe(false);
    expect(refusedForBilling({ ...refusedJob(1), labels: [runnerLabel] })).toBe(false);
    expect(refusedForBilling({ ...refusedJob(1), completedAt: '2026-11-17T15:20:00Z' })).toBe(false);
  });
});

describe('RunnerFallback', () => {
  const now = new Date('2026-11-17T15:10:00Z');
  it('switches every private repository and re-runs the refused runs once', async () => {
    const a = new FakeRepo(1, 'o/a', true, () => now), b = new FakeRepo(2, 'o/b', true, () => now), pub = new FakeRepo(3, 'o/public', false, () => now);
    a.runList = [{ id: 11, status: 'completed', conclusion: 'failure', createdAt: now.toISOString() }, { id: 12, status: 'completed', conclusion: 'failure', createdAt: now.toISOString() }];
    a.jobList.set(11, [refusedJob(11)]); a.jobList.set(12, [failedTest(12)]);
    pub.runList = [{ id: 31, status: 'completed', conclusion: 'failure', createdAt: now.toISOString() }]; pub.jobList.set(31, [refusedJob(31)]);
    const alerts: string[] = [];
    const fallback = new RunnerFallback([a, b, pub], { ...quiet, now: () => now, alerts: { post: async t => { alerts.push(t); } } });
    expect(await fallback.pass()).toBe('switched');
    expect(a.variableValue?.value).toBe(runnerLabel); expect(b.variableValue?.value).toBe(runnerLabel); expect(pub.sets).toEqual([]);
    expect(a.reruns).toEqual([11]);
    expect(alerts).toHaveLength(1);
    expect(await fallback.pass()).toBe('unchanged');
    expect(a.reruns).toEqual([11]);
  });
  it('does nothing without refused jobs', async () => {
    const a = new FakeRepo(1, 'o/a'); a.runList = [{ id: 12, status: 'completed', conclusion: 'failure', createdAt: now.toISOString() }]; a.jobList.set(12, [failedTest(12)]);
    expect(await new RunnerFallback([a], { ...quiet, now: () => now }).pass()).toBe('unchanged');
    expect(a.sets).toEqual([]);
  });
  it('switches back in the next billing month', async () => {
    const a = new FakeRepo(1, 'o/a'); a.variableValue = { value: runnerLabel, updatedAt: '2026-11-17T15:10:00Z' };
    const fallback = new RunnerFallback([a], { ...quiet, now: () => new Date('2026-11-30T23:00:00Z') });
    expect(await fallback.pass()).toBe('unchanged');
    const next = new RunnerFallback([a], { ...quiet, now: () => new Date('2026-12-01T00:05:00Z') });
    expect(await next.pass()).toBe('restored');
    expect(a.variableValue).toBeNull();
  });
  it('keeps a variable a person set to another runner', async () => {
    const a = new FakeRepo(1, 'o/a'); a.variableValue = { value: 'ubuntu-24.04', updatedAt: '2026-10-01T00:00:00Z' };
    expect(await new RunnerFallback([a], { ...quiet, now: () => now }).pass()).toBe('unchanged');
    expect(a.sets).toEqual([]);
  });
});

describe('RunnerDispenser', () => {
  it('hands a configuration to idle slots only while jobs wait', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-runners-'));
    for (const slot of ['1', '2', '3']) await mkdir(join(dir, slot));
    await writeFile(join(dir, '3', 'busy'), '');
    const a = new FakeRepo(1, 'o/a'); a.variableValue = { value: runnerLabel, updatedAt: new Date().toISOString() };
    const dispenser = new RunnerDispenser(new RunnerFallback([a], quiet), dir, () => {});
    expect(await dispenser.pass()).toBe(0);
    a.queued = [{ id: 5, status: 'queued', conclusion: null, createdAt: new Date().toISOString() }];
    a.jobList.set(5, [{ ...refusedJob(5), status: 'queued', conclusion: null, labels: [runnerLabel] }]);
    expect(await dispenser.pass()).toBe(1);
    expect(await readFile(join(dir, '1', 'jitconfig'), 'utf8')).toMatch(/^jit:o\/a:sf-1-/);
    // Slot 1 still holds a configuration for the one waiting job: nothing more is handed out.
    expect(await dispenser.pass()).toBe(0);
    // A second waiting job goes to slot 2, never to the busy slot 3.
    a.queued.push({ id: 6, status: 'queued', conclusion: null, createdAt: new Date().toISOString() });
    a.jobList.set(6, [{ ...refusedJob(6), status: 'queued', conclusion: null, labels: [runnerLabel] }]);
    expect(await dispenser.pass()).toBe(1);
    expect(await readFile(join(dir, '2', 'jitconfig'), 'utf8')).toMatch(/^jit:o\/a:sf-2-/);
    expect(a.configs).toBe(2);
  });
  it('asks GitHub once per switched repository while no job waits, reusing the last pass for the switch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sf-runners-'));
    await mkdir(join(dir, '1'));
    const a = new FakeRepo(1, 'o/a'); a.variableValue = { value: runnerLabel, updatedAt: new Date().toISOString() };
    a.runList = [{ id: 9, status: 'completed', conclusion: 'success', createdAt: new Date().toISOString() }];
    const fallback = new RunnerFallback([a], quiet);
    expect(await fallback.pass()).toBe('unchanged');
    const before = { variable: a.variableCalls, runs: a.runsCalls };
    const dispenser = new RunnerDispenser(fallback, dir, () => {});
    expect(await dispenser.pass()).toBe(0);
    expect(await dispenser.pass()).toBe(0);
    expect(a.variableCalls).toBe(before.variable);
    expect(a.runsCalls - before.runs).toBe(2);
  });
});
