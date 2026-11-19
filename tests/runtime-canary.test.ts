import { describe, expect, it } from 'vitest';
import { assertCanaryConfig, bindCanaryRepository, canaryRepository, runCanary, type CanaryPorts } from '../src/runtime/canary.js';
import { marker, type HarnessEvent } from '../src/state/events.js';
import type { RuntimeObservation } from '../src/runtime/contract.js';
import type { Comment, Issue } from '../src/types.js';
import { taskVersion } from '../src/state/identity.js';
import { config, issue } from './helpers.js';

const bot = 'github-actions[bot]';
const id = 'a'.repeat(32);
/** A scripted acceptance repository: each poll the broker has advanced one step further. */
function world(steps: ((w: World) => void)[]) {
  const cfg = config();
  const w: World = { issues: new Map(), comments: new Map(), observations: [], closed: [], clock: new Date('2026-11-15T00:00:00Z'), cfg };
  const event = (data: HarnessEvent['data']): Comment => ({ id: Math.random(), author: bot, createdAt: w.clock.toISOString(),
    body: `${marker}\n\`\`\`json\n${JSON.stringify({ version: 1, key: `${data.type}:${Math.random()}`, at: w.clock.toISOString(), correlationId: 'c', data })}\n\`\`\`` });
  w.event = (n, data) => { w.comments.set(n, [...(w.comments.get(n) ?? []), event(data)]); };
  let polls = 0;
  const ports: CanaryPorts = {
    openCanaries: async () => [...w.issues.values()].filter(i => i.state === 'open').map(i => i.number),
    createIssue: async (title, body, labels) => { const created: Issue = { ...issue(10 + w.issues.size, labels), title, body }; w.issues.set(created.number, created); return created; },
    getIssue: async n => w.issues.get(n)!,
    comments: async n => w.comments.get(n) ?? [],
    close: async n => { w.closed.push(n); w.issues.get(n)!.state = 'closed'; },
    observations: async ids => w.observations.filter(o => ids.includes(o.executionId)),
    config: async () => cfg,
    now: () => w.clock,
    sleep: async ms => { w.clock = new Date(w.clock.getTime() + ms); steps[polls++]?.(w); },
  };
  return { w, ports };
}
interface World { issues: Map<number, Issue>; comments: Map<number, Comment[]>; observations: RuntimeObservation[]; closed: number[]; clock: Date;
  cfg: ReturnType<typeof config>; event?: (n: number, data: HarnessEvent['data']) => void }
const task = (w: World) => [...w.issues.values()].at(-1)!;
const intent = (w: World) => {
  const t = task(w);
  w.event!(t.number, { type: 'intent', actionId: 'b'.repeat(64), attempt: 0, input: { contractVersion: '1.0', repository: 'owner/target', issueNumber: t.number,
    taskVersion: taskVersion(t), description: t.body, acceptanceCriteria: ['x'], contextReferences: [], executionId: id, allowedActions: ['publish_result'],
    limits: { timeoutMinutes: 10, maxOutputBytes: 16000 }, operation: 'sha256', worker: 'test' } });
};
const run = (w: World) => {
  w.event!(task(w).number, { type: 'temporal_receipt', executionId: id, workflowId: `sf-1-${id}`, runId: '00000000-0000-4000-8000-000000000001', binding: 'd'.repeat(64) });
  w.observations.push({ issueNumber: task(w).number, executionId: id, workflowId: `sf-1-${id}`, runId: '00000000-0000-4000-8000-000000000001', status: 'running',
    phase: 'running', binding: 'd'.repeat(64), createdAt: w.clock.toISOString(), result: null } as RuntimeObservation);
};
const result = (status: 'success' | 'failed', error: string | null = null) => (w: World) => {
  const r = { contractVersion: '1.0' as const, executionId: id, issueNumber: task(w).number, status, summary: 'digest', artifacts: [], error, proposedActions: [] };
  w.event!(task(w).number, { type: 'result', result: r });
  Object.assign(w.observations[0]!, { status: 'completed', phase: 'completed', result: r });
};
const label = (name: string) => (w: World) => { task(w).labels = [...task(w).labels.filter(l => !l.startsWith('harness:') || l === 'harness:managed'), name]; };

