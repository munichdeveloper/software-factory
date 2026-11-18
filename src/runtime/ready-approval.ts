import type { BlockLabelEvent, Issue } from '../types.js';
import { readyApprovalSchema, type ReadyApproval } from './contract.js';
import { hash } from '../state/identity.js';
import { untrustedEdit } from '../state/content-trust.js';

/** Native GitHub timeline evidence; neither a comment nor the reconcile caller grants execution. */
export async function authorizeReadyLabel(issue: Issue, events: BlockLabelEvent[], canApprove: (actor: string) => Promise<boolean>,
  trustedActors: string[], expected?: ReadyApproval, rework?: ReadyApproval): Promise<ReadyApproval> {
  if (issue.state !== 'open' || !issue.labels.includes('harness:managed')) throw new Error('READY_APPROVAL_REQUIRED');
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const grant = ordered.filter(e => e.event === 'labeled').at(-1);
  if (!grant) throw new Error('READY_APPROVAL_REQUIRED');
  // A label applied by an App or the Manager itself (e.g. "name[bot]") is a status, never a grant.
  const parsed = readyApprovalSchema.safeParse({ eventId: grant.id, actor: grant.actor, createdAt: grant.createdAt });
  if (!parsed.success || !await canApprove(parsed.data.actor)) throw new Error('READY_ACTOR_NOT_AUTHORIZED');
  const proof = parsed.data;
  // The grant covers the text as it was when the label was applied, and no later change by someone without write access.
  if (untrustedEdit(issue) || untrustedEdit(issue, proof.createdAt)) throw new Error('READY_CONTENT_CHANGED');
  if (expected && hash(proof) !== hash(expected)) throw new Error('READY_APPROVAL_CHANGED');
  const later = ordered.filter(e => e.id > grant.id);
  // The Manager consumes the ready status when moving the same execution to running.
  // A human unlabel, a new grant, or any unknown transition revokes this exact proof.
  const taken = later.length === 1 && later[0]!.event === 'unlabeled' && trustedActors.includes(later[0]!.actor);
  const consumed = expected && taken && issue.labels.includes('harness:running');
  // The grant that admitted an attempt also covers its bounded rework or its retry after a failure: same proof, consumed
  // only by the Manager, and the task still in a status the Manager set for that attempt or its successor.
  const carried = rework && hash(proof) === hash(rework) && taken && ['harness:running', 'harness:failed', 'harness:blocked'].some(l => issue.labels.includes(l));
  if (later.length && !consumed && !carried || !issue.labels.includes('harness:ready') && !consumed && !carried) throw new Error('READY_APPROVAL_REVOKED');
  return proof;
}

/**
 * The grant where `autonomy.startGrant` is `managed-label`: a person with write access applied `harness:managed`, and
 * nobody without write access changed the task text since. A follow-up the Factory itself created and labelled
 * inherits the grant of the task it came from (`origin`), so planned splits run without a further click. The proof is
 * the native timeline event of that label, so it changes only when a person labels the task again.
 */
export async function authorizeManagedLabel(issue: Issue, events: BlockLabelEvent[], canApprove: (actor: string) => Promise<boolean>,
  trustedActors: string[], origin?: () => Promise<ReadyApproval>): Promise<ReadyApproval> {
  if (issue.state !== 'open' || !issue.labels.includes('harness:managed')) throw new Error('MANAGED_GRANT_REQUIRED');
  const grant = [...events].sort((a, b) => a.id - b.id).filter(e => e.event === 'labeled').at(-1);
  if (!grant) throw new Error('MANAGED_GRANT_REQUIRED');
  const parsed = readyApprovalSchema.safeParse({ eventId: grant.id, actor: grant.actor, createdAt: grant.createdAt });
  if (parsed.success && await canApprove(parsed.data.actor)) {
    if (untrustedEdit(issue) || untrustedEdit(issue, parsed.data.createdAt)) throw new Error('MANAGED_CONTENT_CHANGED');
    return parsed.data;
  }
  // Only the Factory's own follow-up, labelled by the Factory, carries its origin's grant over.
  if (!origin || !trustedActors.includes(grant.actor)) throw new Error('MANAGED_ACTOR_NOT_AUTHORIZED');
  if (untrustedEdit(issue)) throw new Error('MANAGED_CONTENT_CHANGED');
  return origin();
}
