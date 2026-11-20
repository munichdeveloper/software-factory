import { expect, it } from 'vitest';
import { BrokerLife, WorkerWatch, type BrokerLifeStore } from '../src/runtime/broker-health.js';

const sink = () => { const posts: string[] = []; return { posts, post: async (_channel: string, text: string) => { posts.push(text); } }; };

class MemoryLife implements BrokerLifeStore {
  row: { instance: string; startedAt: Date; seenAt: Date; ended: boolean } | null = null;
  async brokerStarted(instance: string, at: Date) {
    const previous = this.row;
    this.row = { instance, startedAt: at, seenAt: at, ended: false };
    return previous && !previous.ended ? { startedAt: previous.startedAt, seenAt: previous.seenAt } : null;
  }
  async brokerAlive(instance: string, at: Date) { if (this.row?.instance === instance) this.row.seenAt = at; }
  async brokerStopped(instance: string) { if (this.row?.instance === instance) this.row.ended = true; }
}

it('reports a start after a crash, not after a clean shutdown', async () => {
  const store = new MemoryLife(), slack = sink();
  const first = new BrokerLife(store, 'a', slack, 'C1');
  await first.start(new Date('2026-11-20T10:00:00Z'));
  await first.stopped();
  const second = new BrokerLife(store, 'b', slack, 'C1');
  await second.start(new Date('2026-11-20T11:00:00Z'));
  expect(slack.posts).toEqual([]);
  await store.brokerAlive('b', new Date('2026-11-20T15:15:00Z'));
  // b dies of an OOM: no stopped() call.
  const third = new BrokerLife(store, 'c', slack, 'C1');
  await third.start(new Date('2026-11-20T15:16:30Z'));
  await second.stopped(); await third.stopped();
  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0]).toContain('seit 2026-11-20 11:00 UTC');
  expect(slack.posts[0]).toContain('15:15 UTC');
});

it('starts even when the store fails', async () => {
  const life = new BrokerLife({ brokerStarted: () => Promise.reject(new Error('down')), brokerAlive: async () => {}, brokerStopped: async () => {} }, 'x');
  await expect(life.start()).resolves.toBeUndefined();
  await life.stopped();
});

it('announces a task queue no worker polls once, and its return', async () => {
  const slack = sink(), t0 = Date.parse('2026-11-20T15:00:00Z');
  let polls: Date[] = [new Date(t0)];
  let failing = false;
  const watch = new WorkerWatch(async () => { if (failing) throw new Error('UNAVAILABLE'); return polls; }, () => ['q', 'q'], slack, 'C1');
  await watch.check(new Date(t0 + 60000));
  polls = [];
  await watch.check(new Date(t0 + 9 * 60000));
  expect(slack.posts).toEqual([]);
  await watch.check(new Date(t0 + 11 * 60000));
  await watch.check(new Date(t0 + 12 * 60000));
  failing = true;
  await watch.check(new Date(t0 + 13 * 60000));
  expect(slack.posts).toHaveLength(1);
  expect(slack.posts[0]).toContain('seit 11 Minuten');
  failing = false; polls = [new Date(t0 + 14 * 60000)];
  await watch.check(new Date(t0 + 14 * 60000));
  expect(slack.posts).toHaveLength(2);
  expect(slack.posts[1]).toContain('wieder da');
});

it('stays silent for a queue Temporal never listed a poller for', async () => {
  const slack = sink();
  const watch = new WorkerWatch(async () => [], () => ['q'], slack, 'C1');
  await watch.check(new Date(Date.now() + 3600000));
  expect(slack.posts).toEqual([]);
});
