import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

/** A changed file as the workflow rules need it: `content` is the head, `baseContent` the base version. */
export interface WorkflowChange { path: string; status?: string; content?: string | null; baseContent?: string | null }

/** `.github/workflows/*.yml|yaml`: the workflows themselves. */
export const isWorkflowFile = (path: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path);
const inWorkflowFolder = (path: string) => /^\.github\/workflows\//i.test(path);
const factoryWrapper = /^\s*-?\s*uses:\s*['"]?munichdeveloper\/software-factory[/@'"\s]/im;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const rank = (v: unknown) => v === 'write' ? 2 : v === 'read' ? 1 : 0;
const sha = /^[0-9a-f]{40}$/i;

function load(text: string | null | undefined): Obj {
  if (typeof text !== 'string') throw new Error('no content');
  const doc: unknown = parse(text);
  if (!isObj(doc) || !isObj(doc.jobs)) throw new Error('not a workflow');
  return doc;
}
const triggers = (doc: Obj) => 'on' in doc ? doc.on : doc['true'];
const jobsOf = (doc: Obj): Record<string, Obj> => Object.fromEntries(Object.entries(doc.jobs as Obj).filter((e): e is [string, Obj] => isObj(e[1])));
const stepsOf = (job: Obj): Obj[] => Array.isArray(job.steps) ? job.steps.filter(isObj) : [];

/** Permissions as scope → rank; `*` stands for read-all/write-all. */
function permissionMap(p: unknown): Record<string, number> {
  if (p === 'write-all') return { '*': 2 };
  if (p === 'read-all') return { '*': 1 };
  if (isObj(p)) return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, rank(v)]));
  return {};
}
/** True when `head` is new, removed or grants more than `base`. */
function permissionsWeakened(base: unknown, head: unknown): boolean {
  if (base === undefined && head === undefined) return false;
  if (base === undefined || head === undefined) return true;
  const b = permissionMap(base), h = permissionMap(head);
  return Object.entries(h).some(([scope, level]) => level > (b[scope] ?? b['*'] ?? 0));
}
const secretRefs = (text: string) => new Set([...text.matchAll(/secrets\.([A-Za-z0-9_-]+)|secrets\[\s*['"]([^'"]+)['"]\s*\]/g)].map(m => m[1] ?? m[2]!));
const usesOf = (doc: Obj): string[] => Object.values(jobsOf(doc)).flatMap(j => [...(typeof j.uses === 'string' ? [j.uses] : []),
  ...stepsOf(j).flatMap(s => typeof s.uses === 'string' ? [s.uses] : [])]);
const splitUses = (u: string) => { const i = u.lastIndexOf('@'); return i < 0 ? [u, ''] as const : [u.slice(0, i), u.slice(i + 1)] as const; };
/** Uses of the head that the base does not have; a move between pinned commits of one action is no change. */
function changedUses(base: string[], head: string[]): string[] {
  const rest = [...base];
  const added = head.filter(u => { const i = rest.indexOf(u); if (i < 0) return true; rest.splice(i, 1); return false; });
  return added.filter(u => {
    const [action, ref] = splitUses(u);
    const i = rest.findIndex(b => { const [a, r] = splitUses(b); return a === action && sha.test(r) && sha.test(ref); });
    if (i < 0) return true;
    rest.splice(i, 1); return false;
  });
}
const unmatched = <T>(have: T[], want: T[]) => { const rest = [...have]; return want.filter(w => { const i = rest.findIndex(x => isDeepStrictEqual(x, w)); if (i < 0) return true; rest.splice(i, 1); return false; }); };

/**
 * Content rules for one modified workflow file: the reasons why it is critical, empty when it only changes neutral
 * things. Anything that cannot be read or compared is critical (fail closed).
 */
