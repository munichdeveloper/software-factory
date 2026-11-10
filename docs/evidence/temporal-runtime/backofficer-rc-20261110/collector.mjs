import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { Client, Connection } from '@temporalio/client';
import { scopedRuntimeGitHub } from './dist/runtime/github-app.js';
import { RuntimeStore } from './dist/runtime/store.js';
let input=''; for await(const c of process.stdin){input+=c;assert(Buffer.byteLength(input)<64000);}
const {appId,installationId,privateKey,setup}=JSON.parse(input); input='';
assert.equal(setup.repositoryId,1448541967);assert.equal(appId,'5669002');assert.equal(installationId,179890385);
const api=scopedRuntimeGitHub({appId,installationId,privateKey,repositoryId:setup.repositoryId});
const target={owner:'munichdeveloper',repo:'Backofficer'},namespace='sf-backofficer-rc';
const managerToken=randomBytes(32).toString('hex'),workerToken=randomBytes(32).toString('hex');
const wait=async(f,ms=120000)=>{const deadline=Date.now()+ms;let err;while(Date.now()<deadline){try{const x=await f();if(x)return x;}catch(e){err=e;}await new Promise(r=>setTimeout(r,2000));}throw new Error('WAIT_TIMEOUT',{cause:err});};
const children=new Set();let worker,broker,connection,pool,phase='pack';
const launch=(args,env,name)=>{const c=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});children.add(c);let logs='';for(const p of [c.stdout,c.stderr])p.on('data',x=>logs+=x);c.on('exit',()=>{children.delete(c);void writeFile(`/evidence/${name}.log`,logs);});return c;};
const exit=c=>new Promise((resolve,reject)=>{c.once('error',reject);c.once('exit',code=>code===0?resolve():reject(new Error('CHILD_FAILED')));});
const stop=async(c,signal='SIGTERM')=>{if(!c||c.exitCode!==null||c.signalCode)return;const done=new Promise(r=>c.once('exit',r));c.kill(signal);await done;};
const call=async(path,body,token=managerToken)=>{const r=await fetch('http://127.0.0.1:8095'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60000)});return{status:r.status,body:await r.json()};};
const repoPath=`/v1/repositories/${setup.repositoryId}`;
try{
 await mkdir('/tmp/rc-package',{recursive:true});
 await exit(launch(['dist/runtime/main.js','pack','--output','/tmp/rc-package','--factory-sha',setup.factorySha,'--harness-sha',setup.harnessSha,'--harness','/app/.runtime/harness/dist/cli.js','--deployment','sf-backofficer-rc','--build',setup.factorySha,'--queue','sf-backofficer-rc'],{PATH:process.env.PATH},'pack'));
 const pack=JSON.parse(await readFile('/tmp/rc-package/worker-package.json','utf8'));
 const registry={namespace,repositories:[{repositoryId:setup.repositoryId,repository:setup.repository,githubInstallationId:installationId,release:pack.release,baseRef:setup.baseRef,executorWorkflow:'factory-manager.yml',configPath:'.github/software-factory.temporal-rc.yml',issueNumbers:[setup.issueNumber],allowedPaths:setup.allowedPaths,requireHumanGate:true}]};
 await writeFile('/tmp/registry.json',JSON.stringify(registry));
 phase='broker-start';
 broker=launch(['dist/runtime/main.js','serve','--file','/tmp/registry.json'],{PATH:process.env.PATH,GITHUB_APP_ID:appId,GITHUB_APP_PRIVATE_KEY:privateKey,GITHUB_ALLOWED_INSTALLATION_IDS:String(installationId),FACTORY_RUNTIME_DATABASE_URL:process.env.RUNTIME_TEST_DATABASE_URL,TEMPORAL_ADDRESS:process.env.TEMPORAL_ADDRESS,FACTORY_MANAGER_TOKEN:managerToken,FACTORY_WORKER_TOKEN:workerToken},'broker');
 await wait(async()=> (await call(repoPath+'/runs')).status===200);
 connection=await Connection.connect({address:process.env.TEMPORAL_ADDRESS});const temporal=new Client({connection,namespace});
 pool=new Pool({connectionString:process.env.RUNTIME_TEST_DATABASE_URL});const store=new RuntimeStore(pool);
 const workerEnv={PATH:process.env.PATH,TEMPORAL_ADDRESS:process.env.TEMPORAL_ADDRESS,TEMPORAL_NAMESPACE:namespace,FACTORY_BROKER_URL:'http://127.0.0.1:8095',FACTORY_WORKER_TOKEN:workerToken};
 const startWorker=()=>worker=launch(['dist/runtime/main.js','worker','--file','/tmp/rc-package/worker-package.json'],workerEnv,'worker');
 startWorker();phase='worker-readiness';
 await wait(async()=> (await temporal.workflowService.describeWorkerDeploymentVersion({namespace,deploymentVersion:{deploymentName:pack.release.deploymentName,buildId:pack.release.buildId}})).workerDeploymentVersionInfo);
 assert.equal((await call(repoPath+'/reconcile',{actor:'munichdeveloper'},workerToken)).status,401);
 assert.equal((await call('/v1/repositories/999/runs')).status,409);
 phase='manager-reconcile';let row;
 for(let cycle=0;cycle<4;cycle++){
  const result=await call(repoPath+'/reconcile',{actor:'munichdeveloper'});assert.equal(result.status,200);
  const rows=await store.list(setup.repositoryId);row=rows[0];if(row?.runId)break;await new Promise(r=>setTimeout(r,3000));
 }
 assert(row?.runId,'NO_CANARY_ADMISSION');assert.equal((await store.list(setup.repositoryId)).length,1);assert.equal(row.snapshot.admission.input.issueNumber,setup.issueNumber);
 phase='human-gate';const handle=temporal.workflow.getHandle(row.workflowId,row.runId);
 await wait(async()=> (await handle.query('factoryState')).phase==='awaiting-approval');
 assert.equal((await api.actions.listWorkflowRuns({...target,workflow_id:'factory-manager.yml',branch:`sf-temporal-executor/${row.snapshot.admission.input.executionId}`,event:'workflow_dispatch'})).data.total_count,0);
 assert.equal((await call(`${repoPath}/runs/${row.snapshot.admission.input.executionId}/approve`,{actor:'munichdeveloper',binding:'0'.repeat(64)})).status,409);
 await stop(worker,'SIGKILL');startWorker();await handle.signal('approvalChanged');
 await wait(async()=> (await handle.query('factoryState')).phase==='awaiting-approval');
 assert.equal((await handle.describe()).runId,row.runId);
 const executionId=row.snapshot.admission.input.executionId;
 assert.equal((await call(`${repoPath}/runs/${executionId}/approve`,{actor:'munichdeveloper',binding:row.binding})).status,200);
 phase='model-dispatch';
 await wait(async()=> (await pool.query("SELECT phase FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 AND effect='coding-dispatch'",[setup.repositoryId,executionId])).rows[0]?.phase==='confirmed',180000);
 await stop(worker,'SIGKILL');startWorker();
 phase='coding-and-publication';
 const result=await Promise.race([handle.result(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('CODING_DEADLINE')),900000))]);assert.equal(result.status,'success');
 const stored=await store.get(setup.repositoryId,executionId);assert(stored.approved&&stored.terminal);assert.equal(stored.runId,row.runId);
 const artifact=await store.artifact(setup.repositoryId,executionId);assert(artifact);assert.deepEqual(artifact.changes.map(c=>c.path).sort(),setup.allowedPaths.toSorted());
 assert.equal(Buffer.from(artifact.changes.find(c=>c.path==='docs/temporal-rc-canary.md').content,'base64').toString(),'Backofficer Temporal RC canary passed.\n');
 const prs=await api.paginate(api.pulls.list,{...target,state:'all',base:setup.baseRef,per_page:100});const matches=prs.filter(p=>p.head.ref.includes(executionId));assert.equal(matches.length,1);const pr=matches[0];assert(pr.draft&&!pr.merged_at);assert.equal(pr.base.ref,setup.baseRef);
 const runs=await api.paginate(api.actions.listWorkflowRuns,{...target,workflow_id:'factory-manager.yml',branch:`sf-temporal-executor/${executionId}`,event:'workflow_dispatch',per_page:100});assert.equal(runs.length,1);assert.equal(runs[0].conclusion,'success');assert.equal(runs[0].head_sha,setup.baseSha);
 assert.equal((await api.git.getRef({...target,ref:'heads/main'})).data.object.sha,setup.mainBefore);
 const detail=await temporal.workflowService.describeWorkflowExecution({namespace,execution:{workflowId:row.workflowId,runId:row.runId}});assert.equal(detail.workflowExecutionInfo.versioningInfo.behavior,1);
 await writeFile('/evidence/worker-package.json',JSON.stringify(pack,null,2));
 const effects=(await pool.query('SELECT effect,phase,receipt FROM factory_runtime_effects WHERE repository_id=$1 AND execution_id=$2 ORDER BY effect',[setup.repositoryId,executionId])).rows;
 await writeFile('/evidence/result.json',JSON.stringify({passed:true,checkedAt:new Date().toISOString(),version:setup.version,factorySha:setup.factorySha,harnessSha:setup.harnessSha,baseRef:setup.baseRef,baseSha:setup.baseSha,mainBefore:setup.mainBefore,mainUnchanged:true,issueNumber:setup.issueNumber,workflowId:row.workflowId,runId:row.runId,executionId,binding:row.binding,release:pack.release,pinned:true,humanGate:true,workerCrashAtGate:true,workerCrashAfterDispatch:true,sameRunId:true,workerRoleRejected:true,wrongBindingRejected:true,issueScoped:true,allowedPaths:setup.allowedPaths,actions:{id:runs[0].id,url:runs[0].html_url,head:runs[0].head_sha},pullRequest:{number:pr.number,url:pr.html_url,head:pr.head.sha,base:pr.base.ref,draft:pr.draft},effects,artifact},null,2));
 console.log('BACKOFFICER_CANARY_PASSED');
}catch(e){await writeFile('/evidence/failure.json',JSON.stringify({phase,message:e.message,checkedAt:new Date().toISOString()},null,2));console.error('BACKOFFICER_CANARY_FAILED_PHASE_'+phase);process.exitCode=1;}
finally{for(const c of [...children])await stop(c);if(connection)await connection.close();if(pool)await pool.end();}
// No outstanding deadline timer may keep the collector alive.
process.exit(process.exitCode??0);
