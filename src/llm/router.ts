import { z } from 'zod';
import { countLlmCall } from './meter.js';
import { noteLlmSelection, withLlmContext } from './analytics.js';

/**
 * Model router (Johannes, 2026-11-19): before a model does the work, a decision model (TypeSafe Jev through the
 * OpenRouter Decisions API) picks which of the configured candidates (model and effort) fits the request best. The
 * candidate it picks then does the actual work. The router never blocks: without a key, on any failure and when Jev's
 * probability for its choice stays below the configured minimum, the caller uses its configured models as before, and the broker
 * reports that the router was not used.
 */
export type RouterPurpose = 'coding' | 'review' | 'risk' | 'planner';
export const routerPurposes: RouterPurpose[] = ['coding', 'review', 'risk', 'planner'];
/** Why the router was not used; fixed codes only, the provider's own text never leaves this module. */
export type RouterSkip = 'no-key' | 'low-confidence' | 'unavailable' | 'invalid-answer';
export const routerSkips: RouterSkip[] = ['no-key', 'low-confidence', 'unavailable', 'invalid-answer'];
export const routeRecordSchema = z.discriminatedUnion('used', [
  z.strictObject({ used: z.literal(true), purpose: z.enum(['coding', 'review', 'risk', 'planner']), choice: z.string().max(40),
    confidence: z.number().min(0).max(1), model: z.string().max(100) }),
  z.strictObject({ used: z.literal(false), purpose: z.enum(['coding', 'review', 'risk', 'planner']), reason: z.enum(['no-key', 'low-confidence', 'unavailable', 'invalid-answer']),
    /** HTTP status or a fixed transport code when Jev could not be asked. */
    code: z.string().regex(/^[A-Z0-9_]{1,40}$/).nullable(), choice: z.string().max(40).nullable(), confidence: z.number().min(0).max(1).nullable(), model: z.string().max(100) })
]);
export type RouteRecord = z.infer<typeof routeRecordSchema>;

export interface RouterSettings { model: string; minConfidence: number; timeoutSeconds: number }
export interface RouterOption { id: string; description?: string; agent?: string; provider?: string; model?: string; reasoningEffort?: string | null }
/**
 * What Jev reads of an option: the actual model, who runs it and its reasoning effort, then the repository's optional
 * note. Jev judges the concrete configurations, not a purpose hidden behind an id (Johannes, 2026-11-19).
 */
export function describeOption(option: RouterOption): string {
  const runner = option.agent ? `${option.agent} coding agent` : option.provider ? `${option.provider} API` : undefined;
  const facts = [option.model && `Model ${option.model}`, runner && `run by the ${runner}`, option.reasoningEffort && `reasoning effort ${option.reasoningEffort}`].filter(Boolean).join(', ');
  return [facts && `${facts}.`, option.description].filter(Boolean).join(' ') || option.id;
}

const questions: Record<RouterPurpose, string> = {
  coding: 'Which coding agent configuration should implement this software task? Pick the cheapest option that will still complete the task correctly; pick a stronger one only when the task needs deep reasoning, broad changes or careful design. Each option names a concrete model and reasoning effort. Judge every combination on its own: a smaller model at a higher effort can do better than a larger model at a lower effort, and the reverse.',
  review: 'Which model configuration should review this pull request before it is merged? Pick the cheapest option that can still find real correctness and security problems in a change of this size and kind. Each option names a concrete model and reasoning effort. Judge every combination on its own: a smaller model at a higher effort can do better than a larger model at a lower effort, and the reverse.',
  risk: 'Which model configuration should assess the merge risk of this pull request? Pick the cheapest option that can still judge the consequences of a mistake in a change of this size and kind. Each option names a concrete model and reasoning effort. Judge every combination on its own: a smaller model at a higher effort can do better than a larger model at a lower effort, and the reverse.',
  planner: 'Which model configuration should plan the next actions for these tasks? Pick the cheapest option that can still plan them correctly. Each option names a concrete model and reasoning effort. Judge every combination on its own: a smaller model at a higher effort can do better than a larger model at a lower effort, and the reverse.'
};
const decisionSchema = z.object({ answers: z.object({ route: z.object({ choice: z.string(), confidence: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number()).optional() }) }) });

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export const decisionsUrl = 'https://openrouter.ai/api/alpha/decisions';
/** TypeSafe's own API for Jev (docs.typesafe.ai/api/system-one): same questions and answers as OpenRouter's Decisions API. */
export const typesafeUrl = 'https://api.typesafe.ai/v1/systemone';
/**
 * Where the broker asks Jev (Johannes, 2026-11-19: "Mach das konfigurierbar und stelle auf direkte Jev api"):
 * `typesafe` with a TypeSafe key (TYPESAFE_API_KEY), or `openrouter` with an OpenRouter key (OPENROUTER_API_KEY).
 */
