import type { ContentEdit, Issue } from '../types.js';

/**
 * A task's title and body are what a maintainer approved by applying `harness:managed`. The issue author keeps the
 * right to edit them afterwards, also on public repositories where the author is anyone. A change by a person without
 * write access after the latest approval is therefore no longer approved text.
 * Edits before the approval were seen by the approving maintainer and are not considered.
 */
export function untrustedEdit(issue: Issue, since = issue.managedAt ?? issue.createdAt): ContentEdit | undefined {
  const floor = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
  return issue.contentEdits?.find(e => !e.trusted && !(Date.parse(e.at) <= floor));
}

export const untrustedEditReason = (edit: ContentEdit) =>
  `Task text was changed after its approval by ${edit.actor ? `@${edit.actor}` : 'an unknown account'}, who has no write access`;
