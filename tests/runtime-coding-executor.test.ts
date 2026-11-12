import { Octokit } from '@octokit/rest';
import { zipSync, strToU8 } from 'fflate';
import { expect, it, vi } from 'vitest';
import { ActionsCodingExecutor, decodeCodingArchive, executorWrapper } from '../src/runtime/coding-executor.js';
import { codingExecutionSchema } from '../src/runtime/coding-contract.js';
import type { EffectPort, EffectRequest } from '../src/runtime/effects.js';
import { snapshotSchema } from '../src/runtime/contract.js';
import { hash } from '../src/state/identity.js';
import { config } from './helpers.js';
import type { CodingArtifact } from '../src/workers/coding.js';
import { defaultValidationPlan, type ValidationReport } from '../src/runtime/validation-contract.js';
import { reportFor } from './validation-fixtures.js';

const snapshot = snapshotSchema.parse({ version: 1, repositoryId: 42, repository: 'owner/target',
  release: { factorySha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), workflowHash: 'c'.repeat(64), deploymentName: 'sf-coding', buildId: 'v1', taskQueue: 'sf-coding', schemaVersion: 1 },
  admission: { actionId: 'd'.repeat(64), policyHash: 'e'.repeat(64), input: { contractVersion: '1.0', repository: 'owner/target', issueNumber: 2, taskVersion: 'f'.repeat(64),
    description: 'Implement a safe change', acceptanceCriteria: ['Tests pass'], contextReferences: [], executionId: '1'.repeat(32), allowedActions: ['publish_result'],
    limits: { timeoutMinutes: 5, maxOutputBytes: 16000 }, operation: 'sha256', worker: 'codex' } },
  baseSha: '2'.repeat(40), specHash: 'f'.repeat(64), configHash: '3'.repeat(64), requireHumanGate: true });
const artifact = ():CodingArtifact => ({ contractVersion: '3.0', baseSha: snapshot.baseSha, result: { contractVersion: '2.0', executionId: snapshot.admission.input.executionId,
  taskId: 'github:owner/target#2', taskVersion: snapshot.specHash, status: 'success', summary: 'Implemented and tested', artifacts: [], error: null },
  changes: [{ path: 'result.txt', content: 'eA==', mode: '100644' }] });
