import { changedLines } from './risk.js';
import type { MergeReview, ReviewChange, ReviewInput } from './contract.js';

/**
 * Review of a large pull request in parts (issue #189, Johannes 2026-11-19: "Wenn der Review-Kontext das Limit
 * überschreitet, soll die Factory den PR in Teilen prüfen, statt abzulehnen").
 *
 * A change set whose full review context exceeds `maxContextBytes` is split into at most `maxParts` parts. Every part
 * carries the same frame (instructions, facts, source task) plus an overview of all other changed files (with their
 * patches while they fit, else paths and line counts) and the full content of its own files only. A file that alone does
 * not fit is reviewed by its patch with a wide window of surrounding lines: every changed line stays in context, so this
 * is no truncated approval. Anything that still does not fit is rejected as before.
 */
export const partsLimitError = 'Review needs more parts than allowed';
export const contextLimitError = 'Review context exceeds limit; no truncated approval';
/** Lines of surrounding content kept on each side of a hunk when a single file is too large for one part. */
export const excerptWindow = 200;
/** Parts when merge.review.maxParts is not set. */
export const defaultMaxParts = 4;

/** Size of a review input exactly as the merge manager measures it (comments are never part of a review). */
export const reviewBytes = (input: ReviewInput) => Buffer.byteLength(JSON.stringify({ ...input, facts: { ...input.facts, comments: [] } }));

/** Files that belong together share a key: a module and its test (`x.ts`, `x.test.ts`, `tests/x.spec.ts`). */
const groupKey = (path: string) => (path.split('/').at(-1) ?? path).toLowerCase().replace(/\.(test|spec)(?=\.)/, '').replace(/\..*$/, '');

/** Changed line ranges of one side of a unified diff (`new` for the head, `old` for a removed file's base). */
function hunkRanges(patch: string, side: 'old' | 'new'): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(side === 'new' ? m[3] : m[1]), count = Number((side === 'new' ? m[4] : m[2]) ?? '1');
    ranges.push([Math.max(1, start), Math.max(start, start + count - 1)]);
  }
  return ranges;
}
/**
 * The content around every hunk (±`window` lines), with markers for what is left out. Null when the patch names no hunk,
 * so the caller cannot mistake a missing excerpt for a reviewed one.
 */
export function excerpt(change: ReviewChange, window = excerptWindow): string | null {
  if (change.content === null) return null;
  const ranges = hunkRanges(change.patch, change.status === 'removed' ? 'old' : 'new');
  if (!ranges.length) return null;
  const lines = change.content.split('\n');
  const merged: [number, number][] = [];
  for (const [a, b] of ranges.map(([a, b]) => [Math.max(1, a - window), Math.min(lines.length, b + window)] as [number, number]).sort((x, y) => x[0] - y[0])) {
    const last = merged.at(-1);
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]);
  }
  const out: string[] = []; let next = 1;
  for (const [a, b] of merged) {
    if (a > next) out.push(`[… Zeilen ${next}–${a - 1} nicht enthalten …]`);
    out.push(...lines.slice(a - 1, b)); next = b + 1;
  }
  if (next <= lines.length) out.push(`[… Zeilen ${next}–${lines.length} nicht enthalten …]`);
  return out.join('\n');
}

/**
 * Splits `input` into review parts of at most `maxBytes` each. One part (the unchanged input) when it fits already;
 * throws `partsLimitError` when more than `maxParts` parts would be needed and `contextLimitError` when a single file
 * does not fit even as an excerpt.
 */
