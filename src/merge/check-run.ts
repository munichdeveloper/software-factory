import type { Octokit } from '@octokit/rest';
import type { MergeStep } from '../runtime/merge.js';

/**
 * The merge pass shown as a GitHub check run on the head of each pull request (issue #208): where it stands (review
 * running, approval needed, merged) and why, next to the repository's own checks. Display only: it never gates a merge,
 * the merge pass ignores its own check run, and a failure to write it never fails the pass.
 */
export const checkRunName = 'Software Factory / Merge';
export interface CheckRunView { status: 'in_progress' | 'completed'; conclusion?: 'success' | 'neutral' | 'action_required'; title: string; summary: string;
  /** Requested actions (buttons) of the check run; GitHub allows label and identifier up to 20 and description up to 40 characters. */
  actions?: { label: string; description: string; identifier: string }[] }
export interface MergeCheckRuns {
  show(pullRequest: number, head: string, view: CheckRunView): void;
  /** Whether the Factory has set its own check run on this head, whatever the token reading the checks can see. */
  has?(head: string): boolean;
}

const views: Record<MergeStep, { status: CheckRunView['status']; conclusion?: CheckRunView['conclusion']; title: string; summary: string }> = {
  checks: { status: 'in_progress', title: 'Wartet auf Pflichtprüfungen', summary: 'Die Factory prüft den PR, sobald die Pflichtprüfungen für diesen Stand grün sind.' },
  'checks-failed': { status: 'completed', conclusion: 'neutral', title: 'Pflichtprüfung fehlgeschlagen', summary: 'Eine Pflichtprüfung ist für diesen Stand fehlgeschlagen.' },
  conflict: { status: 'completed', conclusion: 'neutral', title: 'Merge-Konflikt', summary: 'Der Branch hat Konflikte mit der Basis.' },
  'branch-update': { status: 'completed', conclusion: 'neutral', title: 'Branch wird aktualisiert', summary: 'Die Factory aktualisiert den Branch; der neue Stand wird erneut geprüft.' },
  review: { status: 'in_progress', title: 'KI-Review läuft', summary: 'Das unabhängige KI-Review und die Risikobewertung laufen.' },
  'review-rejected': { status: 'completed', conclusion: 'action_required', title: 'KI-Review verlangt Änderungen', summary: 'Das KI-Review hat diesen Stand nicht freigegeben.' },
  'approval-required': { status: 'completed', conclusion: 'action_required', title: 'Freigabe nötig', summary: 'Der PR ist geprüft und wartet auf eine menschliche Freigabe.' },
  gate: { status: 'completed', conclusion: 'neutral', title: 'Merge blockiert', summary: 'Eine Merge-Bedingung ist nicht erfüllt.' },
  merging: { status: 'in_progress', title: 'Wird gemergt', summary: 'Die Factory mergt diesen Stand.' },
  merged: { status: 'completed', conclusion: 'success', title: 'Gemergt', summary: 'Der PR ist gemergt.' },
  handover: { status: 'completed', conclusion: 'action_required', title: 'An einen Menschen übergeben', summary: 'Die Factory mergt diesen PR nicht selbst.' },
  stopped: { status: 'completed', conclusion: 'neutral', title: 'Angehalten', summary: 'Die Factory bearbeitet diesen PR nicht weiter.' },
  waiting: { status: 'completed', conclusion: 'neutral', title: 'Wartet auf Vorgänger', summary: 'Der PR wartet auf einen Vorgänger (Depends on:); Review und Merge folgen danach.' },
  error: { status: 'completed', conclusion: 'neutral', title: 'Fehler im Merge-Durchlauf', summary: 'Der Merge-Durchlauf konnte einen Schritt nicht bestätigen; der nächste Durchlauf versucht es erneut.' }
};
/** The view of a merge step: the Factory's own texts only (detail is the broker's reason, never model or PR text). */
export function checkRunView(step: MergeStep, detail?: string | null, risk?: string | null, approvalId?: { id: string; overrule: boolean } | null): CheckRunView {
  const { status, conclusion, title, summary } = views[step];
  const reviewed = step === 'review' && risk;
  return { status, ...(conclusion ? { conclusion } : {}), title: reviewed ? `KI-Review fertig, Risiko ${risk}` : title,
    summary: [(detail ?? '').slice(0, 2000) || summary, risk ? `Risiko: ${risk}` : ''].filter(Boolean).join('\n\n'),
    ...(approvalId ? { actions: [approvalId.overrule
      ? { label: 'Überstimmen', description: 'Zurückstellung überstimmen', identifier: approvalIdentifier(approvalId.id) }
      : { label: 'Freigeben', description: 'Merge freigeben (wie /harness approve)', identifier: approvalIdentifier(approvalId.id) }] } : {}) };
}
/** The identifier of the button: a prefix of the approval id (head, base, review, risk), at most 20 characters. */
export const approvalIdentifier = (approvalId: string) => `a:${approvalId.slice(0, 18)}`;
/** Approvals the buttons of the check runs currently stand for, per pull request; an old button after a push matches nothing. */
export class CheckApprovals {
  private pending = new Map<number, { head: string; approvalId: string }>();
  set(pullRequest: number, head: string, approvalId: string) { this.pending.set(pullRequest, { head, approvalId }); }
  clear(pullRequest: number) { this.pending.delete(pullRequest); }
  get(pullRequest: number) { return this.pending.get(pullRequest); }
}

