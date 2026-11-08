import { readFile, writeFile } from 'node:fs/promises';
import { installationContract } from '../src/install.js';
const names = ['software-factory.yml', 'software-factory-coding.yml', 'factory-manager.yml', 'factory-manager-coding.yml', 'factory-deploy.yml'];
const templates = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(`templates/${name}`, 'utf8')])));
const runtime = JSON.parse(await readFile('runtime.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile('installation-contract.json', JSON.stringify(installationContract(templates, pkg.version, runtime), null, 2) + '\n');
