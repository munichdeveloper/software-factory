import { admissionSchema, observationSchema, type Admission, type RuntimeObservation, type WorkerRuntimePort } from './contract.js';

export class RuntimeHttpClient implements WorkerRuntimePort {
  private base: URL;
  constructor(url: string, private token: string, private repositoryId: number, private fetcher: typeof fetch = fetch) {
    this.base = new URL(url);
    if ((this.base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(this.base.hostname)) ||
      this.base.username || this.base.password || this.base.search || this.base.hash || token.length < 32 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0) throw new Error('Invalid Factory runtime connection');
  }
  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetcher(new URL(`/v1/repositories/${this.repositoryId}/${path}`, this.base), {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Factory runtime request rejected or unavailable'); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 1000000) throw new Error('Factory runtime response exceeds limit');
    return JSON.parse(text);
  }
  async start(admission: Admission) { return observationSchema.parse(await this.request('runs', admissionSchema.parse(admission))); }
  async observations(executionIds: string[]): Promise<RuntimeObservation[]> {
    return observationSchema.array().max(1000).parse(await this.request('observations', { executionIds }));
  }
  async cancel(executionId: string) { await this.request(`runs/${executionId}/cancel`, {}); }
}
