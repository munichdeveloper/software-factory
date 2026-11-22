import { Pool, type PoolClient } from 'pg';
import { usageRecordSchema, type UsageEntry, type UsageRecord } from './usage.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { snapshotSchema, type RunSnapshot } from './contract.js';
import { workerResultSchema, type WorkerResult } from '../workers/contract.js';
import { codingArtifactSchema, type CodingArtifact } from '../workers/coding.js';
import { hash } from '../state/identity.js';
import { validationReportSchema, type ValidationReport } from './validation-contract.js';
import type { Finding, FindingKind, SanityStore } from './sanity.js';
import type { LlmCallRecord, LlmVerdictRecord } from '../llm/analytics.js';
import { tokensOf, type AnalyticsCall, type AnalyticsIssue, type AnalyticsVerdict } from './analytics.js';
import { escalationMarker } from './coding-context.js';
import type { RuntimeEvent, RuntimeEventStore, RuntimeEventType, StoredRuntimeEvent } from './events.js';

export interface Registration { repositoryId: number; repository: string; githubInstallationId: number }
export interface StoredRun {
  snapshot: RunSnapshot; binding: string; workflowId: string; runId: string | null; createdAt: string;
  approved: boolean; cancelled: boolean; terminal: boolean; result: WorkerResult | null;
}
type Row = { snapshot: unknown; binding: string; workflow_id: string; run_id: string | null; created_at: Date;
  approved: boolean; cancelled: boolean; terminal: boolean; result: unknown };
const decode = (row: Row): StoredRun => ({ snapshot: snapshotSchema.parse(row.snapshot), binding: row.binding,
  workflowId: row.workflow_id, runId: row.run_id, createdAt: row.created_at.toISOString(), approved: row.approved,
  cancelled: row.cancelled, terminal: row.terminal, result: row.result === null ? null : workerResultSchema.parse(row.result) });