export type RouterApi = 'typesafe' | 'openrouter';
export interface RouterEndpoint { api: RouterApi; key: string | undefined }
/**
 * The endpoint from the broker's environment: FACTORY_ROUTER_API names it; without it TypeSafe is used when its key
 * is set, otherwise OpenRouter.
 */
export function routerEndpoint(env: Record<string, string | undefined>): RouterEndpoint {
  const api = z.enum(['typesafe', 'openrouter']).optional().parse(env.FACTORY_ROUTER_API || undefined)
    ?? (env.TYPESAFE_API_KEY ? 'typesafe' : 'openrouter');
  return { api, key: (api === 'typesafe' ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY)?.trim() || undefined };
}
/**
 * The model name for the endpoint: repositories configure OpenRouter's id (typesafe/jev-1.14); TypeSafe names the
 * same model jev-1.14.0 and accepts its aliases (jev-latest, jev-preview) as they are.
 */
export function endpointModel(api: RouterApi, model: string): string {
  if (api === 'openrouter') return model;
  const name = model.replace(/^typesafe\//, '');
  return /^jev-\d+\.\d+$/.test(name) ? `${name}.0` : name;
}
/** At most this many characters of the request reach Jev; more adds cost, not a better choice. */
export const maxRouterState = 8000;

/** A routing decision with Jev's probability per option (null where Jev gave none). */
export interface Decision { record: RouteRecord; probabilities: Record<string, number> | null }

export class ModelRouter {
  private key: string | undefined;
  readonly api: RouterApi;
  constructor(endpoint: RouterEndpoint | string | undefined, private fetcher: Fetcher = fetch) {
    const resolved = typeof endpoint === 'object' ? endpoint : { api: 'openrouter' as const, key: endpoint };
    this.key = resolved.key; this.api = resolved.api;
  }
  /** Never throws: an unusable answer comes back as a record with used false. */
  async route(purpose: RouterPurpose, state: string, options: RouterOption[], settings: RouterSettings): Promise<RouteRecord> {
    return (await this.decide(purpose, questions[purpose], state, options, settings)).record;
  }
  /**
   * Any choice question to Jev (the planner's start order and readiness ask their own): the decision record and Jev's
   * probability per option, where it gave them. Never throws.
   */
  async decide(purpose: RouterPurpose, question: string, state: string, options: RouterOption[], settings: RouterSettings): Promise<Decision> {
    let probabilities: Record<string, number> | null = null;
    const record = await this.ask(purpose, question, state, options, settings, p => { probabilities = p; });
    return { record, probabilities };
  }
  private async ask(purpose: RouterPurpose, question: string, state: string, options: RouterOption[], settings: RouterSettings,
    onProbabilities: (p: Record<string, number>) => void): Promise<RouteRecord> {
    const skip = (reason: RouterSkip, code: string | null = null, choice: string | null = null, confidence: number | null = null): RouteRecord =>
      ({ used: false, purpose, reason, code, choice, confidence, model: settings.model });
    if (!this.key) return skip('no-key');
    let response: Response;
    try {
      response = await this.fetcher(this.api === 'typesafe' ? typesafeUrl : decisionsUrl, { method: 'POST', signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
        headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: endpointModel(this.api, settings.model), state: state.slice(0, maxRouterState),
          questions: { route: { type: 'choice', instructions: question, criteria: Object.fromEntries(options.map(o => [o.id, describeOption(o)])) } } }) });
    } catch (error) {
      return skip('unavailable', error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT');
    }
    if (!response.ok) return skip('unavailable', `HTTP_${response.status}`);
    let answer: z.infer<typeof decisionSchema>['answers']['route'];
    try { answer = decisionSchema.parse(await response.json()).answers.route; }
    catch { return skip('invalid-answer', 'INVALID_JSON'); }
    if (!options.some(o => o.id === answer.choice)) return skip('invalid-answer', 'UNKNOWN_CHOICE');
    if (answer.probabilities) onProbabilities(Object.fromEntries(Object.entries(answer.probabilities).filter(([id, p]) => options.some(o => o.id === id) && Number.isFinite(p))));
    // The threshold applies to the probability Jev gives the chosen candidate. Jev's own `confidence` is a different
    // measure, (p_max - 1/n) / (1 - 1/n): 0 for an even split, so with two candidates a clear 66 % lean is only 32 %
    // confidence (docs.typesafe.ai/confidence; Johannes, 2026-11-19: constant "low confidence" fallbacks). Without
    // probabilities the probability is recovered from that formula.
    const n = options.length, probability = answer.probabilities?.[answer.choice]
      ?? (answer.confidence === undefined ? undefined : answer.confidence * (1 - 1 / n) + 1 / n);
    const confidence = probability === undefined || !Number.isFinite(probability) ? null : Math.min(1, Math.max(0, probability));
    if (confidence === null) return skip('invalid-answer', 'NO_CONFIDENCE', answer.choice);
    if (confidence < settings.minConfidence) return skip('low-confidence', null, answer.choice, confidence);
    return { used: true, purpose, choice: answer.choice, confidence, model: settings.model };
  }
}

