import type { Config } from '../config/index.js';
import type { SanityAlertSink } from '../notifications/sanity-alerts.js';
import type { Snapshot } from '../types.js';
import type { EventWebhooks } from './webhooks.js';
import { admissionBackoffMinutes, infrastructureFailureCode, reconstruct, type Execution, type Task } from '../state/reconstruct.js';

/**
 * Runtime events (docs/failure-events.md, issue #188 step 1). The broker derives them from what every reconciliation
 * already knows: a failed independent validation, a refused start, a start that runs again after a refusal, a failed run
 * and a task that no automatic step can move any more. They cost no GitHub request.
 *
 * Events carry fixed codes and numbers only, never issue text, log lines or external error messages, so they may go to
 * Slack or a webhook. Every event has a key from its type, the execution and its code: deriving it again on the next
 * reconciliation stores nothing new.
 */
export const runtimeEventTypes = ['validation_failed', 'start_refused', 'start_resumed', 'run_failed', 'attention_required'] as const;
export type RuntimeEventType = typeof runtimeEventTypes[number];
export type EventValue = string | number | boolean | null | { name: string; exitCode: number | null }[];
export interface RuntimeEvent {
  key: string; type: RuntimeEventType; issueNumber: number; taskVersion: string; executionId: string | null;
  /** When the underlying fact happened (journal or runtime time), not when the broker noticed it. */
  at: string; data: Record<string, EventValue>;
}
/** Refusals that hold for every start of a repository until its installation or the host changes. */
export const repositoryWideRefusals = new Set(['EXECUTOR_WRAPPER_RELEASE_MISMATCH', 'UNKNOWN_WORKER_DEPLOYMENT_VERSION',
  'CODING_EXECUTOR_UNAVAILABLE', 'WORKER_READINESS_FAILED', 'POLICY_MISMATCH']);
export const attentionReasons = ['retries_exhausted', 'rework_exhausted', 'blocked_without_pr'] as const;

const code = (value: string | null | undefined) => value && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : null;
const resultAt = (task: Task, e: Execution) =>
  task.events.find(x => x.data.type === 'result' && x.data.result.executionId === e.input.executionId)?.at ?? e.runtime?.createdAt ?? e.at;

/** The events one reconciliation's view implies, for the current version of every open task. */
export function deriveEvents(tasks: Task[], config: Config): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const task of tasks.filter(t => t.issue.state === 'open')) {
    const n = task.issue.number, version = task.version;
    const current = task.executions.filter(e => e.input.taskVersion === version).sort((a, b) => a.attempt - b.attempt);
    const push = (type: RuntimeEventType, e: Execution | null, discriminator: string, at: string, data: Record<string, EventValue>) =>
      events.push({ key: `${type}:${e?.input.executionId ?? `${n}:${version.slice(0, 16)}`}${discriminator ? `:${discriminator}` : ''}`,
        type, issueNumber: n, taskVersion: version, executionId: e?.input.executionId ?? null, at, data });
    let refused = 0;
    for (const [i, e] of current.entries()) {
      if (e.rejected) {
        refused++;
        const at = resultAt(task, e);
        push('start_refused', e, code(e.rejected) ?? 'UNKNOWN', at, { code: code(e.rejected) ?? 'UNKNOWN', refusals: refused,
          retryAt: new Date(Date.parse(at) + admissionBackoffMinutes(refused) * 60000).toISOString(),
          repositoryWide: repositoryWideRefusals.has(e.rejected) });
        continue;
      }
      const before = current[i - 1];
      if (before?.rejected) {
        // Until a cleared cause is detected (concept 6.1), a start before the backoff ran out followed a changed grant or policy.
        const until = Date.parse(resultAt(task, before)) + admissionBackoffMinutes(refused) * 60000;
        push('start_resumed', e, '', e.at, { code: code(before.rejected) ?? 'UNKNOWN', refusals: refused,
          trigger: Date.parse(e.at) < until ? 'manual' : 'backoff' });
      }
      refused = 0;
      const validation = e.runtime?.validation;
      if (validation?.status === 'failed') {
        push('validation_failed', e, '', resultAt(task, e), { reason: code(validation.reason) ?? 'UNKNOWN', steps: validation.failed,
          validationRunId: validation.runId, attempt: e.attempt,
          next: task.latest === e && task.reworkable ? 'rework' : 'none' });
      }
      if (e.result && ['failed', 'cancelled'].includes(e.result.status)) {
        push('run_failed', e, '', resultAt(task, e), { status: e.result.status, error: code(e.result.error),
          infrastructure: e.result.error === infrastructureFailureCode, attempt: e.attempt,
          remainingAttempts: Math.max(0, config.execution.maxRetries + 1 - task.attemptsUsed) });
      }
    }
    const reason = attention(task, config);
    if (reason) push('attention_required', task.latest ?? null, reason, task.latest ? resultAt(task, task.latest) : task.issue.updatedAt ?? new Date(0).toISOString(),
      { reason, attempts: task.attemptsUsed, error: code(task.latest?.result?.error) });
  }
  return events;
}