const forbidden = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && [401, 403, 422].includes(Number(error.status));
const sameView = (a: CheckRunView, b: { status: string; conclusion: string | null; output: { title: string | null; summary: string | null } }) =>
  a.status === b.status && (a.conclusion ?? null) === (b.conclusion ?? null) && !a.actions?.length && a.title === b.output.title && a.summary === b.output.summary;

/**
 * Writes the check runs of one repository with a token that holds checks:write only. Writes are queued one after
 * another and only when the view of a head changed; after a broker restart the existing check run of a head is
 * found by name and updated instead of a second one. Without the permission it pauses itself for `retryMs` (default
 * six hours, so a permission granted later takes effect without a restart) and says so once per pause.
 */
export class GitHubCheckRuns implements MergeCheckRuns {
  private queue: Promise<void> = Promise.resolve();
  private written = new Map<string, { id: number; view: string }>();
  private target: { owner: string; repo: string };
  private pausedUntil = -Infinity;
  constructor(private repository: string, private api: Pick<Octokit, 'checks'>, private log: (event: object) => void = e => console.warn(JSON.stringify(e)),
    private retryMs = 6 * 3600000, private now: () => number = Date.now) {
    const [owner, repo] = repository.split('/') as [string, string];
    this.target = { owner, repo };
  }
  has(head: string) { return this.written.has(head); }
  get disabled() { return this.now() < this.pausedUntil; }
  show(pullRequest: number, head: string, view: CheckRunView) {
    if (this.disabled) return;
    this.queue = this.queue.then(() => this.write(pullRequest, head, view)).catch((error: unknown) => {
      const status = error && typeof error === 'object' && 'status' in error ? String(error.status) : 'unavailable';
      if (forbidden(error)) { if (!this.disabled) this.log({ event: 'factory-check-run-disabled', repository: this.repository, status }); this.pausedUntil = this.now() + this.retryMs; }
      else this.log({ event: 'factory-check-run-failed', repository: this.repository, pullRequest, status });
    });
  }
  /** Resolves once every queued write has finished (tests, shutdown). */
  flush() { return this.queue; }
  private async write(pullRequest: number, head: string, view: CheckRunView) {
    if (this.disabled) return;
    const key = JSON.stringify(view), known = this.written.get(head);
    if (known?.view === key) return;
    let id = known?.id;
    if (id === undefined) {
      const { data } = await this.api.checks.listForRef({ ...this.target, ref: head, check_name: checkRunName, filter: 'latest', per_page: 10 });
      const existing = data.check_runs.find(r => r.name === checkRunName && r.head_sha === head);
      if (existing && sameView(view, existing)) { this.remember(head, existing.id, key); return; }
      id = existing?.id;
    }
    const body = { ...this.target, status: view.status, details_url: `https://github.com/${this.repository}/pull/${pullRequest}`,
      external_id: `sf-merge:${pullRequest}`, output: { title: view.title, summary: view.summary },
      ...(view.status === 'completed' ? { conclusion: view.conclusion ?? 'neutral', completed_at: new Date().toISOString() } : {}) };
    if (id === undefined) id = (await this.api.checks.create({ ...body, ...(view.actions ? { actions: view.actions } : {}), name: checkRunName, head_sha: head })).data.id;
    // An update always sets the actions, so the button of a former step disappears.
    else await this.api.checks.update({ ...body, actions: view.actions ?? [], check_run_id: id });
    this.remember(head, id, key);
  }
  private remember(head: string, id: number, view: string) {
    this.written.delete(head); this.written.set(head, { id, view });
    if (this.written.size > 500) this.written.delete(this.written.keys().next().value!);
  }
}
