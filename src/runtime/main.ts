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
import { attemptAgents, loadConfig, type Config } from '../config/index.js';
import { escalated } from './coding-context.js';
import { GitHubClient } from '../github/client.js';
import { CodingRepository } from '../github/coding.js';
import { ClaudePlanner, FallbackPlanner, MockPlanner, OpenAIPlanner } from '../llm/provider.js';
import { claudeModels, claudeStructured } from '../llm/claude.js';
import { ModelRouter, RouterAlerts, Routing } from '../llm/router.js';
import { routedAssessor, routedPlanner, routedReviewer, type RoutedModels } from '../llm/routed-models.js';
import { assertRetainedReleases } from './retention.js';
import { hash } from '../state/identity.js';
import { releaseSchema, baseRefSchema, executorWorkflowSchema } from './contract.js';
import { RuntimeStore, type Registration } from './store.js';
import { RuntimeController, type RuntimeRepository } from './controller.js';
import { startReconcileSchedule } from './schedule.js';
import { QueueBoard } from './queue.js';
import { SanityMonitor } from './sanity.js';
import { SlackSanityAlerts } from '../notifications/sanity-alerts.js';
import { CreditAlerts } from './credit-alerts.js';
import { listenAddresses } from './listen.js';
import { runtimeServer, type RuntimeBinding } from './server.js';
import { startRuntimeWorker, type WorkerPackage } from './worker.js';
import { appCommitIdentity, scopedRuntimeGitHub } from './github-app.js';
import { RunnerDispenser, RunnerFallback, startRunnerFallback, type RunnerRepositoryPort } from './runners.js';
import { runnerRepository } from './runner-github.js';
import { ActionsCodingExecutor, codingWorkflow, storedSelection } from './coding-executor.js';
import { RuntimeEffects } from './effects.js';
import { RuntimeCodingPublisher, containsCommit } from './publisher.js';
import { IssueScopedGitHub } from './issue-scope.js';
import { defaultValidationPlan, validationPlanSchema } from './validation-contract.js';
import { RuntimeMerge } from './merge.js';
import { SlackSink } from '../notifications/slack.js';
import { GitHubMergePort } from '../merge/github.js';
import { MergeManager } from '../merge/manager.js';
import { assertCanaryConfig, canaryLabel, canaryRepository, runCanary } from './canary.js';
import { ClaudeMergeReviewer, FallbackMergeReviewer, OpenAIMergeReviewer } from '../merge/reviewer.js';
import { ClaudeRiskAssessor, FallbackRiskAssessor, OpenAIRiskAssessor } from '../merge/risk.js';

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
/**
 * The registry entry of a repository the SF Manager registered: the rollout installs the executor wrapper as
 * factory-manager.yml, the ready label is the grant, and coding is validated independently.
 */
export function registeredItem(registration: Registration, release: unknown, retainedReleases: unknown[] = []) {
  return registrySchema.shape.repositories.element.parse({ ...registration, release, retainedReleases, executorWorkflow: 'factory-manager.yml',
    approvalMode: 'ready-label', requireHumanGate: false, validateCoding: true });
}
const packageRelease = (workerPackage: unknown) => releaseSchema.parse(z.object({ release: z.unknown() }).parse(workerPackage).release);
/**
 * The releases of the worker packages the host runs (the files `pack` writes): the current one serves every new run;
 * the previous one, where it differs, is retained only for runs admitted before the last host rollout.
 */
