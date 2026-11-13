import { expect, it, vi } from 'vitest';
import { RuntimeMerge } from '../src/runtime/merge.js';
import { config, MemoryGitHub } from './helpers.js';

const snapshot = new MemoryGitHub().state;
const enabled = () => { const cfg = config(); cfg.merge.enabled = true; return cfg; };
const report = { reviewed: 1, updated: 0, merged: 1, errors: [] as string[] };

it('runs one pass at a time, at most once per interval, and only where merging is enabled', async () => {
  let now = 0, finish!: () => void;
  const pass = vi.fn(() => new Promise<typeof report>(resolve => { finish = () => resolve(report); }));
  const merge = new RuntimeMerge(42, pass, 180000, () => now);
  expect(merge.start(config(), snapshot)).toBeNull();
  now = 100000; const running = merge.start(enabled(), snapshot); expect(running).not.toBeNull();
  now = 200000; expect(merge.start(enabled(), snapshot)).toBeNull(); // still running
  finish(); await running;
  now = 250000; expect(merge.start(enabled(), snapshot)).toBeNull(); // within the interval of the last start
  now = 380001; const next = merge.start(enabled(), snapshot); finish(); await next;
  expect(pass).toHaveBeenCalledTimes(2);
});
it('logs counts and pull request numbers only, and never rejects when a pass fails', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await new RuntimeMerge(42, async () => report).start(enabled(), snapshot);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ event: 'factory-merge', repositoryId: 42, reviewed: 1, updated: 0, merged: 1, errors: [] });
    const failing = new RuntimeMerge(42, async () => { throw Object.assign(new Error('secret provider body'), { status: 403 }); });
    await expect(failing.start(enabled(), snapshot)).resolves.toBeUndefined();
    expect(String(warn.mock.calls[0]![0])).not.toContain('secret');
    expect(failing.errors).toEqual(['Merge: pass failed before reading pull requests (403)']);
    // A pass's own errors replace those of the previous pass.
    const partial = new RuntimeMerge(42, async () => ({ ...report, errors: ['PR #42: review/update/merge not confirmed (403); no unreviewed merge performed'] }));
    await partial.start(enabled(), snapshot); expect(partial.errors).toEqual(['Merge: PR #42: review/update/merge not confirmed (403); no unreviewed merge performed']);
  } finally { log.mockRestore(); warn.mockRestore(); }
});
