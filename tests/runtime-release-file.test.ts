import { expect, it } from 'vitest';
import { hostReleases, registeredItem, supersedeRelease } from '../src/runtime/main.js';

const release = (sha: string) => ({ factorySha: sha.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-test', buildId: sha.repeat(40), taskQueue: 'sf-test-v1', schemaVersion: 1 });
const pack = (sha: string) => ({ release: release(sha), bundlePath: '/app/package/workflow-bundle.js' });
it('serves every repository with the release of the worker package and retains no other', () => {
  const repositories = [{ repository: 'o/a', release: release('1'), retainedReleases: [release('0')] }, { repository: 'o/b', release: release('1') }];
  supersedeRelease(repositories, pack('2'));
  expect(repositories).toEqual([{ repository: 'o/a', release: release('2'), retainedReleases: [] }, { repository: 'o/b', release: release('2'), retainedReleases: [] }]);
});
it('retains the previous worker release for runs admitted before the host rollout (software-factory#102)', () => {
  const repositories = [{ repository: 'o/a', release: release('1'), retainedReleases: [release('0')] }];
  supersedeRelease(repositories, pack('2'), pack('1'));
  expect(repositories).toEqual([{ repository: 'o/a', release: release('2'), retainedReleases: [release('1')] }]);
  // A previous release equal to the current one is not retained twice.
  expect(hostReleases(pack('2'), pack('2'))).toEqual({ release: release('2'), retainedReleases: [] });
  expect(registeredItem({ repositoryId: 7, repository: 'o/r', githubInstallationId: 9 }, release('2'), [release('1')]).retainedReleases).toEqual([release('1')]);
});
it('rejects a file that is not a worker package and leaves the registry untouched', () => {
  const repositories = [{ release: release('1') }];
  for (const invalid of [{}, { release: { ...release('2'), factorySha: 'short' } }, null, 'x']) {
    expect(() => supersedeRelease(repositories, invalid)).toThrow();
    expect(() => supersedeRelease(repositories, pack('2'), invalid)).toThrow();
  }
  expect(repositories).toEqual([{ release: release('1') }]);
});
