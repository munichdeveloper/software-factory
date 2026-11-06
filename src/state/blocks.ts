import type { Issue } from '../types.js';
import type { HarnessEvent } from './events.js';

export const lastBlockLabelEventId = (issue: Issue): number => issue.blockedLabelEvents?.at(-1)?.id ?? 0;

export function currentAutomaticBlock(issue: Issue, events: HarnessEvent[], trustedActors: string[]) {
  if (!issue.labels.includes('harness:blocked')) return;
  const changes = issue.blockedLabelEvents ?? [];
  const current = changes.at(-1);
  if (!current || current.event !== 'labeled' || !trustedActors.includes(current.actor)) return;
  // Only the first label change after an intent can belong to that intent.
  // A later remove/reapply (even by a trusted actor) cannot inherit an old origin.
  for (const event of [...events].reverse()) {
    if (event.data.type !== 'block_intent') continue;
    const floor = event.data.afterLabelEventId;
    const boundary = floor === 0 ? -1 : changes.findIndex(change => change.id === floor);
    if (floor !== 0 && boundary === -1) continue; // Incomplete provenance must fail closed.
    const applied = changes[boundary + 1];
    if (applied?.id === current.id) return event.data;
  }
}
