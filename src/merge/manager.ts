import type { Config } from '../config/index.js';
import type { Snapshot } from '../types.js';
import { decodeEvent, encodeEvent, type HarnessEvent } from '../state/events.js';
import { untrustedEdit } from '../state/content-trust.js';
import { hash, taskVersion } from '../state/identity.js';
import type { GitHubPort } from '../github/port.js';
import { permission, policyVersion } from '../policies/engine.js';
import { mergeReviewSchema, needsHumanLabel, type MergeFacts, type MergePort, type MergeReview, type MergeReviewer, type ReviewInput } from './contract.js';
import { aboveThreshold, builtinCriticalPaths, classifyRisk, describeRisk, type RiskAssessor, type RiskRecord } from './risk.js';
import { routeNoteDe, routeOutcome } from '../llm/router.js';
import { combineReviews, contextLimitError, defaultMaxParts, partsLimitError, reviewParts } from './parts.js';
import { setLlmSubject, withLlmContext } from '../llm/analytics.js';
import { reconstruct } from '../state/reconstruct.js';
import type { MergeObserver } from '../runtime/merge.js';
import { checkRunName, checkRunView, type MergeCheckRuns } from './check-run.js';

const safe = (s: string) => s.replaceAll('@', '@\u200b').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// The broker's own display-only risk and hand-over labels are no input of a review: setting them must not invalidate it.
const factsKey = (f: MergeFacts) => ({ ...f, comments: [], labels: f.labels.filter(l => !l.startsWith('sf:risk-') && l !== needsHumanLabel).sort(),
  nativeRequiredChecks: [...f.nativeRequiredChecks].sort(),
  checks: [...f.checks].sort((a, b) => `${a.name}:${a.state}`.localeCompare(`${b.name}:${b.state}`)) });
export function mergeGate(f: MergeFacts, config: Config): string | null {
  if (f.state !== 'open' || f.draft || !f.sameRepository) return 'PR ist geschlossen, ein Entwurf oder stammt aus einem anderen Repository/Zielbranch.';
  if (f.labels.includes('sf:blocked') || f.labels.includes('harness:blocked')) return 'PR wurde ausdrücklich blockiert.';
  if (f.unresolvedThreads.length) return 'Es gibt ungelöste Review-Diskussionen.';
  if (f.reviewDecision === 'CHANGES_REQUESTED' || f.reviewDecision === 'REVIEW_REQUIRED') return 'GitHub verlangt Änderungen oder zusätzliche Reviews.';
  if (config.merge.protection === 'factory') {
    // No server-side rules: the head must contain the current base, so the required checks below ran on what is merged.
    if (f.behindBy !== 0) return f.behindBy ? `Der Branch enthält ${f.behindBy} neuere Commit(s) der Basis nicht; Aktualisierung und neue Prüfungen sind erforderlich.` : 'Ob der Branch die aktuelle Basis enthält, ist unbekannt.';
  } else if (!f.strictChecks || !f.nativeRequiredChecks.length) return 'Serverseitige PR-Regeln mit strikt aktuellen Pflichtprüfungen sind erforderlich.';
  if (f.checks.some(c => c.state === 'action_required')) return 'GitHub verlangt eine Workflow-Freigabe am PR: Approve workflows to run. Separat per workflow_dispatch gestartete Tests ersetzen diese Pflichtprüfungen nicht. SF umgeht oder erteilt diese Freigabe nicht.';
  if (f.mergeState !== 'CLEAN') return `GitHub meldet ${f.mergeState}; kein Merge bei veraltetem, blockiertem oder unklarem Stand.`;
  for (const name of new Set([...config.merge.requiredChecks, ...f.nativeRequiredChecks])) {
    const checks = f.checks.filter(c => c.name === name);
    if (!checks.length || checks.some(c => c.state !== 'success')) return `Prüfung ${name} fehlt, läuft noch oder ist nicht erfolgreich.`;
  }
  if (f.checks.some(c => !['success', 'neutral', 'skipped'].includes(c.state))) return 'Mindestens eine weitere Prüfung ist offen oder fehlgeschlagen.';
  return null;
}

/** A review that stops the merge of its head: changes requested, deferred to a person, or a blocking finding. */
const rejects = (review: MergeReview) => review.findings.some(x => x.severity === 'blocking') || ['request_changes', 'defer'].includes(review.decision);
const failedCheck = (state: string) => ['failure', 'timed_out', 'cancelled', 'startup_failure', 'error'].includes(state);
const blockedLabel = (f: MergeFacts) => f.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l));
/** What a conflict rework tells the coding worker; the executor leaves the conflicting merge in its workspace. */
const conflictReview = (f: MergeFacts): MergeReview => ({ decision: 'request_changes', findings: [],
  reason: `Merge-Konflikt: Der Branch ${f.headBranch} lässt sich nicht konfliktfrei mit ${f.baseBranch} (Basis ${f.base.slice(0, 7)}) zusammenführen. ` +
    'Setze die bisherigen Änderungen dieses Versuchs auf der aktuellen Basis fort. Wo sie kollidieren, enthält der Arbeitsbereich Konfliktmarker ' +
    '(<<<<<<<, =======, >>>>>>>). Löse jeden Konflikt so auf, dass die neueren Änderungen der Basis erhalten bleiben und die Aufgabe weiterhin ' +
    'vollständig erfüllt ist. Baue nichts neu, was schon vorhanden ist, und hinterlasse keine Konfliktmarker.' });
const behind = (f: MergeFacts, config: Config) => config.merge.protection === 'factory' ? !!f.behindBy : f.mergeState === 'BEHIND';
export interface MergeOptions {
  /** Only pull requests the Factory published for its own tasks; no adoption by label (an issue-scoped broker). */
  ownedOnly?: boolean;
  /** Assesses the risk class of a head when merge.risk is enabled; without it every assessment fails closed (critical). */
  assessor?: RiskAssessor;
  /** Told where each pull request stands after this pass looked at it (the queue view's merge step); display only. */
  observe?: MergeObserver;
  /** Shows the same steps as a check run on the head of each pull request (issue #208); display only. */
  checkRuns?: MergeCheckRuns;
}
/** A pull request the Factory published for a task, with the outcome it was published with. */
interface Ownership { task: Snapshot['issues'][number]; status: string; publishedHead: string | null }

