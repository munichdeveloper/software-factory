import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { installFiles, renderTemplate } from '../src/install.js';
const { values } = parseArgs({ options: {
  directory: { type: 'string' }, ref: { type: 'string' }, coding: { type: 'boolean', default: false },
  'no-manager': { type: 'boolean', default: false }, deploy: { type: 'boolean', default: false },
  'deploy-trigger': { type: 'string', default: 'checks' }, 'deploy-after': { type: 'string', multiple: true, default: ['Test'] },
  'deploy-environment': { type: 'string', default: 'production' }, 'deploy-path': { type: 'string', default: '/opt/app' }
} });
if (!values.directory || !values.ref || !/^[a-f0-9]{40}$/.test(values.ref)) {
  throw new Error('Usage: npx tsx scripts/install.ts --directory TARGET --ref 40_CHAR_COMMIT_SHA [--coding] [--no-manager] ' +
    '[--deploy [--deploy-trigger checks|push] [--deploy-after "CI workflow name"]... [--deploy-environment production] [--deploy-path /opt/app]]');
}
if (values['deploy-trigger'] !== 'checks' && values['deploy-trigger'] !== 'push') throw new Error('--deploy-trigger must be checks or push');
const runtime = JSON.parse(await readFile(new URL('../runtime.json', import.meta.url), 'utf8')) as { ref: string };
const options = { ref: values.ref, harnessRef: runtime.ref, deploy: values.deploy, deployTrigger: values['deploy-trigger'],
  deployAfter: values['deploy-after'], deployEnvironment: values['deploy-environment'], deployPath: values['deploy-path'] } as const;
for (const [source, destination] of installFiles(values.coding, !values['no-manager'], values.deploy)) {
  const content = renderTemplate(source, await readFile(new URL(`../templates/${source}`, import.meta.url), 'utf8'), options);
  const target = resolve(values.directory, destination);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, content, { flag: 'wx' }); console.log(`Created ${destination}`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; console.log(`Preserved existing ${destination}`); }
}