export function hostReleases(workerPackage: unknown, previousPackage?: unknown) {
  const release = packageRelease(workerPackage), previous = previousPackage === undefined ? null : packageRelease(previousPackage);
  return { release, retainedReleases: previous && hash(previous) !== hash(release) ? [previous] : [] };
}
/** Replaces every repository's releases with those of the host's worker packages. */
export function supersedeRelease(repositories: { release: unknown; retainedReleases?: unknown }[], workerPackage: unknown, previousPackage?: unknown) {
  const releases = hostReleases(workerPackage, previousPackage);
  for (const item of repositories) Object.assign(item, releases);
}
export async function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, output: { type: 'string' }, 'factory-sha': { type: 'string' }, 'harness-sha': { type: 'string' },
    harness: { type: 'string' }, deployment: { type: 'string' }, build: { type: 'string' }, queue: { type: 'string' },
    release: { type: 'string' }, timeout: { type: 'string' },
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
  if (positionals[0] === 'canary') { process.exitCode = await canary(values.release ?? '', values.timeout); return; }
  if (positionals[0] !== 'serve') throw new Error('Use serve, worker, pack or canary');
  const registry = registrySchema.parse(JSON.parse(await readFile(resolve(z.string().min(1).parse(values.file)), 'utf8')));
  // A stack that builds its PINNED worker itself names that worker's release here, and the previous worker's release
  // it still runs; they replace the registry's release entries, so a release rollout needs no edit on the host. Runs of
  // any other release are not retained: the start guard below refuses to orphan them (software-factory#102).
  const packageFile = async (name: string) => process.env[name] ? JSON.parse(await readFile(resolve(process.env[name]!), 'utf8')) as unknown : undefined;
  const workerPackage = await packageFile('FACTORY_RELEASE_FILE'), previousPackage = await packageFile('FACTORY_PREVIOUS_RELEASE_FILE');
  const host = workerPackage === undefined ? null : hostReleases(workerPackage, previousPackage);
  // The acceptance repository of the deployment canary (software-factory#27): bound without a ready grant and with the
  // test worker only. Configured through the deployment (FACTORY_CANARY_REPOSITORY), never by editing the host.
  const canaryItem = canaryRepository(process.env.FACTORY_CANARY_REPOSITORY);
  if (canaryItem && host && !registry.repositories.some(r => r.repositoryId === canaryItem.repositoryId)) {
    registry.repositories.push(registrySchema.shape.repositories.element.parse({ ...canaryItem, release: host.release,
      approvalMode: 'manual', requireHumanGate: false, validateCoding: false }));
  }
  if (workerPackage !== undefined) supersedeRelease(registry.repositories, workerPackage, previousPackage);
  // Runs of the previous release are ended after this many hours; 0 keeps them until they end by themselves.
  const retainedRunMs = z.coerce.number().min(0).max(720).parse(process.env.FACTORY_RETAINED_RUN_HOURS ?? '2') * 3600000;
  const store = new RuntimeStore(new Pool({ connectionString: process.env.FACTORY_RUNTIME_DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 }));
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233', connectTimeout: '5 seconds' });
  const temporal = new Client({ connection, namespace: registry.namespace });
  // Used-up agent credit (workers.coding.agents) goes to this channel, at most three times per agent.
  // The broker's own Anthropic key (deploy secret BROKER_ANTHROPIC_API_KEY): planner, merge review and risk ask Claude first.
  const claude = process.env.ANTHROPIC_API_KEY ? claudeStructured(process.env.ANTHROPIC_API_KEY) : undefined, models = claudeModels(process.env);
  const creditChannel = process.env.FACTORY_CREDIT_ALERT_CHANNEL;
  const creditAlerts = process.env.SLACK_BOT_TOKEN && creditChannel ? new CreditAlerts(store, new SlackSanityAlerts(process.env.SLACK_BOT_TOKEN), creditChannel) : undefined;
  // The model router (router: in a repository's configuration) asks Jev through OpenRouter with the broker's own key
  // (deploy secret BROKER_OPENROUTER_API_KEY). Without the key every routed purpose runs its configured models and,
  // with FACTORY_ROUTER_ALERT_CHANNEL, Slack hears about it.
  const routerChannel = process.env.FACTORY_ROUTER_ALERT_CHANNEL;
  const routing = new Routing(new ModelRouter(process.env.OPENROUTER_API_KEY || undefined),
    process.env.SLACK_BOT_TOKEN && routerChannel ? new RouterAlerts(new SlackSanityAlerts(process.env.SLACK_BOT_TOKEN), routerChannel) : undefined);
  try {
    await store.migrate();
    type Item = z.infer<typeof registrySchema>['repositories'][number];
    // Self-hosted runner fallback (software-factory#110): every App-bound repository; public ones are skipped by the
    // fallback itself. The admin token is limited to this repository and to runners and variables.
    const runnerPorts: RunnerRepositoryPort[] = [];
    const addRunnerPort = (item: Item, actions: Octokit) => {
      if (!item.githubInstallationId || runnerPorts.some(p => p.repositoryId === item.repositoryId)) return;
      runnerPorts.push(runnerRepository(item.repositoryId, item.repository, actions, scopedRuntimeGitHub({ appId: process.env.GITHUB_APP_ID ?? '',
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? '', installationId: item.githubInstallationId, repositoryId: item.repositoryId,
        permissions: { administration: 'write', actions_variables: 'write' } })));
    };
    const bind = async (item: Item): Promise<RuntimeBinding> => {
      if (item.githubInstallationId && !(process.env.GITHUB_ALLOWED_INSTALLATION_IDS ?? '').split(',').includes(String(item.githubInstallationId))) throw new Error('INSTALLATION_NOT_ALLOWLISTED');
      const token = item.githubTokenEnv ? z.string().min(1).parse(process.env[item.githubTokenEnv]) : '';
      const api = item.githubInstallationId ? scopedRuntimeGitHub({ appId: z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
        privateKey: z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), installationId: item.githubInstallationId, repositoryId: item.repositoryId }) : new Octokit({ auth: token });
      const source = new GitHubClient(item.repository, token, 30000, fetch, api);
      const github = item.issueNumbers ? new IssueScopedGitHub(source, item.issueNumbers) : source;
      const [owner, repo] = item.repository.split('/') as [string, string];
      if ((await api.repos.get({ owner, repo })).data.id !== item.repositoryId) throw new Error('REPOSITORY_ID_MISMATCH');
      addRunnerPort(item, api);
      const isCanary = canaryItem?.repositoryId === item.repositoryId;
      const repository: RuntimeRepository = { ...item, github, retainedRunMs, config: async () => {
        const config = loadConfig(await source.readConfig(item.configPath, item.baseRef));
        return isCanary ? assertCanaryConfig(config) : config;
      },
        baseSha: async () => item.baseRef ? (await api.git.getRef({ ...{ owner, repo }, ref: `heads/${item.baseRef}` })).data.object.sha : (await new CodingRepository(item.repository, token, fetch, api).base()).sha };
      repository.baseContains = async sha => containsCommit(api, { owner, repo }, await repository.baseSha(), sha);
      repository.executorWrapper = async () => {
        try {
          const data = (await api.repos.getContent({ owner, repo, path: `.github/workflows/${item.executorWorkflow ?? codingWorkflow}`, ref: await repository.baseSha() })).data;
          return 'content' in data && data.encoding === 'base64' ? Buffer.from(data.content, 'base64').toString('utf8') : null;
        } catch (error) { if (error && typeof error === 'object' && 'status' in error && error.status === 404) return null; throw error; }
      };
      const controller = new RuntimeController(repository, store, temporal);
      if (item.approvalMode === 'ready-label') {
        repository.readyApproval = async (number, expected, rework) => source.readyApproval(number, (await repository.config()).manager.trustedActors, expected, rework);
        repository.managedApproval = async number => source.managedApproval(number, (await repository.config()).manager.trustedActors);
      }
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
        id => store.validation(repository.repositoryId, id),
        async (_snapshot, selection) => { try { await creditAlerts?.observe(item.repository, selection); } catch { /* an alert never fails a run */ } },
        routing),
        publish: async (snapshot, binding, artifact, createdAt, validation) => { const config = await repository.config();
          // The agent that ran: the executor's stored choice for a priority list, otherwise the configured agent.
          const chosen = await storedSelection(effects(snapshot, binding), snapshot.admission.input.executionId, () => controller.authorize(snapshot, binding));
          const agent = chosen?.selected?.worker ?? (config.workers.coding ? attemptAgents(config.workers.coding, escalated(snapshot.admission.input))[0]!.agent : 'codex');
          // Commits show the App's bot user as author; without it Vercel and GitHub see a stranger's noreply account.
          const identity = item.githubInstallationId ? await appCommitIdentity(z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
            z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), api).catch(error => {
            console.log(JSON.stringify({ event: 'factory-commit-identity', outcome: 'legacy', reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
            return undefined;
          }) : undefined;
          return new RuntimeCodingPublisher(api, effects(snapshot, binding), () => controller.authorize(snapshot, binding), config.manager.trustedActors,
            agent, identity).publish(snapshot, artifact, createdAt, validation); } };
      // Refuse a registry rollout which would orphan any running version, including long human gates.
      await assertRetainedReleases(item.repositoryId, [item.release, ...item.retainedReleases], store, temporal);
      await repository.config(); // An unreadable or invalid configuration fails the start, not the first reconciliation.
      // Chosen per reconciliation: a configuration change in the repository applies without restarting the broker.
      // Claude first, OpenAI second (as for the coding agents), when the broker has an Anthropic key.
      // A purpose the repository routes (router: review, risk, planner) asks the router first; its configured chain
      // below stays the fallback.
      const routed: RoutedModels = { routing, repository: item.repository, claude, openaiKey: process.env.OPENAI_API_KEY ?? '' };
      const openai = new OpenAIPlanner(process.env.OPENAI_API_KEY ?? ''), mock = new MockPlanner();
      const planner = routedPlanner(routed, claude ? new FallbackPlanner(new ClaudePlanner(claude, models.planner), openai) : openai);
      const reviewer = (config: Config) => { const plain = new OpenAIMergeReviewer(process.env.OPENAI_API_KEY ?? '', config);
        return routedReviewer(routed, config, claude ? new FallbackMergeReviewer(new ClaudeMergeReviewer(claude, models.review, config), plain) : plain); };
      const assessor = (config: Config) => { const plain = new OpenAIRiskAssessor(process.env.OPENAI_API_KEY ?? '', config);
        return routedAssessor(routed, config, claude ? new FallbackRiskAssessor(new ClaudeRiskAssessor(claude, models.risk, config), plain) : plain); };
      // Only pull requests the Factory published for its tasks in an issue-scoped registry entry; closed ones while a merge's follow-up may be open.
      const merge = new RuntimeMerge(item.repositoryId, (config, snapshot) => new MergeManager(
        new GitHubMergePort(item.repository, api, config.factory.scope, config.merge.adoptLabel, fetch, 48 * 3600000),
        config, reviewer(config), `temporal-merge:${item.repositoryId}`, github,
        { ownedOnly: !!item.issueNumbers, assessor: assessor(config) }).run(snapshot));
      return { repository, controller, planner: config => config.llm.provider === 'mock' ? mock : planner, merge };
    };
    const bindings: RuntimeBinding[] = [];
    for (const item of registry.repositories) bindings.push(await bind(item));
    // Private repositories the runtime does not serve but whose CI should follow the fallback too (for example the
    // SF Manager itself): "id:owner/name" pairs, reached through the App installation of the bound repositories.
    const runnerInstallation = registry.repositories.find(item => item.githubInstallationId)?.githubInstallationId;
    for (const entry of (process.env.FACTORY_RUNNER_REPOSITORIES ?? '').split(',').map(e => e.trim()).filter(Boolean)) {
      const [, id, repository] = /^([0-9]+):([\w.-]+\/[\w.-]+)$/.exec(entry) ?? [];
      if (!id || !repository || !runnerInstallation) throw new Error(`INVALID_RUNNER_REPOSITORY ${entry}`);
      const item = { repositoryId: Number(id), repository, githubInstallationId: runnerInstallation } as Item;
      addRunnerPort(item, scopedRuntimeGitHub({ appId: z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
        privateKey: z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), installationId: runnerInstallation, repositoryId: item.repositoryId }));
    }
    // Repositories the SF Manager registered (Temporal rollout): served with the PINNED worker release, the ready
    // label as grant and independent validation. A registration that cannot be bound is reported, never fatal for
    // the repositories of the static registry.
    const registered = async (registration: Registration) => {
      if (!host) throw new Error('REGISTRATION_REQUIRES_PINNED_RELEASE');
      return bind(registeredItem(registration, host.release, host.retainedReleases));
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
    const notifications = process.env.SLACK_BOT_TOKEN ? new SlackSink(process.env.SLACK_BOT_TOKEN) : undefined;
    const monitor = new SanityMonitor(store, undefined, process.env.SLACK_BOT_TOKEN ? new SlackSanityAlerts(process.env.SLACK_BOT_TOKEN) : undefined);
    // The broker reconciles its repositories itself; 0 leaves it to external callers (the SF Manager) as before.
    // 180 s like the Manager did: one pass costs about 150 GitHub requests, once a minute already exceeds an App
    // installation's 5000 requests per hour.
    const interval = z.coerce.number().int().min(0).max(3600).parse(process.env.FACTORY_RECONCILE_INTERVAL_SECONDS ?? '180');
    // The job queue view for software-factory-monitor; FACTORY_MONITOR_TOKEN opens it read-only (unset: manager token only).
    const queue = new QueueBoard(undefined, interval || null);
    const serverOptions = { monitor, queue, managerToken: process.env.FACTORY_MANAGER_TOKEN ?? '', workerToken: process.env.FACTORY_WORKER_TOKEN ?? '', bindings, store, register,
      monitorToken: process.env.FACTORY_MONITOR_TOKEN ?? '', ...(notifications ? { notifications } : {}) };
    const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.FACTORY_RUNTIME_PORT ?? '8095');
    const addresses = await listenAddresses(process.env.FACTORY_RUNTIME_LISTEN_ALIAS);
    // One server per address; they share the options, so a registration through either is served by both.
    const servers = addresses.map(() => runtimeServer(serverOptions));
    await Promise.all(servers.map((server, i) => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, addresses[i], resolve); })));
    const stopSchedule = interval ? startReconcileSchedule(bindings, { store, monitor, queue, ...(notifications ? { notifications } : {}) }, interval * 1000) : async () => {};
    // Off unless the deployment turns it on: the App needs Administration and Variables write for it.
    const stopRunners = process.env.FACTORY_RUNNER_FALLBACK === 'on' ? (() => {
      const channel = process.env.FACTORY_RUNNER_ALERT_CHANNEL, slack = process.env.SLACK_BOT_TOKEN && channel ? new SlackSanityAlerts(process.env.SLACK_BOT_TOKEN) : undefined;
      const fallback = new RunnerFallback(runnerPorts, slack ? { alerts: { post: text => slack.post(channel!, text) } } : {});
      const slots = process.env.FACTORY_RUNNER_SLOTS_DIR;
      return startRunnerFallback(fallback, slots ? new RunnerDispenser(fallback, slots) : null, Math.max(interval, 60) * 1000);
    })() : () => {};
    console.log(JSON.stringify({ service: 'factory-runtime', port, addresses, reconcileIntervalSeconds: interval, repositories: bindings.map(b => b.repository.repositoryId) }));
    await new Promise<void>(resolve => {
      const stop = () => { stopRunners(); void stopSchedule().finally(() => Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done())))).then(() => resolve())); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    });
  } finally { await connection.close(); await store.pool.end(); }
}
/**
 * The deployment canary, run inside the broker container after a deployment: one task in the acceptance repository
 * through the whole chain (software-factory#27). Prints one JSON line and returns the exit code: 0 passed or no canary
 * configured, 1 failed (the line names the stage that did not complete).
 */
