import { expect, it } from 'vitest';
import { supersedeRelease } from '../src/runtime/main.js';

const release = (sha: string) => ({ factorySha: sha.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-test', buildId: sha.repeat(40), taskQueue: 'sf-test-v1', schemaVersion: 1 });
it('serves every repository with the release of the worker package and retains no other', () => {
  const repositories = [{ repository: 'o/a', release: release('1'), retainedReleases: [release('0')] }, { repository: 'o/b', release: release('1') }];
  supersedeRelease(repositories, { release: release('2'), bundlePath: '/app/package/workflow-bundle.js' });
  expect(repositories).toEqual([{ repository: 'o/a', release: release('2'), retainedReleases: [] }, { repository: 'o/b', release: release('2'), retainedReleases: [] }]);
});
it('rejects a file that is not a worker package and leaves the registry untouched', () => {
  const repositories = [{ release: release('1') }];
  for (const invalid of [{}, { release: { ...release('2'), factorySha: 'short' } }, null, 'x']) expect(() => supersedeRelease(repositories, invalid)).toThrow();
  expect(repositories).toEqual([{ release: release('1') }]);
});
