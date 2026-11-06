import { readFile, readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { parseDocument } from 'yaml';
for (const path of [...(await readdir('.github/workflows')).map(f => `.github/workflows/${f}`), 'templates/factory-manager.yml']) {
  const doc = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  assert.equal(doc.errors.length, 0); const workflow = doc.toJS();
  assert(workflow.on && workflow.jobs && workflow.permissions); assert(!workflow.on.pull_request_target);
  if (path.startsWith('templates/')) assert(workflow.concurrency && workflow.on.schedule && workflow.on.workflow_dispatch);
  for (const job of Object.values(workflow.jobs) as { permissions?: unknown }[]) assert(job.permissions);
  console.log(`Validated ${path}`);
}
const action = parseDocument(await readFile('action.yml', 'utf8')).toJS();
assert.equal(action.runs.using, 'composite');