export function workflowContentReasons(change: WorkflowChange, merge: { requiredChecks: readonly string[]; validationWorkflow: string | null }): string[] {
  const name = change.path.split('/').pop()!;
  let base: Obj, head: Obj;
  try { base = load(change.baseContent); head = load(change.content); }
  catch { return [`${name} konnte nicht als YAML gelesen oder verglichen werden`]; }
  const reasons: string[] = [];
  if (!isDeepStrictEqual(triggers(base), triggers(head))) reasons.push(`on geändert in ${name}`);
  const bj = jobsOf(base), hj = jobsOf(head);
  if (permissionsWeakened(base.permissions, head.permissions) || Object.keys(bj).some(id => hj[id] && permissionsWeakened(bj[id]!.permissions, hj[id]!.permissions))
    || Object.keys(hj).some(id => !bj[id] && hj[id]!.permissions !== undefined)) reasons.push(`permissions geändert in ${name}`);
  const baseSecrets = secretRefs(change.baseContent!);
  const newSecrets = [...secretRefs(change.content!)].filter(s => !baseSecrets.has(s));
  if (newSecrets.length) reasons.push(`neue secrets-Verweise in ${name} (${newSecrets.slice(0, 5).map(s => `secrets.${s}`).join(', ')})`);
  const uses = changedUses(usesOf(base), usesOf(head));
  if (uses.length) reasons.push(`uses geändert in ${name} (${uses.slice(0, 3).join(', ')})`);
  const required = (id: string, job: Obj) => name === merge.validationWorkflow || merge.requiredChecks.includes(id) || (typeof job.name === 'string' && merge.requiredChecks.includes(job.name));
  for (const [id, job] of Object.entries(bj)) {
    if (!required(id, job)) continue;
    const next = hj[id];
    if (!next || next.name !== job.name) { reasons.push(`Pflicht-Check-Job ${id} entfernt oder umbenannt in ${name}`); continue; }
    if (!isDeepStrictEqual(job.if, next.if) || !isDeepStrictEqual(job['continue-on-error'], next['continue-on-error'])) reasons.push(`if/continue-on-error geändert im Pflicht-Check-Job ${id} in ${name}`);
    const runs = (j: Obj) => stepsOf(j).filter(s => s.run !== undefined).map(s => s.run);
    if (unmatched(runs(next), runs(job)).length) reasons.push(`run-Befehl entfernt oder geändert im Pflicht-Check-Job ${id} in ${name}`);
    const guards = (j: Obj) => stepsOf(j).flatMap(s => [...(s.if !== undefined ? [{ if: s.if }] : []), ...(s['continue-on-error'] !== undefined ? [{ coe: s['continue-on-error'] }] : [])]);
    if (unmatched(guards(job), guards(next)).length) reasons.push(`Schritt-if/continue-on-error neu oder geändert im Pflicht-Check-Job ${id} in ${name}`);
  }
  return reasons;
}

export interface WorkflowVerdict { critical: { path: string; reason: string }[]; neutral: string[] }
/** Splits the changed workflow files into always/content-critical ones and ones that only count as ordinary code (floor medium). */
export function workflowVerdict(changes: WorkflowChange[], merge: { requiredChecks: readonly string[]; validationWorkflow: string | null }): WorkflowVerdict {
  const verdict: WorkflowVerdict = { critical: [], neutral: [] };
  for (const c of changes) {
    if (!inWorkflowFolder(c.path)) continue;
    const name = c.path.split('/').pop()!;
    if (!isWorkflowFile(c.path)) { verdict.critical.push({ path: c.path, reason: `${c.path} liegt im Workflow-Ordner, ist aber keine Workflow-Datei` }); continue; }
    if (c.status !== undefined && c.status !== 'modified' && c.status !== 'changed') { verdict.critical.push({ path: c.path, reason: `Workflow-Datei ${name} neu angelegt, gelöscht oder umbenannt` }); continue; }
    if (factoryWrapper.test(c.content ?? '') || factoryWrapper.test(c.baseContent ?? '')) { verdict.critical.push({ path: c.path, reason: `${name} bindet munichdeveloper/software-factory ein (Factory-Wrapper)` }); continue; }
    const reasons = workflowContentReasons(c, merge);
    if (reasons.length) verdict.critical.push({ path: c.path, reason: reasons.join('; ') }); else verdict.neutral.push(c.path);
  }
  return verdict;
}
