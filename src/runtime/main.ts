import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Pool } from 'pg';
import { Connection, Client } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { Octokit } from '@octokit/rest';
import { loadConfig } from '../config/index.js';
import { GitHubClient } from '../github/client.js';
import { CodingRepository } from '../github/coding.js';
import { MockPlanner, OpenAIPlanner } from '../llm/provider.js';
import { hash } from '../state/identity.js';
import { releaseSchema } from './contract.js';
import { RuntimeStore } from './store.js';
import { RuntimeController, type RuntimeRepository } from './controller.js';
import { runtimeServer, type RuntimeBinding } from './server.js';
import { startRuntimeWorker, type WorkerPackage } from './worker.js';
import { scopedRuntimeGitHub } from './github-app.js';

const registrySchema = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-z0-9-]{2,100}$/),
  repositories: z.array(z.strictObject({ repositoryId: z.number().int().positive().safe(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    githubTokenEnv: z.string().regex(/^SF_GH_[A-Z0-9_]{1,80}$/).optional(), githubInstallationId: z.number().int().positive().safe().optional(), release: releaseSchema,
    retainedReleases: releaseSchema.array().default([]), requireHumanGate: z.boolean().default(true) })
    .refine(item => Number(!!item.githubTokenEnv) + Number(!!item.githubInstallationId) === 1, 'Select exactly one scoped credential source')).min(1).max(100),
});
export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, output: { type: 'string' }, 'factory-sha': { type: 'string' }, 'harness-sha': { type: 'string' },
    harness: { type: 'string' }, deployment: { type: 'string' }, build: { type: 'string' }, queue: { type: 'string' },
  } });
  if (positionals[0] === 'pack') {
    const out = resolve(values.output ?? '.runtime/temporal-package'), harness = resolve(z.string().min(1).parse(values.harness));
    const bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url)) });
    const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const release = releaseSchema.parse({ factorySha: values['factory-sha'], harnessSha: values['harness-sha'],
      workflowHash: digest(bundle.code), deploymentName: values.deployment, buildId: values.build, taskQueue: values.queue, schemaVersion: 1 });
    await mkdir(out, { recursive: true });
    await writeFile(resolve(out, 'workflow-bundle.js'), bundle.code);
    const pack: WorkerPackage = { release, bundlePath: resolve(out, 'workflow-bundle.js'), harnessEntrypoint: harness,
      harnessEntrypointHash: digest(await readFile(harness)) };
    await writeFile(resolve(out, 'worker-package.json'), JSON.stringify(pack, null, 2));
    console.log(JSON.stringify({ release, packageFile: resolve(out, 'worker-package.json') })); return;
  }
  if (positionals[0] === 'worker') {
    const pack = JSON.parse(await readFile(resolve(z.string().min(1).parse(values.file)), 'utf8')) as WorkerPackage;
    await startRuntimeWorker(pack, process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', process.env.TEMPORAL_NAMESPACE ?? 'software-factory-poc',
      process.env.FACTORY_BROKER_URL ?? '', process.env.FACTORY_WORKER_TOKEN ?? ''); return;
  }
  if (positionals[0] !== 'serve') throw new Error('Use serve, worker or pack');
  const registry = registrySchema.parse(JSON.parse(await readFile(resolve(z.string().min(1).parse(values.file)), 'utf8')));
  const store = new RuntimeStore(new Pool({ connectionString: process.env.FACTORY_RUNTIME_DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 }));
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', connectTimeout: '5 seconds' });
  const temporal = new Client({ connection, namespace: registry.namespace });
  try {
    await store.migrate();
    const bindings: RuntimeBinding[] = [];
    for (const item of registry.repositories) {
      if (item.githubInstallationId && !(process.env.GITHUB_ALLOWED_INSTALLATION_IDS ?? '').split(',').includes(String(item.githubInstallationId))) throw new Error('INSTALLATION_NOT_ALLOWLISTED');
      const token = item.githubTokenEnv ? z.string().min(1).parse(process.env[item.githubTokenEnv]) : '';
      const api = item.githubInstallationId ? scopedRuntimeGitHub({ appId: z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
        privateKey: z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), installationId: item.githubInstallationId, repositoryId: item.repositoryId }) : new Octokit({ auth: token });
      const github = new GitHubClient(item.repository, token, 30000, fetch, api);
      const [owner, repo] = item.repository.split('/') as [string, string];
      if ((await api.repos.get({ owner, repo })).data.id !== item.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
      const repository: RuntimeRepository = { ...item, github, config: async () => loadConfig(await github.readConfig('.github/software-factory.yml')),
        baseSha: async () => (await new CodingRepository(item.repository, token, fetch, api).base()).sha };
      const controller = new RuntimeController(repository, store, temporal);
      // Refuse a registry rollout which would orphan any running version, including long human gates.
      const rows = await store.list(item.repositoryId), observations = await controller.observations(rows.filter(r => r.runId).map(r => r.snapshot.admission.input.executionId));
      for (const row of rows.filter(r => observations.find(o => o.executionId === r.snapshot.admission.input.executionId)?.status === 'running')) {
        if (![item.release, ...item.retainedReleases].some(r => hash(r) === hash(row.snapshot.release))) throw new Error('OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE');
      }
      const config = await repository.config();
      bindings.push({ repository, controller, planner: config.llm.provider === 'mock' ? new MockPlanner() : new OpenAIPlanner(process.env.OPENAI_API_KEY ?? '') });
    }
    const server = runtimeServer({ managerToken: process.env.FACTORY_MANAGER_TOKEN ?? '', workerToken: process.env.FACTORY_WORKER_TOKEN ?? '', bindings, store });
    const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.FACTORY_RUNTIME_PORT ?? '8095');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.log(JSON.stringify({ service: 'factory-runtime', port, repositories: bindings.map(b => b.repository.repositoryId) }));
    await new Promise<void>(resolve => {
      const stop = () => { server.close(() => resolve()); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await connection.close(); await store.pool.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('FACTORY_RUNTIME_FAILED'); process.exitCode = 1;
});
