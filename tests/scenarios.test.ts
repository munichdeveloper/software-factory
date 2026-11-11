import { describe, expect, it } from 'vitest';
import { World, bot, type Tick, type WorldOptions } from './scenario-world.js';

/**
 * Rules that must hold once the surroundings are healthy again and the Manager had time to reconcile.
 * They describe the lifecycle as a whole; every sequence of events below is checked against them.
 */
async function settle(world: World): Promise<string[]> {
  world.temporalDown = false; world.timelineDown = false; world.github.failWrites = 0;
  // Reconcile until nothing changes any more. Chains such as cancel, fail, retry, start take one run per link;
  // the total exceeds the dispatch grace period, so everything that can resolve itself has resolved.
  let fixpoint: Tick = {}, quiet = 0, statusWrites = 0;
  for (let i = 0; i < 40 && quiet < 2; i++) {
    statusWrites = world.github.statusWrites;
    world.advance(1); fixpoint = await world.tick();
    if (fixpoint.thrown) return [`reconciliation rejects in a healthy environment: ${fixpoint.thrown}`];
    quiet = i >= 11 && !fixpoint.report!.decisions.some(d => d.executed) ? quiet + 1 : 0;
  }
  const violations: string[] = [];
  if (quiet < 2) violations.push('reconciliation does not come to rest within 40 runs');
  if (world.github.statusWrites !== statusWrites) violations.push('a status comment was rewritten although nothing changed');
  const report = fixpoint.report!;
  const running = world.running();
  const max = world.cfg.execution.maxParallelWorkers;

  for (const issue of world.github.state.issues) {
    const events = world.events(issue.number);
    const intents = events.filter(e => e.type === 'intent');
    const ids = intents.map(e => e.type === 'intent' ? e.input.executionId : '');
    // An intent is never duplicated and always ends: it is running in Temporal or has a journaled result.
    if (new Set(ids).size !== ids.length) violations.push(`#${issue.number}: duplicate intent`);
    for (const id of ids) {
      const done = events.some(e => e.type === 'result' && e.result.executionId === id);
      const live = running.some(r => r.snapshot.admission.input.executionId === id);
      if (!done && !live) violations.push(`#${issue.number}: intent ${id} has neither a running workflow nor a result`);
      if (done && live) violations.push(`#${issue.number}: intent ${id} has a result while its workflow is still running`);
    }
    // A closed task holds no worker and is never started again.
    if (issue.state === 'closed' && running.some(r => r.snapshot.admission.input.issueNumber === issue.number)) violations.push(`#${issue.number}: closed task still runs`);
    // One readable status comment at most, and it names the lifecycle status the task has.
    const comments = world.statusComments(issue.number);
    if (comments.length > 1) violations.push(`#${issue.number}: ${comments.length} status comments`);
    if (comments.length && !comments[0]!.includes(`\`${world.status(issue.number)[0]}\``)) violations.push(`#${issue.number}: status comment does not match ${world.status(issue.number)[0]}`);
    // Exactly one lifecycle status.
    if (world.status(issue.number).length !== 1) violations.push(`#${issue.number}: ${world.status(issue.number).length} lifecycle labels`);
    // In ready-label mode only a person grants execution, and only a person ever applies the label.
    if (world.options.readyLabel && world.github.readyFor(issue.number).some(e => e.event === 'labeled' && e.actor === bot)) violations.push(`#${issue.number}: the Manager applied harness:ready itself`);
    if (world.options.readyLabel) for (const row of world.store.rows.values()) {
      if (row.snapshot.admission.input.issueNumber === issue.number && row.snapshot.readyApproval?.actor === bot) violations.push(`#${issue.number}: run admitted on the Manager's own label`);
    }
  }
  // Nothing is ever left as an unknown outcome once the runtime answers.
  for (const blocker of report.blockers) if (blocker.includes('uncertain')) violations.push(`unresolved uncertainty: ${blocker}`);
  if (report.errors.length) violations.push(`errors in a healthy environment: ${report.errors.join(' | ')}`);
  // The fixpoint: a further reconciliation changes nothing.
  for (const d of report.decisions) if (d.executed) violations.push(`not a fixpoint: ${d.action.kind} #${d.action.issueNumber} ${d.action.status ?? ''} executed again`);
  // A free worker slot is used: nothing waits behind a slot that no running workflow occupies.
  for (const d of report.decisions) {
    if (d.decision.reason === 'Maximum parallel workers reached' && running.length < max) violations.push(`#${d.action.issueNumber}: denied a free worker slot (${running.length}/${max} running)`);
    if (!['start_worker', 'retry_worker'].includes(d.action.kind) || d.decision.outcome !== 'allow') continue;
    const number = d.action.issueNumber, issue = world.issue(number);
    const rejected = report.blockers.find(b => b.startsWith(`#${number}: runtime admission rejected`));
    if (!rejected) { violations.push(`#${number}: allowed ${d.action.kind} neither started nor explained`); continue; }
    // A person's grant that is still in place must be honoured.
    const grant = world.github.readyFor(number).at(-1);
    if (world.options.readyLabel && issue.labels.includes('harness:ready') && grant?.event === 'labeled' && grant.actor === 'maintainer') violations.push(`#${number}: a standing human grant was rejected: ${rejected}`);
  }
  return violations;
}
const healthy = async (world: World) => expect(await settle(world), world.log.join('\n')).toEqual([]);
const execution = (world: World, number: number) => world.running().find(r => r.snapshot.admission.input.issueNumber === number)!.snapshot.admission.input.executionId;