/** One log line per routing decision: fixed codes, ids and numbers only. */
export function logRoute(repository: string, record: RouteRecord) {
  console.log(JSON.stringify({ event: 'factory-router', repository, ...record }));
}

export interface RouterAlertSink { post(channel: string, text: string): Promise<void> }
/** The pull request or issue a routing decision was made for, named with its link in the Slack message. */
export interface RouteSubject { kind: 'pull' | 'issue'; number: number }
/** `owner/repo PR #12` or `owner/repo Issue #12`, and the link on its own line (Johannes, 2026-11-22: "um welchen PR es sich handelt"). */
export function subjectText(repository: string, subject?: RouteSubject): { name: string; link: string | null } {
  if (!subject) return { name: repository, link: null };
  return { name: `${repository} ${subject.kind === 'pull' ? 'PR' : 'Issue'} #${subject.number}`,
    link: `https://github.com/${repository}/${subject.kind === 'pull' ? 'pull' : 'issues'}/${subject.number}` };
}
const purposeNames: Record<RouterPurpose, string> = { coding: 'Coding', review: 'Merge-Review', risk: 'Risikobewertung', planner: 'Planung' };
const skipTexts: Record<RouterSkip, string> = {
  'no-key': 'Der Broker hat keinen Schlüssel für Jev (TYPESAFE_API_KEY oder OPENROUTER_API_KEY).',
  unavailable: 'Jev war nicht erreichbar',
  'invalid-answer': 'Jev hat keine verwertbare Antwort geliefert',
  'low-confidence': 'Jev war sich zu unsicher: die Wahrscheinlichkeit seiner Wahl lag unter router.minConfidence'
};
/** At most one message per repository, purpose and reason in this window; the next one counts the skipped cases. */
export const routerAlertWindowMs = 6 * 3600000;

