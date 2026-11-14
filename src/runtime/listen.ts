import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

type Lookup = (host: string) => Promise<string>;
const ipv4: Lookup = async host => (await dnsLookup(host, { family: 4 })).address;

// The broker always listens on loopback, for the processes that share its network namespace (the Factory worker).
// FACTORY_RUNTIME_LISTEN_ALIAS names a network alias that exists only on the dedicated runtime API network: the
// broker resolves it to its own address there and listens on that address as well, never on 0.0.0.0, so the
// SF Manager in its own Compose project reaches the API while the broker's other networks (Temporal) do not.
export async function listenAddresses(alias: string | undefined, lookup: Lookup = ipv4): Promise<string[]> {
  if (!alias) return ['127.0.0.1'];
  if (isIP(alias)) throw new Error('LISTEN_ALIAS_MUST_BE_A_NAME');
  const address = await lookup(alias).catch(() => { throw new Error('LISTEN_ALIAS_UNRESOLVED'); });
  if (isIP(address) !== 4 || address === '0.0.0.0' || address.startsWith('127.')) throw new Error('LISTEN_ALIAS_INVALID_ADDRESS');
  return ['127.0.0.1', address];
}