class Effects implements EffectPort {
  claims = new Map<string, { digest: string; receipt?: unknown }>();
  async perform<T>(r: EffectRequest<T>): Promise<T> {
    const previous = this.claims.get(r.key), digest = hash(r.payload);
    if (previous && previous.digest !== digest) throw new Error('EFFECT_PAYLOAD_CONFLICT');
    if (previous?.receipt) return r.validate(previous.receipt);
    await r.authorize(); const evidence = await r.reconcile();
    if (previous && evidence === null) throw new Error('EFFECT_UNCERTAIN_RECONCILIATION_REQUIRED');
    const claim = previous ?? { digest }; this.claims.set(r.key, claim);
    const receipt = evidence ?? await r.apply(); claim.receipt = receipt; return r.validate(receipt);
  }
}
function fixture(requestSnapshot = snapshot, extra?: (path: string) => unknown, previousValidation?: (id: string) => Promise<ValidationReport | null>) {
  const requests: { task: { contextReferences: string[] } }[] = [], calls: string[] = [];
  const cfg = config(); cfg.workers.coding = { enabled: true, agent: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', validationWorkflow: null, loopback: false };
  let ref = false, dispatches = 0, lost = false, before = false, complete = false, wrongHead = false, duplicate = false, badWrapper = false;
  let missingValidation=false,forgedValidation=false;
  let source = artifact(); const effects = new Effects(), authorize = vi.fn(async () => {}), workflowPaths:string[]=[];
  const fetcher: typeof fetch = async (input, init) => {
    const path = decodeURIComponent(new URL(String(input)).pathname).replace('/repos/owner/target', ''), method = init?.method ?? 'GET';
    if(path.includes('/actions/workflows/'))workflowPaths.push(path);
    let data: unknown, status = 200; calls.push(path);
    const custom = extra?.(path);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) { if (custom === null) status = 404; data = custom ?? {}; }
    else if (path === '') data = { id: 42, default_branch: 'main' };
    else if (path.startsWith('/contents/')) data = { encoding: 'base64', content: Buffer.from(badWrapper ? 'unapproved' : executorWrapper(snapshot.release.factorySha, snapshot.release.harnessSha,!!requestSnapshot.validationPlan)).toString('base64') };
    else if (path.startsWith('/git/ref/heads/')) { data = { object: { sha: snapshot.baseSha } }; if (!ref) status = 404; }
    else if (path === '/git/refs') { ref = true; data = { object: { sha: snapshot.baseSha } }; }
    else if (path.endsWith('/dispatches')) {
      dispatches++; const body = JSON.parse(String(init?.body)); expect(body.inputs.binding).toBe(hash(requestSnapshot)); requests.push(codingExecutionSchema.parse(JSON.parse(body.inputs.request)));
      if (before) { before = false; throw new Error('Uncertain send'); }
      if (lost) { lost = false; complete = true; throw new Error('Lost response'); }
      data = {}; status = 204;
    } else if (path.endsWith('/runs') && method === 'GET') {
      const run = { id: 12, display_title: `SF Temporal ${snapshot.admission.input.executionId} ${hash(requestSnapshot)}`, head_sha: wrongHead ? '9'.repeat(40) : snapshot.baseSha,
        actor: { login: 'factory[bot]' }, run_attempt: 1, event: 'workflow_dispatch', status: complete ? 'completed' : 'in_progress', conclusion: complete ? 'success' : null };
      data = { total_count: complete ? duplicate ? 2 : 1 : 0, workflow_runs: complete ? duplicate ? [run, run] : [run] : [] };
    } else if (path === '/actions/runs/12/artifacts') data = { total_count: 2, artifacts: [{ id: 15, name: `coding-result-${snapshot.admission.input.executionId}`, size_in_bytes: 1000, expired: false },...requestSnapshot.validationPlan&&!missingValidation?[{id:16,name:`coding-validation-${snapshot.admission.input.executionId}`,size_in_bytes:1000,expired:false}]:[]] };
    else if (path === '/actions/artifacts/15/zip') return new Response(zipSync({ 'artifact.json': strToU8(JSON.stringify(source)) }) as BodyInit);
    else if (path === '/actions/artifacts/16/zip') {const report=reportFor(source,requestSnapshot.validationPlan!);if(forgedValidation)report.artifactHash='9'.repeat(64);return new Response(zipSync({'validation.json':strToU8(JSON.stringify(report))}) as BodyInit);}
    else throw new Error(`Unexpected executor API ${method} ${path}`);
    const response = status === 204 ? new Response(null, { status }) : Response.json(data, { status }); Object.defineProperty(response, 'url', { value: String(input) }); return response;
  };
  const api = new Octokit({ auth: 'test-only', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  const executor = new ActionsCodingExecutor(api, () => effects, authorize, async () => ['factory[bot]'], previousValidation);
  return { cfg, requests, calls, poll: () => executor.poll(requestSnapshot, hash(requestSnapshot), cfg), workflowPaths, authorize, dispatches: () => dispatches, finish: () => { complete = true; },
    lose: () => { lost = true; }, before: () => { before = true; }, wrong: () => { wrongHead = true; }, duplicate: () => { duplicate = true; },
    badWrapper: () => { badWrapper = true; }, unrelated: () => { source = { ...source, baseSha: '9'.repeat(40) }; },missingValidation:()=>{missingValidation=true;},forgeValidation:()=>{forgedValidation=true;},blocked:()=>{source.result.status='blocked';} };
}
it('dispatches once, validates immutable wrapper/run/ZIP and returns only the correlated coding artifact', async () => {
  const f = fixture(); expect(await f.poll()).toBeNull(); expect(await f.poll()).toBeNull(); f.finish();
  expect(await f.poll()).toEqual({ artifact: artifact() }); expect(f.dispatches()).toBe(1);
});
it('retrieves a separate bound validation report for blocked code and refuses missing or forged evidence',async()=>{
  const selected=snapshotSchema.parse({...snapshot,validationPlan:defaultValidationPlan()}),f=fixture(selected);f.blocked();await f.poll();f.finish();
  const result=await f.poll();expect(result&&'artifact'in result&&result.artifact.result.status).toBe('blocked');expect(result&&'validation'in result&&result.validation?.status).toBe('passed');expect(f.dispatches()).toBe(1);
  const missing=fixture(selected);missing.finish();missing.missingValidation();await expect(missing.poll()).rejects.toThrow('INVALID_VALIDATION_ARTIFACT');
  const forged=fixture(selected);forged.finish();forged.forgeValidation();await expect(forged.poll()).rejects.toThrow('UNRELATED_VALIDATION_REPORT');
});
it('uses only the frozen existing workflow path for branch-isolated canaries', async () => {
  const f=fixture(snapshotSchema.parse({...snapshot,baseRef:'test/temporal-rc',executorWorkflow:'factory-manager.yml'}));
  await f.poll();f.finish();expect(await f.poll()).toEqual({artifact:artifact()});
  expect(f.workflowPaths.length).toBeGreaterThan(0);expect(f.workflowPaths.every(p=>p.includes('/factory-manager.yml/'))).toBe(true);
  expect(()=>snapshotSchema.parse({...snapshot,executorWorkflow:'../unsafe.yml'})).toThrow();
});
it('reconciles a lost Actions dispatch response and blocks an uncertain send without a run', async () => {
  const f = fixture(); f.lose(); await expect(f.poll()).rejects.toThrow(); expect(await f.poll()).toEqual({ artifact: artifact() }); expect(f.dispatches()).toBe(1);
  const uncertain = fixture(); uncertain.before(); await expect(uncertain.poll()).rejects.toThrow(); expect(await uncertain.poll()).toBeNull(); expect(uncertain.dispatches()).toBe(1);
});
it('rejects altered wrappers, wrong heads, duplicate runs, unrelated artifacts and revoked authorization', async () => {
  const wrapper = fixture(); wrapper.badWrapper(); await expect(wrapper.poll()).rejects.toThrow('EXECUTOR_WRAPPER_RELEASE_MISMATCH'); expect(wrapper.dispatches()).toBe(0);
  const head = fixture(); head.finish(); head.wrong(); await expect(head.poll()).rejects.toThrow('EXECUTOR_RUN_CONFLICT');
  const duplicate = fixture(); duplicate.finish(); duplicate.duplicate(); await expect(duplicate.poll()).rejects.toThrow('MULTIPLE_EXECUTOR_RUNS');
  const unrelated = fixture(); unrelated.finish(); unrelated.unrelated(); await expect(unrelated.poll()).rejects.toThrow('UNRELATED_EXECUTOR_ARTIFACT');
  const revoked = fixture(); revoked.authorize.mockRejectedValue(new Error('Revoked')); await expect(revoked.poll()).rejects.toThrow('Revoked'); expect(revoked.dispatches()).toBe(0);
});
it('rejects archive paths, extra entries, unsafe file changes and declared decompression bombs', () => {
  expect(() => decodeCodingArchive(zipSync({ 'nested/artifact.json': strToU8('{}') }))).toThrow('UNEXPECTED_ARTIFACT_ENTRY');
  expect(() => decodeCodingArchive(zipSync({ 'artifact.json': strToU8(JSON.stringify(artifact())), 'extra.txt': strToU8('x') }))).toThrow('UNEXPECTED_ARTIFACT_ENTRY');
  const unsafe = artifact(); unsafe.changes[0]!.path = '.github/workflows/unapproved.yml'; expect(() => decodeCodingArchive(zipSync({ 'artifact.json': strToU8(JSON.stringify(unsafe)) }))).toThrow('Protected');
  const bomb = zipSync({ 'artifact.json': strToU8('{}') }); const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
  for (let i = 0; i < bomb.length - 28; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 8000001, true); break; }
  expect(() => decodeCodingArchive(bomb)).toThrow('UNEXPECTED_ARTIFACT_ENTRY');
});

it('hands a rework the previous attempt, its failed checks and their output, and the refs the task names', async () => {
  const previous = '7'.repeat(32), named = '8'.repeat(40), plan = defaultValidationPlan();
  const selected = snapshotSchema.parse({ ...snapshot, validationPlan: plan, admission: { ...snapshot.admission, input: { ...snapshot.admission.input,
    description: `Bring PR #14 and commit ${named} to main, see \`feature/camera\` and \`src/app/page.tsx\`. Related: #99, pull/15, \`main\`, ${'9'.repeat(40)}.`,
    contextReferences: ['https://github.com/owner/target/issues/2', `urn:sf-rework:${previous}`] } } });
  const report = { ...reportFor({ ...artifact(), result: { ...artifact().result, executionId: previous } }, plan, 'failed', 77) };
  const log = `\u001b[31mError:\u001b[0m response.json: Test timeout\r\n${'x'.repeat(3000)}\nat tests/browser/camera-upload.spec.ts:80\u0007`;
  const f = fixture(selected, path => path === `/git/ref/heads/sf/issue-2/${previous}` ? { object: { sha: '5'.repeat(40) } }
    : path === `/git/commits/${named}` ? { sha: named } : path === `/git/commits/${'9'.repeat(40)}` ? null
    : path === '/pulls/14' ? { head: { sha: '6'.repeat(40), repo: { id: 42 } } } : path === '/pulls/15' ? { head: { sha: '4'.repeat(40), repo: { id: 43 } } } : path === '/pulls/99' ? null
    : path === '/branches' ? [{ name: 'main', commit: { sha: snapshot.baseSha } }, { name: 'feature/camera', commit: { sha: '3'.repeat(40) } }]
    : path === '/actions/runs/77/artifacts' ? { total_count: 1, artifacts: [{ id: 30, name: `coding-validation-logs-${previous}`, size_in_bytes: 900, expired: false }] }
    : path === '/actions/artifacts/30/zip' ? new Response(zipSync({ 'test.log': strToU8(log), 'build.log': strToU8('unrelated') }) as BodyInit) : undefined,
  async id => id === previous ? report : null);
  await f.poll(); await f.poll();
  const references = f.requests[0]!.task.contextReferences;
  expect(references.slice(0, 4)).toEqual(['https://github.com/owner/target/issues/2', `urn:sf-rework:${previous}`, `sf-context rework ${'5'.repeat(40)} ${previous}`, 'sf-context validation-failed test:1']);
  const output = references.filter(r => r.startsWith('sf-context validation-output test '));
  expect(output).toHaveLength(3);
  expect(output.at(-1)).toMatch(/^sf-context validation-output test 3\/3: x+\nat tests\/browser\/camera-upload\.spec\.ts:80$/);
  for (const forbidden of [String.fromCharCode(27), String.fromCharCode(7), 'unrelated']) expect(output.join('')).not.toContain(forbidden);
  expect(references.slice(4 + output.length)).toEqual([`sf-context ref ${named} commit ${named.slice(0, 12)}`, `sf-context ref ${'6'.repeat(40)} pull #14`, `sf-context ref ${'3'.repeat(40)} branch feature/camera`,
    `sf-context unavailable commit ${'9'.repeat(12)}`, 'sf-context unavailable pull #15']);
  // Resolved once: the second poll rebuilt the same request from the stored receipt.
  expect(f.calls.filter(c => c === '/branches')).toHaveLength(1); expect(f.dispatches()).toBe(1);
});
it('adds nothing for a task that names no refs, and survives a missing previous branch or log', async () => {
  const plain = fixture(); await plain.poll(); expect(plain.requests[0]!.task.contextReferences).toEqual([]);
  const previous = '7'.repeat(32), plan = defaultValidationPlan();
  const selected = snapshotSchema.parse({ ...snapshot, validationPlan: plan, admission: { ...snapshot.admission, input: { ...snapshot.admission.input, contextReferences: [`urn:sf-rework:${previous}`] } } });
  const f = fixture(selected, path => path === `/git/ref/heads/sf/issue-2/${previous}` ? null : path === '/actions/runs/77/artifacts' ? { total_count: 0, artifacts: [] } : undefined,
    async () => reportFor({ ...artifact(), result: { ...artifact().result, executionId: previous } }, plan, 'failed', 77));
  await f.poll();
  expect(f.requests[0]!.task.contextReferences).toEqual([`urn:sf-rework:${previous}`, `sf-context unavailable branch sf/issue-2/${previous}`, 'sf-context validation-failed test:1']);
});

it('leaves the request of an execution dispatched before context existed exactly as it was sent', async () => {
  const selected = snapshotSchema.parse({ ...snapshot, admission: { ...snapshot.admission, input: { ...snapshot.admission.input, description: 'Reuse `feature/camera` and PR #14.' } } });
  // Its executor ref is already there, as an earlier broker release created it before dispatching.
  const f = fixture(selected, path => path === `/git/ref/heads/sf-temporal-executor/${snapshot.admission.input.executionId}` ? { object: { sha: snapshot.baseSha } } : undefined);
  await f.poll();
  expect(f.requests[0]!.task.contextReferences).toEqual([]);
  expect(f.calls.some(c => c === '/branches' || c === '/pulls/14')).toBe(false);
});

it('passes the repository\'s loopback opt-in to the executor and nothing by default', async () => {
  const f = fixture(); f.cfg.workers.coding = { ...(f.cfg.workers.coding as object), loopback: true } as typeof f.cfg.workers.coding;
  await f.poll(); expect(f.requests[0]!.task.contextReferences).toEqual(['sf-context sandbox loopback']);
});
