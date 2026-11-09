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

// Explicit opt-in local acceptance only. Credentials arrive over stdin, never env/argv/files.
export async function githubFixtures(release: RuntimeRelease, store: RuntimeStore, temporal: Client) {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 64000) throw new Error('CREDENTIAL_INPUT_LIMIT'); }
  const credentials = z.strictObject({ appId: z.literal('5669002'), privateKey: z.string().min(100), installationId: z.literal(179890385) }).parse(JSON.parse(input));
  const actor = 'munichdeveloper', bot = 'munichdeveloper-sf-manager-local[bot]';
  const cfg = configSchema.parse({ version: 1, factory: { scope: 'Isolated Temporal runtime acceptance; deterministic test Harness only.' },
    manager: { trustedActors: [bot] }, autonomy: { profile: 'autonomous', overrides: { merge_pr: 'deny', close_issue: 'deny', create_followup: 'deny', expand_scope: 'deny' } },
    execution: { engine: 'temporal' }, merge: { enabled: false }, deploy: { enabled: false } });
  class Target extends GitHubClient {
    lostResultResponse = false;
    override async writeEvent(...args: Parameters<GitHubClient['writeEvent']>) {
      await super.writeEvent(...args);
      if (args[1].data.type === 'result' && this.lostResultResponse) { this.lostResultResponse = false; throw new Error('Injected lost journal response'); }
    }
  }
  const fixtures = [];
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
    try { assert.deepEqual(loadConfig(await github.readConfig(path)), cfg, 'Existing test configuration differs; inspect before changing it'); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'status' in error && error.status === 404)) throw error;
      await api.repos.createOrUpdateFileContents({ ...target, path, message: 'Configure isolated Temporal runtime acceptance (no deployment or merge)', content: Buffer.from(content).toString('base64') });
    }
    await github.bootstrap();
    const task = await github.createIssue(`Temporal runtime acceptance ${randomUUID()}`, 'Compute a deterministic digest through the pinned Harness.\n\n## Acceptance criteria\n- Produce a durable digest result after an authenticated human gate.\n- Preserve the run across worker restart.\n\nNo product changes or merge requested.', ['harness:managed', 'harness:ready']);
    const coding = new CodingRepository(metadata.full_name, '', fetch, api);
    const repository = { repositoryId, repository: metadata.full_name, release, requireHumanGate: true, github,
      config: async () => loadConfig(await github.readConfig(path)), baseSha: async () => (await coding.base()).sha };
    fixtures.push({ repository, controller: new RuntimeController(repository, store, temporal), planner: new MockPlanner(), github, issueNumber: task.number });
  }
  return { fixtures, actor };
}
