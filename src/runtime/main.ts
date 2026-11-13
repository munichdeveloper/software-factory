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
import { assertRetainedReleases } from './retention.js';
import { releaseSchema, baseRefSchema, executorWorkflowSchema } from './contract.js';
import { RuntimeStore, type Registration } from './store.js';
import { RuntimeController, type RuntimeRepository } from './controller.js';
import { runtimeServer, type RuntimeBinding } from './server.js';
import { startRuntimeWorker, type WorkerPackage } from './worker.js';
import { scopedRuntimeGitHub } from './github-app.js';
import { ActionsCodingExecutor } from './coding-executor.js';
import { RuntimeEffects } from './effects.js';
import { RuntimeCodingPublisher } from './publisher.js';
import { IssueScopedGitHub } from './issue-scope.js';
import { defaultValidationPlan, validationPlanSchema } from './validation-contract.js';
import { RuntimeMerge } from './merge.js';
import { SlackSink } from '../notifications/slack.js';
import { GitHubMergePort } from '../merge/github.js';
import { MergeManager } from '../merge/manager.js';
import { OpenAIMergeReviewer } from '../merge/reviewer.js';

const registrySchema = z.strictObject({
  namespace: z.string().regex(/^[a-z][a-z0-9-]{2,100}$/),
  repositories: z.array(z.strictObject({ repositoryId: z.number().int().positive().safe(), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    githubTokenEnv: z.string().regex(/^SF_GH_[A-Z0-9_]{1,80}$/).optional(), githubInstallationId: z.number().int().positive().safe().optional(), release: releaseSchema,
    baseRef: baseRefSchema.optional(), executorWorkflow: executorWorkflowSchema.optional(),
    configPath: z.string().regex(/^\.github\/[\w.-]+\.ya?ml$/).default('.github/software-factory.yml'),
    issueNumbers: z.array(z.number().int().positive().safe()).min(1).max(100).optional(),
    allowedPaths: z.array(z.string().min(1).max(500)).min(1).max(100).optional(),
    approvalMode: z.enum(['manual', 'ready-label']).default('manual'),
    validateCoding: z.boolean().default(true),
    retainedReleases: releaseSchema.array().default([]), requireHumanGate: z.boolean().default(true) })
    .refine(item => Number(!!item.githubTokenEnv) + Number(!!item.githubInstallationId) === 1, 'Select exactly one scoped credential source')
    .refine(item => item.approvalMode !== 'ready-label' || !item.requireHumanGate, 'Ready label replaces the manual gate')).min(1).max(100),
});
/** Replaces every repository's release with the one of a worker package (the file `pack` writes). */
export function supersedeRelease(repositories: { release: unknown; retainedReleases?: unknown }[], workerPackage: unknown) {
  const release = releaseSchema.parse(z.object({ release: z.unknown() }).parse(workerPackage).release);
  for (const item of repositories) Object.assign(item, { release, retainedReleases: [] });
}
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
  // A stack that builds its PINNED worker itself names that worker's release here; it then replaces the registry's
  // release entries, so a release rollout needs no edit on the host. Runs of another release are not retained:
  // the start guard below refuses to orphan them.
  if (process.env.FACTORY_RELEASE_FILE) supersedeRelease(registry.repositories, JSON.parse(await readFile(resolve(process.env.FACTORY_RELEASE_FILE), 'utf8')));
  const store = new RuntimeStore(new Pool({ connectionString: process.env.FACTORY_RUNTIME_DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 }));
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', connectTimeout: '5 seconds' });
  const temporal = new Client({ connection, namespace: registry.namespace });
  try {
    await store.migrate();
    type Item = z.infer<typeof registrySchema>['repositories'][number];
    const bind = async (item: Item): Promise<RuntimeBinding> => {
      if (item.githubInstallationId && !(process.env.GITHUB_ALLOWED_INSTALLATION_IDS ?? '').split(',').includes(String(item.githubInstallationId))) throw new Error('INSTALLATION_NOT_ALLOWLISTED');
      const token = item.githubTokenEnv ? z.string().min(1).parse(process.env[item.githubTokenEnv]) : '';
      const api = item.githubInstallationId ? scopedRuntimeGitHub({ appId: z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
        privateKey: z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), installationId: item.githubInstallationId, repositoryId: item.repositoryId }) : new Octokit({ auth: token });
      const source = new GitHubClient(item.repository, token, 30000, fetch, api);
      const github = item.issueNumbers ? new IssueScopedGitHub(source, item.issueNumbers) : source;
      const [owner, repo] = item.repository.split('/') as [string, string];
      if ((await api.repos.get({ owner, repo })).data.id !== item.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
      const repository: RuntimeRepository = { ...item, github, config: async () => loadConfig(await source.readConfig(item.configPath, item.baseRef)),
        baseSha: async () => item.baseRef ? (await api.git.getRef({ ...{ owner, repo }, ref: `heads/${item.baseRef}` })).data.object.sha : (await new CodingRepository(item.repository, token, fetch, api).base()).sha };
      const controller = new RuntimeController(repository, store, temporal);
      if (item.approvalMode === 'ready-label') repository.readyApproval = async (number, expected, rework) => source.readyApproval(number, (await repository.config()).manager.trustedActors, expected, rework);
      if (item.validateCoding) repository.validationPlan = async () => {
        try {
          const data = (await api.repos.getContent({ owner, repo, path: '.github/software-factory.validation.json', ref: await repository.baseSha() })).data;
          if (!('content' in data) || data.encoding !== 'base64' || data.size > 6000) throw new Error('INVALID_VALIDATION_PLAN');
          return validationPlanSchema.parse(JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')));
        } catch (error) {
          if (error && typeof error === 'object' && 'status' in error && error.status === 404) return defaultValidationPlan();
          throw error;
        }
      };
      const effects = (snapshot: Parameters<ActionsCodingExecutor['poll']>[0], binding: string) => new RuntimeEffects(store, repository.repositoryId, snapshot.admission.input.executionId, binding);
      repository.coding = { executor: new ActionsCodingExecutor(api, effects, (snapshot, binding) => controller.authorize(snapshot, binding), async () => (await repository.config()).manager.trustedActors,
        id => store.validation(repository.repositoryId, id)),
        publish: async (snapshot, binding, artifact, createdAt, validation) => new RuntimeCodingPublisher(api, effects(snapshot, binding),
          () => controller.authorize(snapshot, binding), (await repository.config()).manager.trustedActors).publish(snapshot, artifact, createdAt, validation) };
      // Refuse a registry rollout which would orphan any running version, including long human gates.
      await assertRetainedReleases(item.repositoryId, [item.release, ...item.retainedReleases], store, temporal);
      await repository.config(); // An unreadable or invalid configuration fails the start, not the first reconciliation.
      // Chosen per reconciliation: a configuration change in the repository applies without restarting the broker.
      const mock = new MockPlanner(), openai = new OpenAIPlanner(process.env.OPENAI_API_KEY ?? '');
      // Only pull requests the Factory published for its tasks in an issue-scoped registry entry; closed ones while a merge's follow-up may be open.
      const merge = new RuntimeMerge(item.repositoryId, (config, snapshot) => new MergeManager(
        new GitHubMergePort(item.repository, api, config.factory.scope, config.merge.adoptLabel, fetch, 48 * 3600000),
        config, new OpenAIMergeReviewer(process.env.OPENAI_API_KEY ?? '', config), `temporal-merge:${item.repositoryId}`, github,
        { ownedOnly: !!item.issueNumbers }).run(snapshot));
      return { repository, controller, planner: config => config.llm.provider === 'mock' ? mock : openai, merge };
    };
    const bindings: RuntimeBinding[] = [];
    for (const item of registry.repositories) bindings.push(await bind(item));
    // Repositories the SF Manager registered (Temporal rollout): served with the PINNED worker release, the ready
    // label as grant and independent validation. A registration that cannot be bound is reported, never fatal for
    // the repositories of the static registry.
    const release = process.env.FACTORY_RELEASE_FILE ? releaseSchema.parse(z.object({ release: z.unknown() })
      .parse(JSON.parse(await readFile(resolve(process.env.FACTORY_RELEASE_FILE), 'utf8'))).release) : null;
    const registered = async (registration: Registration) => {
      if (!release) throw new Error('REGISTRATION_REQUIRES_PINNED_RELEASE');
      return bind(registrySchema.shape.repositories.element.parse({ ...registration, release, approvalMode: 'ready-label', requireHumanGate: false, validateCoding: true }));
    };
    for (const registration of await store.registrations()) {
      if (bindings.some(b => b.repository.repositoryId === registration.repositoryId)) continue;
      try { bindings.push(await registered(registration)); }
      catch (error) { console.warn(JSON.stringify({ event: 'factory-registration-unavailable', repositoryId: registration.repositoryId,
        reason: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'BINDING_FAILED' })); }
    }
    const register = async (registration: Registration) => {
      const binding = await registered(registration);
      await store.register(registration);
      return binding;
    };
    const server = runtimeServer({ managerToken: process.env.FACTORY_MANAGER_TOKEN ?? '', workerToken: process.env.FACTORY_WORKER_TOKEN ?? '', bindings, store, register,
      ...(process.env.SLACK_BOT_TOKEN ? { notifications: new SlackSink(process.env.SLACK_BOT_TOKEN) } : {}) });
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
