import { expect, it } from 'vitest';
import { currentAutomaticBlock, lastBlockLabelEventId } from '../src/state/blocks.js';
import type { HarnessEvent } from '../src/state/events.js';
import { clock, issue } from './helpers.js';

it('binds provenance to native timeline order, treating IDs as opaque identifiers', () => {
  const task = issue(1, ['harness:managed', 'harness:blocked']);
  task.blockedLabelEvents = [
    { id: 90, event: 'unlabeled', actor: 'github-actions[bot]', createdAt: clock.toISOString() },
    { id: 20, event: 'labeled', actor: 'github-actions[bot]', createdAt: clock.toISOString() }
  ];
  const intent: HarnessEvent = { version: 1, key: 'block:test', at: clock.toISOString(), correlationId: 'test',
    data: { type: 'block_intent', taskVersion: 'a'.repeat(64), cause: 'specification', afterLabelEventId: 90 } };
  expect(lastBlockLabelEventId(task)).toBe(20);
  expect(currentAutomaticBlock(task, [intent], ['github-actions[bot]'])).toEqual(intent.data);
  task.blockedLabelEvents.shift();
  expect(currentAutomaticBlock(task, [intent], ['github-actions[bot]'])).toBeUndefined();
});
