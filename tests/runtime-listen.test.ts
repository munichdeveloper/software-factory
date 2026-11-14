import { expect, it } from 'vitest';
import { listenAddresses } from '../src/runtime/listen.js';

it('listens on loopback only without an alias', async () => {
  expect(await listenAddresses(undefined)).toEqual(['127.0.0.1']);
  expect(await listenAddresses('')).toEqual(['127.0.0.1']);
});

it('adds the address the alias resolves to on the runtime API network', async () => {
  expect(await listenAddresses('runtime-api', async host => (host === 'runtime-api' ? '172.20.0.5' : '10.0.0.1'))).toEqual(['127.0.0.1', '172.20.0.5']);
});

it('fails the start instead of widening or guessing the address', async () => {
  await expect(listenAddresses('0.0.0.0')).rejects.toThrow('LISTEN_ALIAS_MUST_BE_A_NAME');
  await expect(listenAddresses('runtime-api', async () => { throw new Error('ENOTFOUND'); })).rejects.toThrow('LISTEN_ALIAS_UNRESOLVED');
  await expect(listenAddresses('runtime-api', async () => '0.0.0.0')).rejects.toThrow('LISTEN_ALIAS_INVALID_ADDRESS');
  await expect(listenAddresses('runtime-api', async () => '127.0.0.11')).rejects.toThrow('LISTEN_ALIAS_INVALID_ADDRESS');
});