describe('lifecycle scenarios', () => {
  it('runs a managed task without a gate from intake to its result', async () => {
    const w = new World(); w.open(1);
    await w.tick(); await w.tick();
    expect(w.status(1)).toEqual(['running']);
    await w.finish(execution(w, 1));
    await w.tick();
    expect(w.status(1)).toEqual(['awaiting-pr']);
    await healthy(w);
  });
  it('waits for a person in ready-label mode and starts on the grant', async () => {
    const w = new World({ readyLabel: true }); w.open(1);
    await w.tick(); await w.tick();
    expect(w.running()).toEqual([]);
    await healthy(w);
    w.grant(1); await w.tick();
    expect(w.status(1)).toEqual(['running']);
    await healthy(w);
  });
  it('tells a person on the issue what the task is waiting for', async () => {
    const w = new World({ readyLabel: true }); w.open(1);
    await w.tick();
    expect(w.statusComments(1)).toHaveLength(1);
    expect(w.statusComments(1)[0]).toContain('waiting for the grant');
    expect(w.statusComments(1)[0]).toContain('applies the label `harness:ready`');
    w.grant(1); await w.tick();
    expect(w.statusComments(1)).toHaveLength(1);
    expect(w.statusComments(1)[0]).toContain('A worker is running.');
    await w.finish(execution(w, 1), 'blocked'); await w.tick(); await w.tick();
    expect(w.statusComments(1)[0]).toContain('The last run ended blocked.');
    expect(w.statusComments(1)[0]).not.toContain('Worker blocked'); // the worker's own summary is never repeated
    await healthy(w);
  });
  it('holds a task at the human gate until it is approved', async () => {
    const w = new World({ humanGate: true }); w.open(1);
    await w.tick(); await w.tick();
    expect(w.status(1)).toEqual(['awaiting-approval']);
    await w.approve(execution(w, 1)); await w.tick();
    expect(w.status(1)).toEqual(['running']);
    await healthy(w);
  });
  it('works through a queue with one worker slot, including a task closed while it waited', async () => {
    const w = new World(); w.open(1); w.open(2); w.open(3);
    await w.tick();
    expect(w.running()).toHaveLength(1);
    w.close(2);
    await w.finish(execution(w, 1)); await w.tick(); await w.tick();
    expect(w.status(3)).toEqual(['running']);
    await healthy(w);
  });
  it('recovers a start that never reached Temporal, also after the task was closed', async () => {
    const w = new World(); w.open(1); w.open(2);
    w.temporalDown = true; await w.tick();
    w.close(1);
    await healthy(w);
    expect(w.status(2)).toEqual(['running']);
  });
  it('survives a GitHub outage at every write of a start', async () => {
    for (let failAt = 0; failAt < 8; failAt++) {
      const w = new World({ readyLabel: true }); w.open(1); w.grant(1);
      // The first `failAt` writes succeed, then one fails.
      const original = w.github.failWrites; let writes = 0;
      const guard = <A extends unknown[]>(method: (...args: A) => Promise<void>) => async (...args: A) => { if (writes++ === failAt) w.github.failWrites = 1; return method.apply(w.github, args); };
      w.github.writeEvent = guard(w.github.writeEvent); w.github.updateIssue = guard(w.github.updateIssue);
      await w.tick(); w.github.failWrites = original;
      await healthy(w);
      expect(w.running().length + w.events(1).filter(e => e.type === 'result').length, `write ${failAt}`).toBeGreaterThan(0);
    }
  });
  it('ends a run cleanly when the task is revised or closed underneath it', async () => {
    for (const change of ['revise', 'close'] as const) {
      const w = new World(); w.open(1); await w.tick();
      const id = execution(w, 1);
      w[change](1);
      await w.finish(id);
      await healthy(w);
    }
  });
});

