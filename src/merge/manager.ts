import type { Config } from '../config/index.js';
import type { Snapshot } from '../types.js';
import { decodeEvent, encodeEvent, type HarnessEvent } from '../state/events.js';
import { hash, taskVersion } from '../state/identity.js';
import type { GitHubPort } from '../github/port.js';
import { permission, policyVersion } from '../policies/engine.js';
import { mergeReviewSchema, type MergeFacts, type MergePort, type MergeReviewer } from './contract.js';

const safe = (s: string) => s.replaceAll('@', '@\u200b').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const factsKey = (f: MergeFacts) => ({ ...f, comments: [], labels: [...f.labels].sort(),
  nativeRequiredChecks: [...f.nativeRequiredChecks].sort(),
  checks: [...f.checks].sort((a, b) => `${a.name}:${a.state}`.localeCompare(`${b.name}:${b.state}`)) });
export function mergeGate(f: MergeFacts, config: Config): string | null {
  if (f.state !== 'open' || f.draft || !f.sameRepository) return 'PR ist geschlossen, ein Entwurf oder stammt aus einem anderen Repository/Zielbranch.';
  if (f.labels.includes('sf:blocked') || f.labels.includes('harness:blocked')) return 'PR wurde ausdrücklich blockiert.';
  if (f.unresolvedThreads.length) return 'Es gibt ungelöste Review-Diskussionen.';
  if (f.reviewDecision === 'CHANGES_REQUESTED' || f.reviewDecision === 'REVIEW_REQUIRED') return 'GitHub verlangt Änderungen oder zusätzliche Reviews.';
  if (!f.strictChecks || !f.nativeRequiredChecks.length) return 'Serverseitige PR-Regeln mit strikt aktuellen Pflichtprüfungen sind erforderlich.';
  if (f.mergeState !== 'CLEAN') return `GitHub meldet ${f.mergeState}; kein Merge bei veraltetem, blockiertem oder unklarem Stand.`;
  for (const name of new Set([...config.merge.requiredChecks, ...f.nativeRequiredChecks])) {
    const checks = f.checks.filter(c => c.name === name);
    if (!checks.length || checks.some(c => c.state !== 'success')) return `Prüfung ${name} fehlt, läuft noch oder ist nicht erfolgreich.`;
  }
  if (f.checks.some(c => !['success', 'neutral', 'skipped'].includes(c.state))) return 'Mindestens eine weitere Prüfung ist offen oder fehlgeschlagen.';
  return null;
}

