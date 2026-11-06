import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { directory: { type: 'string' }, ref: { type: 'string' }, coding: { type: 'boolean', default: false } } });
if (!values.directory || !values.ref || !/^[a-f0-9]{40}$/.test(values.ref)) throw new Error('Usage: npx tsx scripts/install.ts --directory TARGET --ref 40_CHAR_COMMIT_SHA');
const runtime = JSON.parse(await readFile(new URL('../runtime.json', import.meta.url), 'utf8')) as { ref: string };
for (const [source, destination] of [[values.coding ? 'software-factory-coding.yml' : 'software-factory.yml', '.github/software-factory.yml'],
  [values.coding ? 'factory-manager-coding.yml' : 'factory-manager.yml', '.github/workflows/factory-manager.yml']]) {
  const content = (await readFile(new URL(`../templates/${source}`, import.meta.url), 'utf8'))
    .replaceAll('FACTORY_COMMIT_SHA', values.ref).replaceAll('HARNESS_COMMIT_SHA', runtime.ref);
  const target = resolve(values.directory, destination!);
  await mkdir(dirname(target), { recursive: true });
  try { await writeFile(target, content, { flag: 'wx' }); console.log(`Created ${destination}`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; console.log(`Preserved existing ${destination}`); }
}
