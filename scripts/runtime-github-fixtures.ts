import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { scopedRuntimeGitHub } from '../src/runtime/github-app.js';
import { GitHubClient } from '../src/github/client.js';
import { CodingRepository } from '../src/github/coding.js';
import { loadConfig, configSchema } from '../src/config/index.js';
import { RuntimeController } from '../src/runtime/controller.js';
import { MockPlanner } from '../src/llm/provider.js';
import type { RuntimeRelease } from '../src/runtime/contract.js';
import type { RuntimeStore } from '../src/runtime/store.js';
import type { Client } from '@temporalio/client';
import { RuntimeEffects } from '../src/runtime/effects.js';
import { RuntimeCodingPublisher } from '../src/runtime/publisher.js';
import type { RuntimeRepository } from '../src/runtime/controller.js';
import type { CodingArtifact } from '../src/workers/coding.js';
import { ActionsCodingExecutor } from '../src/runtime/coding-executor.js';

// Explicit opt-in local acceptance only. Credentials arrive over stdin, never env/argv/files.
export async function githubFixtures(release: RuntimeRelease, store: RuntimeStore, temporal: Client) {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 64000) throw new Error('CREDENTIAL_INPUT_LIMIT'); }
  const credentials = z.strictObject({ appId: z.literal('5669002'), privateKey: z.string().min(100), installationId: z.literal(179890385) }).parse(JSON.parse(input));
  const actor = 'munichdeveloper', bot = 'munichdeveloper-sf-manager-local[bot]';
  const cfg = configSchema.parse({ version: 1, factory: { scope: 'Isolated Temporal runtime acceptance; deterministic test Harness only.' },
    manager: { trustedActors: [bot] }, autonomy: { profile: 'autonomous', overrides: { merge_pr: 'deny', close_issue: 'deny', create_followup: 'deny', expand_scope: 'deny' } },
    execution: { engine: 'temporal' }, merge: { enabled: false }, deploy: { enabled: false } });
  const publisherFixture = process.env.SF_TEST_PUBLISHER_FIXTURE === '1';
  const actualCoding = process.env.SF_TEST_REAL_CODING === '1';
  const previousConfig = structuredClone(cfg);
  if (publisherFixture || actualCoding) cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null };
  const publisherConfig = structuredClone(cfg);
  if (actualCoding) { cfg.factory.scope = 'Isolated Temporal acceptance in this disposable repository; bounded coding tasks and Draft PR publication only.'; cfg.execution.workerTimeoutMinutes = 10; }
  class Target extends GitHubClient {
    lostResultResponse = false;
    override async writeEvent(...args: Parameters<GitHubClient['writeEvent']>) {
      await super.writeEvent(...args);
      if (args[1].data.type === 'result' && this.lostResultResponse) { this.lostResultResponse = false; throw new Error('Injected lost journal response'); }
    }
  }
  const fixtures = [];
  const digestBody = 'Compute a deterministic digest through the pinned Harness.\n\n## Acceptance criteria\n- Produce a durable digest result after an authenticated human gate.\n- Preserve the run across worker restart.\n\nNo product changes or merge requested.';
  const publisherBody = 'Verify a deterministic publisher fixture, without a model call.\n\n## Acceptance criteria\n- Publish the bounded fixture text file as exactly one Draft PR.\n- Reconcile lost GitHub and database receipts without duplicate publication.\n\nNo product changes or merge requested.';
  const codingBody = 'Implement a tiny isolated Temporal coding acceptance task. Do not edit existing files.\n\n## Acceptance criteria\n- Create acceptance/temporal-coding.txt containing exactly "Temporal executes this coding task." followed by a newline.\n- Create acceptance/verify-temporal-coding.mjs using only Node built-ins to assert that exact file content.\n- Run node acceptance/verify-temporal-coding.mjs successfully.\n- Leave the two files for the caller to publish as a Draft PR; do not push or merge.\n\nNo product changes or deployment requested.';
  for (const [repositoryId, repo] of [[1450715381, 'sf-temporal-acceptance-a-20261108'], [1450715704, 'sf-temporal-acceptance-b-20261108']] as const) {
    const api = scopedRuntimeGitHub({ ...credentials, repositoryId }), target = { owner: actor, repo };
    const metadata = (await api.repos.get(target)).data;
    assert.equal(metadata.id, repositoryId); assert.equal(metadata.private, true); assert.equal(metadata.owner.login, actor);
    const github = new Target(metadata.full_name, '', 20000, fetch, api);
    assert(await github.canApprove(actor), 'Expected the owner to have live repository permission');
    // Prove a token for one selected repository cannot access the other selected repository.
    const other = repositoryId === 1450715381 ? 'sf-temporal-acceptance-b-20261108' : 'sf-temporal-acceptance-a-20261108';
    await assert.rejects(api.repos.get({ owner: actor, repo: other }), (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404);
    const path = '.github/software-factory.yml', content = JSON.stringify(cfg, null, 2) + '\n';
    try {
      const existing = loadConfig(await github.readConfig(path));
      if ((publisherFixture || actualCoding) && [previousConfig, publisherConfig].some(c => JSON.stringify(existing) === JSON.stringify(c)) && JSON.stringify(existing) !== JSON.stringify(cfg)) {
        const file = (await api.repos.getContent({ ...target, path, ref: metadata.default_branch })).data;
        assert('sha' in file && !Array.isArray(file));
        await api.repos.createOrUpdateFileContents({ ...target, path, sha: file.sha, message: actualCoding ? 'Configure bounded real Temporal coding acceptance' : 'Enable isolated publisher acceptance fixture (no model run)', content: Buffer.from(content).toString('base64') });
      } else assert.deepEqual(existing, cfg, 'Existing test configuration differs; inspect before changing it');
    }
    catch (error) {
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
      await api.repos.createOrUpdateFileContents({ ...target, path, message: 'Configure isolated Temporal runtime acceptance (no deployment or merge)', content: Buffer.from(content).toString('base64') });
    }
    await github.bootstrap();
    // A fresh disposable database cannot claim authority over gates from a removed test cluster.
    // Retire only our exact, bot-authored fixture envelopes from the active test scope; preserve evidence.
    const retiredFixtureIssues: number[] = [];
    for (const old of await api.paginate(api.issues.listForRepo, { ...target, labels: 'harness:managed', state: 'all', per_page: 100 })) {
      if (!old.pull_request && old.user?.login === bot && /^Temporal runtime acceptance [a-f0-9-]{36}$/.test(old.title) &&
          [digestBody, publisherBody, codingBody].includes(old.body ?? '')) {
        await api.issues.update({ ...target, issue_number: old.number, labels: old.labels.map(l => typeof l === 'string' ? l : l.name ?? '').filter(l => l !== 'harness:managed') });
        retiredFixtureIssues.push(old.number);
      }
    }
    const task = await github.createIssue(`Temporal runtime acceptance ${randomUUID()}`, actualCoding ? codingBody : publisherFixture ? publisherBody : digestBody, ['harness:managed', 'harness:ready']);
    const coding = new CodingRepository(metadata.full_name, '', fetch, api);
    const repository: RuntimeRepository = { repositoryId, repository: metadata.full_name, release, requireHumanGate: true, github,
      config: async () => loadConfig(await github.readConfig(path)), baseSha: async () => (await coding.base()).sha };
    const controller = new RuntimeController(repository, store, temporal);
    if (publisherFixture) {
      // Test publisher boundary explicitly, without pretending this deterministic artifact came from an LLM.
      repository.coding = { executor: { cancel: async () => {}, poll: async snapshot => {
        const input = snapshot.admission.input;
        const artifact: CodingArtifact = { contractVersion: '3.0', baseSha: snapshot.baseSha,
          result: { contractVersion: '2.0', executionId: input.executionId, taskId: `github:${snapshot.repository}#${input.issueNumber}`, taskVersion: input.taskVersion,
            status: 'success', summary: 'Deterministic publisher acceptance fixture; no model execution.', artifacts: [], error: null },
          changes: [{ path: `acceptance/${input.executionId}.txt`, mode: '100644', content: Buffer.from('Verified durable Temporal publisher fixture.\n').toString('base64') }] };
        return { artifact };
      } }, publish: (snapshot, binding, artifact, at) => new RuntimeCodingPublisher(api,
        new RuntimeEffects(store, repositoryId, snapshot.admission.input.executionId, binding), () => controller.authorize(snapshot, binding), cfg.manager.trustedActors).publish(snapshot, artifact, at) };
    }
    if (actualCoding) {
      repository.coding = { executor: new ActionsCodingExecutor(api, (snapshot, binding) => new RuntimeEffects(store, repositoryId, snapshot.admission.input.executionId, binding),
        (snapshot, binding) => controller.authorize(snapshot, binding), cfg.manager.trustedActors),
        publish: (snapshot, binding, artifact, at) => new RuntimeCodingPublisher(api,
          new RuntimeEffects(store, repositoryId, snapshot.admission.input.executionId, binding), () => controller.authorize(snapshot, binding), cfg.manager.trustedActors).publish(snapshot, artifact, at) };
    }
    const verifyCoding = async (executionId: string) => {
      const artifact = await store.artifact(repositoryId, executionId); assert(artifact, 'Missing stored coding artifact');
      const content = artifact.changes.find(c => c.path === 'acceptance/temporal-coding.txt');
      assert(content?.content); assert.equal(Buffer.from(content.content, 'base64').toString('utf8'), 'Temporal executes this coding task.\n');
      assert(artifact.changes.some(c => c.path === 'acceptance/verify-temporal-coding.mjs'));
      const runs = await api.paginate(api.actions.listWorkflowRuns, { ...target, workflow_id: 'factory-temporal-executor.yml', branch: `sf-temporal-executor/${executionId}`, event: 'workflow_dispatch', per_page: 100 });
      assert.equal(runs.length, 1); assert.equal(runs[0]!.conclusion, 'success');
      return { id: runs[0]!.id, url: runs[0]!.html_url, head: runs[0]!.head_sha, artifactHash: (await import('../src/state/identity.js')).hash(artifact) };
    };
    fixtures.push({ repository, controller, planner: new MockPlanner(), github, issueNumber: task.number, retiredFixtureIssues, verifyCoding });
  }
  return { fixtures, actor };
}
