import { hash } from '../state/identity.js';
import type { RuntimeStore } from './store.js';

export interface EffectRequest<T> {
  key: string; payload: unknown; authorize(): Promise<unknown>; reconcile(): Promise<T | null>;
  apply(): Promise<T>; validate(value: unknown): T;
  /** Only content-addressed Git objects, never PR/comment/dispatch creation. */
  contentAddressed?: boolean;
}
export interface EffectPort { perform<T>(request: EffectRequest<T>): Promise<T> }
export class RuntimeEffects implements EffectPort {
  constructor(private store: RuntimeStore, private repositoryId: number, private executionId: string, private binding: string) {}
  async perform<T>(request: EffectRequest<T>): Promise<T> {
    if (!/^[a-z0-9:._-]{1,180}$/.test(request.key)) throw new Error('INVALID_EFFECT_KEY');
    const digest = hash({ binding: this.binding, payload: request.payload });
    return this.store.locked(this.repositoryId, this.executionId, async client => {
      const { rows } = await client.query<{ payload_hash: string; phase: string; receipt: unknown }>(
        'SELECT * FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 AND effect=$3', [this.repositoryId, this.executionId, request.key]);
      const prior = rows[0];
      if (prior && prior.payload_hash !== digest) throw new Error('EFFECT_PAYLOAD_CONFLICT');
      if (prior?.phase === 'confirmed' && prior.receipt !== null) return request.validate(prior.receipt);
      await request.authorize();
      const evidence = await request.reconcile();
      if (prior && evidence === null && !request.contentAddressed) throw new Error('EFFECT_UNCERTAIN_RECONCILIATION_REQUIRED');
      if (!prior) await client.query('INSERT INTO factory_runtime_effects(repository_id,execution_id,effect,payload_hash,phase) VALUES($1,$2,$3,$4,$5)', [this.repositoryId, this.executionId, request.key, digest, 'attempted']);
      // Claim is committed before a request leaves the broker. No transaction replay.
      const receipt = request.validate(evidence ?? await request.apply());
      await client.query('UPDATE factory_runtime_effects SET phase=$4,receipt=$5 WHERE repository_id=$1 AND execution_id=$2 AND effect=$3', [this.repositoryId, this.executionId, request.key, 'confirmed', JSON.stringify(receipt)]);
      return receipt;
    });
  }
}