/**
 * Slack messages about the router (Johannes, 2026-11-19): every decision Jev made, and when the router was not used and
 * the configured models ran instead. The latter are throttled in memory: one message per repository, purpose and reason
 * every six hours, naming how often it happened meanwhile.
 */
/** What a candidate names beyond its id, when the caller's candidates carry it (coding: agent, model, effort). */
export interface ChosenDetails { agent?: unknown; model?: unknown; reasoningEffort?: unknown }

/**
 * Jev's full scores for a Slack message, highest first (Johannes, 2026-11-21: "immer die vollständigen Scores, nicht
 * nur der Gewinner"). Undefined when Jev gave no probability per option.
 */
export function scoreLine(probabilities: Record<string, number> | null | undefined): string | undefined {
  const entries = Object.entries(probabilities ?? {}).filter(([, p]) => Number.isFinite(p)).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return undefined;
  const shown = entries.slice(0, maxScoreEntries).map(([id, p]) => `\`${id}\` ${String(Math.round(p * 1000) / 10).replace('.', ',')} %`);
  return `Alle Bewertungen: ${shown.join(', ')}${entries.length > maxScoreEntries ? `, und ${entries.length - maxScoreEntries} weitere` : ''}`;
}
const maxScoreEntries = 20;

export class RouterAlerts {
  private last = new Map<string, { at: number; suppressed: number }>();
  constructor(private sink: RouterAlertSink, private channel: string, private now: () => number = Date.now, private windowMs = routerAlertWindowMs) {}
  async observe(repository: string, record: RouteRecord, chosen?: RouterOption & ChosenDetails, probabilities?: Record<string, number> | null,
    subject?: RouteSubject): Promise<void> {
    const scores = scoreLine(probabilities), { name, link } = subjectText(repository, subject);
    if (record.used) {
      // Every decision Jev made gets its own message, unthrottled (Johannes, 2026-11-19: "welche Entscheidung Jev
      // erfolgreich getroffen hat"): one per coding execution, merge review or risk assessment.
      const details = chosen ? [chosen.agent, chosen.model, chosen.reasoningEffort].filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
      await this.sink.post(this.channel, `SF Model Router: Jev hat für ${purposeNames[record.purpose]} in ${name} \`${record.choice}\`${details.length ? ` (${details.join(', ')})` : ''} gewählt, mit ${Math.round(record.confidence * 100)} % Wahrscheinlichkeit.${link ? `\n${link}` : ''}${scores ? `\n${scores}` : ''}`);
      return;
    }
    const key = `${repository}|${record.purpose}|${record.reason}`, prior = this.last.get(key), now = this.now();
    if (prior && now - prior.at < this.windowMs) { prior.suppressed++; return; }
    this.last.set(key, { at: now, suppressed: 0 });
    const detail = record.reason === 'low-confidence' && record.choice !== null && record.confidence !== null
      ? ` (gewählt hätte er ${record.choice} mit ${Math.round(record.confidence * 100)} %)` : record.code ? ` (${record.code})` : '';
    await this.sink.post(this.channel, [`SF Model Router: ${purposeNames[record.purpose]} in ${name} lief ohne Router, direkt mit den konfigurierten Modellen.`,
      ...(link ? [link] : []),
      `Grund: ${skipTexts[record.reason]}${record.reason === 'no-key' ? '' : `${detail}.`}`,
      ...(scores ? [scores] : []),
      ...(prior?.suppressed ? [`Seit der letzten Meldung ${prior.suppressed}-mal ohne eigene Nachricht.`] : []),
      `(Höchstens eine Meldung je Repository, Zweck und Grund alle ${Math.round(this.windowMs / 3600000)} Stunden.)`].join('\n'));
  }
}