async function canary(release: string, timeout: string | undefined): Promise<number> {
  const item = canaryRepository(process.env.FACTORY_CANARY_REPOSITORY);
  if (!item) { console.log(JSON.stringify({ event: 'factory-canary', outcome: 'skipped', reason: 'FACTORY_CANARY_REPOSITORY not set' })); return 0; }
  const api = scopedRuntimeGitHub({ appId: z.string().regex(/^[0-9]+$/).parse(process.env.GITHUB_APP_ID),
    privateKey: z.string().min(1).parse(process.env.GITHUB_APP_PRIVATE_KEY), installationId: item.githubInstallationId, repositoryId: item.repositoryId });
  const github = new GitHubClient(item.repository, '', 30000, fetch, api);
  const [owner, repo] = item.repository.split('/') as [string, string];
  const port = z.coerce.number().int().min(1024).max(65535).parse(process.env.FACTORY_RUNTIME_PORT ?? '8095');
  const token = z.string().min(32).parse(process.env.FACTORY_MANAGER_TOKEN);
  const outcome = await runCanary({
    openCanaries: async () => (await api.paginate(api.issues.listForRepo, { owner, repo, labels: canaryLabel, state: 'open', per_page: 100 }))
      .filter(i => !i.pull_request).map(i => i.number),
    createIssue: (title, body, labels) => github.createIssue(title, body, labels),
    getIssue: number => github.getIssue(number),
    comments: number => github.comments(number),
    close: number => github.updateIssue(number, { state: 'closed' }),
    observations: async executionIds => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/repositories/${item.repositoryId}/observations`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ executionIds }) });
      if (!response.ok) throw new Error('CANARY_OBSERVATIONS_UNAVAILABLE');
      return await response.json() as Awaited<ReturnType<RuntimeController['observations']>>;
    },
    config: async () => assertCanaryConfig(loadConfig(await github.readConfig('.github/software-factory.yml'))),
    now: () => new Date(), sleep: ms => new Promise(done => setTimeout(done, ms)),
  }, { release, timeoutMs: z.coerce.number().int().min(60).max(3600).parse(timeout ?? '900') * 1000 });
  console.log(JSON.stringify({ event: 'factory-canary', outcome: outcome.ok ? 'passed' : 'failed', repositoryId: item.repositoryId, ...outcome }));
  return outcome.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('FACTORY_RUNTIME_FAILED'); process.exitCode = 1;
});