/**
 * Context errors that depend only on the pull request's head and base, not on GitHub or a provider being reachable
 * (geschaeftsideen-web#57 added a ZIP file: every pass failed the same way and the monitor promised another try).
 */
/** Check and commit status states that do not hold a merge back. */
const passingStates = new Set(['success', 'neutral', 'skipped']);
const permanentContextErrors = new Set(['Change set exceeds review file limit', 'Diff is incomplete or contains binary changes',
  'File cannot be reviewed completely', 'Binary file cannot be reviewed', contextLimitError, partsLimitError]);

export class MergeManager {
  constructor(private api: MergePort, private config: Config, private reviewer: MergeReviewer, private correlationId: string,
    private tasks?: Pick<GitHubPort, 'getIssue'>, private options: MergeOptions = {}) {}
  private events(f: MergeFacts) { return f.comments.flatMap(c => { const e = decodeEvent(c, this.config.manager.trustedActors); return e ? [e] : []; }); }
  private async event(f: MergeFacts, key: string, data: HarnessEvent['data'], text = '') {
    if (this.events(f).some(e => e.key === key)) return;
    const journal = encodeEvent({ version: 1, key, at: new Date().toISOString(), correlationId: this.correlationId, data });
    const summary = text ? Buffer.from(`\n\n### Software Factory – Mergeprüfung\n\n${safe(text)}`) : Buffer.alloc(0);
    // Keep the full durable decision; bound the extra human-readable presentation.
    await this.api.comment(f.number, journal + summary.subarray(0, Math.max(0, 60000 - Buffer.byteLength(journal) - 4)).toString('utf8'));
  }
  private async explain(f: MergeFacts, reason: string) {
    await this.event(f, `merge-status:${hash({ head: f.head, base: f.base, reason })}`,
      { type: 'merge_status', head: f.head, base: f.base, reason }, `${f.mergeSha ? '**Merge bestätigt – Nacharbeit offen.**' : '**Noch kein Merge.**'} ${reason}\n\nGeprüfter Head: \`${f.head}\`; Basis: \`${f.base}\`.`);
  }
  /**
   * The review asked for changes to a pull request the Factory published for a task: journal that on the task, once per
   * review. It is the source a rework answers (with execution.rework), so the pull request does not wait for nobody.
   */
  private async changesRequested(f: MergeFacts, task: Snapshot['issues'][number], snapshot: Snapshot, reviewKey: string, review: MergeReview) {
    const executionId = f.headBranch.match(/^sf\/issue-\d+\/([a-f0-9]{32})$/)?.[1];
    if (!executionId) return;
    const key = `merge-changes-requested:${reviewKey}`;
    if ((snapshot.comments.get(task.number) ?? []).some(c => decodeEvent(c, this.config.manager.trustedActors)?.key === key)) return;
    const journal = encodeEvent({ version: 1, key, at: new Date().toISOString(), correlationId: this.correlationId,
      data: { type: 'merge_changes_requested', prNumber: f.number, head: f.head, executionId, reviewKey, review } });
    const next = this.config.execution.rework ? 'Die Factory startet selbst einen weiteren Versuch, der die Änderungen des PR fortsetzt und die Befunde des Reviews erhält (bis zur Grenze von `execution.maxRetries`).'
      : 'Automatische Nacharbeit ist in diesem Repository aus (`execution.rework`); bitte selbst nacharbeiten oder entscheiden.';
    const summary = Buffer.from(`\n\n### Software Factory – Review verlangt Änderungen\n\n${safe(`Das unabhängige KI-Review von #${f.number} verlangt Änderungen. ${next}`)}`);
    await this.api.comment(task.number, journal + summary.subarray(0, Math.max(0, 60000 - Buffer.byteLength(journal) - 4)).toString('utf8'));
  }
  /**
   * Sets or removes `sf:needs-human` on the pull request and, when given, on its task. Only changes what differs, so a
   * pass that finds the same state touches nothing.
   */
  private async needsHuman(f: MergeFacts, on: boolean, task?: Snapshot['issues'][number]) {
    if (!this.api.needsHuman) return;
    if (on !== f.labels.includes(needsHumanLabel)) {
      await this.api.needsHuman(f.number, on);
      f.labels = on ? [...f.labels, needsHumanLabel] : f.labels.filter(l => l !== needsHumanLabel);
    }
    if (task && on !== task.labels.includes(needsHumanLabel)) {
      await this.api.needsHuman(task.number, on);
      task.labels = on ? [...task.labels, needsHumanLabel] : task.labels.filter(l => l !== needsHumanLabel);
    }
  }
  /** Tells the task, once per approval request, that its pull request waits for a person, why, and how to approve. */
  private async approvalOnTask(task: Snapshot['issues'][number], snapshot: Snapshot, data: Extract<HarnessEvent['data'], { type: 'merge_approval_required' }>) {
    const key = `merge-approval-required:${data.approvalId}`;
    if ((snapshot.comments.get(task.number) ?? []).some(c => decodeEvent(c, this.config.manager.trustedActors)?.key === key)) return;
    const journal = encodeEvent({ version: 1, key, at: new Date().toISOString(), correlationId: this.correlationId, data });
    const summary = Buffer.from(`\n\n### Software Factory – Freigabe nötig\n\n${safe(`PR #${data.prNumber} ist geprüft, wartet aber auf eine menschliche Freigabe: Risiko ${data.riskClass} liegt über der Schwelle ${data.autoMergeUpTo} für automatisches Mergen. Freigeben mit diesem Kommentar am PR #${data.prNumber}:`)}\n\n\`/harness approve ${data.approvalId}\``);
    await this.api.comment(task.number, journal + summary.subarray(0, Math.max(0, 60000 - Buffer.byteLength(journal) - 4)).toString('utf8'));
  }
  /**
   * Commits pushed onto a Factory pull request after it was published (a person fixed review findings, or updated the
   * branch). They are adopted when every one of them comes from an account that may write to the repository, which could
   * merge the pull request itself anyway: the new head then goes through the required checks, the validation workflow
   * and a fresh review like any other head. Returns why the head is refused, or null when it is adopted.
   */
  private async laterCommits(f: MergeFacts, publishedHead: string): Promise<string | null> {
    const refused = 'Der Head entspricht nicht dem veröffentlichten, validierten Commit; die Factory mergt keine fremden Änderungen.';
    if (!this.api.pushedSince) return refused;
    const authors = await this.api.pushedSince(publishedHead, f.head);
    if (!authors?.length) return `${refused} Der Head setzt den veröffentlichten Commit nicht fort (umgeschriebene Historie).`;
    const unique = [...new Set(authors)];
    const trusted = await Promise.all(unique.map(a => !!a && (this.config.manager.trustedActors.includes(a) || this.api.canApprove(a))));
    const outsiders = unique.filter((_, i) => !trusted[i]).map(a => a || 'unbekannt');
    if (outsiders.length) return `${refused} Nachträgliche Commits ohne Schreibrecht im Repository: ${outsiders.join(', ')}.`;
    await this.dispatch(f, this.config.merge.validationWorkflow, f.headBranch, f.head);
    await this.explain(f, `Nachträgliche Commits von ${unique.join(', ')} (Schreibrecht im Repository) werden übernommen: der neue Head durchläuft Pflichtprüfungen, Validierung und ein neues KI-Review.`);
    return null;
  }
  /**
   * The branch conflicts with its base. A Factory pull request goes back to the coding worker as a rework when
   * execution.rework allows one (journaled on the task once per head, like review findings); it resolves the conflict on
   * the current base with the first-attempt agents. Everything else is handed over to a person (sf:needs-human).
   */
  private async conflict(f: MergeFacts, snapshot: Snapshot, ownership: Ownership | undefined, adopted: boolean) {
    const conflictKey = hash({ protocol: 'sf-merge-conflict-v1', repository: this.api.repository.toLowerCase(), head: f.head });
    const executionId = f.headBranch.match(/^sf\/issue-\d+\/([a-f0-9]{32})$/)?.[1];
    const task = ownership && !adopted && executionId ? reconstruct(snapshot, this.config).find(t => t.issue.number === ownership.task.number) : undefined;
    const limit = !!task && task.attemptsUsed > this.config.execution.maxRetries;
    if (task && executionId && this.config.execution.rework && !limit && task.latest?.input.executionId === executionId) {
      const key = `merge-changes-requested:${conflictKey}`;
      if (!(snapshot.comments.get(task.issue.number) ?? []).some(c => decodeEvent(c, this.config.manager.trustedActors)?.key === key)) {
        const journal = encodeEvent({ version: 1, key, at: new Date().toISOString(), correlationId: this.correlationId,
          data: { type: 'merge_changes_requested', prNumber: f.number, head: f.head, executionId, reviewKey: conflictKey, review: conflictReview(f), cause: 'conflict' } });
        const summary = `\n\n### Software Factory – Merge-Konflikt\n\n${safe(`Der Branch von #${f.number} hat Merge-Konflikte mit ${f.baseBranch}. Die Factory startet selbst einen weiteren Versuch, der die Änderungen auf der aktuellen Basis fortsetzt und die Konflikte auflöst (bis zur Grenze von \`execution.maxRetries\`).`)}`;
        await this.api.comment(task.issue.number, journal + summary);
      }
      await this.explain(f, 'Der Branch hat Merge-Konflikte mit der Basis. Die Factory löst sie mit einer Nacharbeit auf der aktuellen Basis auf; der neue Stand durchläuft danach Pflichtprüfungen, Validierung und ein neues KI-Review.');
      return;
    }
    const why = !ownership || adopted ? 'Der PR wurde nicht von der Factory für eine Aufgabe erstellt.'
      : !this.config.execution.rework ? 'Automatische Nacharbeit ist in diesem Repository aus (`execution.rework`).'
      : limit ? `Die Versuche der Aufgabe sind aufgebraucht (\`execution.maxRetries\`: ${this.config.execution.maxRetries}).`
      : 'Der PR gehört nicht zum letzten Versuch der Aufgabe.';
    await this.event(f, `merge-handover:${conflictKey}`, { type: 'merge_handover', prNumber: f.number, head: f.head, base: f.base, reviewKey: conflictKey, decision: 'conflict' });
    if (this.api.needsHuman && !f.labels.includes(needsHumanLabel)) await this.api.needsHuman(f.number, true);
    await this.explain(f, `Der Branch hat Merge-Konflikte mit der Basis. ${why} Bitte die Konflikte selbst auflösen; danach folgen Pflichtprüfungen, Validierung und ein neues KI-Review.`);
  }
  /** Merges the base into the branch (once per head and base), then dispatches the validation of the new head. */
  private async updateBranch(f: MergeFacts, snapshot: Snapshot, ownership: Ownership | undefined, adopted: boolean, done: string): Promise<boolean> {
    const key = `branch-update:${hash({ head: f.head, base: f.base })}`;
    if (this.events(f).some(e => e.key === key)) { await this.explain(f, 'Branch-Aktualisierung wurde bereits angefordert; GitHub-Status prüfen.'); return false; }
    await this.event(f, key, { type: 'branch_update', head: f.head, base: f.base });
    let head: string;
    try { head = await this.api.update(f.number, f.head); }
    catch (error) {
      if (!(error instanceof Error && error.message === 'MERGE_CONFLICT')) throw error;
      await this.conflict(f, snapshot, ownership, adopted); return false;
    }
    const updated = await this.read(f.number);
    if (updated.head !== head) { await this.explain(updated, 'Branch wurde erneut verändert; keine Freigabe für den ungeprüften Stand.'); return true; }
    await this.dispatch(updated, this.config.merge.validationWorkflow, updated.headBranch, head);
    await this.explain(updated, done);
    return true;
  }
  private ownership(f: MergeFacts, snapshot: Snapshot): Ownership | undefined {
    const url = `https://github.com/${this.api.repository}/pull/${f.number}`;
    for (const task of snapshot.issues) {
      const comments = snapshot.comments.get(task.number) ?? [];
      for (const c of comments) {
        const e = decodeEvent(c, this.config.manager.trustedActors);
        if (e?.data.type !== 'result' || f.headBranch !== `sf/issue-${task.number}/${e.data.result.executionId}` || !e.data.result.artifacts.includes(url)) continue;
        // The publication record of the Temporal publisher names the commit it published.
        const published = comments.find(p => this.config.manager.trustedActors.includes(p.author) && p.body.startsWith(`Draft PR: ${url}\n`))?.body.match(/^Head: ([a-f0-9]{40})$/m)?.[1];
        return { task, status: e.data.result.status, publishedHead: published ?? null };
      }
    }
    return undefined;
  }
  private note(n: number, step: Parameters<MergeObserver>[1], detail?: string | null, risk?: string | null) {
    try { this.options.observe?.(n, step, detail, risk); } catch { /* display only: never fails the pass */ }
    const head = this.heads.get(n);
    if (!head || this.config.merge.checkRun === false) return;
    if (risk) this.risks.set(head, risk);
    try { this.options.checkRuns?.show(n, head, checkRunView(step, detail, risk ?? this.risks.get(head))); } catch { /* display only */ }
  }
  /** The head each pull request had when this pass last read it, and the risk class seen for a head (check runs). */
  private heads = new Map<number, string>();
  private risks = new Map<string, string>();
  /** Reads a pull request without the Factory's own check run: it shows the merge pass and must never gate it (issue #208). */
  private async read(number: number) {
    const f = await this.api.facts(number);
    const own = f.checks.some(c => c.name === checkRunName);
    f.checks = f.checks.filter(c => c.name !== checkRunName);
    // GitHub counts that check run into mergeStateStatus: while it is in progress the pull request reads UNSTABLE. Every
    // review then saw the state change under it and the gate never saw CLEAN (geschaeftsideen-web#57). UNSTABLE with every
    // other check passing is the Factory's own check run alone.
    if (own && f.mergeState === 'UNSTABLE' && f.checks.every(c => passingStates.has(c.state))) f.mergeState = 'CLEAN';
    this.heads.set(number, f.head);
    return f;
  }
  private owned(f: MergeFacts, snapshot: Snapshot) { return this.ownership(f, snapshot)?.task; }
  private eligible(f: MergeFacts, snapshot: Snapshot) {
    const owned = this.config.merge.includeFactoryPRs && !!this.ownership(f, snapshot);
    return this.options.ownedOnly ? owned : f.labels.includes(this.config.merge.adoptLabel) || owned;
  }
  /**
   * Starts `workflow` on `ref` once per commit. A workflow without a workflow_dispatch trigger on `ref` is skipped: GitHub
   * would refuse it with 422 in every pass, and the pull_request checks of the new head run without it (issue #195).
   */
  private async dispatch(f: MergeFacts, workflow: string | null, ref: string, sha: string) {
    if (!workflow) return;
    const key = `merge-ci:${hash({ workflow, ref, sha })}`;
    if (this.events(f).some(e => e.key === key)) return;
    if (!(await this.api.workflowAvailable(workflow, ref))) return;
    await this.api.dispatch(workflow, ref);
    await this.event(f, key, { type: 'workflow_dispatch', workflow, ref, sha });
  }
  private async postMerge(f: MergeFacts, sha: string) {
    for (const workflow of new Set(this.config.merge.postMergeWorkflows)) await this.dispatch(f, workflow, f.baseBranch, sha);
  }
  /** One merge pass; its model calls are recorded for analytics under the pull request (and issue) they review. */
  run(snapshot: Snapshot) { return withLlmContext({}, () => this.pass(snapshot)); }
  private async pass(snapshot: Snapshot) {
    const report: { reviewed: number; updated: number; merged: number; errors: string[] } = { reviewed: 0, updated: 0, merged: 0, errors: [] };
    if (!this.config.factory.enabled || !this.config.merge.enabled || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return report;
    if (permission(this.config, 'merge_pr') === 'deny') return report;
    for (const number of await this.api.candidates()) {
      setLlmSubject({ repository: this.api.repository, prNumber: number, issueNumber: snapshot.prs.find(p => p.number === number)?.closingIssues[0] ?? null });
      if (report.reviewed >= this.config.merge.maxReviewsPerRun || report.updated + report.merged >= this.config.merge.maxActionsPerRun) break;
      let f: MergeFacts | undefined;
      let phase = 'GitHub-Zustand lesen';
      try {
        f = await this.read(number);
        if (!this.eligible(f, snapshot)) continue;
        if (f.state === 'closed') {
          this.note(number, f.mergeSha ? 'merged' : 'stopped', f.mergeSha ? null : 'PR wurde ohne Merge geschlossen.');
          // Nobody waits for an approval any more, also when a person merged or closed the pull request themselves.
          phase = 'Übergabe-Label entfernen';
          await this.needsHuman(f, false, this.owned(f, snapshot));
          if (f.mergeSha && f.mergeActorType === 'Bot' && this.events(f).some(e => e.data.type === 'merge_intent' && e.data.head === f!.head)) {
            await this.event(f, `merge-completed:${f.head}`, { type: 'merge_completed', prNumber: number, head: f.head, mergeSha: f.mergeSha });
            await this.postMerge(f, f.mergeSha);
          }
          continue;
        }
        const ownership = this.ownership(f, snapshot), owner = ownership?.task;
        // The published head of a blocked run whose branch was repaired afterwards (its PR text describes that head).
        let revalidated: string | null = null;
        if (owner && (owner.state === 'closed' || owner.labels.includes('harness:blocked'))) { this.note(number, 'stopped', 'Die zugehörige Aufgabe wurde geschlossen oder blockiert.'); await this.explain(f, 'Die zugehörige Aufgabe wurde geschlossen oder blockiert.'); continue; }
        const adopted = !this.options.ownedOnly && f.labels.includes(this.config.merge.adoptLabel);
        if (ownership && !adopted) {
          // Only a successful run whose independent validation passed is a merge candidate; a draft kept for review is not.
          // Exception (issue #188 step 6, concept 6.4): a blocked run whose branch people with write access repaired
          // afterwards. Its new head is validated again (validationWorkflow), must pass the required checks and gets a new
          // AI review, like any later commit on a successful run.
          const repaired = ownership.status === 'blocked' && !!ownership.publishedHead && f.head !== ownership.publishedHead;
          if (ownership.status !== 'success' && !repaired) { this.note(number, 'stopped', `Lauf mit Status ${ownership.status} veröffentlicht, nicht als erfolgreich validiert.`); await this.explain(f, `Der Lauf wurde mit Status ${ownership.status} veröffentlicht, nicht als erfolgreich validiert; die Factory mergt ihn nicht. Ein neuer Commit auf dem Branch (von jemandem mit Schreibrecht) wird erneut validiert und geprüft.`); continue; }
          if (repaired) revalidated = ownership.publishedHead;
          // The published, validated commit or a base update the Factory itself requested; nothing pushed by others.
          if (ownership.publishedHead && f.head !== ownership.publishedHead && (repaired || !this.events(f).some(e => e.data.type === 'branch_update'))) {
            phase = 'Nachträgliche Commits prüfen';
            const refusal = await this.laterCommits(f, ownership.publishedHead);
            if (refusal) { this.note(number, 'stopped', refusal); await this.explain(f, refusal); continue; }
          }
          if (f.draft && f.state === 'open' && this.api.ready && !f.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l))) {
            phase = 'Entwurf freigeben';
            await this.api.ready(number, f.head);
            this.note(number, 'checks', 'Entwurf zur Prüfung freigegeben.');
            await this.explain(f, 'Der validierte Entwurf wurde zur Prüfung freigegeben; Review und Merge folgen im nächsten Durchlauf.'); continue;
          }
        }
        // A conflicting branch gets no pull-request checks from GitHub, so it would wait for them forever: resolve it first.
        if (f.state === 'open' && !f.draft && f.sameRepository && !blockedLabel(f) && f.mergeState === 'DIRTY') {
          phase = 'Merge-Konflikt behandeln';
          this.note(number, 'conflict');
          await this.conflict(f, snapshot, ownership, adopted); continue;
        }
        if (f.state === 'open' && !f.draft) {
          const required = [...new Set([...this.config.merge.requiredChecks, ...f.nativeRequiredChecks])];
          const failed = f.checks.filter(c => required.includes(c.name) && failedCheck(c.state));
          if (failed.length) {
            phase = 'Fehlgeschlagene Pflichtprüfung wiederholen';
            // At most once per workflow run (only first attempts are re-run): a failure of the re-run stands.
            if (this.api.rerunFailed && await this.api.rerunFailed(number, f.head, required)) {
              this.note(number, 'checks', `Pflichtprüfung ${failed.map(c => c.name).join(', ')} wird einmal wiederholt.`);
              await this.explain(f, 'Eine Pflichtprüfung ist fehlgeschlagen und wird einmal wiederholt, falls die Ursache die Ausführungsumgebung war (z. B. Netzwerk bei der Installation).'); continue;
            }
            this.note(number, 'checks-failed', `Pflichtprüfung ${failed.map(c => c.name).join(', ')} ist fehlgeschlagen.`);
            await this.explain(f, `Pflichtprüfung ${failed.map(c => c.name).join(', ')} ist fehlgeschlagen; kein Review und kein Merge für diesen Stand.`); continue;
          }
          // A review of a state whose required checks are still running would only defer, and be repeated for each check.
          const pending = required.filter(name => !f!.checks.some(c => c.name === name) || f!.checks.some(c => c.name === name && !['success', 'neutral', 'skipped'].includes(c.state)));
          if (pending.length && !f.checks.some(c => c.state === 'action_required')) {
            this.note(number, 'checks', `Pflichtprüfung ${pending.join(', ')} fehlt oder läuft noch.`);
            await this.explain(f, `Pflichtprüfung ${pending.join(', ')} fehlt oder läuft noch; Review und Merge folgen danach.`); continue;
          }
        }
        if (f.state !== 'open' || f.draft || !f.sameRepository || f.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l))) {
          this.note(number, 'stopped', 'PR ist nicht offen/freigegeben oder wurde ausdrücklich blockiert.');
          await this.explain(f, 'PR ist nicht offen/freigegeben, stammt aus einem Fork/falschen Zielbranch oder wurde ausdrücklich blockiert.'); continue;
        }
        const pendingUpdate = this.events(f).find(e => e.data.type === 'branch_update' && e.data.base === f!.base && e.data.head !== f!.head);
        if (pendingUpdate) {
          const previous = phase; phase = 'Validierung nach Branch-Aktualisierung starten';
          await this.dispatch(f, this.config.merge.validationWorkflow, f.headBranch, f.head);
          phase = previous;
        }
        const sourceTask = owner ? { number: owner.number, title: owner.title, body: owner.body } : null;
        // Immutable head/base IDs bind all source/context files. Mutable facts and task intent are included explicitly.
        // The risk settings decide only whether a person approves; they are no input of the code review.
        const { risk: _risk, ...mergePolicy } = this.config.merge; void _risk;
        const reviewKey = hash({ protocol: 'sf-merge-review-v1', repository: this.api.repository.toLowerCase(), sourceTask,
          facts: factsKey(f), merge: mergePolicy, policy: policyVersion(this.config) });
        const cached = this.events(f).find(e => e.data.type === 'merge_review' && e.data.reviewKey === reviewKey);
        // The same head, task, checks and policy without the base: a newer base alone does not change a rejection. Only
        // a new commit, a revised task or a changed configuration earns a new review (controla#123: 16 reviews of one head).
        const verdictKey = hash({ protocol: 'sf-merge-verdict-v1', repository: this.api.repository.toLowerCase(), sourceTask, head: f.head,
          checks: factsKey(f).checks, labels: factsKey(f).labels, merge: mergePolicy, policy: policyVersion(this.config) });
        const rejected = cached ? undefined : this.events(f).find(e => e.data.type === 'merge_review' && e.data.verdictKey === verdictKey && rejects(e.data.review));
        if (rejected?.data.type === 'merge_review') {
          const earlier = rejected.data;
          this.note(number, 'review-rejected', `KI-Review hat diesen Stand bereits abgelehnt (${earlier.review.decision}).`);
          await this.event(f, `merge-status:${hash({ head: f.head, verdictKey })}`, { type: 'merge_status', head: f.head, base: f.base,
            reason: `Das KI-Review hat diesen Stand bereits abgelehnt (${earlier.review.decision}, Basis ${earlier.base.slice(0, 7)}).` },
            `**Noch kein Merge.** Das KI-Review hat diesen Head bereits abgelehnt (**${earlier.review.decision}**). Eine neuere Basis allein ändert daran nichts; ein neues Review folgt erst nach einem neuen Commit, einer geänderten Aufgabe oder Konfiguration.\n\nGeprüfter Head: \`${f.head}\`.`);
          continue;
        }
        // A branch behind its base is brought up to date before any review: the review of a stale state would only be
        // repeated after the update (controla#135 waited 16 base commits behind for a review that never asked for one).
        if (this.config.merge.updateBranch && behind(f, this.config) && !f.unresolvedThreads.length &&
          !['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(f.reviewDecision ?? '')) {
          phase = 'Branch-Aktualisierung';
          this.note(number, 'branch-update', `Branch lag ${f.behindBy ?? 'einige'} Commit(s) hinter der Basis.`);
          if (await this.updateBranch(f, snapshot, ownership, adopted, `Der Branch enthielt ${f.behindBy ?? 'einige'} neuere Commit(s) der Basis nicht und wurde von der Factory aktualisiert. Pflichtprüfungen, Validierung und KI-Review folgen für den neuen Stand.`)) report.updated++;
          continue;
        }
        const risk = this.config.merge.risk;
        // One assessment per head, base and risk configuration; the built-in list is part of the protocol. v3 (0.26.0):
        // fixed Haiku assessor and hard rules, so heads assessed by Jev are assessed again.
        const riskKey = risk.enabled ? hash({ protocol: 'sf-merge-risk-v3', repository: this.api.repository.toLowerCase(), head: f.head, base: f.base,
          risk, builtin: builtinCriticalPaths }) : null;
        const cachedRisk = riskKey ? this.events(f).find(e => e.data.type === 'merge_risk' && e.data.riskKey === riskKey) : undefined;
        let context: Promise<ReviewInput> | undefined;
        const current = f;
        const { maxFiles, maxContextBytes } = this.config.merge.review, maxParts = this.config.merge.review.maxParts ?? defaultMaxParts;
        // The whole context may span maxParts review parts; each part stays under maxContextBytes (issue #189).
        const load = () => context ??= this.api.context(current, maxFiles, maxContextBytes * maxParts).then(input => {
          if (sourceTask) input.sourceTask = sourceTask;
          if (revalidated) input.validationNote = `The Factory run that published this pull request was blocked by its independent validation at commit ${revalidated}. The pull request text still describes that commit. People with write access pushed fixes since; the current head was validated again and is judged by its current checks.`;
          return input; });
        let planned: Promise<ReviewInput[]> | undefined;
        const plan = () => planned ??= load().then(input => reviewParts(input, maxContextBytes, maxParts));
        // Which model did the work, when the model router was asked (router.review, router.risk); shown, never journaled.
        let reviewNote = '', riskNote = '';
        const configuredAssessor = this.options.assessor;
        const assessor: RiskAssessor | undefined = configuredAssessor && { assess: async i => {
          const assessed = await configuredAssessor.assess({ ...i, pullRequest: number }); riskNote = routeNoteDe(routeOutcome(assessed)); return assessed; } };
        // Review and risk assessment are independent and run in parallel; the assessment never rejects (failures are critical).
        const reviewing: Promise<MergeReview> = cached?.data.type === 'merge_review' ? Promise.resolve(cached.data.review) : (async () => {
          report.reviewed++;
          phase = 'Vollständigen Änderungskontext laden';
          const parts = await plan();
          phase = parts.length > 1 ? `KI-Review in ${parts.length} Teilen` : 'KI-Review';
          this.note(number, 'review', parts.length > 1 ? `KI-Review in ${parts.length} Teilen.` : null);
          const reviews: MergeReview[] = [];
          for (const part of parts) {
            const reviewed = await this.reviewer.review(part);
            reviewNote = routeNoteDe(routeOutcome(reviewed));
            const parsed = mergeReviewSchema.parse(reviewed); reviews.push(parsed);
            // A part that does not approve decides for the whole pull request; the remaining parts are not reviewed.
            if (rejects(parsed)) break;
          }
          return parts.length > 1 ? mergeReviewSchema.parse(combineReviews(reviews, parts.length)) : reviews[0]!;
        })();
        const assessing: Promise<RiskRecord | null> = !riskKey ? Promise.resolve(null) : cachedRisk?.data.type === 'merge_risk' ? Promise.resolve(cachedRisk.data.risk)
          // Without a review plan (more than maxParts parts) the whole change set is assessed at once, as before parts existed.
          : load().then(input => plan().then(parts => parts.map(p => p.changes), () => [input.changes])
            .then(parts => classifyRisk(input.changes, risk, assessor, parts)),
            () => classifyRisk([], risk, { assess: () => Promise.reject(new Error('No context')) }));
        const [review, riskRecord] = await Promise.all([reviewing, assessing]);
        await this.event(f, `merge-review:${reviewKey}`, { type: 'merge_review', head: f.head, base: f.base, reviewKey, review, verdictKey },
          `**KI-Entscheidung: ${review.decision}**\n\n${review.reason}\n\n${review.findings.map(x => `- ${x.severity}: ${x.path} – ${x.explanation}`).join('\n')}\n\n${reviewNote ? `${reviewNote}\n\n` : ''}Head: \`${f.head}\`; Basis: \`${f.base}\`.`);
        this.note(number, 'review', null, riskRecord && riskRecord.source !== 'error' ? riskRecord.class : null);
        if (riskKey && riskRecord) {
          // A failed assessment is not journaled, so the next pass assesses again; until then it counts as critical.
          if (riskRecord.source === 'error') await this.explain(f, describeRisk(riskRecord, risk));
          else await this.event(f, `merge-risk:${riskKey}`, { type: 'merge_risk', head: f.head, base: f.base, riskKey, risk: riskRecord },
            `${describeRisk(riskRecord, risk)}\n\n${riskNote ? `${riskNote}\n\n` : ''}Head: \`${f.head}\`; Basis: \`${f.base}\`.`);
          const label = `sf:risk-${riskRecord.class}`;
          if (this.api.riskLabel && (!f.labels.includes(label) || f.labels.some(l => l.startsWith('sf:risk-') && l !== label))) {
            phase = 'Risiko-Label setzen';
            await this.api.riskLabel(number, label);
          }
        }
        if (f.checks.some(c => c.state === 'action_required')) { this.note(number, 'gate', 'GitHub verlangt eine Workflow-Freigabe am PR.'); await this.explain(f, mergeGate(f, this.config)!); continue; }
        if (owner && !adopted && (review.decision === 'request_changes' || review.findings.some(x => x.severity === 'blocking'))) {
          phase = 'Nacharbeit an der Aufgabe vermerken';
          await this.changesRequested(f, owner, snapshot, reviewKey, review);
        }
        // Hand over to a person what nothing in the Factory will continue: changes without automatic rework, or a deferral.
        const blocked = review.decision === 'request_changes' || review.findings.some(x => x.severity === 'blocking');
        const handOver = !!owner && !adopted && ((blocked && !this.config.execution.rework) || review.decision === 'defer');
        if (handOver) await this.event(f, `merge-handover:${reviewKey}`, { type: 'merge_handover', prNumber: number, head: f.head, base: f.base,
          reviewKey, decision: review.decision === 'defer' ? 'defer' : 'request_changes' });
        // sf:needs-human marks what waits for a person: a hand-over, or an approval (below). Another rejection takes it off;
        // the approval and merge path decides it for a review that lets the change through.
        if (handOver || rejects(review)) { phase = 'Übergabe-Label setzen'; await this.needsHuman(f, handOver); }
        if (rejects(review)) { this.note(number, handOver ? 'handover' : 'review-rejected', `KI-Entscheidung: ${review.decision}.`); continue; }
        const live = await this.read(number);
        if (hash(factsKey(live)) !== hash(factsKey(f)) || !this.eligible(live, snapshot) || live.state !== 'open' || live.draft || !live.sameRepository ||
          live.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l))) { this.note(number, 'review', 'Stand hat sich während der KI-Prüfung geändert; erneute Prüfung folgt.'); await this.explain(live, 'PR, Head, Basis oder Freigabe hat sich während der KI-Prüfung geändert; erneute Prüfung erforderlich.'); continue; }
        let liveOwner: Snapshot['issues'][number] | undefined;
        if (owner) {
          liveOwner = this.tasks ? await this.tasks.getIssue(owner.number) : owner;
          if (liveOwner.state !== 'open' || liveOwner.labels.includes('harness:blocked') || !liveOwner.labels.includes('harness:managed') ||
            taskVersion(liveOwner) !== taskVersion(owner) || untrustedEdit(liveOwner)) {
            this.note(number, 'stopped', 'Die zugehörige Aufgabe wurde während des Reviews verändert.');
            await this.explain(live, 'Die zugehörige Aufgabe wurde während des Reviews geschlossen, blockiert, abgemeldet oder fachlich verändert.'); continue;
          }
        }
        // The risk class only tightens 'allow': above the threshold a person approves (or merges) instead of the Factory.
        const riskGate = !!riskKey && !!riskRecord && risk.mode === 'enforce' && review.decision === 'merge' &&
          permission(this.config, 'merge_pr') === 'allow' && aboveThreshold(riskRecord.class, risk);
        if (riskGate && risk.aboveThreshold === 'block') {
          this.note(number, 'handover', `Risiko ${riskRecord!.class} über der Schwelle ${risk.autoMergeUpTo}; bitte selbst mergen.`);
          await this.explain(live, `Risiko ${riskRecord!.class} liegt über der Schwelle ${risk.autoMergeUpTo}; die Factory mergt diesen PR nicht. Bitte selbst prüfen und mergen.`); continue;
        }
        if (permission(this.config, 'merge_pr') === 'approval' || riskGate) {
          const approvalId = hash({ repository: this.api.repository, number, head: f.head, base: f.base, reviewKey, review,
            ...(riskGate ? { riskKey, riskClass: riskRecord!.class } : {}) });
          let approved = false;
          for (const c of live.comments) {
            const match = c.body.trim().match(/^\/harness (approve|revoke) ([a-f0-9]{64})$/);
            if (match?.[2] === approvalId && await this.api.canApprove(c.author)) approved = match[1] === 'approve';
          }
          if (!approved) {
            this.note(number, 'approval-required', `${riskGate ? `Risiko ${riskRecord!.class} über der Schwelle ${risk.autoMergeUpTo}: menschliche Freigabe nötig.` : 'Menschliche Freigabe nötig.'} Freigeben mit diesem Kommentar am PR: /harness approve ${approvalId}`);
            if (riskGate) await this.event(live, `merge-approval-required:${approvalId}`, { type: 'merge_approval_required', prNumber: number,
              head: f.head, base: f.base, approvalId, riskClass: riskRecord!.class, autoMergeUpTo: risk.autoMergeUpTo });
            // Visible where people look: on the pull request and on its task, with the reason and the command (issue #204).
            phase = 'Übergabe-Label setzen';
            await this.needsHuman(live, true, liveOwner);
            if (liveOwner && riskGate) await this.approvalOnTask(liveOwner, snapshot, { type: 'merge_approval_required', prNumber: number,
              head: f.head, base: f.base, approvalId, riskClass: riskRecord!.class, autoMergeUpTo: risk.autoMergeUpTo });
            await this.explain(live, `${riskGate ? `Risiko ${riskRecord!.class} liegt über der Schwelle ${risk.autoMergeUpTo}. ` : ''}Menschliche Freigabe erforderlich: /harness approve ${approvalId}`); continue;
          }
        }
        // Nothing waits for a person any more: the review lets the change through and no approval is (still) missing.
        phase = 'Übergabe-Label setzen';
        await this.needsHuman(live, false, liveOwner);
        if (review.decision === 'update_branch') {
          if (!this.config.merge.updateBranch || !behind(live, this.config) || live.unresolvedThreads.length ||
            ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(live.reviewDecision ?? '')) { this.note(number, 'gate', 'Branch-Aktualisierung ist nicht erlaubt oder durch offene Reviews blockiert.'); await this.explain(live, 'Branch-Aktualisierung ist nicht erlaubt oder durch offene Reviews blockiert.'); continue; }
          phase = 'Branch-Aktualisierung';
          this.note(number, 'branch-update', 'KI hat eine Branch-Aktualisierung veranlasst.');
          if (await this.updateBranch(live, snapshot, ownership, adopted, 'KI hat eine Branch-Aktualisierung veranlasst. Neue Tests und eine neue KI-Entscheidung sind vor dem Merge erforderlich.')) report.updated++;
          continue;
        }
        const gate = mergeGate(live, this.config);
        if (gate) { this.note(number, 'gate', gate); await this.explain(live, gate); continue; }
        await this.event(live, `merge-intent:${reviewKey}`, { type: 'merge_intent', prNumber: number, head: f.head, base: f.base, reviewKey });
        phase = 'GitHub-Merge';
        this.note(number, 'merging');
        const sha = await this.api.merge(number, f.head, this.config.merge.method); report.merged++;
        this.note(number, 'merged');
        f.state = 'closed'; f.mergeSha = sha;
        await this.event(live, `merge-completed:${f.head}`, { type: 'merge_completed', prNumber: number, head: f.head, mergeSha: sha },
          `**Gemergt.** Die KI hat den geprüften Commit freigegeben; GitHub hat den Merge bestätigt: \`${sha}\`.`);
        phase = 'Workflows nach Merge';
        await this.postMerge(live, sha);
      } catch (error) {
        const status = error instanceof Error && 'status' in error ? String(error.status) : 'unavailable';
        report.errors.push(`PR #${number}: review/update/merge not confirmed (${status}); no unreviewed merge performed`);
        this.note(number, 'error', `${phase} konnte nicht bestätigt werden (${status}).`);
        const reasons: Record<string, string> = {
          'Change set exceeds review file limit': 'Die Änderung überschreitet das konfigurierte Dateilimit für einen vollständigen KI-Review.',
          [contextLimitError]: 'Der vollständige Review-Kontext überschreitet das konfigurierte Größenlimit, auch bei Prüfung in Teilen (merge.review.maxParts); eine gekürzte Prüfung genügt nicht. Bitte den PR in kleinere PRs aufteilen.',
          [partsLimitError]: `Die Prüfung bräuchte mehr als ${this.config.merge.review.maxParts ?? defaultMaxParts} Teile (merge.review.maxParts). Bitte den PR in kleinere PRs aufteilen (workers.coding.smallPullRequests).`,
          'Diff is incomplete or contains binary changes': 'Der Diff ist unvollständig oder enthält nicht prüfbare Binäränderungen.',
          'File cannot be reviewed completely': 'Mindestens eine Datei kann nicht vollständig geprüft werden.',
          'Binary file cannot be reviewed': 'Eine Binärdatei kann die KI nicht prüfen.',
          'Merge review incomplete or refused': 'Die KI-Prüfung wurde nicht vollständig abgeschlossen oder abgelehnt.',
          'A real OpenAI merge reviewer is required': 'Für den KI-Review ist kein Modellschlüssel konfiguriert (beim Temporal-Broker: OPENAI_API_KEY in seiner Umgebung) oder die Konfiguration verlangt keinen echten Reviewer.',
          'fetch failed': 'Der Review-Anbieter ist nicht erreichbar.',
          'Merge review provider unavailable': 'Der Review-Anbieter hat die Anfrage abgelehnt oder ist nicht verfügbar.'
        };
        const message = error instanceof Error ? error.message : '';
        const path = error instanceof Error && 'path' in error && typeof error.path === 'string' ? error.path : null;
        const detail = `${reasons[message] ?? ''}${path ? ` Betroffene Datei: \`${path}\`.` : ''}`;
        // The same head always gives the same result: a person (or a new commit) has to take over, retrying changes nothing.
        if (f && permanentContextErrors.has(message)) {
          const why = `${phase} ist für diesen Stand nicht möglich. ${detail}`.trim();
          this.note(number, 'stopped', `${why} Ein neuer Commit startet die Prüfung neu.`);
          await this.explain(f, `${why} Die Factory prüft diesen Head nicht erneut und gibt keinen ungeprüften Stand frei. Ein neuer Commit auf dem Branch (etwa ohne die Datei, oder nachdem die Basis sie enthält) startet die Prüfung neu; sonst entscheidet ein Mensch über den PR.`).catch(() => {});
          await this.needsHuman(f, true).catch(() => {});
          continue;
        }
        if (f) await this.explain(f, `${phase} konnte nicht bestätigt werden (${status}). ${detail} Kein ungeprüfter Stand wird freigegeben; vorhandene Intents bleiben zur Wiederaufnahme erhalten.`).catch(() => {});
        break;
      }
    }
    return report;
  }
}
