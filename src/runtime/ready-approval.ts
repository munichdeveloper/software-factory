import type { BlockLabelEvent, Issue } from '../types.js';
import { readyApprovalSchema, type ReadyApproval } from './contract.js';
import { hash } from '../state/identity.js';

/** Native GitHub timeline evidence; neither a comment nor the reconcile caller grants execution. */
export async function authorizeReadyLabel(issue: Issue, events: BlockLabelEvent[], canApprove: (actor: string) => Promise<boolean>,
  trustedActors: string[], expected?: ReadyApproval): Promise<ReadyApproval> {
  if (issue.state !== 'open' || !issue.labels.includes('harness:managed')) throw new Error('READY_APPROVAL_REQUIRED');
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const grant = ordered.filter(e => e.event === 'labeled').at(-1);
  if (!grant) throw new Error('READY_APPROVAL_REQUIRED');
  const proof = readyApprovalSchema.parse({ eventId: grant.id, actor: grant.actor, createdAt: grant.createdAt });
  if (!await canApprove(proof.actor)) throw new Error('READY_ACTOR_NOT_AUTHORIZED');
  if (expected && hash(proof) !== hash(expected)) throw new Error('READY_APPROVAL_CHANGED');
  const later = ordered.filter(e => e.id > grant.id);
  // The Manager consumes the ready status when moving the same execution to running.
  // A human unlabel, a new grant, or any unknown transition revokes this exact proof.
  const consumed = expected && later.length === 1 && later[0]!.event === 'unlabeled' && trustedActors.includes(later[0]!.actor)
    && issue.labels.includes('harness:running');
  if (later.length && !consumed || !issue.labels.includes('harness:ready') && !consumed) throw new Error('READY_APPROVAL_REVOKED');
  return proof;
}
