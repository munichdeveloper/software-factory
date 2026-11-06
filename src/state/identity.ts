import { createHash } from 'node:crypto';
import type { Action, Issue } from '../types.js';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const taskVersion = (issue: Issue): string => hash({ title: issue.title, body: issue.body });
export function actionId(action: Action, policyVersion: string): string {
  const { reason: _reason, ...semantic } = action;
  void _reason;
  return hash({ action: semantic, policyVersion });
}
export const executionId = (repo: string, issue: Issue, attempt: number): string => hash({ repo, issue: issue.number, version: taskVersion(issue), attempt }).slice(0, 32);
