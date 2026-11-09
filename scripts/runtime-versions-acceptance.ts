import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { bundleWorkflowCode } from '@temporalio/worker';
import { RuntimeStore } from '../src/runtime/store.js';
import { RuntimeController } from '../src/runtime/controller.js';
import { runtimeServer } from '../src/runtime/server.js';
import { assertRetainedReleases } from '../src/runtime/retention.js';
import { Manager } from '../src/manager/index.js';
import { githubFixtures } from './runtime-github-fixtures.js';
import type { RuntimeRelease, RuntimeObservation } from '../src/runtime/contract.js';

let phase='initialize';
process.on('uncaughtException',(error:Error&{code?:unknown;status?:unknown})=>{console.error(JSON.stringify({code:'VERSION_MATRIX_FAILED',phase,reason:/^[A-Z_]+$/.test(error.message)?error.message:undefined,grpcStatus:typeof error.code==='number'?error.code:undefined,httpStatus:typeof error.status==='number'?error.status:undefined,frames:error.stack?.split('\n').slice(1,5)}));process.exit(1);});
const directory=resolve('.runtime/runtime-acceptance'), oldRoot=resolve('.runtime/release-a/dist');
const previousManager=await import(pathToFileURL(resolve(oldRoot,'manager/index.js')).href) as typeof import('../src/manager/index.js');
const previousController=await import(pathToFileURL(resolve(oldRoot,'runtime/controller.js')).href) as typeof import('../src/runtime/controller.js');
const previousWorker=await import(pathToFileURL(resolve(oldRoot,'runtime/worker.js')).href) as typeof import('../src/runtime/worker.js');
const database=new URL(process.env.RUNTIME_TEST_DATABASE_URL??'');assert.equal(database.hostname,'sf-factory-acceptance-db');assert.equal(database.pathname,'/factory_runtime_acceptance');
const namespace='sf-factory-runtime-acceptance', store=new RuntimeStore(new Pool({connectionString:database.toString(),max:8}));
const connection=await Connection.connect({address:'sf-factory-acceptance-temporal:7233'}),temporal=new Client({connection,namespace});
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const factoryB=process.env.SF_TEST_FACTORY_SHA??'',factoryA=process.env.SF_TEST_PREVIOUS_FACTORY_SHA??'';
assert.match(factoryA,/^[a-f0-9]{40}$/);assert.match(factoryB,/^[a-f0-9]{40}$/);assert.notEqual(factoryA,factoryB);
async function pack(root:string,factorySha:string,name:string){
 const bundle=await bundleWorkflowCode({workflowsPath:resolve(root,'runtime/workflow.js')});
 const bundlePath=resolve(directory,`workflow-${name}.js`);await writeFile(bundlePath,bundle.code);
 const release:RuntimeRelease={factorySha,harnessSha:'f70d11556075e9764d69ac03e029720d12ccef65',workflowHash:digest(bundle.code),deploymentName:'sf-version-matrix',buildId:factorySha,taskQueue:'sf-version-matrix',schemaVersion:1};
 const harnessEntrypoint=resolve('.runtime/harness/dist/cli.js'),packageFile=resolve(directory,`worker-${name}.json`);
 const value={release,bundlePath,harnessEntrypoint,harnessEntrypointHash:digest(await readFile(harnessEntrypoint))};await writeFile(packageFile,JSON.stringify(value));
 return {...value,packageFile,main:resolve(root,'runtime/main.js')};
}
const a=await pack(oldRoot,factoryA,'a'),b=await pack(resolve('dist'),factoryB,'b');assert.notEqual(a.release.workflowHash,b.release.workflowHash);
await store.migrate();const {fixtures,actor}=await githubFixtures(a.release,store,temporal);const [fa,fb]=fixtures;assert(fa&&fb);
fa.controller=new previousController.RuntimeController(fa.repository,store,temporal);fb.repository.release=b.release;
const managerToken=randomBytes(32).toString('hex'),workerToken=randomBytes(32).toString('hex');
const server=runtimeServer({managerToken,workerToken,bindings:fixtures,store});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert(address&&typeof address!=='string');const broker=`http://127.0.0.1:${address.port}`;
const children=new Map<string,ChildProcess>();
const env={PATH:process.env.PATH,TEMPORAL_ADDRESS:'sf-factory-acceptance-temporal:7233',TEMPORAL_NAMESPACE:namespace,FACTORY_BROKER_URL:broker,FACTORY_WORKER_TOKEN:workerToken};
const wait=async<T>(work:()=>Promise<T|null|false>,timeout=90000)=>{const end=Date.now()+timeout;while(Date.now()<end){try{const value=await work();if(value)return value;}catch{/* Bounded readiness/reconciliation. */}await new Promise(r=>setTimeout(r,250));}throw Error('VERSION_MATRIX_TIMEOUT');};
async function start(p:typeof a){const child=spawn(process.execPath,[p.main,'worker','--file',p.packageFile],{env,stdio:['ignore','pipe','pipe']});children.set(p.release.buildId,child);let logs='';child.stdout!.on('data',c=>{logs+=c;});child.stderr!.on('data',c=>{logs+=c;});child.on('exit',()=>{void writeFile(resolve(directory,`worker-version-${p.release.factorySha}.log`),logs);});await wait(async()=> (await temporal.workflowService.describeWorkerDeploymentVersion({namespace,deploymentVersion:{deploymentName:p.release.deploymentName,buildId:p.release.buildId}})).workerDeploymentVersionInfo);}
async function stop(p:typeof a){const child=children.get(p.release.buildId);if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}}
const managerCycles:unknown[]=[];
async function runManager(f:typeof fa,old:boolean){const Constructor=old?previousManager.Manager:Manager;const report=await new Constructor(f.repository.github,await f.repository.config(),f.planner,{correlationId:`version-matrix:${f.repository.repositoryId}`,workerRuntime:f.controller}).run();const safe={phase,repositoryId:f.repository.repositoryId,old,outcome:report.outcome,tasks:report.tasks,errors:report.errors,decisions:report.decisions.map(d=>({issue:d.action.issueNumber,kind:d.action.kind,outcome:d.decision.outcome,reason:d.decision.reason,executed:d.executed}))};managerCycles.push(safe);console.log(JSON.stringify({managerCycle:safe}));}
async function gate(f:typeof fa,number:number){return wait(async()=>{const rows=await store.list(f.repository.repositoryId);const row=rows.find(r=>r.snapshot.admission.input.issueNumber===number);if(!row?.runId)return null;const observation=(await f.controller.observations([row.snapshot.admission.input.executionId]))[0];return observation?.phase==='awaiting-approval'?observation:null;});}
async function admit(f:typeof fa,number:number,old:boolean){for(let attempt=0;attempt<3;attempt++){await runManager(f,old);if((await store.list(f.repository.repositoryId)).some(r=>r.snapshot.admission.input.issueNumber===number&&r.runId))return gate(f,number);await new Promise(r=>setTimeout(r,1000));}throw Error('MANAGER_DID_NOT_ADMIT_VERSION_TASK');}
async function complete(f:typeof fa,row:RuntimeObservation){await f.controller.gate(row.executionId,row.binding,actor,true);const done=await wait(async()=>{const value=(await f.controller.observations([row.executionId]))[0];return value?.status==='completed'&&value.result?value:null;},180000);assert.equal(done.runId,row.runId);assert.equal(done.result?.status,'success');return done;}
async function current(p:typeof a){await wait(async()=>{await temporal.workflowService.setWorkerDeploymentCurrentVersion({namespace,deploymentName:p.release.deploymentName,buildId:p.release.buildId,identity:'isolated-version-acceptance'});return true;});}
const evidence:Record<string,unknown>={};
try{
 phase='v1-human-gate';await start(a);await current(a);const first=await admit(fa,fa.issueNumber,true);
 phase='parallel-v2-and-rollout';await start(b);await current(b);const second=await admit(fb,fb.issueNumber,false);
 for(const row of [first,second]){const detail=await temporal.workflowService.describeWorkflowExecution({namespace,execution:{workflowId:row.workflowId,runId:row.runId}});assert.equal(detail.workflowExecutionInfo?.versioningInfo?.behavior,1);}
 const definition=await temporal.workflow.getHandle(second.workflowId,second.runId).query<{revision:number;release:RuntimeRelease}>('factoryDefinition');assert.equal(definition.revision,2);assert.equal(definition.release.factorySha,factoryB);
 await assert.rejects(assertRetainedReleases(fa.repository.repositoryId,[b.release],store,temporal),/OPEN_PINNED_RUN_REQUIRES_RETAINED_RELEASE/);
 await assertRetainedReleases(fa.repository.repositoryId,[a.release,b.release],store,temporal);
 const storedB=await store.get(fb.repository.repositoryId,second.executionId);assert(storedB);let brokerCalls=0;
 await assert.rejects(previousWorker.createActivities(a,async()=>{brokerCalls++;}).authorize(storedB.snapshot,storedB.binding),/WORKER_RELEASE_MISMATCH/);assert.equal(brokerCalls,0);
 phase='retained-v1-crash-and-signal';await stop(a);await fa.controller.gate(first.executionId,first.binding,actor,true);await new Promise(r=>setTimeout(r,2000));assert.equal((await store.get(fa.repository.repositoryId,first.executionId))?.result,null);await start(a);
 const recovered=await wait(async()=>{const value=(await fa.controller.observations([first.executionId]))[0];return value?.status==='completed'&&value.result?value:null;},180000);assert.equal(recovered.runId,first.runId);
 evidence.retainedV1={...recovered,factorySha:factoryA};evidence.v2Gate=second;
 const body=(await fa.github.getIssue(fa.issueNumber)).body;
 phase='upgrade-new-run';fa.repository.release=b.release;fa.repository.retainedReleases=[a.release];fa.controller=new RuntimeController(fa.repository,store,temporal);
 const upgradeIssue=await fa.github.createIssue(`Temporal runtime acceptance ${randomUUID()}`,body,['harness:managed','harness:ready']);const upgrade=await admit(fa,upgradeIssue.number,false);evidence.upgrade=await complete(fa,upgrade);
 phase='rollback-new-run';await current(a);fa.repository.release=a.release;fa.repository.retainedReleases=[b.release];fa.controller=new previousController.RuntimeController(fa.repository,store,temporal);
 const rollbackIssue=await fa.github.createIssue(`Temporal runtime acceptance ${randomUUID()}`,body,['harness:managed','harness:ready']);const rollback=await admit(fa,rollbackIssue.number,true);evidence.rollback=await complete(fa,rollback);
 assert.equal((await fb.controller.observations([second.executionId]))[0]?.phase,'awaiting-approval');evidence.v2AfterRollback=await complete(fb,second);
 phase='unknown-version';const unknown={...b.release,buildId:'unknown-build',factorySha:'f'.repeat(40)};fa.repository.release=unknown;fa.repository.retainedReleases=[a.release,b.release];fa.controller=new RuntimeController(fa.repository,store,temporal);
 const unknownIssue=await fa.github.createIssue(`Temporal runtime acceptance ${randomUUID()}`,body,['harness:managed','harness:ready']);await runManager(fa,false);assert(!(await store.list(fa.repository.repositoryId)).some(r=>r.snapshot.admission.input.issueNumber===unknownIssue.number));
 await assertRetainedReleases(fb.repository.repositoryId,[],store,temporal);
 const report={passed:true,scope:'actual-two-factory-build-version-matrix',factorySha:factoryB,previousFactorySha:factoryA,releases:[a.release,b.release],realRepositoryIds:fixtures.map(f=>f.repository.repositoryId),sharedTaskQueue:true,actualFactoryManagers:[factoryA,factoryB],pinned:true,retentionGuard:true,wrongWorkerBlocked:true,approvalWhileStopped:true,sameRunIdAfterRestart:true,unknownVersionBlocked:true,upgradeRollback:true,evidence,managerCycles,workerEnvironmentKeys:Object.keys(env),checkedAt:new Date().toISOString()};
 await writeFile(resolve(directory,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await stop(a);await stop(b);await new Promise<void>(resolve=>server.close(()=>resolve()));await connection.close();await store.pool.end();}