export class MergeManager {
  constructor(private api: MergePort, private config: Config, private reviewer: MergeReviewer, private correlationId: string,
    private tasks?: Pick<GitHubPort, 'getIssue'>) {}
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
      { type: 'merge_status', head: f.head, base: f.base, reason }, `**Noch kein Merge.** ${reason}\n\nGeprüfter Head: \`${f.head}\`; Basis: \`${f.base}\`.`);
  }
  private owned(f: MergeFacts, snapshot: Snapshot) {
    return snapshot.issues.find(i => (snapshot.comments.get(i.number) ?? []).some(c => {
      const e = decodeEvent(c, this.config.manager.trustedActors);
      return e?.data.type === 'result' && f.headBranch === `sf/issue-${i.number}/${e.data.result.executionId}` &&
        e.data.result.artifacts.includes(`https://github.com/${this.api.repository}/pull/${f.number}`);
    }));
  }
  private eligible(f: MergeFacts, snapshot: Snapshot) { return f.labels.includes(this.config.merge.adoptLabel) ||
    (this.config.merge.includeFactoryPRs && !!this.owned(f, snapshot)); }
  private async dispatch(f: MergeFacts, workflow: string, ref: string, sha: string) {
    const key = `merge-ci:${hash({ workflow, ref, sha })}`;
    if (this.events(f).some(e => e.key === key)) return;
    await this.api.dispatch(workflow, ref);
    await this.event(f, key, { type: 'workflow_dispatch', workflow, ref, sha });
  }
  async run(snapshot: Snapshot) {
    const report: { reviewed: number; updated: number; merged: number; errors: string[] } = { reviewed: 0, updated: 0, merged: 0, errors: [] };
    if (!this.config.factory.enabled || !this.config.merge.enabled || this.config.execution.dryRun || this.config.autonomy.profile === 'advisory') return report;
    if (permission(this.config, 'merge_pr') === 'deny') return report;
    for (const number of await this.api.candidates()) {
      if (report.reviewed >= this.config.merge.maxReviewsPerRun || report.updated + report.merged >= this.config.merge.maxActionsPerRun) break;
      let f: MergeFacts | undefined;
      let phase = 'GitHub-Zustand lesen';
      try {
        f = await this.api.facts(number);
        if (!this.eligible(f, snapshot)) continue;
        if (f.state === 'closed') {
          if (f.mergeSha && f.mergeActorType === 'Bot' && this.events(f).some(e => e.data.type === 'merge_intent' && e.data.head === f!.head)) {
            await this.event(f, `merge-completed:${f.head}`, { type: 'merge_completed', prNumber: number, head: f.head, mergeSha: f.mergeSha });
            for (const workflow of this.config.merge.postMergeWorkflows) await this.dispatch(f, workflow, f.baseBranch, f.mergeSha);
          }
          continue;
        }
        const owner = this.owned(f, snapshot);
        if (owner && (owner.state === 'closed' || owner.labels.includes('harness:blocked'))) { await this.explain(f, 'Die zugehörige Aufgabe wurde geschlossen oder blockiert.'); continue; }
        if (f.state !== 'open' || f.draft || !f.sameRepository || f.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l))) {
          await this.explain(f, 'PR ist nicht offen/freigegeben, stammt aus einem Fork/falschen Zielbranch oder wurde ausdrücklich blockiert.'); continue;
        }
        const pendingUpdate = this.events(f).find(e => e.data.type === 'branch_update' && e.data.base === f!.base && e.data.head !== f!.head);
        if (pendingUpdate) await this.dispatch(f, this.config.merge.validationWorkflow, f.headBranch, f.head);
        report.reviewed++;
        phase = 'Vollständigen Änderungskontext laden';
        const input = await this.api.context(f, this.config.merge.review.maxFiles, this.config.merge.review.maxContextBytes);
        if (owner) input.sourceTask = { number: owner.number, title: owner.title, body: owner.body };
        if (Buffer.byteLength(JSON.stringify({ ...input, facts: factsKey(f) })) > this.config.merge.review.maxContextBytes) throw new Error('Review context exceeds limit; no truncated approval');
        const reviewKey = hash({ repository: this.api.repository.toLowerCase(), ...input, facts: factsKey(f), merge: this.config.merge, policy: policyVersion(this.config) });
        const cached = this.events(f).find(e => e.data.type === 'merge_review' && e.data.reviewKey === reviewKey);
        phase = 'KI-Review';
        const review = cached?.data.type === 'merge_review' ? cached.data.review : mergeReviewSchema.parse(await this.reviewer.review(input));
        await this.event(f, `merge-review:${reviewKey}`, { type: 'merge_review', head: f.head, base: f.base, reviewKey, review },
          `**KI-Entscheidung: ${review.decision}**\n\n${review.reason}\n\n${review.findings.map(x => `- ${x.severity}: ${x.path} – ${x.explanation}`).join('\n')}\n\nHead: \`${f.head}\`; Basis: \`${f.base}\`.`);
        if (review.findings.some(x => x.severity === 'blocking') || ['request_changes', 'defer'].includes(review.decision)) continue;
        const live = await this.api.facts(number);
        if (hash(factsKey(live)) !== hash(factsKey(f)) || !this.eligible(live, snapshot) || live.state !== 'open' || live.draft || !live.sameRepository ||
          live.labels.some(l => ['sf:blocked', 'harness:blocked'].includes(l))) { await this.explain(live, 'PR, Head, Basis oder Freigabe hat sich während der KI-Prüfung geändert; erneute Prüfung erforderlich.'); continue; }
        if (owner) {
          const liveOwner = this.tasks ? await this.tasks.getIssue(owner.number) : owner;
          if (liveOwner.state !== 'open' || liveOwner.labels.includes('harness:blocked') || !liveOwner.labels.includes('harness:managed') ||
            taskVersion(liveOwner) !== taskVersion(owner)) {
            await this.explain(live, 'Die zugehörige Aufgabe wurde während des Reviews geschlossen, blockiert, abgemeldet oder fachlich verändert.'); continue;
          }
        }
        if (permission(this.config, 'merge_pr') === 'approval') {
          const approvalId = hash({ repository: this.api.repository, number, head: f.head, base: f.base, reviewKey, review });
          let approved = false;
          for (const c of live.comments) {
            const match = c.body.trim().match(/^\/harness (approve|revoke) ([a-f0-9]{64})$/);
            if (match?.[2] === approvalId && await this.api.canApprove(c.author)) approved = match[1] === 'approve';
          }
          if (!approved) { await this.explain(live, `Menschliche Freigabe erforderlich: /harness approve ${approvalId}`); continue; }
        }
        if (review.decision === 'update_branch') {
          if (!this.config.merge.updateBranch || live.mergeState !== 'BEHIND' || live.unresolvedThreads.length ||
            ['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(live.reviewDecision ?? '')) { await this.explain(live, 'Branch-Aktualisierung ist nicht erlaubt oder durch offene Reviews blockiert.'); continue; }
          const key = `branch-update:${hash({ head: f.head, base: f.base })}`;
          if (this.events(live).some(e => e.key === key)) { await this.explain(live, 'Branch-Aktualisierung wurde bereits angefordert; GitHub-Status prüfen.'); continue; }
          await this.event(live, key, { type: 'branch_update', head: f.head, base: f.base });
          phase = 'Branch-Aktualisierung';
          const head = await this.api.update(number, f.head); report.updated++;
          const updated = await this.api.facts(number);
          if (updated.head !== head) { await this.explain(updated, 'Branch wurde erneut verändert; keine Freigabe für den ungeprüften Stand.'); continue; }
          await this.dispatch(updated, this.config.merge.validationWorkflow, updated.headBranch, head);
          await this.explain(updated, 'KI hat eine Branch-Aktualisierung veranlasst. Neue Tests und eine neue KI-Entscheidung sind vor dem Merge erforderlich.');
          continue;
        }
        const gate = mergeGate(live, this.config);
        if (gate) { await this.explain(live, gate); continue; }
        await this.event(live, `merge-intent:${reviewKey}`, { type: 'merge_intent', prNumber: number, head: f.head, base: f.base, reviewKey });
        phase = 'GitHub-Merge';
        const sha = await this.api.merge(number, f.head, this.config.merge.method); report.merged++;
        await this.event(live, `merge-completed:${f.head}`, { type: 'merge_completed', prNumber: number, head: f.head, mergeSha: sha },
          `**Gemergt.** Die KI hat den geprüften Commit freigegeben; GitHub hat den Merge bestätigt: \`${sha}\`.`);
        phase = 'Workflows nach Merge';
        for (const workflow of this.config.merge.postMergeWorkflows) await this.dispatch(live, workflow, f.baseBranch, sha);
      } catch (error) {
        const status = error instanceof Error && 'status' in error ? String(error.status) : 'unavailable';
        report.errors.push(`PR #${number}: review/update/merge not confirmed (${status}); no unreviewed merge performed`);
        const reasons: Record<string, string> = {
          'Change set exceeds review file limit': 'Die Änderung überschreitet das konfigurierte Dateilimit für einen vollständigen KI-Review.',
          'Review context exceeds limit; no truncated approval': 'Der vollständige Review-Kontext überschreitet das konfigurierte Größenlimit; eine gekürzte Prüfung genügt nicht.',
          'Diff is incomplete or contains binary changes': 'Der Diff ist unvollständig oder enthält nicht prüfbare Binäränderungen.',
          'File cannot be reviewed completely': 'Mindestens eine Datei kann nicht vollständig geprüft werden.',
          'Merge review incomplete or refused': 'Die KI-Prüfung wurde nicht vollständig abgeschlossen oder abgelehnt.'
        };
        const detail = error instanceof Error ? reasons[error.message] ?? '' : '';
        if (f) await this.explain(f, `${phase} konnte nicht bestätigt werden (${status}). ${detail} Kein ungeprüfter Stand wird freigegeben; vorhandene Intents bleiben zur Wiederaufnahme erhalten.`).catch(() => {});
        break;
      }
    }
    return report;
  }
}
