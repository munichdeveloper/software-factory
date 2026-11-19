/**
 * Tasks the coding worker cannot do: it never edits `.github/` (CI workflows), agent instruction files or CODEOWNERS
 * (`validateChanges`, and the App token has no `workflows: write`). A task whose text asks for such a change is not
 * started; a maintainer makes that part first or takes it out of the task (controla#123: 16 merge reviews of a pull
 * request whose CI job the worker was not allowed to add).
 *
 * The check is deliberately plain text matching, without a model: it runs on every reconciliation and costs nothing.
 */
const pathPatterns: RegExp[] = [
  // `.github`, `.github/workflows/test.yml`, `.gitmodules`; `.gitignore`/`.gitattributes` are ordinary files (controla#124).
  /(?<![\w.-])\.git(?:hub|modules)(?:\/[\w./*-]*)?(?![\w-])/gi,
  /(?<![\w.-])\.(?:codex|agents|squad|copilot|claude)\/[\w./*-]*/gi,
  /(?<![\w.-])(?:AGENTS\.md|CODEOWNERS)(?![\w.-])/gi
];
/** Asking for a new CI job or workflow means editing `.github/workflows`, even where the task names only `test.yml`. */
const ciPatterns: RegExp[] = [
  /\b(?:neue[nrs]?|eigene[nrs]?|zusätzliche[nrs]?|separate[nrs]?|weitere[nrs]?)\s+(?:CI|GitHub[- ]Actions)[- ](?:Job|Workflow)s?\b/gi,
  /\b(?:new|separate|dedicated|additional|own)\s+(?:CI|GitHub Actions)[- ](?:job|workflow)s?\b/gi,
  /\b(?:add|create|extend|change|modify|edit)(?:s|ing)?\s+(?:a\s+|an\s+|the\s+)?(?:CI|GitHub Actions)[- ](?:job|workflow)s?\b/gi
];
/** Sections and lines that say what the task does NOT include are no request. */
const outOfScopeHeading = /^#{1,6}\s*(?:Nicht enthalten|Nicht Teil|Außerhalb des Umfangs|Out of scope|Not in scope|Non-goals|Not included)\b/i;
const outOfScopeLine = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Nicht enthalten|Nicht Teil|Out of scope|Not in scope|Not included)\b/i;
/** A line that forbids or only points at such a path ("Keine Änderungen an `.github/`", "`AGENTS.md` beachten") asks for no change. */
const prohibitionLine = /(?<![\p{L}\d_])(?:nicht ändern|nicht anfassen|nicht verändern|keine (?:Änderungen|Änderung)|unverändert|ändern wir|ergänzen wir|von Hand|beachten|befolgen|do not (?:change|edit|touch|modify)|don't (?:change|edit|touch|modify)|must not (?:change|edit|touch|modify)|never (?:change|edit|touch|modify)|no changes? (?:to|in)|leave [^.]* unchanged|follow)(?![\p{L}\d_])/iu;

function inScope(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) skipping = outOfScopeHeading.test(line);
    if (!skipping && !outOfScopeLine.test(line) && !prohibitionLine.test(line)) kept.push(line);
  }
  return kept.join('\n');
}

/** The protected paths or CI changes a task text asks for, in order of appearance (at most five). */
export function protectedPathRequests(text: string): string[] {
  const scoped = inScope(text);
  const found: { at: number; value: string }[] = [];
  for (const pattern of [...pathPatterns, ...ciPatterns]) for (const m of scoped.matchAll(pattern)) found.push({ at: m.index, value: m[0] });
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at).map(f => f.value).filter(v => !seen.has(v.toLowerCase()) && !!seen.add(v.toLowerCase())).slice(0, 5);
}

export const protectedPathBlockPrefix = 'Task requires changes to protected paths';
export function protectedPathBlockReason(title: string, body: string): string | undefined {
  const found = protectedPathRequests(`${title}\n${body}`);
  return found.length ? `${protectedPathBlockPrefix} the coding worker may not edit (${found.map(f => `\`${f.replaceAll('`', '')}\``).join(', ')})` : undefined;
}

/** Error code a coding worker reports with `blocked` when the task needs a protected path. */
export const protectedPathErrorCode = 'PROTECTED_PATH_REQUIRED';
const refusal = /\b(?:not allowed|may not|must not|cannot|can't|can not|unable to|forbidden|protected|darf nicht|dürfen nicht|nicht erlaubt|geschützt)\b/i;
/**
 * A coding result that ended blocked because the change needs a protected path. Its passed validation is no evidence
 * of a complete change, so the run stays blocked instead of counting as successful.
 */
export function blockedOnProtectedPath(result: { status: string; summary: string; error: string | null }): boolean {
  if (result.status !== 'blocked') return false;
  if (result.error?.includes(protectedPathErrorCode)) return true;
  const text = `${result.summary}\n${result.error ?? ''}`;
  return refusal.test(text) && pathPatterns.some(p => { p.lastIndex = 0; return p.test(text); });
}
