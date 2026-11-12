import type { ValidationReport } from './validation-contract.js';

/**
 * Context the broker adds to a coding request, as plain `contextReferences` strings. The request contract stays
 * unchanged, so an executor release that predates an entry kind simply shows it to the worker as text.
 * Every value is produced by the broker from its own records or from GitHub facts; task text only names candidates.
 */
const sha = /^[a-f0-9]{40}$/, execution = /^[a-f0-9]{32}$/;
export const maxContextRefs = 6;

/** Written by the Manager into the intent of a further attempt: which execution it reworks. */
export const reworkMarker = (previousExecutionId: string) => `urn:sf-rework:${previousExecutionId}`;
export function reworkOf(input: { contextReferences: string[] }): string | null {
  const ids = input.contextReferences.flatMap(r => r.match(/^urn:sf-rework:([a-f0-9]{32})$/)?.[1] ?? []);
  return ids.length === 1 ? ids[0]! : null;
}

// Ref and branch names are echoed into a prompt and a shell-free git call: keep them to an inert alphabet.
const label = (value: string) => value.replace(/[^A-Za-z0-9._/#-]/g, '').slice(0, 200);
export const refEntry = (commit: string, kind: 'branch' | 'commit' | 'pull', name: string) => {
  if (!sha.test(commit)) throw new Error('INVALID_CONTEXT_REF');
  return `sf-context ref ${commit} ${kind} ${label(name)}`;
};
export const unavailableEntry = (kind: 'branch' | 'commit' | 'pull', name: string) => `sf-context unavailable ${kind} ${label(name)}`;
export const reworkEntry = (commit: string, previousExecutionId: string) => {
  if (!sha.test(commit) || !execution.test(previousExecutionId)) throw new Error('INVALID_CONTEXT_REF');
  return `sf-context rework ${commit} ${previousExecutionId}`;
};
/** The repository opted in to a private loopback for the worker's commands; read by the executor workflow. */
export const loopbackEntry = 'sf-context sandbox loopback';
export const failedChecksEntry = (report: ValidationReport) =>
  `sf-context validation-failed ${report.checks.filter(c => c.status === 'failed').map(c => `${c.name}:${c.exitCode ?? 'none'}`).join(', ')}`;

/** Commits the executor fetches before the network is closed; `rework` is the one it also applies to the workspace. */
export function contextCommits(references: string[]): { commit: string; rework: boolean }[] {
  const found = references.flatMap(r => { const m = r.match(/^sf-context (ref|rework) ([a-f0-9]{40})(?: |$)/); return m ? [{ commit: m[2]!, rework: m[1] === 'rework' }] : []; });
  return found.filter((entry, index) => found.findIndex(other => other.commit === entry.commit) === index).slice(0, maxContextRefs + 1);
}

/**
 * Refs of the target repository that the task text names explicitly. Only candidates: the broker resolves each
 * against the repository and never fetches a URL or another repository from task text.
 */
export function namedRefs(text: string): { commits: string[]; pulls: number[]; names: string[] } {
  const unique = <T>(values: T[]) => [...new Set(values)];
  const commits = unique([...text.matchAll(/(?<![A-Za-z0-9])([a-f0-9]{40})(?![A-Za-z0-9])/g)].map(m => m[1]!));
  // "#14", "PR 14", "pull/14", never a number inside a URL: an issue with that number is not a pull request and is skipped by the broker.
  const pulls = unique([...text.matchAll(/(?:(?<![A-Za-z0-9&/])#|(?<![A-Za-z0-9/.-])(?:PR|pull request|pull)[ /#]{1,2})([1-9][0-9]{0,6})\b/gi)].map(m => Number(m[1])));
  // Branch candidates must be quoted as code; whether one is a branch is decided against the repository's branch list.
  const names = unique([...text.matchAll(/`([A-Za-z0-9][A-Za-z0-9._/-]{0,199})`/g)].map(m => m[1]!)
    .filter(n => !n.includes('..') && !n.includes('//') && !n.endsWith('/') && !n.endsWith('.lock') && !sha.test(n)));
  return { commits: commits.slice(0, 20), pulls: pulls.slice(0, 20), names: names.slice(0, 200) };
}

/**
 * The tail of one failed check's output as bounded, inert pieces. It is untrusted program output: control
 * characters and terminal sequences are removed and every piece is labelled as output, never mixed with broker text.
 */
export function outputEntries(check: string, output: string, limit = 2700): string[] {
  const escape = String.fromCharCode(27), printable = (c: string) => c === '\n' || c === '\t' || c >= ' ' && c !== String.fromCharCode(127);
  const plain = [...output.replace(new RegExp(`${escape}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '').replace(/\r\n?/g, '\n')].filter(printable).join('')
    .split('\n').map(line => line.trimEnd()).filter((line, index, lines) => line || lines[index - 1]).join('\n').trim();
  if (!plain || !/^[a-z-]{1,30}$/.test(check)) return [];
  const tail = plain.slice(-limit), size = 900, count = Math.ceil(tail.length / size);
  return Array.from({ length: count }, (_, i) => `sf-context validation-output ${check} ${i + 1}/${count}: ${tail.slice(i * size, (i + 1) * size)}`);
}