export function reviewParts(input: ReviewInput, maxBytes: number, maxParts: number): ReviewInput[] {
  if (reviewBytes(input) <= maxBytes) return [input];
  if (maxParts < 2) throw new Error(contextLimitError);
  const all = input.changes.map(c => ({ path: c.path, status: c.status, lines: changedLines(c.patch), patch: c.patch }));
  const frame = (overview: NonNullable<ReviewInput['part']>['otherFiles']): ReviewInput =>
    ({ ...input, changes: [], part: { index: maxParts, total: maxParts, otherFiles: overview } });
  // The overview keeps every patch only while the frame leaves at least half of a part for full contents.
  const withPatches = reviewBytes(frame(all)) <= maxBytes / 2;
  const overview = withPatches ? all : all.map(({ patch: _patch, ...rest }) => { void _patch; return rest; });
  // The frame with every file in the overview is an upper bound: a part lists only the files it does not contain.
  const budget = maxBytes - reviewBytes(frame(overview));
  if (budget <= 0) throw new Error(contextLimitError);
  const cost = (c: ReviewChange) => Buffer.byteLength(JSON.stringify(c)) + 1;
  const changes = input.changes.map(change => {
    if (cost(change) <= budget) return change;
    const content = excerpt(change);
    const reduced: ReviewChange = { ...change, content, contentScope: 'excerpt' };
    if (content === null || cost(reduced) > budget) throw new Error(contextLimitError);
    return reduced;
  });
  // Groups of related files, kept together where they fit; largest first into the first part with room.
  const groups = new Map<string, ReviewChange[]>();
  for (const change of changes) groups.set(groupKey(change.path), [...groups.get(groupKey(change.path)) ?? [], change]);
  const units = [...groups.values()].flatMap(g => g.reduce((s, c) => s + cost(c), 0) <= budget ? [g] : g.map(c => [c]))
    .sort((a, b) => b.reduce((s, c) => s + cost(c), 0) - a.reduce((s, c) => s + cost(c), 0) || a[0]!.path.localeCompare(b[0]!.path));
  const bins: { used: number; changes: ReviewChange[] }[] = [];
  for (const unit of units) {
    const size = unit.reduce((s, c) => s + cost(c), 0);
    const bin = bins.find(b => b.used + size <= budget);
    if (bin) { bin.used += size; bin.changes.push(...unit); } else bins.push({ used: size, changes: [...unit] });
  }
  if (bins.length > maxParts) throw new Error(partsLimitError);
  const order = new Map(input.changes.map((c, i) => [c.path, i]));
  const parts = bins.map(b => b.changes.sort((x, y) => order.get(x.path)! - order.get(y.path)!))
    .sort((a, b) => order.get(a[0]!.path)! - order.get(b[0]!.path)!)
    .map((own, i, list): ReviewInput => {
      const paths = new Set(own.map(c => c.path));
      return { ...input, changes: own, part: { index: i + 1, total: list.length, otherFiles: overview.filter(f => !paths.has(f.path)) } };
    });
  if (parts.some(p => reviewBytes(p) > maxBytes)) throw new Error(contextLimitError);
  return parts;
}

const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const rank = { merge: 0, update_branch: 1, defer: 2, request_changes: 3 } as const;
/**
 * One verdict from the reviews of all parts of the same head: merge only when every part approves; a rejection or
 * deferral of any part holds for the whole pull request. Findings name their part. `total` counts all planned parts,
 * also those not reviewed because an earlier part already rejected.
 */
export function combineReviews(reviews: MergeReview[], total: number): MergeReview {
  const decision = reviews.reduce<MergeReview['decision']>((d, r) => rank[r.decision] > rank[d] ? r.decision : d, 'merge');
  const approved = reviews.length === total && rank[decision] <= rank.update_branch;
  const head = approved ? `KI-Review in ${total} Teilen, alle freigegeben.`
    : `KI-Review in ${total} Teilen; ${reviews.length < total ? `Teil ${reviews.length} hat nicht freigegeben, die übrigen wurden nicht mehr geprüft.` : 'nicht alle Teile haben freigegeben.'}`;
  const share = Math.floor((3000 - head.length - 2) / reviews.length) - 20;
  const reason = clip([head, ...reviews.map((r, i) => `Teil ${i + 1}/${total} (${r.decision}): ${clip(r.reason, Math.max(50, share))}`)].join('\n'), 3000);
  const findings = reviews.flatMap((r, i) => r.findings.map(f => ({ ...f, explanation: clip(`Teil ${i + 1}/${total}: ${f.explanation}`, 2000) })))
    .sort((a, b) => Number(b.severity === 'blocking') - Number(a.severity === 'blocking')).slice(0, 15);
  return { decision, reason, findings };
}
