import { z } from 'zod';
import type { Comment } from '../types.js';

export const mergeReviewSchema = z.strictObject({ decision: z.enum(['merge', 'update_branch', 'request_changes', 'defer']),
  reason: z.string().min(1).max(3000), findings: z.array(z.strictObject({
    path: z.string().max(500), severity: z.enum(['blocking', 'warning']), explanation: z.string().min(1).max(2000)
  })).max(15) });
export type MergeReview = z.infer<typeof mergeReviewSchema>;
export interface MergeFacts {
  number: number; title: string; body: string; head: string; base: string; headBranch: string; baseBranch: string;
  state: string; draft: boolean; sameRepository: boolean; labels: string[]; mergeState: string; reviewDecision: string | null;
  unresolvedThreads: string[]; checks: { name: string; state: string }[];
  mergeSha: string | null; mergeActorType: string | null;
  strictChecks: boolean; nativeRequiredChecks: string[]; comments: Comment[];
}
export interface ReviewInput { facts: MergeFacts; trustedScope: string; trustedInstructions: string;
  sourceTask?: { number: number; title: string; body: string };
  changes: { path: string; status: string; patch: string; content: string | null }[] }
export interface MergeReviewer { review(input: ReviewInput): Promise<MergeReview> }
export interface MergePort {
  readonly repository: string;
  candidates(): Promise<number[]>;
  facts(number: number): Promise<MergeFacts>;
  context(facts: MergeFacts, maxFiles: number, maxBytes: number): Promise<ReviewInput>;
  comment(number: number, body: string): Promise<void>;
  update(number: number, head: string): Promise<string>;
  merge(number: number, head: string, method: 'squash' | 'merge' | 'rebase'): Promise<string>;
  dispatch(workflow: string, ref: string): Promise<void>;
  workflowAvailable(workflow: string): Promise<boolean>;
  canApprove(login: string): Promise<boolean>;
}
