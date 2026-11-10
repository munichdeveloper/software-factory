import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '../src/runtime/contract.js';
const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  gateApproved: vi.fn(), authorize: vi.fn(), execute: vi.fn(), publish: vi.fn(),
  condition: vi.fn(),
}));
vi.mock('@temporalio/workflow', () => ({
  defineQuery: (name: string) => name, defineSignal: (name: string) => name,
  setHandler: (name: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(name, fn),
  proxyActivities: () => fake, condition: (fn: () => boolean) => fake.condition(fn),
}));
import { factoryExecution } from '../src/runtime/workflow.js';
const snapshot = { requireHumanGate: true, admission: { input: { limits: { timeoutMinutes: 1 } } } } as RunSnapshot;
beforeEach(() => {
  fake.handlers.clear(); fake.gateApproved.mockReset().mockResolvedValue(true); fake.authorize.mockReset().mockResolvedValue(undefined);
  fake.execute.mockReset().mockResolvedValue({ status: 'success' }); fake.publish.mockReset().mockImplementation(async (_s, _b, result) => result);
  fake.condition.mockReset().mockResolvedValue(undefined);
});
describe('durable workflow control rules', () => {
  it('checks broker approval and authorization before work and again before publication', async () => {
    const result = await factoryExecution(snapshot, 'binding'); expect(result).toEqual({ status: 'success' });
    expect(fake.authorize).toHaveBeenCalledTimes(2); expect(fake.handlers.get('factoryState')!()).toMatchObject({ phase: 'completed', binding: 'binding' });
  });
  it('does not treat a wake-up signal or forged actor payload as permission', async () => {
    fake.gateApproved.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    fake.condition.mockImplementation(async () => { expect(fake.execute).not.toHaveBeenCalled(); fake.handlers.get('approvalChanged')!({ actor: 'forged' }); });
    await factoryExecution(snapshot, 'binding'); expect(fake.gateApproved).toHaveBeenCalledTimes(2);
  });
  it('cancels a waiting gate without invoking the Harness or publisher', async () => {
    fake.gateApproved.mockResolvedValue(false); fake.condition.mockImplementation(async () => { fake.handlers.get('cancelRequested')!(); });
    expect(await factoryExecution(snapshot, 'binding')).toBeNull(); expect(fake.execute).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
    expect(fake.handlers.get('factoryState')!()).toMatchObject({ phase: 'cancelled' });
  });
  it('blocks publication if approval was revoked while the worker ran', async () => {
    fake.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await expect(factoryExecution(snapshot, 'binding')).rejects.toThrow('revoked'); expect(fake.publish).not.toHaveBeenCalled();
  });
  it('stops after work if a cancellation arrived and supports gates disabled by reviewed policy', async () => {
    fake.execute.mockImplementation(async () => { fake.handlers.get('cancelRequested')!(); return { status: 'success' }; });
    expect(await factoryExecution({ ...snapshot, requireHumanGate: false }, 'binding')).toBeNull();
    expect(fake.gateApproved).not.toHaveBeenCalled(); expect(fake.publish).not.toHaveBeenCalled();
  });
});