/** The router as the broker uses it: decide, log, and report every case in which the configured models ran instead. */
export class Routing {
  constructor(private router: ModelRouter, private alerts?: RouterAlerts) {}
  async route(repository: string, purpose: RouterPurpose, state: string, options: RouterOption[], settings: RouterSettings, subject?: RouteSubject): Promise<RouteRecord> {
    const decision = await this.router.decide(purpose, questions[purpose], state, options, settings);
    return this.observed(repository, decision.record, options, decision.probabilities, subject);
  }
  /** A choice question of the caller's own (the Jev planner), logged and reported like a routing decision. */
  async decide(repository: string, purpose: RouterPurpose, question: string, state: string, options: RouterOption[], settings: RouterSettings,
    subject?: RouteSubject): Promise<Decision> {
    const decision = await this.router.decide(purpose, question, state, options, settings);
    await this.observed(repository, decision.record, options, decision.probabilities, subject);
    return decision;
  }
  private async observed(repository: string, record: RouteRecord, options: RouterOption[], probabilities?: Record<string, number> | null,
    subject?: RouteSubject): Promise<RouteRecord> {
    logRoute(repository, record);
    const chosen = record.used ? options.find(o => o.id === record.choice) as (RouterOption & ChosenDetails) | undefined : undefined;
    try { await this.alerts?.observe(repository, record, chosen, probabilities, subject); } catch { /* an alert never fails the work */ }
    return record;
  }
}

/** What a routed broker call did: the decision, the candidate it named, and who did the work. */
export interface RouteOutcome { record: RouteRecord; candidate: { id: string; model: string; reasoningEffort: string | null } | null;
  /** jev: Jev gave the answer himself (risk class, Johannes 2026-11-21); configured: the configured models did the work. */
  ran: 'candidate' | 'configured' | 'jev';
  /** Jev was asked for the answer itself, not for a model: the comment says who assessed instead of which model was chosen. */
  direct?: boolean }
const outcomes = new WeakMap<object, RouteOutcome>();
/** Records what produced a result, for the comment that reports it (routeOutcome). */
export const noteOutcome = <T>(value: T, outcome: RouteOutcome): T => { if (value && typeof value === 'object') outcomes.set(value, outcome); return value; };
/** The outcome routedCall recorded for a result it returned, so the comment reporting that result can name the model. */
export const routeOutcome = (value: unknown): RouteOutcome | undefined => value && typeof value === 'object' ? outcomes.get(value) : undefined;
const pct = (confidence: number) => `${Math.round(confidence * 100)} %`;
const skipDe: Record<RouterSkip, string> = { 'no-key': 'kein Jev-Schlüssel im Broker', unavailable: 'Jev nicht erreichbar',
  'invalid-answer': 'keine verwertbare Antwort von Jev', 'low-confidence': 'Jev zu unsicher' };
const skipEn: Record<RouterSkip, string> = { 'no-key': 'no Jev key on the broker', unavailable: 'Jev was unreachable',
  'invalid-answer': 'Jev gave no usable answer', 'low-confidence': "Jev's choice was below the minimum probability" };
/** One German line for the merge comments (review, risk): which model did the work and why. */
export function routeNoteDe(outcome: RouteOutcome | undefined): string {
  if (!outcome) return '';
  const { record, candidate } = outcome;
  if (outcome.ran === 'jev') return `Bewertung: Jev (${record.model}) hat die Risikoklasse direkt bestimmt.`;
  if (outcome.direct) return `Bewertung: ohne Jev (${record.used ? 'Jev hat keine verwertbare Klasse genannt' : skipDe[record.reason]}${!record.used && record.reason === 'low-confidence' && record.confidence !== null ? `, ${pct(record.confidence)}` : ''}); bewertet haben die konfigurierten Modelle.`;
  if (outcome.ran === 'candidate' && record.used && candidate)
    return `Modellwahl: Der Model Router (Jev) wählte \`${candidate.id}\` (${candidate.model}${candidate.reasoningEffort ? `, ${candidate.reasoningEffort}` : ''}) mit ${pct(record.confidence)} Wahrscheinlichkeit.`;
  if (record.used) return `Modellwahl: Der Model Router wählte \`${record.choice}\`, der Kandidat konnte nicht laufen; geprüft haben die konfigurierten Modelle.`;
  return `Modellwahl: ohne Model Router (${skipDe[record.reason]}${record.reason === 'low-confidence' && record.confidence !== null ? `, ${pct(record.confidence)}` : ''}); geprüft haben die konfigurierten Modelle.`;
}
/** One English line for a task's status comment: which agent a coding execution runs and why. */
export function routeNoteEn(record: RouteRecord, agent: { agent: string; model: string; reasoningEffort: string } | null): string {
  if (record.used && agent) return `**Model:** chosen by the model router (Jev): \`${record.choice}\` (${agent.agent}, ${agent.model}, ${agent.reasoningEffort}), ${pct(record.confidence)} probability.`;
  if (record.used) return `**Model:** the model router chose \`${record.choice}\`; the configured agents run.`;
  return `**Model:** the configured agents; the model router was not used (${skipEn[record.reason]}${record.reason === 'low-confidence' && record.confidence !== null ? `, ${pct(record.confidence)}` : ''}).`;
}

