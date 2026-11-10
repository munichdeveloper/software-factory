import { expect, it } from 'vitest';
import { IssueScopedGitHub } from '../src/runtime/issue-scope.js';
import { MemoryGitHub, issue } from './helpers.js';

it('exposes only the selected canary task and its journal', async () => {
  const source = new MemoryGitHub(); source.state.issues.push(issue(1), issue(2));
  source.state.comments.set(1, []); source.state.comments.set(2, []);
  const scoped = new IssueScopedGitHub(source, [2]), snapshot = await scoped.snapshot(null);
  expect(snapshot.issues.map(i => i.number)).toEqual([2]); expect([...snapshot.comments.keys()]).toEqual([2]);
  expect(() => scoped.getIssue(1)).toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
  expect(() => scoped.comments(1)).toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
  expect(() => scoped.updateIssue(1, { state: 'closed' })).toThrow('ISSUE_OUTSIDE_RUNTIME_SCOPE');
  expect(source.mutations).toEqual([]);
  await scoped.updateIssue(2, { labels: ['harness:managed'] }); expect(source.mutations).toEqual(['update:2']);
});
it('forbids unscoped creation, legacy dispatch and legacy run cancellation', async () => {
  const source = new MemoryGitHub(), scoped = new IssueScopedGitHub(source, [2]);
  await expect(scoped.createIssue()).rejects.toThrow('ISSUE_CREATION_FORBIDDEN');
  await expect(scoped.bootstrap()).rejects.toThrow('BOOTSTRAP_FORBIDDEN');
  await expect(scoped.snapshot('factory-manager.yml')).rejects.toThrow('LEGACY_DISPATCH_FORBIDDEN');
  await expect(scoped.dispatch()).rejects.toThrow('LEGACY_DISPATCH_FORBIDDEN');
  await expect(scoped.cancelRun()).rejects.toThrow('LEGACY_DISPATCH_FORBIDDEN');
  expect(source.mutations).toEqual([]); expect(source.dispatches).toBe(0);
});
