import { describe, expect, it } from 'vitest';
import { contextCommits, namedRefs, outputEntries, refEntry, reworkEntry, reworkMarker, reworkOf, unavailableEntry } from '../src/runtime/coding-context.js';

describe('context the broker adds to a coding request', () => {
  it('takes only explicit candidates from task text', () => {
    const sha = 'a1'.repeat(20);
    const refs = namedRefs(`Reuse PR #14 (pull/15, PR 16), commit \`${sha}\` and ${'b'.repeat(40)}; branch \`test/temporal-camera-issue-13\`, file \`src/app/page.tsx\`.
      Not refs: abc#17x, &#18;, ${'c'.repeat(41)}, \`../etc\`, \`a..b\`, \`x.lock\`, https://example.com/other/repo/pull/19 \`rm -rf /\`.`);
    expect(refs.commits).toEqual([sha, 'b'.repeat(40)]);
    expect(refs.pulls).toEqual([14, 15, 16]);
    expect(refs.names).toEqual(['test/temporal-camera-issue-13', 'src/app/page.tsx']);
  });
  it('recognises the rework marker only in its exact form and only once', () => {
    const id = '7'.repeat(32);
    expect(reworkOf({ contextReferences: ['https://github.com/o/r/issues/1', reworkMarker(id)] })).toBe(id);
    expect(reworkOf({ contextReferences: [` ${reworkMarker(id)}`, 'urn:sf-rework:short'] })).toBeNull();
    expect(reworkOf({ contextReferences: [reworkMarker(id), reworkMarker('8'.repeat(32))] })).toBeNull();
  });
  it('keeps names inert and lists the commits an executor fetches, rework included', () => {
    expect(refEntry('1'.repeat(40), 'branch', 'feature/x; rm -rf $(y)\n`z`')).toBe(`sf-context ref ${'1'.repeat(40)} branch feature/xrm-rfyz`);
    expect(unavailableEntry('pull', '#14')).toBe('sf-context unavailable pull #14');
    expect(() => refEntry('nope', 'commit', 'x')).toThrow('INVALID_CONTEXT_REF');
    const entries = [reworkEntry('2'.repeat(40), '7'.repeat(32)), refEntry('1'.repeat(40), 'pull', '#14'), refEntry('1'.repeat(40), 'branch', 'same'), 'sf-context unavailable commit abc',
      `sf-context ref ${'3'.repeat(40)}x commit bad`, `x sf-context ref ${'4'.repeat(40)} commit bad`];
    expect(contextCommits(entries)).toEqual([{ commit: '2'.repeat(40), rework: true }, { commit: '1'.repeat(40), rework: false }]);
    expect(contextCommits(Array.from({ length: 20 }, (_, i) => refEntry(String(i % 10).repeat(39) + String(Math.floor(i / 10)), 'commit', 'c')))).toHaveLength(7);
  });
  it('bounds check output to its tail in labelled pieces without control sequences', () => {
    const entries = outputEntries('browser', `start\n${'a'.repeat(5000)}\n\n\n\u001b[1mFAIL\u001b[22m \u0000end`);
    expect(entries).toHaveLength(3);
    expect(entries.every(e => e.length <= 1000 && /^sf-context validation-output browser [1-3]\/3: /.test(e))).toBe(true);
    expect(entries.at(-1)!.endsWith('\n\nFAIL end')).toBe(true);
    expect(entries.join('')).not.toContain('start');
    expect(outputEntries('browser', ' \n ')).toEqual([]);
    expect(outputEntries('not a check', 'text')).toEqual([]);
  });
});
