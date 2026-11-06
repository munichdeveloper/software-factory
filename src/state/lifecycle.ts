import type { Issue, Status } from '../types.js';
import { statuses } from '../types.js';

export const managedLabel = 'harness:managed';
export const lifecycleLabels = statuses.map(s => `harness:${s}`);
export const priorityLabels = ['harness:priority-high', 'harness:priority-normal', 'harness:priority-low'];
export const allLabels = [managedLabel, ...lifecycleLabels, ...priorityLabels];
const transitions: Record<Status, readonly Status[]> = {
  backlog: ['ready', 'running', 'failed', 'awaiting-pr', 'blocked', 'awaiting-approval', 'done'],
  ready: ['running', 'failed', 'blocked', 'awaiting-approval', 'awaiting-pr', 'done', 'backlog'],
  running: ['awaiting-pr', 'failed', 'blocked', 'awaiting-approval', 'done'],
  'awaiting-pr': ['running', 'failed', 'blocked', 'done', 'backlog', 'ready', 'awaiting-approval'],
  'awaiting-approval': ['ready', 'running', 'blocked', 'backlog', 'done', 'awaiting-pr', 'failed'],
  blocked: ['ready', 'running', 'backlog', 'awaiting-approval', 'failed', 'done', 'awaiting-pr'],
  failed: ['running', 'ready', 'blocked', 'awaiting-approval', 'done', 'awaiting-pr'],
  done: ['backlog']
};
export const issueStatus = (issue: Issue): Status | undefined => statuses.find(s => issue.labels.includes(`harness:${s}`));
export const canTransition = (from: Status | undefined, to: Status): boolean => from === undefined || from === to || transitions[from].includes(to);
export function withStatus(issue: Issue, to: Status): string[] {
  if (!canTransition(issueStatus(issue), to)) throw new Error(`Invalid lifecycle transition ${issueStatus(issue)} -> ${to}`);
  return [...issue.labels.filter(l => !lifecycleLabels.includes(l)), `harness:${to}`];
}
export function dependencies(body: string): number[] {
  const lines = body.match(/^Depends on:\s*.+$/gim) ?? [];
  return [...new Set(lines.flatMap(line => [...line.matchAll(/#(\d+)/g)].map(m => Number(m[1]))))];
}
export function acceptanceCriteria(body: string): string[] {
  const section = body.match(/^#{1,3}\s+(?:Acceptance criteria|Akzeptanzkriterien)\s*\r?\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/im)?.[1] ?? '';
  return section.split(/\r?\n/).map(l => l.replace(/^\s*[-*]\s*(?:\[[ x]\]\s*)?/i, '').trim()).filter(Boolean).slice(0, 20);
}