/** Why no automatic step can move this task any more; null while the Factory can still act on its own. */
export function attention(task: Task, config: Config): typeof attentionReasons[number] | null {
  const latest = task.latest, active = task.executions.some(e => e.active);
  if (task.issue.state !== 'open' || active || !latest?.result) {
    // A Factory block without a pull request and without any attempt (specification, planner) also needs a person.
    return task.issue.state === 'open' && !active && blockedWithoutPr(task) ? 'blocked_without_pr' : null;
  }
  if (['failed', 'cancelled'].includes(latest.result.status) && task.attemptsUsed > config.execution.maxRetries) return 'retries_exhausted';
  if (latest.result.status === 'blocked' && latest.runtime?.validation?.status === 'failed' && !task.reworkable &&
    task.attemptsUsed > config.execution.maxRetries) return 'rework_exhausted';
  return blockedWithoutPr(task) ? 'blocked_without_pr' : null;
}
/** The same dead end the sanity check reports: blocked by the Factory, no pull request, not waiting for anything. */
const blockedWithoutPr = (task: Task) => task.status === 'blocked' && task.desiredStatus === 'blocked' && !task.hasOpenPR &&
  !task.blockReason?.startsWith('Unresolved dependencies') && !task.blockReason?.startsWith('Issue explicitly marked blocked');

export interface StoredRuntimeEvent extends RuntimeEvent { id: number; repository: string; recordedAt: string }
export interface RuntimeEventStore {
  /** Stores events not yet known by key; returns the ones that are new. */
  recordEvents(repositoryId: number, repository: string, events: RuntimeEvent[]): Promise<RuntimeEvent[]>;
  /** True exactly once per key and kind (Slack deduplication across reconciliations and broker restarts). */
  claimUsageAlert(key: string, kind: string): Promise<boolean>;
}

/** Only facts this recent are posted: the first reconciliation after a deploy records older ones silently. */
export const notifyWithinMs = 6 * 3600000;
const attentionText: Record<typeof attentionReasons[number], string> = {
  retries_exhausted: 'alle Versuche sind aufgebraucht', rework_exhausted: 'die Validierung scheitert auch nach allen Nachbesserungen',
  blocked_without_pr: 'die Aufgabe ist ohne PR blockiert',
};
const refusalHint: Record<string, string> = {
  EXECUTOR_WRAPPER_RELEASE_MISMATCH: 'Der Wrapper im Repository passt nicht zum Release des Hosts; die Factory-Version über den SF Manager ausrollen.',
  UNKNOWN_WORKER_DEPLOYMENT_VERSION: 'Der Host kennt die Worker-Version nicht; Deployment der Laufzeit prüfen.',
  CODING_EXECUTOR_UNAVAILABLE: 'Der Coding-Executor ist nicht erreichbar.',
  WORKER_READINESS_FAILED: 'Die Worker sind nicht bereit.',
  POLICY_MISMATCH: 'Die Policy des Repositories passt nicht zur Laufzeit.',
};
/** The Slack text of one event: repository, issue, what happened and what the Factory does next. Fixed codes only. */
export function eventText(repository: string, e: RuntimeEvent): string {
  const issue = `https://github.com/${repository}/issues/${e.issueNumber}`;
  if (e.type === 'attention_required') {
    return `SF braucht dich: ${repository}#${e.issueNumber}\nDie Factory kommt nicht mehr automatisch weiter: ${attentionText[e.data.reason as typeof attentionReasons[number]] ?? String(e.data.reason)} ` +
      `(${String(e.data.attempts)} Versuch(e)${e.data.error ? `, letzter Fehler ${String(e.data.error)}` : ''}).\n${issue}`;
  }
  if (e.type === 'start_refused') {
    return `SF Starts abgelehnt: ${repository}\nCode ${String(e.data.code)}; das betrifft alle Issues des Repositories. ${refusalHint[String(e.data.code)] ?? ''}`.trim() +
      `\n${e.data.retryAt ? `Nächster Versuch frühestens ${String(e.data.retryAt).slice(0, 16).replace('T', ' ')} UTC.` : 'Die Factory prüft bei jedem Abgleich erneut und startet, sobald die Ursache behoben ist.'} Zuerst gesehen bei ${issue}`;
  }
  if (e.type === 'validation_failed') {
    const steps = Array.isArray(e.data.steps) && e.data.steps.length ? e.data.steps.map(s => `${s.name} (Exit ${s.exitCode ?? '?'})`).join(', ') : String(e.data.reason);
    return `SF Validierung fehlgeschlagen: ${repository}#${e.issueNumber}\nSchritt: ${steps}. Nächster Schritt: ${e.data.next === 'rework' ? 'Nachbesserung startet automatisch' : 'keiner automatisch'}.` +
      `\n${issue}\nValidierungslauf: https://github.com/${repository}/actions/runs/${String(e.data.validationRunId)}`;
  }
  return `SF ${e.type}: ${repository}#${e.issueNumber}\n${issue}`;
}