describe('deployment canary (software-factory#27)', () => {
  it('passes once one intent, one Temporal run, a successful result and a matching lifecycle exist, and closes the issue', async () => {
    const { w, ports } = world([() => {}, intent, run, result('success'), () => {}, label('harness:awaiting-pr')]);
    w.issues.set(3, { ...issue(3, ['harness:managed', 'sf:canary']) });
    const outcome = await runCanary(ports, { release: 'e'.repeat(40), timeoutMs: 600000 });
    expect(outcome).toMatchObject({ ok: true, stage: 'done', executionId: id });
    // The leftover canary of an earlier deployment is closed first, the new one afterwards.
    expect(w.closed).toEqual([3, outcome.issue]);
    expect(task(w).title).toBe(`Factory canary ${'e'.repeat(12)}`);
    expect(task(w).labels).toEqual(expect.arrayContaining(['harness:managed', 'sf:canary']));
  });
  it('names the stage that did not complete', async () => {
    const none = world([]);
    expect(await runCanary(none.ports, { release: 'e'.repeat(40), timeoutMs: 60000 })).toMatchObject({ ok: false, stage: 'intent', detail: 'No delegation intent was written within 60 s' });
    expect(none.w.closed).toHaveLength(1);
    const noRun = world([intent]);
    expect(await runCanary(noRun.ports, { release: 'e'.repeat(40), timeoutMs: 60000 })).toMatchObject({ ok: false, stage: 'temporal-run' });
    const failed = world([intent, run, result('failed', 'STALE_SNAPSHOT')]);
    expect(await runCanary(failed.ports, { release: 'e'.repeat(40), timeoutMs: 60000 })).toMatchObject({ ok: false, stage: 'result', detail: 'The run ended failed (STALE_SNAPSHOT)' });
    const stale = world([intent, run, result('success')]);
    expect(await runCanary(stale.ports, { release: 'e'.repeat(40), timeoutMs: 60000 })).toMatchObject({ ok: false, stage: 'lifecycle' });
    const twice = world([w => { intent(w); intent(w); }]);
    twice.ports.comments = async n => { const c = twice.w.comments.get(n) ?? []; return c.map((x, i) => i === 1 ? { ...x, body: x.body.replace(id, 'f'.repeat(32)) } : x); };
    expect(await runCanary(twice.ports, { release: 'e'.repeat(40), timeoutMs: 60000 })).toMatchObject({ ok: false, stage: 'intent', detail: '2 intents instead of exactly one' });
  });
  it('asks the App for the installation when none is configured and refuses one that is not allow-listed', async () => {
    const asked: string[] = [];
    const lookup = async (owner: string, repo: string) => { asked.push(`${owner}/${repo}`); return 7; };
    expect(await bindCanaryRepository({ repositoryId: 1, repository: 'o/r' }, '5,7', lookup)).toEqual({ repositoryId: 1, repository: 'o/r', githubInstallationId: 7 });
    expect(asked).toEqual(['o/r']);
    expect(await bindCanaryRepository({ repositoryId: 1, repository: 'o/r', githubInstallationId: 5 }, '5', lookup)).toMatchObject({ githubInstallationId: 5 });
    expect(asked).toHaveLength(1);
    await expect(bindCanaryRepository({ repositoryId: 1, repository: 'o/r' }, '5', lookup)).rejects.toThrow('CANARY_INSTALLATION_NOT_ALLOWLISTED');
    await expect(bindCanaryRepository({ repositoryId: 1, repository: 'o/r', githubInstallationId: 5 }, undefined, lookup)).rejects.toThrow('CANARY_INSTALLATION_NOT_ALLOWLISTED');
  });
  it('is configured through FACTORY_CANARY_REPOSITORY and runs the test worker only', () => {
    expect(canaryRepository(undefined)).toBeNull(); expect(canaryRepository(' ')).toBeNull();
    expect(canaryRepository('{"repositoryId":1,"repository":"o/r","githubInstallationId":2}')).toEqual({ repositoryId: 1, repository: 'o/r', githubInstallationId: 2 });
    expect(canaryRepository('{"repositoryId":1,"repository":"o/r"}')).toEqual({ repositoryId: 1, repository: 'o/r' });
    expect(() => canaryRepository('{"repositoryId":1}')).toThrow();
    const cfg = config();
    expect(assertCanaryConfig(cfg)).toBe(cfg);
    expect(() => assertCanaryConfig({ ...cfg, workers: { ...cfg.workers, coding: { enabled: true } as never } })).toThrow('CANARY_CODING_FORBIDDEN');
    expect(() => assertCanaryConfig({ ...cfg, workers: { ...cfg.workers, test: { ...cfg.workers.test, enabled: false } } })).toThrow('CANARY_TEST_WORKER_DISABLED');
  });
});