/**
 * A broker-side model call through the router: the routed candidate does the work when the router picked one and that
 * candidate can run; otherwise, and when the routed candidate fails, `configured` (the repository's configured models)
 * does it. `fatal` errors (a configuration guard) are never retried with the configured models.
 */
export async function routedCall<C extends RouterOption & { model: string; reasoningEffort?: string | null }, T>(options: {
  routing: Routing | undefined; repository: string; purpose: Exclude<RouterPurpose, 'coding'>; state: () => string;
  /** The pull request or issue the call works on, named in the Slack message. */
  subject?: RouteSubject;
  router: (RouterSettings & { enabled: boolean }) | undefined; candidates: C[] | undefined;
  /** The routed candidate's call, or null when it cannot run here (e.g. a Claude candidate without the broker's key). */
  run: (candidate: C) => (() => Promise<T>) | null;
  configured: () => Promise<T>; fatal?: (error: unknown) => boolean;
}): Promise<T> {
  // Analytics: every model call below belongs to this repository and step; the router's outcome is noted once known.
  return withLlmContext({ repository: options.repository, step: options.purpose, selection: 'configured', routerChoice: null, routerProbability: null }, () => routedCallIn(options));
}
async function routedCallIn<C extends RouterOption & { model: string; reasoningEffort?: string | null }, T>(options: Parameters<typeof routedCall<C, T>>[0]): Promise<T> {
  const { routing, router, candidates } = options;
  countLlmCall(options.repository, options.purpose);
  if (!routing || !router?.enabled || !candidates?.length) return options.configured();
  const record = await routing.route(options.repository, options.purpose, options.state(), candidates, router, options.subject);
  const candidate = record.used ? candidates.find(c => c.id === record.choice) : undefined;
  const named = candidate ? { id: candidate.id, model: candidate.model, reasoningEffort: candidate.reasoningEffort ?? null } : null;
  const noted = (value: T, ran: RouteOutcome['ran']): T => { if (value && typeof value === 'object') outcomes.set(value, { record, candidate: named, ran }); return value; };
  const call = candidate ? options.run(candidate) : null;
  noteLlmSelection(call ? 'router' : 'configured', record.choice ?? null, record.confidence ?? null);
  if (!call) {
    if (candidate) console.warn(JSON.stringify({ event: 'factory-router-candidate', repository: options.repository, purpose: options.purpose, choice: candidate.id, outcome: 'unavailable' }));
    return noted(await options.configured(), 'configured');
  }
  try { return noted(await call(), 'candidate'); }
  catch (error) {
    if (options.fatal?.(error)) throw error;
    console.warn(JSON.stringify({ event: 'factory-router-candidate', repository: options.repository, purpose: options.purpose, choice: candidate!.id, outcome: 'failed' }));
    noteLlmSelection('configured', record.choice ?? null, record.confidence ?? null);
    return noted(await options.configured(), 'configured');
  }
}