/**
 * Refusals of the runtime's preflight (for example EXECUTOR_WRAPPER_RELEASE_MISMATCH): they happen before an intent, so
 * no journal holds them. The preflight runs again on every reconciliation, which is how such a start resumes as soon as
 * the cause is gone (concept 6.1); `cleared` lists the starts that followed a refusal of the previous reconciliation.
 */
export function preflightEvents(tasks: Task[], refused: ReadonlyMap<number, string>, before: ReadonlyMap<number, { code: string; version: string; at: string }>, now: Date): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const task of tasks.filter(t => t.issue.state === 'open')) {
    const n = task.issue.number, refusal = code(refused.get(n)), earlier = before.get(n);
    if (refusal) events.push({ key: `start_refused:${n}:${task.version.slice(0, 16)}:${refusal}`, type: 'start_refused', issueNumber: n, taskVersion: task.version,
      executionId: null, at: earlier?.code === refusal && earlier.version === task.version ? earlier.at : now.toISOString(),
      data: { code: refusal, refusals: 1, retryAt: null, repositoryWide: repositoryWideRefusals.has(refusal), stage: 'preflight' } });
    else if (earlier && earlier.version === task.version) {
      const started = task.executions.find(e => e.input.taskVersion === task.version && !e.rejected && e.at >= earlier.at);
      if (started) events.push({ key: `start_resumed:${started.input.executionId}:cleared`, type: 'start_resumed', issueNumber: n, taskVersion: task.version,
        executionId: started.input.executionId, at: started.at, data: { code: earlier.code, refusals: 1, trigger: 'cause_cleared' } });
    }
  }
  return events;
}

/** Records the events of every completed reconciliation. Never throws: events never block the Factory. */
export class RuntimeEvents {
  /** Preflight refusals of the previous reconciliation per repository (in memory: a broker restart starts over). */
  private preflight = new Map<number, Map<number, { code: string; version: string; at: string }>>();
  constructor(private store: RuntimeEventStore, private now: () => Date = () => new Date(), private alerts?: SanityAlertSink, private webhooks?: EventWebhooks) {}
  async observed(target: { repositoryId: number; repository: string }, config: Config, snapshot: Snapshot | undefined,
    refused: ReadonlyMap<number, string> = new Map()): Promise<RuntimeEvent[]> {
    if (!snapshot) return [];
    try {
      const tasks = reconstruct(snapshot, config, this.now());
      const pre = preflightEvents(tasks, refused, this.preflight.get(target.repositoryId) ?? new Map(), this.now());
      this.preflight.set(target.repositoryId, new Map(pre.filter(e => e.type === 'start_refused')
        .map(e => [e.issueNumber, { code: String(e.data.code), version: e.taskVersion, at: e.at }])));
      const found = [...deriveEvents(tasks, config), ...pre];
      const added = found.length ? await this.store.recordEvents(target.repositoryId, target.repository, found) : [];
      if (added.length) console.log(JSON.stringify({ event: 'factory-runtime-events', repositoryId: target.repositoryId,
        added: added.map(e => ({ type: e.type, issue: e.issueNumber, ...(e.data.code ? { code: e.data.code } : {}), ...(e.data.reason ? { reason: e.data.reason } : {}) })) }));
      await this.notify(target, config, added);
      return added;
    } catch {
      console.warn(JSON.stringify({ event: 'factory-runtime-events-failed', repositoryId: target.repositoryId }));
      return [];
    }
  }
  /**
   * Posts new events the configuration subscribes to (notifications.slack.events). Decision 3 of the concept: Slack is for
   * what needs a person (attention_required) and for refusals that stop a whole repository; every event stays in the
   * store and the monitor. At most once: a message lost to Slack is not repeated.
   */
  async notify(target: { repositoryId: number; repository: string }, config: Config, added: RuntimeEvent[]) {
    // Webhooks get every new event their rule names, also the ones Slack leaves out; stale ones (first reconciliation
    // after a deploy) are only stored, as for Slack.
    const fresh = added.filter(e => this.now().getTime() - Date.parse(e.at) <= notifyWithinMs);
    try { this.webhooks?.deliver(target, config.notifications.webhooks, fresh); } catch { /* never blocks the Factory */ }
    const slack = config.notifications.slack;
    if (!this.alerts || !slack.enabled) return;
    const now = this.now().getTime();
    for (const e of added) {
      if (e.type !== 'validation_failed' && e.type !== 'start_refused' && e.type !== 'attention_required') continue;
      const rule = slack.events[e.type], channel = rule?.channel ?? slack.channel;
      if (!rule?.enabled || !channel || now - Date.parse(e.at) > notifyWithinMs) continue;
      if (e.type === 'start_refused' && (!e.data.repositoryWide ||
        !await this.store.claimUsageAlert(`${target.repositoryId}:${String(e.data.code)}:${this.now().toISOString().slice(0, 10)}`, 'start_refused'))) continue;
      try { await this.alerts.post(channel, eventText(target.repository, e)); }
      catch { console.warn(JSON.stringify({ event: 'factory-runtime-event-alert-failed', repositoryId: target.repositoryId, type: e.type })); }
    }
  }
}
