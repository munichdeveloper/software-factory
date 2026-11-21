import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AnalyticsCall, AnalyticsIssue } from '../src/runtime/analytics.js';
import { distribution, loadMetrics, metricsView } from '../src/runtime/metrics.js';
import { runtimeServer, type RuntimeBinding } from '../src/runtime/server.js';
import type { RuntimeStore } from '../src/runtime/store.js';

const hour = 3600000;
const call = (over: Partial<AnalyticsCall>): AnalyticsCall => ({ repository: 'owner/repo', step: 'coding', issueNumber: 7, prNumber: null, executionId: null,
  selection: 'router', routerChoice: null, routerProbability: null, agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', tokens: null,
  costUsd: 1, outcome: 'success', at: '2026-11-18T10:00:00.000Z', durationMs: 20 * 60000, ...over });
const issue = (over: Partial<AnalyticsIssue & { repository: string }>): AnalyticsIssue & { repository: string } => ({ repository: 'owner/repo', issueNumber: 7,
  title: 'Feature', state: 'closed', prNumber: 20, mergedAt: '2026-11-18T12:00:00.000Z', mergedBy: 'factory', qualifiedAt: '2026-11-18T08:00:00.000Z', handoverAt: null, ...over });
const from = new Date('2026-11-10T00:00:00Z'), to = new Date('2026-11-20T00:00:00Z');

describe('metrics view', () => {
  it('measures intake to the Factory merge and, separately, runs that waited for a person', () => {
    const calls = [
      call({ at: '2026-11-18T09:00:00.000Z', outcome: 'failed', durationMs: 30 * 60000 }), call({ at: '2026-11-18T10:00:00.000Z' }),
      call({ step: 'review', prNumber: 20, at: '2026-11-18T11:00:00.000Z', durationMs: null }),
      call({ issueNumber: 8, at: '2026-11-17T10:00:00.000Z' }),
      call({ issueNumber: 9, at: '2026-11-16T10:00:00.000Z' }),
      call({ issueNumber: 11, at: '2026-11-15T10:00:00.000Z', outcome: 'failed' })
    ];
    const issues = [
      issue({}),
      // Waited 6 h for a person after the handover; 10 h from intake.
      issue({ issueNumber: 8, mergedBy: 'human', qualifiedAt: '2026-11-17T08:00:00.000Z', handoverAt: '2026-11-17T12:00:00.000Z', mergedAt: '2026-11-17T18:00:00.000Z' }),
      // A person merged before the Factory reached its merge step: not a run that waited for a person.
      issue({ issueNumber: 9, mergedBy: 'human', mergedAt: '2026-11-16T12:00:00.000Z' }),
      // Not merged: not measured.
      issue({ issueNumber: 10, state: 'open', mergedAt: null, mergedBy: null, prNumber: null }),
      issue({ issueNumber: 11, mergedAt: null, mergedBy: null, prNumber: null }),
      // Merged before the period.
      issue({ issueNumber: 12, mergedAt: '2026-11-01T12:00:00.000Z' }),
      // Intake never seen.
      issue({ issueNumber: 13, qualifiedAt: null, mergedAt: '2026-11-19T12:00:00.000Z' })
    ];
    const view = metricsView(calls, issues, { from, to, now: to });
    expect(view.items.map(i => i.issueNumber)).toEqual([13, 7, 8]);
    expect(view.leadTime.factory).toEqual({ count: 1, meanMs: 4 * hour, medianMs: 4 * hour, p90Ms: 4 * hour });
    expect(view.leadTime.human.count).toBe(1);
    expect(view.leadTime.human.meanMs).toBe(10 * hour);
    expect(view.leadTime.human.wait.medianMs).toBe(6 * hour);
    expect(view.leadTime.unknownIntake).toBe(1);
    const seven = view.items.find(i => i.issueNumber === 7)!;
    // The first coding run started 30 min before it was recorded: picked up 30 min after intake.
    expect(seven).toMatchObject({ codingRuns: 2, failedCodingRuns: 1, codingMs: 50 * 60000, reviews: 1, pickupMs: 30 * 60000, costUsd: 3, waitMs: null });
    expect(view.flow).toMatchObject({ merged: 3, mergedByFactory: 2, mergedByHuman: 1, automationRate: 0.667, firstPassYield: 0.5, closedWithoutMerge: 1,
      codingRuns: 5, failedCodingRuns: 2 });
    expect(view.flow.codingShare).toBeCloseTo((50 / 60) / 4, 3);
    expect(view.weekly).toEqual([{ week: '2026-11-16', merged: 3, mergedByFactory: 2, leadMedianMs: 4 * hour }]);
    expect(view.repositoryRows).toEqual([{ repository: 'owner/repo', merged: 3, mergedByFactory: 2, leadMedianMs: 4 * hour, firstPassYield: 0.5, costPerMergedUsd: 1.3333 }]);
    expect(metricsView(calls, issues, { from, to, repository: 'owner/other' }).items).toEqual([]);
  });
  it('summarises a distribution and ignores unknown and negative values', () => {
    expect(distribution([null, -5, 10, 30, 20, 40])).toEqual({ count: 4, meanMs: 25, medianMs: 25, p90Ms: 37 });
    expect(distribution([])).toEqual({ count: 0, meanMs: null, medianMs: null, p90Ms: null });
  });
  it('loads with bounded days and a checked repository', async () => {
    const store = { analyticsCalls: async () => [call({})], analyticsIssues: async () => [issue({})] };
    const view = await loadMetrics(store, new URLSearchParams('days=9999'), new Date('2026-11-19T00:00:00Z'));
    expect(view.from).toBe('2025-11-19T00:00:00.000Z');
    await expect(loadMetrics(store, new URLSearchParams('repository=a b/c'))).rejects.toThrow('INVALID_REPOSITORY');
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
describe('GET /v1/metrics', () => {
  it('serves the monitor and manager tokens only', async () => {
    const managerToken = 'm'.repeat(32), workerToken = 'w'.repeat(32), monitorToken = 'q'.repeat(32);
    const store = { analyticsCalls: async () => [call({})], analyticsIssues: async () => [issue({ mergedAt: new Date(Date.now() - 60000).toISOString() })] } as unknown as RuntimeStore;
    const server = runtimeServer({ managerToken, workerToken, monitorToken, bindings: [] as RuntimeBinding[], store });
    servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test listener');
    const get = (path: string, token: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const ok = await get('/v1/metrics?days=30', monitorToken);
    expect(ok.status).toBe(200);
    expect((await ok.json() as { items: unknown[] }).items).toHaveLength(1);
    expect((await get('/v1/metrics', managerToken)).status).toBe(200);
    expect((await get('/v1/metrics', workerToken)).status).toBe(401);
    expect((await get('/v1/metrics?repository=a%20b/c', monitorToken)).status).toBe(400);
  });
});
