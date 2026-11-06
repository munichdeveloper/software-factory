import { build } from 'esbuild';
await build({ entryPoints: ['src/action.ts'], outfile: 'bundle/factory.cjs', bundle: true, platform: 'node', format: 'cjs',
  target: 'node22', legalComments: 'none', define: { 'import.meta.url': '"software-factory:bundle"' } });