export interface StoredFinding extends Finding { firstSeen: string; lastSeen: string; resolvedAt: string | null }
export class RuntimeStore implements SanityStore, RuntimeEventStore {
  private context = new AsyncLocalStorage<PoolClient>();
  private db() { return this.context.getStore() ?? this.pool; }
  constructor(readonly pool: Pool) {}
  async migrate() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS factory_runtime_runs (
      repository_id bigint NOT NULL, execution_id text NOT NULL, snapshot jsonb NOT NULL, binding text NOT NULL,
      workflow_id text NOT NULL UNIQUE, run_id uuid, approved boolean NOT NULL DEFAULT false,
      cancelled boolean NOT NULL DEFAULT false, terminal boolean NOT NULL DEFAULT false,
      result jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(repository_id,execution_id));
      CREATE TABLE IF NOT EXISTS factory_runtime_effects (
        repository_id bigint NOT NULL, execution_id text NOT NULL, effect text NOT NULL,
        payload_hash text NOT NULL, phase text NOT NULL, PRIMARY KEY(repository_id,execution_id,effect));
      CREATE TABLE IF NOT EXISTS factory_runtime_approvals (
        repository_id bigint NOT NULL, execution_id text NOT NULL, binding text NOT NULL, actor text NOT NULL,
        approved boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE factory_runtime_effects ADD COLUMN IF NOT EXISTS receipt jsonb;
      CREATE TABLE IF NOT EXISTS factory_runtime_artifacts (
        repository_id bigint NOT NULL, execution_id text NOT NULL, digest text NOT NULL, artifact jsonb NOT NULL,
        PRIMARY KEY(repository_id,execution_id));
      ALTER TABLE factory_runtime_artifacts ADD COLUMN IF NOT EXISTS validation jsonb;
      ALTER TABLE factory_runtime_artifacts ADD COLUMN IF NOT EXISTS validation_digest text;
      CREATE TABLE IF NOT EXISTS factory_runtime_registrations (
        repository_id bigint PRIMARY KEY, repository text NOT NULL, installation_id bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS factory_runtime_findings (
        repository_id bigint NOT NULL, key text NOT NULL, kind text NOT NULL, issue_number integer, detail text NOT NULL,
        first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL, resolved_at timestamptz,
        PRIMARY KEY(repository_id,key));
      CREATE TABLE IF NOT EXISTS factory_runtime_credit_alerts (
        agent text NOT NULL, kind text NOT NULL, sent integer NOT NULL DEFAULT 0, last_execution text,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent,kind));
      CREATE TABLE IF NOT EXISTS factory_runtime_usage (
        repository_id bigint NOT NULL, execution_id text NOT NULL, repository text NOT NULL, issue_number integer NOT NULL,
        run_id bigint NOT NULL, record jsonb NOT NULL, cost_usd double precision, recorded_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(repository_id,execution_id));
      CREATE INDEX IF NOT EXISTS factory_runtime_usage_day ON factory_runtime_usage(repository_id, recorded_at);
      ALTER TABLE factory_runtime_usage ADD COLUMN IF NOT EXISTS billing text NOT NULL DEFAULT 'api';
      CREATE TABLE IF NOT EXISTS factory_runtime_usage_alerts (
        key text NOT NULL, kind text NOT NULL, sent_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(key,kind));
      CREATE TABLE IF NOT EXISTS factory_analytics_calls (
        id bigserial PRIMARY KEY, repository text NOT NULL, step text NOT NULL, pr_number integer, issue_number integer,
        selection text NOT NULL, router_choice text, router_probability double precision, provider text NOT NULL, model text NOT NULL,
        effort text, tokens jsonb, cost_usd double precision, outcome text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS factory_analytics_calls_time ON factory_analytics_calls(recorded_at);
      CREATE TABLE IF NOT EXISTS factory_analytics_issues (
        repository text NOT NULL, issue_number integer NOT NULL, title text NOT NULL, state text NOT NULL, pr_number integer,
        merged_at timestamptz, merged_by text, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(repository,issue_number));
      ALTER TABLE factory_analytics_calls ADD COLUMN IF NOT EXISTS price_source text;
      ALTER TABLE factory_analytics_issues ADD COLUMN IF NOT EXISTS qualified_at timestamptz;
      ALTER TABLE factory_analytics_issues ADD COLUMN IF NOT EXISTS handover_at timestamptz;
      CREATE TABLE IF NOT EXISTS factory_analytics_verdicts (
        id bigserial PRIMARY KEY, repository text NOT NULL, step text NOT NULL, pr_number integer, issue_number integer,
        decision text NOT NULL, rejected boolean NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS factory_analytics_verdicts_time ON factory_analytics_verdicts(recorded_at);
      ALTER TABLE factory_runtime_usage ADD COLUMN IF NOT EXISTS price_source text;
      ALTER TABLE factory_runtime_usage ADD COLUMN IF NOT EXISTS agent_estimate_usd double precision;
      CREATE TABLE IF NOT EXISTS factory_runtime_events (
        id bigserial PRIMARY KEY, repository_id bigint NOT NULL, repository text NOT NULL, key text NOT NULL, type text NOT NULL,
        issue_number integer NOT NULL, task_version text NOT NULL, execution_id text, data jsonb NOT NULL,
        occurred_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), UNIQUE(repository_id,key));
      CREATE INDEX IF NOT EXISTS factory_runtime_events_time ON factory_runtime_events(recorded_at);
      CREATE TABLE IF NOT EXISTS factory_runtime_broker_life (
        id integer PRIMARY KEY CHECK (id = 1), instance text NOT NULL, started_at timestamptz NOT NULL, seen_at timestamptz NOT NULL,
        ended boolean NOT NULL DEFAULT false);`);
  }
  /** The broker's own start (software-factory#194); the previous instance when it ended without a clean shutdown. */
  async brokerStarted(instance: string, at: Date): Promise<{ startedAt: Date; seenAt: Date } | null> {
    const { rows } = await this.pool.query<{ started_at: Date; seen_at: Date; ended: boolean }>(
      `WITH previous AS (SELECT started_at, seen_at, ended FROM factory_runtime_broker_life WHERE id=1)
       , replaced AS (INSERT INTO factory_runtime_broker_life(id,instance,started_at,seen_at,ended) VALUES(1,$1,$2,$2,false)
         ON CONFLICT (id) DO UPDATE SET instance=$1, started_at=$2, seen_at=$2, ended=false)
       SELECT * FROM previous`, [instance, at]);
    const previous = rows[0];
    return previous && !previous.ended ? { startedAt: previous.started_at, seenAt: previous.seen_at } : null;
  }
  async brokerAlive(instance: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE factory_runtime_broker_life SET seen_at=$2 WHERE id=1 AND instance=$1', [instance, at]);
  }
  async brokerStopped(instance: string): Promise<void> {
    await this.pool.query('UPDATE factory_runtime_broker_life SET ended=true WHERE id=1 AND instance=$1', [instance]);
  }
  /** One broker model call (merge review, risk assessment, planner) for the cost analytics. */
  async recordLlmCall(r: LlmCallRecord): Promise<void> {
    await this.pool.query(`INSERT INTO factory_analytics_calls(repository,step,pr_number,issue_number,selection,router_choice,router_probability,provider,model,effort,tokens,cost_usd,outcome,price_source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [r.repository, r.step, r.prNumber, r.issueNumber, r.selection, r.routerChoice, r.routerProbability,
      r.provider, r.model, r.effort, r.tokens === null ? null : JSON.stringify(r.tokens), r.costUsd, r.outcome, r.priceSource]);
  }
  /** The decision of a fresh merge review (router evaluation). */
  async recordLlmVerdict(r: LlmVerdictRecord): Promise<void> {
    await this.pool.query('INSERT INTO factory_analytics_verdicts(repository,step,pr_number,issue_number,decision,rejected) VALUES($1,$2,$3,$4,$5,$6)',
      [r.repository, r.step, r.prNumber, r.issueNumber, r.decision, r.rejected]);
  }
  async analyticsVerdicts(since: Date): Promise<AnalyticsVerdict[]> {
    const { rows } = await this.pool.query<{ repository: string; step: string; pr_number: number | null; issue_number: number | null; decision: string; rejected: boolean; recorded_at: Date }>(
      'SELECT repository,step,pr_number,issue_number,decision,rejected,recorded_at FROM factory_analytics_verdicts WHERE recorded_at >= $1 ORDER BY recorded_at LIMIT 50000', [since]);
    return rows.map(r => ({ repository: r.repository, step: r.step, prNumber: r.pr_number, issueNumber: r.issue_number, decision: r.decision, rejected: r.rejected, at: r.recorded_at.toISOString() }));
  }
  /** Title, state and merge of the issues the analytics name; written only when they changed. */
  async upsertAnalyticsIssues(repository: string, issues: AnalyticsIssue[]): Promise<void> {
    // Intake and handover keep the earliest instant ever seen: the timeline of a settled issue is no longer read, and the
    // broker only learns of a handover while it runs (LEAST ignores NULL).
    for (const i of issues) await this.pool.query(`INSERT INTO factory_analytics_issues(repository,issue_number,title,state,pr_number,merged_at,merged_by,qualified_at,handover_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (repository,issue_number) DO UPDATE SET title=EXCLUDED.title, state=EXCLUDED.state, pr_number=EXCLUDED.pr_number,
        merged_at=EXCLUDED.merged_at, merged_by=EXCLUDED.merged_by, qualified_at=LEAST(factory_analytics_issues.qualified_at, EXCLUDED.qualified_at),
        handover_at=LEAST(factory_analytics_issues.handover_at, EXCLUDED.handover_at), updated_at=now()`,
      [repository, i.issueNumber, i.title, i.state, i.prNumber, i.mergedAt, i.mergedBy, i.qualifiedAt ?? null, i.handoverAt ?? null]);
  }
  async analyticsIssues(): Promise<(AnalyticsIssue & { repository: string })[]> {
    const { rows } = await this.pool.query<{ repository: string; issue_number: number; title: string; state: string; pr_number: number | null; merged_at: Date | null; merged_by: string | null;
      qualified_at: Date | null; handover_at: Date | null }>(
      'SELECT repository,issue_number,title,state,pr_number,merged_at,merged_by,qualified_at,handover_at FROM factory_analytics_issues');
    return rows.map(r => ({ repository: r.repository, issueNumber: r.issue_number, title: r.title, state: r.state === 'closed' ? 'closed' : 'open',
      prNumber: r.pr_number, mergedAt: r.merged_at?.toISOString() ?? null, mergedBy: r.merged_by === 'human' ? 'human' : r.merged_by === 'factory' ? 'factory' : null,
      qualifiedAt: r.qualified_at?.toISOString() ?? null, handoverAt: r.handover_at?.toISOString() ?? null }));
  }
  /**
   * Every priced model call since `since`: the coding runs (factory_runtime_usage, with the stored routing decision and
   * whether the attempt was an escalation; runs on the Claude subscription as agent claude-subscription at 0 $) and the
   * broker's own calls.
   */
  async analyticsCalls(since: Date): Promise<AnalyticsCall[]> {
    const { rows } = await this.pool.query<{ repository: string; step: string; issue_number: number | null; pr_number: number | null; execution_id: string | null;
      selection: string; router_choice: string | null; router_probability: number | null; agent: string; model: string; effort: string | null;
      tokens: unknown; cost_usd: number | null; price_source: string | null; outcome: string | null; recorded_at: Date; duration_ms: string | null }>(`
      SELECT u.repository, 'coding' AS step, u.issue_number, NULL::integer AS pr_number, u.execution_id,
        CASE WHEN jsonb_exists(r.snapshot->'admission'->'input'->'contextReferences', $2) THEN 'escalation'
          WHEN jsonb_typeof(e.receipt->'agent') = 'object' THEN 'router' ELSE 'configured' END AS selection,
        e.receipt->'route'->>'choice' AS router_choice, (e.receipt->'route'->>'confidence')::double precision AS router_probability,
        CASE WHEN u.billing='subscription' THEN 'claude-subscription' ELSE u.record->>'worker' END AS agent,
        u.record->>'model' AS model, u.record->>'effort' AS effort, u.record->'tokens' AS tokens,
        -- A run on the Claude subscription is not billed: its estimate stays in the usage report, not in the cost.
        CASE WHEN u.billing='subscription' THEN 0 ELSE u.cost_usd END AS cost_usd, u.price_source, u.record->>'outcome' AS outcome, u.recorded_at,
        u.record->>'durationMs' AS duration_ms
      FROM factory_runtime_usage u
        LEFT JOIN factory_runtime_effects e ON e.repository_id=u.repository_id AND e.execution_id=u.execution_id AND e.effect='coding-route' AND e.phase='confirmed'
        LEFT JOIN factory_runtime_runs r ON r.repository_id=u.repository_id AND r.execution_id=u.execution_id
      WHERE u.recorded_at >= $1
      UNION ALL
      SELECT repository, step, issue_number, pr_number, NULL, selection, router_choice, router_probability, provider, model, effort, tokens,
        cost_usd, price_source, outcome, recorded_at, NULL FROM factory_analytics_calls WHERE recorded_at >= $1
      ORDER BY recorded_at LIMIT 50000`, [since, escalationMarker]);
    return rows.map(r => ({ repository: r.repository, step: r.step as AnalyticsCall['step'], issueNumber: r.issue_number, prNumber: r.pr_number, executionId: r.execution_id,
      selection: r.selection as AnalyticsCall['selection'], routerChoice: r.router_choice, routerProbability: r.router_probability,
      agent: r.agent, model: r.model, effort: r.effort, tokens: tokensOf(r.tokens), costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
      priceSource: r.price_source, outcome: r.outcome, at: r.recorded_at.toISOString(),
      durationMs: r.duration_ms !== null && Number.isFinite(Number(r.duration_ms)) ? Number(r.duration_ms) : null }));
  }
  /** Token usage of coding runs (UsageAlerts): stored once per execution. */
  async recordUsage(entry: UsageEntry): Promise<boolean> {
    const { rowCount } = await this.pool.query(`INSERT INTO factory_runtime_usage(repository_id,execution_id,repository,issue_number,run_id,record,cost_usd,billing,price_source,agent_estimate_usd)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`, [entry.repositoryId, entry.record.executionId, entry.repository, entry.issueNumber,
      entry.runId, JSON.stringify(entry.record), entry.record.costUsd, entry.billing, entry.priceSource ?? null, entry.agentEstimateUsd ?? null]);
    return (rowCount ?? 0) > 0;
  }
  async usageDay(repositoryId: number, day: string): Promise<{ costUsd: number; runs: number; unknownCost: number }> {
    const { rows } = await this.pool.query<{ cost: number | null; runs: string; unknown: string }>(
      `SELECT sum(cost_usd) AS cost, count(*) AS runs, count(*) FILTER (WHERE cost_usd IS NULL) AS unknown FROM factory_runtime_usage
        WHERE repository_id=$1 AND billing='api' AND recorded_at >= $2::date AND recorded_at < $2::date + 1`, [repositoryId, day]);
    return { costUsd: Number(rows[0]?.cost ?? 0), runs: Number(rows[0]?.runs ?? 0), unknownCost: Number(rows[0]?.unknown ?? 0) };
  }
  async claimUsageAlert(key: string, kind: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('INSERT INTO factory_runtime_usage_alerts(key,kind) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, kind]);
    return (rowCount ?? 0) > 0;
  }
  /** The stored usage of one execution, for the status comment. */
  async usage(repositoryId: number, executionId: string): Promise<UsageRecord | null> {
    const { rows } = await this.pool.query<{ record: unknown }>('SELECT record FROM factory_runtime_usage WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId]);
    const parsed = rows[0] ? usageRecordSchema.safeParse(rows[0].record) : null;
    return parsed?.success ? parsed.data : null;
  }
  /** Spend per repository between two instants, for the daily report. */
  async usageReport(from: Date, to: Date): Promise<{ repository: string; runs: number; costUsd: number; unknownCost: number; maxCostUsd: number; budgetStops: number; subscriptionRuns: number; subscriptionCostUsd: number }[]> {
    const { rows } = await this.pool.query<{ repository: string; runs: string; cost: number | null; unknown: string; max: number | null; stops: string; abo: string; abo_cost: number | null }>(
      `SELECT repository, count(*) AS runs, sum(cost_usd) FILTER (WHERE billing='api') AS cost,
        count(*) FILTER (WHERE cost_usd IS NULL AND billing='api') AS unknown, max(cost_usd) FILTER (WHERE billing='api') AS max,
        count(*) FILTER (WHERE (record->>'budgetReached')::boolean) AS stops,
        count(*) FILTER (WHERE billing='subscription') AS abo, sum(cost_usd) FILTER (WHERE billing='subscription') AS abo_cost
        FROM factory_runtime_usage WHERE recorded_at >= $1 AND recorded_at < $2 GROUP BY repository ORDER BY repository`, [from, to]);
    return rows.map(r => ({ repository: r.repository, runs: Number(r.runs), costUsd: Number(r.cost ?? 0), unknownCost: Number(r.unknown),
      maxCostUsd: Number(r.max ?? 0), budgetStops: Number(r.stops), subscriptionRuns: Number(r.abo), subscriptionCostUsd: Number(r.abo_cost ?? 0) }));
  }
  /** Runs on the Claude subscription across all repositories since an instant, for the daily cap (SubscriptionCap). */
  async subscriptionRunsSince(from: Date): Promise<number> {
    const { rows } = await this.pool.query<{ runs: string }>(`SELECT count(*) AS runs FROM factory_runtime_usage WHERE billing='subscription' AND recorded_at >= $1`, [from]);
    return Number(rows[0]?.runs ?? 0);
  }
  /** Claims the next credit alert of an agent (CreditAlerts); null at the limit or when this execution already had one. */
  async claimCreditAlert(agent: string, kind: string, executionId: string, limit: number): Promise<number | null> {
    await this.pool.query('INSERT INTO factory_runtime_credit_alerts(agent,kind) VALUES($1,$2) ON CONFLICT DO NOTHING', [agent, kind]);
    const { rows } = await this.pool.query<{ sent: number }>(
      `UPDATE factory_runtime_credit_alerts SET sent=sent+1, last_execution=$3, updated_at=now()
        WHERE agent=$1 AND kind=$2 AND sent<$4 AND last_execution IS DISTINCT FROM $3 RETURNING sent`, [agent, kind, executionId, limit]);
    return rows[0] ? rows[0].sent : null;
  }
  async resetCreditAlerts(agent: string, kind: string): Promise<void> {
    await this.pool.query('UPDATE factory_runtime_credit_alerts SET sent=0, updated_at=now() WHERE agent=$1 AND kind=$2 AND sent>0', [agent, kind]);
  }
  /** Repositories the SF Manager registered with this runtime, in addition to the host's static registry. */
  async registrations(): Promise<Registration[]> {
    const { rows } = await this.pool.query<{ repository_id: string; repository: string; installation_id: string }>(
      'SELECT repository_id, repository, installation_id FROM factory_runtime_registrations ORDER BY repository_id');
    return rows.map(r => ({ repositoryId: Number(r.repository_id), repository: r.repository, githubInstallationId: Number(r.installation_id) }));
  }
  /** Idempotent; a repository ID is bound to one name and installation for good (a rename re-registers nothing). */
  async register(item: Registration): Promise<void> {
    const { rows } = await this.pool.query<{ repository: string; installation_id: string }>(
      `INSERT INTO factory_runtime_registrations(repository_id, repository, installation_id) VALUES($1,$2,$3)
       ON CONFLICT(repository_id) DO UPDATE SET repository_id=excluded.repository_id RETURNING repository, installation_id`,
      [item.repositoryId, item.repository, item.githubInstallationId]);
    if (rows[0]?.repository !== item.repository || Number(rows[0]?.installation_id) !== item.githubInstallationId) throw new Error('REGISTRATION_CONFLICT');
  }
  /**
   * Like locked(), but never waits: when another holder has the lock it fails with BUSY at once. A caller that may
   * repeat while a long holder runs (scheduled reconciliations) must not park one pool connection per waiting request.
   */
  async tryLocked<T>(repositoryId: number, executionId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(), key = `${repositoryId}:${executionId}`;
    try {
      const { rows } = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [key]);
      if (!rows[0]?.acquired) throw new Error('BUSY');
      try { return await this.context.run(client, () => work(client)); }
      finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
    } finally { client.release(); }
  }
  async locked<T>(repositoryId: number, executionId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const inherited = this.context.getStore(), client = inherited ?? await this.pool.connect(), key = `${repositoryId}:${executionId}`;
    try {
      // A session lock survives deliberate commits around external side effects; never auto-retry work().
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [key]);
      return await this.context.run(client, () => work(client));
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      finally { if (!inherited) client.release(); }
    }
  }
  async get(repositoryId: number, executionId: string): Promise<StoredRun | null> {
    const { rows } = await this.db().query<Row>('SELECT * FROM factory_runtime_runs WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId]);
    return rows[0] ? decode(rows[0]) : null;
  }
  async insert(snapshot: RunSnapshot, binding: string, workflowId: string) {
    await this.db().query(`INSERT INTO factory_runtime_runs(repository_id,execution_id,snapshot,binding,workflow_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(repository_id,execution_id) DO NOTHING`,
    [snapshot.repositoryId, snapshot.admission.input.executionId, JSON.stringify(snapshot), binding, workflowId]);
    const stored = await this.get(snapshot.repositoryId, snapshot.admission.input.executionId);
    if (!stored || stored.binding !== binding) throw new Error('SNAPSHOT_CONFLICT');
    return stored;
  }
  async started(repositoryId: number, executionId: string, runId: string) {
    const { rowCount } = await this.db().query(`UPDATE factory_runtime_runs SET run_id=$3 WHERE repository_id=$1 AND execution_id=$2 AND (run_id IS NULL OR run_id=$3)`, [repositoryId, executionId, runId]);
    if (rowCount !== 1) throw new Error('RUN_ID_CONFLICT');
  }
  async gate(repositoryId: number, executionId: string, binding: string, actor: string, approved: boolean) {
    await this.locked(repositoryId, executionId, async client => {
      await client.query('BEGIN');
      try {
        const { rowCount } = await client.query(`UPDATE factory_runtime_runs SET approved=$4 WHERE repository_id=$1 AND execution_id=$2 AND binding=$3 AND NOT terminal AND NOT cancelled`, [repositoryId, executionId, binding, approved]);
        if (rowCount !== 1) throw new Error('STALE_APPROVAL');
        await client.query('INSERT INTO factory_runtime_approvals(repository_id,execution_id,binding,actor,approved) VALUES($1,$2,$3,$4,$5)', [repositoryId, executionId, binding, actor, approved]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    });
  }
  async list(repositoryId: number): Promise<StoredRun[]> {
    const { rows } = await this.db().query<Row>('SELECT * FROM factory_runtime_runs WHERE repository_id=$1 ORDER BY created_at DESC LIMIT 1000', [repositoryId]);
    return rows.map(decode);
  }
  async *inFlight(repositoryId: number): AsyncGenerator<StoredRun> {
    let after = '';
    for (;;) {
      const { rows } = await this.db().query<Row & { execution_id: string }>(
        'SELECT * FROM factory_runtime_runs WHERE repository_id=$1 AND NOT terminal AND execution_id>$2 ORDER BY execution_id LIMIT 100', [repositoryId, after]);
      if (!rows.length) return;
      for (const row of rows) yield decode(row);
      after = rows.at(-1)!.execution_id;
    }
  }
  async cancel(repositoryId: number, executionId: string) {
    await this.db().query('UPDATE factory_runtime_runs SET cancelled=true,approved=false WHERE repository_id=$1 AND execution_id=$2 AND NOT terminal', [repositoryId, executionId]);
  }
  async complete(repositoryId: number, executionId: string, result: WorkerResult) {
    await this.db().query('UPDATE factory_runtime_runs SET result=$3,terminal=true WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId, JSON.stringify(result)]);
  }
  async terminal(repositoryId: number, executionId: string) {
    await this.db().query('UPDATE factory_runtime_runs SET terminal=true WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId]);
  }
  /** The confirmed receipt of one runtime effect of an execution, or null when it has none (yet). */
  async effectReceipt(repositoryId: number, executionId: string, effect: string): Promise<unknown> {
    const { rows } = await this.db().query<{ receipt: unknown }>("SELECT receipt FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 AND effect=$3 AND phase='confirmed'",
      [repositoryId, executionId, effect]);
    return rows[0]?.receipt ?? null;
  }
  async artifact(repositoryId: number, executionId: string): Promise<CodingArtifact | null> {
    const { rows } = await this.db().query<{ artifact: unknown; digest: string }>('SELECT artifact,digest FROM factory_runtime_artifacts WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId]);
    if (!rows[0]) return null;
    const artifact = codingArtifactSchema.parse(rows[0].artifact);
    if (hash(artifact) !== rows[0].digest) throw new Error('STORED_ARTIFACT_INTEGRITY_FAILED');
    return artifact;
  }
  async saveArtifact(repositoryId: number, executionId: string, value: CodingArtifact) {
    const artifact = codingArtifactSchema.parse(value), digest = hash(artifact);
    await this.db().query('INSERT INTO factory_runtime_artifacts(repository_id,execution_id,digest,artifact) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id,execution_id) DO NOTHING', [repositoryId, executionId, digest, JSON.stringify(artifact)]);
    if (hash(await this.artifact(repositoryId, executionId)) !== digest) throw new Error('CODING_ARTIFACT_CONFLICT');
  }
  async validation(repositoryId: number, executionId: string): Promise<ValidationReport | null> {
    const { rows } = await this.db().query('SELECT validation,validation_digest FROM factory_runtime_artifacts WHERE repository_id=$1 AND execution_id=$2', [repositoryId, executionId]);
    if (!rows[0]?.validation) return null;
    const report = validationReportSchema.parse(rows[0].validation);
    if (hash(report) !== rows[0].validation_digest) throw new Error('STORED_VALIDATION_INTEGRITY_FAILED');
    return report;
  }
  async saveValidation(repositoryId: number, executionId: string, value: ValidationReport) {
    const report = validationReportSchema.parse(value), digest = hash(report), artifact = await this.artifact(repositoryId, executionId);
    if (!artifact || hash(artifact) !== report.artifactHash) throw new Error('VALIDATION_ARTIFACT_CONFLICT');
    await this.db().query('UPDATE factory_runtime_artifacts SET validation=$3,validation_digest=$4 WHERE repository_id=$1 AND execution_id=$2 AND (validation IS NULL OR validation_digest=$4)', [repositoryId, executionId, JSON.stringify(report), digest]);
    if (hash(await this.validation(repositoryId, executionId)) !== digest) throw new Error('VALIDATION_REPORT_CONFLICT');
  }
  /** Runtime events (issue #188): stored once per key; returns the ones this call added. */
  async recordEvents(repositoryId: number, repository: string, events: RuntimeEvent[]): Promise<RuntimeEvent[]> {
    const added: RuntimeEvent[] = [];
    for (const e of events) {
      const { rowCount } = await this.pool.query(`INSERT INTO factory_runtime_events(repository_id,repository,key,type,issue_number,task_version,execution_id,data,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(repository_id,key) DO NOTHING`,
      [repositoryId, repository, e.key, e.type, e.issueNumber, e.taskVersion, e.executionId, JSON.stringify(e.data), e.at]);
      if (rowCount) added.push(e);
    }
    return added;
  }
  /** Events recorded since `since` (all repositories without `repositoryId`), oldest first, at most `limit`. */
  async events(repositoryId: number | null, since: Date, limit = 500): Promise<StoredRuntimeEvent[]> {
    const { rows } = await this.db().query<{ id: string; repository: string; key: string; type: RuntimeEventType; issue_number: number; task_version: string;
      execution_id: string | null; data: RuntimeEvent['data']; occurred_at: Date; recorded_at: Date }>(
      `SELECT * FROM factory_runtime_events WHERE recorded_at > $1 AND ($2::bigint IS NULL OR repository_id=$2) ORDER BY recorded_at, id LIMIT $3`,
      [since, repositoryId, limit]);
    return rows.map(r => ({ id: Number(r.id), repository: r.repository, key: r.key, type: r.type, issueNumber: r.issue_number, taskVersion: r.task_version,
      executionId: r.execution_id, data: r.data, at: r.occurred_at.toISOString(), recordedAt: r.recorded_at.toISOString() }));
  }
  /** Open findings and those resolved in the last week, newest first. */
  async findings(repositoryId: number): Promise<StoredFinding[]> {
    const { rows } = await this.db().query<{ key: string; kind: FindingKind; issue_number: number | null; detail: string; first_seen: Date; last_seen: Date; resolved_at: Date | null }>(
      `SELECT * FROM factory_runtime_findings WHERE repository_id=$1 AND (resolved_at IS NULL OR resolved_at > now() - interval '7 days')
       ORDER BY resolved_at IS NULL DESC, first_seen DESC LIMIT 200`, [repositoryId]);
    return rows.map(r => ({ key: r.key, kind: r.kind, issueNumber: r.issue_number, detail: r.detail, firstSeen: r.first_seen.toISOString(),
      lastSeen: r.last_seen.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null }));
  }
  async syncFindings(repositoryId: number, findings: Finding[], kinds: readonly FindingKind[], now: Date) {
    const { rows } = await this.pool.query<{ key: string; kind: FindingKind; issue_number: number | null; detail: string }>(
      'SELECT key, kind, issue_number, detail FROM factory_runtime_findings WHERE repository_id=$1 AND resolved_at IS NULL AND kind = ANY($2)', [repositoryId, [...kinds]]);
    const open = new Map(rows.map(r => [r.key, { key: r.key, kind: r.kind, issueNumber: r.issue_number, detail: r.detail }]));
    const current = new Set(findings.map(f => f.key));
    const opened = findings.filter(f => !open.has(f.key)), resolved = [...open.values()].filter(f => !current.has(f.key));
    for (const f of findings) await this.pool.query(`INSERT INTO factory_runtime_findings(repository_id,key,kind,issue_number,detail,first_seen,last_seen)
      VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(repository_id,key) DO UPDATE SET detail=excluded.detail, last_seen=excluded.last_seen,
      first_seen=CASE WHEN factory_runtime_findings.resolved_at IS NULL THEN factory_runtime_findings.first_seen ELSE excluded.first_seen END, resolved_at=NULL`,
    [repositoryId, f.key, f.kind, f.issueNumber, f.detail, now]);
    if (resolved.length) await this.pool.query('UPDATE factory_runtime_findings SET resolved_at=$3 WHERE repository_id=$1 AND key = ANY($2) AND resolved_at IS NULL',
      [repositoryId, resolved.map(f => f.key), now]);
    return { opened, resolved };
  }
}
