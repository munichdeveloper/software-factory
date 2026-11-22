import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
const managerTemplates = ['templates/factory-manager.yml'];
const RUNNER = "${{ vars.SF_RUNNER || 'ubuntu-latest' }}";
const runnerSwitched = [...managerTemplates, 'templates/factory-deploy.yml',
  '.github/workflows/temporal-coding-executor.yml', '.github/workflows/temporal-artifact-validator.yml'];
for (const path of [...(await readdir('.github/workflows')).map(f => `.github/workflows/${f}`), ...managerTemplates, 'templates/factory-deploy.yml']) {
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  assert.equal(doc.errors.length, 0); const workflow = doc.toJS();
  assert(workflow.on && workflow.jobs && workflow.permissions); assert(!workflow.on.pull_request_target);
  for (const job of Object.values(workflow.jobs) as { permissions?: unknown }[]) assert(job.permissions);
  // Jobs that run in installed (possibly private) repositories take their runner from the repository variable
  // SF_RUNNER, so the broker can move them to the self-hosted pool when the Actions budget is used up (#110).
  if (runnerSwitched.includes(path)) {
    for (const [name, job] of Object.entries(workflow.jobs) as [string, { 'runs-on'?: unknown; uses?: unknown }][]) {
      if (job.uses) continue;
      assert.equal(job['runs-on'], RUNNER, `${path}: job ${name} must run on ${RUNNER}`);
    }
  }
  if (managerTemplates.includes(path)) {
    assert(workflow.concurrency && workflow.on.schedule && workflow.on.workflow_dispatch);
    for (const name of ['factory', 'merge-notifications']) {
      assert.equal(workflow.jobs[name].permissions['pull-requests'], 'write', `${name} must persist notification receipts on PRs`);
    }
  }
  if (path === 'templates/factory-deploy.yml') {
    assert(workflow.concurrency && workflow.concurrency['cancel-in-progress'] === false, 'deployments must never be cancelled mid-flight');
    assert(workflow.on.workflow_run && workflow.on.push !== undefined && workflow.on.workflow_dispatch);
    const job = workflow.jobs.deploy;
    assert.deepEqual(job.permissions, { contents: 'read', deployments: 'write', actions: 'read' });
    assert(job.environment, 'deployments run in a GitHub environment');
    const step = job.steps.find((s: { uses?: string }) => s.uses?.startsWith('munichdeveloper/software-factory@'));
    assert.equal(step.with.mode, 'deploy');
    assert(!JSON.stringify(job).includes('OPENAI_API_KEY') && !JSON.stringify(job).includes('SLACK_BOT_TOKEN'), 'deploy job receives only deployment secrets');
  }
  // GitHub drops a job output it takes for a secret, so a coding request quoting `Authorization: Bearer <key>` reached the
  // next job empty (#182). The request travels as the artifact coding-request-<executionId>, never as a job output.
  if (path === '.github/workflows/temporal-coding-executor.yml') {
    for (const [name, job] of Object.entries(workflow.jobs) as [string, { outputs?: Record<string, string> }][]) {
      assert(!Object.keys(job.outputs ?? {}).includes('request'), `${path}: job ${name} must not pass the coding request as a job output`);
    }
    assert(JSON.stringify(workflow.jobs).includes('coding-request-'), `${path}: the coding request must travel as an artifact`);
  }
  if (path === '.github/workflows/temporal-artifact-validator.yml') assert(!workflow.on.workflow_call.inputs.request, 'the validator reads the request artifact');
  console.log(`Validated ${path}`);
}
const action = parseDocument(await readFile('action.yml', 'utf8')).toJS();
assert.equal(action.runs.using, 'composite');
for (const step of action.runs.steps as { env?: Record<string, string>; if?: string }[]) {
  if (!step.env) continue;
  const deploySecrets = Object.keys(step.env).filter(k => k.startsWith('DEPLOY_'));
  if (deploySecrets.length) assert(step.if?.includes("inputs.mode == 'deploy'"), 'deployment secrets are only exposed in deploy mode');
}
