import type { Comment, Issue, Snapshot, WorkflowRun } from '../types.js';
import type { HarnessEvent } from '../state/events.js';

export interface GitHubPort {
  readonly repository: string;
  readConfig(path: string): Promise<string>;
  snapshot(workflow: string): Promise<Snapshot>;
  getIssue(number: number): Promise<Issue>;
  comments(number: number): Promise<Comment[]>;
  canApprove(login: string): Promise<boolean>;
  writeEvent(issue: number, event: HarnessEvent): Promise<void>;
  updateIssue(issue: number, update: { labels?: string[]; state?: 'open' | 'closed' }): Promise<void>;
  createIssue(title: string, body: string, labels: string[]): Promise<Issue>;
  bootstrap(): Promise<string[]>;
  dispatch(workflow: string, ref: string, executionId: string, issue: number): Promise<void>;
  runs(workflow: string): Promise<WorkflowRun[]>;
  cancelRun(id: number): Promise<void>;
}