/** Deterministic pseudo-random numbers so that every failing sequence can be replayed from its seed. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export async function explore(options: WorldOptions, seed: number, steps: number) {
  const next = random(seed), pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
  const world = new World(options); let issues = 0;
  for (let step = 0; step < steps; step++) {
    const numbers = world.github.state.issues.map(i => i.number), running = world.running();
    const roll = next();
    if (roll < 0.30) { world.advance(pick([1, 3, 12])); await world.tick(); }
    else if (roll < 0.38 && issues < 4) world.open(++issues);
    else if (!numbers.length) continue;
    else if (roll < 0.50) world.grant(pick(numbers), next() < 0.9 ? 'maintainer' : 'stranger');
    else if (roll < 0.60 && running.length) await world.finish(pick(running).snapshot.admission.input.executionId, pick(['success', 'blocked', 'failed'] as const));
    else if (roll < 0.64 && running.length) world.crash(pick(running).snapshot.admission.input.executionId);
    else if (roll < 0.70) world.revise(pick(numbers));
    else if (roll < 0.75) world.close(pick(numbers));
    else if (roll < 0.78) { const n = pick(numbers); if (world.issue(n).state === 'closed') world.reopen(n); }
    else if (roll < 0.83) { const n = pick(numbers); if (world.issue(n).labels.includes('harness:blocked')) world.unblock(n); }
    else if (roll < 0.88 && running.length && options.humanGate) await world.approve(pick(running).snapshot.admission.input.executionId);
    else if (roll < 0.92) world.temporalDown = !world.temporalDown;
    else if (roll < 0.95) world.timelineDown = !world.timelineDown;
    else world.github.failWrites = pick([1, 1, 2]);
  }
  return { world, violations: await settle(world) };
}

/** Number of random sequences per mode; raise SF_SCENARIO_SEEDS for a deeper search. */
const seeds = Number(process.env.SF_SCENARIO_SEEDS ?? 150);
describe('lifecycle rules hold for arbitrary sequences of events', () => {
  const modes: [string, WorldOptions][] = [
    ['no gate', {}], ['ready label', { readyLabel: true }], ['human gate', { humanGate: true }], ['two workers, ready label', { readyLabel: true, maxParallelWorkers: 2 }],
  ];
  for (const [name, options] of modes) it(name, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const { world, violations } = await explore(options, seed, 40 + seed % 30);
      if (violations.length) failures.push(`seed ${seed}: ${violations.join('; ')}\n${failures.length ? '' : world.log.join('\n')}`);
    }
    expect(failures.slice(0, 5), `${failures.length} of ${seeds} sequences violate a rule`).toEqual([]);
  }, 120000 + seeds * 400);
});
