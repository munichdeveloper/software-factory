import { z } from 'zod';
import { actionKinds } from './config/index.js';

export const statuses = ['backlog', 'ready', 'running', 'awaiting-pr', 'awaiting-approval', 'blocked', 'failed', 'done'] as const;
export const statusSchema = z.enum(statuses);
export type Status = z.infer<typeof statusSchema>;
export const followupSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,99}$/), title: z.string().min(3).max(200),
  context: z.string().min(1).max(4000), goal: z.string().min(1).max(2000),
  acceptanceCriteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
  dependencies: z.array(z.number().int().positive()).max(20), expandsScope: z.boolean()
});
// All fields are required and nullable where inapplicable, including for OpenAI strict output.
export const actionSchema = z.strictObject({
  kind: z.enum(actionKinds), issueNumber: z.number().int().positive(), taskVersion: z.string().regex(/^[a-f0-9]{64}$/),
  status: statusSchema.nullable(), priority: z.enum(['high', 'normal', 'low']).nullable(), attempt: z.number().int().min(0).max(5).nullable(),
  followup: followupSchema.nullable(), reason: z.string().min(1).max(2000)
});
export const planSchema = z.strictObject({ version: z.literal(1), actions: z.array(actionSchema).max(100) });
export type Action = z.infer<typeof actionSchema>;
export type Plan = z.infer<typeof planSchema>;
export interface BlockLabelEvent { id: number; event: 'labeled' | 'unlabeled'; actor: string; createdAt: string }
export interface Issue { number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; updatedAt: string; reopenedAt?: string; blockedLabelEvents?: BlockLabelEvent[] }
export interface Comment { id: number; body: string; author: string; createdAt: string }
export interface PullRequest { number: number; state: 'open' | 'closed'; merged: boolean; mergedAt?: string; closingIssues: number[]; referencedIssues: number[] }
export interface WorkflowRun { id: number; title: string; status: string; conclusion: string | null; createdAt: string; url: string }
export interface Snapshot { issues: Issue[]; comments: Map<number, Comment[]>; prs: PullRequest[]; runs: WorkflowRun[]; defaultBranch: string; dependencyStates: Map<number, boolean> }
export type Decision = { outcome: 'allow' | 'deny' | 'approval'; reason: string; actionId: string };
