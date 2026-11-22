import { describe, expect, it } from 'vitest';
import { isLockfile, lockfileSummary } from '../src/merge/lockfile.js';

const lock = (packages: Record<string, object>) => JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: { '': { name: 'fixture' }, ...packages } });
const npm = (name: string, version: string) => ({ version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` });

describe('lockfiles in the merge review', () => {
  it('recognizes npm lockfiles at any depth', () => {
    expect(isLockfile('package-lock.json')).toBe(true);
    expect(isLockfile('apps/web/npm-shrinkwrap.json')).toBe(true);
    expect(isLockfile('package.json')).toBe(false);
    expect(isLockfile('docs/package-lock.json.md')).toBe(false);
  });
  it('lists added, changed and removed packages and marks foreign registries', () => {
    const before = lock({ 'node_modules/a': npm('a', '1.0.0'), 'node_modules/b': npm('b', '1.0.0') });
    const after = lock({ 'node_modules/a': npm('a', '1.1.0'), 'node_modules/c': npm('c', '2.0.0'),
      'node_modules/evil': { version: '0.0.1', resolved: 'https://evil.example/evil.tgz' } });
    const summary = lockfileSummary('package-lock.json', before, after, 42)!;
    expect(summary).toContain('42 geänderte Zeilen');
    expect(summary).toContain('2 neu, 1 geändert, 1 entfernt; 1 Pakete außerhalb von registry.npmjs.org');
    expect(summary).toContain('+ node_modules/c 2.0.0\n');
    expect(summary).toContain('~ node_modules/a 1.0.0 -> 1.1.0');
    expect(summary).toContain('- node_modules/b 1.0.0');
    expect(summary).toContain('+ node_modules/evil 0.0.1 [AUSSERHALB registry.npmjs.org: evil.example]');
  });
  it('handles added and removed lockfiles and leaves anything else to the raw diff', () => {
    expect(lockfileSummary('package-lock.json', '', lock({ 'node_modules/a': npm('a', '1.0.0') }), 5)).toContain('1 neu, 0 geändert, 0 entfernt');
    expect(lockfileSummary('package-lock.json', lock({ 'node_modules/a': npm('a', '1.0.0') }), '', 5)).toContain('0 neu, 0 geändert, 1 entfernt');
    expect(lockfileSummary('package-lock.json', 'not json', lock({}), 1)).toBeNull();
    expect(lockfileSummary('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: {} }), lock({}), 1)).toBeNull();
  });
  it('bounds a long list', () => {
    const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`node_modules/p${i}`, npm(`p${i}`, '1.0.0')]));
    const summary = lockfileSummary('package-lock.json', lock({}), lock(many), 4000)!;
    expect(summary).toContain('[… 100 weitere Einträge nicht aufgeführt …]');
    expect(summary.split('\n')).toHaveLength(303);
  });
});
