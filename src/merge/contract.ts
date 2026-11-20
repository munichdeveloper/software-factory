import { z } from 'zod';
import type { Comment } from '../types.js';

/** A Factory pull request the review sent back to a person (no automatic rework, or a decision that needs a human). */
export const needsHumanLabel = 'sf:needs-human';
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
  /** Commits of the current base that the head does not contain; null when unknown. */
  behindBy?: number | null;
}
/**
 * One changed file. `contentScope` 'excerpt': the file alone exceeds a review part, so `content` holds the lines around
 * every hunk (see merge/parts.ts) instead of the whole file; every changed line is still included.
 */
export interface ReviewChange { path: string; status: string; patch: string; content: string | null; contentScope?: 'excerpt' }
export interface ReviewInput { facts: MergeFacts; trustedScope: string; trustedInstructions: string;
  sourceTask?: { number: number; title: string; body: string };
  changes: ReviewChange[];
  /** Set when a large change set is reviewed in parts: which part this is and the pull request's other changed files. */
  part?: { index: number; total: number; otherFiles: { path: string; status: string; lines: number; patch?: string }[] } }
export interface MergeReviewer { review(input: ReviewInput): Promise<MergeReview> }
export interface MergePort {
  readonly repository: string;
  candidates(): Promise<number[]>;
  facts(number: number): Promise<MergeFacts>;
  context(facts: MergeFacts, maxFiles: number, maxBytes: number): Promise<ReviewInput>;
  comment(number: number, body: string): Promise<void>;
  /** Merges the base into the branch while its head is `head`; throws MERGE_CONFLICT when the two conflict. */
  update(number: number, head: string): Promise<string>;
  merge(number: number, head: string, method: 'squash' | 'merge' | 'rebase'): Promise<string>;
  dispatch(workflow: string, ref: string): Promise<void>;
  workflowAvailable(workflow: string): Promise<boolean>;
  canApprove(login: string): Promise<boolean>;
  /** Sets `label` as the pull request's only `sf:risk-*` label (display only; never read as authorization). */
  riskLabel?(number: number, label: string): Promise<void>;
  /** Marks a draft pull request ready for review, only while its head is still `head`. */
  ready?(number: number, head: string): Promise<void>;
  /**
   * Re-runs, once, the failed jobs of first-attempt pull-request workflow runs on `head` that contain one of `checks`.
   * Returns how many runs were re-run.
   */
  rerunFailed?(number: number, head: string, checks: string[]): Promise<number>;
  /**
   * Logins of the authors of the commits `head` adds on top of `from` (the committer where GitHub knows no author account,
   * '' where it knows neither); null when `head` does not contain `from`.
   */
  pushedSince?(from: string, head: string): Promise<string[] | null>;
  /** Adds (`on`) or removes the pull request's `sf:needs-human` label (display and filter only; never read as authorization). */
  needsHuman?(number: number, on: boolean): Promise<void>;
}
