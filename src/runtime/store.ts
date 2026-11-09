import { Pool, type PoolClient } from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { snapshotSchema, type RunSnapshot } from './contract.js';
import { workerResultSchema, type WorkerResult } from '../workers/contract.js';
import { codingArtifactSchema, type CodingArtifact } from '../workers/coding.js';
import { hash } from '../state/identity.js';

export interface StoredRun {
  snapshot: RunSnapshot; binding: string; workflowId: string; runId: string | null; createdAt: string;
  approved: boolean; cancelled: boolean; terminal: boolean; result: WorkerResult | null;
}
type Row = { snapshot: unknown; binding: string; workflow_id: string; run_id: string | null; created_at: Date;
  approved: boolean; cancelled: boolean; terminal: boolean; result: unknown };
const decode = (row: Row): StoredRun => ({ snapshot: snapshotSchema.parse(row.snapshot), binding: row.binding,
  workflowId: row.workflow_id, runId: row.run_id, createdAt: row.created_at.toISOString(), approved: row.approved,
  cancelled: row.cancelled, terminal: row.terminal, result: row.result === null ? null : workerResultSchema.parse(row.result) });
export class RuntimeStore {
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
        PRIMARY KEY(repository_id,execution_id));`);
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
}
