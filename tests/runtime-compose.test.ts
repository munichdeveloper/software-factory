import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const compose = parse(readFileSync(new URL('../operations/temporal-runtime/compose.production.yaml', import.meta.url), 'utf8'), { merge: true }) as {
  services: Record<string, { network_mode?: string; networks?: Record<string, { aliases?: string[] } | null>; build?: unknown;
    restart?: string; depends_on?: Record<string, { condition: string }>; environment?: Record<string, string> }>;
};
const { services } = compose;

// software-factory#194: a restart of only the broker (docker restart sfm-runtime-broker-1, or a crash) must not cut the
// workers off. They share a network namespace with the broker (they reach it on loopback); it must belong to a
// container that neither restarts with the broker nor is rebuilt by a deployment.
it('keeps the network namespace of broker and workers in a container of its own', () => {
  const holder = services['runtime-net'];
  expect(holder.build).toBeUndefined();
  expect(holder.restart).toBe('unless-stopped');
  expect(holder.network_mode).toBeUndefined();
  for (const name of ['runtime-broker', 'runtime-worker', 'runtime-worker-previous']) {
    expect(services[name].network_mode).toBe('service:runtime-net');
    expect(services[name].networks).toBeUndefined();
    expect(services[name].depends_on?.['runtime-net']).toBeDefined();
  }
  for (const service of Object.values(services)) expect(service.network_mode).not.toBe('service:runtime-broker');
});

it('keeps the names the broker is listened on and reached by in the runtime API network', () => {
  const aliases = services['runtime-net'].networks?.['runtime-api']?.aliases ?? [];
  // The broker listens on the address of this alias; the SF Manager and the monitor ask http://runtime-broker:8095.
  expect(aliases).toContain(services['runtime-broker'].environment?.FACTORY_RUNTIME_LISTEN_ALIAS);
  expect(aliases).toContain('runtime-broker');
  expect(Object.keys(services['runtime-net'].networks ?? {}).sort()).toEqual(['private', 'runtime-api', 'temporal']);
});
