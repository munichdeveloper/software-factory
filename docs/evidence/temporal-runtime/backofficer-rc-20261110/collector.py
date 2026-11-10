from pathlib import Path
import subprocess as sp,json,time,secrets,sys
root=Path(__file__).resolve().parent
out=root.parent.parent/'outputs/temporal-migration/backofficer-rc'
out.mkdir(parents=True,exist_ok=True)
payload=sys.stdin.buffer.read(64001);assert 100<len(payload)<64000
name='sf-backofficer-rc';pg=name+'-db';server=name+'-temporal';runner=name+'-runner';egress=name+'-egress';label='sf.backofficer.rc=1'
pg_image='postgres@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9'
server_image='temporalio/server@sha256:7bf69188a6232fea14869b9cef3d94aa82a1601d99517f7e86c71f22da4e0670'
tools_image='temporalio/admin-tools@sha256:4a95866efba29d7e17ab012df5232795e8b0ad0f7d5f9d1ec4df321f7792a754'
created=[];networks=[]
def run(args,timeout=120,**kw):return sp.run(args,check=True,capture_output=True,timeout=timeout,**kw).stdout
def inspect(x):return json.loads(run(['docker','inspect',x]))[0]
for x in (pg,server,runner):assert sp.run(['docker','inspect',x],capture_output=True).returncode!=0,'Existing test resource'
for x in (name,egress):assert sp.run(['docker','network','inspect',x],capture_output=True).returncode!=0,'Existing test network'
password=secrets.token_urlsafe(32);envfile=root/'backofficer-rc.env'
envfile.write_text('POSTGRES_USER=temporal_admin\nPOSTGRES_PASSWORD='+password+'\nDB=postgres12\nPOSTGRES_PWD='+password+'\nPOSTGRES_SEEDS='+pg+'\nDB_PORT=5432\nNUM_HISTORY_SHARDS=32\nBIND_ON_IP=0.0.0.0\nDYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/runtime.yaml\nSQL_HOST='+pg+'\nSQL_PORT=5432\nSQL_USER=temporal_admin\nSQL_PASSWORD='+password+'\nSQL_PLUGIN=postgres12\nRUNTIME_TEST_DATABASE_URL=postgresql://temporal_admin:'+password+'@'+pg+':5432/factory_runtime_acceptance\nTEMPORAL_ADDRESS='+server+':7233\n')
try:
 run(['docker','network','create','--internal','--label',label,name]);networks.append(name)
 run(['docker','run','-d','--name',pg,'--label',label,'--network',name,'--memory','1g','--tmpfs','/var/lib/postgresql/data:rw,size=768m','--env-file',str(envfile),pg_image]);created.append(pg)
 for _ in range(60):
  if sp.run(['docker','exec',pg,'pg_isready','-U','temporal_admin'],capture_output=True).returncode==0:break
  time.sleep(1)
 for db in ('temporal','temporal_visibility','factory_runtime_acceptance'):run(['docker','exec',pg,'createdb','-U','temporal_admin',db])
 for db,schema in (('temporal','temporal'),('temporal_visibility','visibility')):
  base=['docker','run','--rm','--label',label,'--network',name,'--env-file',str(envfile),'--entrypoint','temporal-sql-tool',tools_image,'--db',db]
  run(base+['setup-schema','-v','0.0']);run(base+['update-schema','-d','/etc/temporal/schema/postgresql/v12/'+schema+'/versioned'])
 run(['docker','run','-d','--name',server,'--label',label,'--network',name,'--memory','1g','--cap-drop','ALL','--security-opt','no-new-privileges','--env-file',str(envfile),'--mount','type=bind,source='+str(root/'software-factory/operations/temporal-runtime/dynamicconfig.yaml')+',target=/etc/temporal/config/dynamicconfig/runtime.yaml,readonly',server_image]);created.append(server)
 cli=['docker','run','--rm','--label',label,'--network',name,'--entrypoint','temporal',tools_image]
 for _ in range(30):
  ready=sp.run(cli+['operator','namespace','list','--address',server+':7233'],capture_output=True,timeout=15)
  if ready.returncode==0:break
  time.sleep(1)
 assert ready.returncode==0,'Temporal unavailable'
 run(cli+['operator','namespace','create','--address',server+':7233','--namespace','sf-backofficer-rc','--retention','1d'])
 run(['docker','network','create','--label',label,egress]);networks.append(egress)
 run(['docker','create','-i','--name',runner,'--label',label,'--network',name,'--memory','2g','--cap-drop','ALL','--security-opt','no-new-privileges','--env-file',str(envfile),'--mount','type=bind,source='+str(root/'backofficer-rc-runner.mjs')+',target=/app/rc-runner.mjs,readonly','--mount','type=bind,source='+str(out)+',target=/evidence','--entrypoint','node','sf-temporal-rc:0.7.0-rc.1','/app/rc-runner.mjs']);created.append(runner)
 run(['docker','network','connect',egress,runner])
 result=sp.run(['docker','start','--attach','--interactive',runner],input=payload,capture_output=True,timeout=1800);payload=b''
 (out/'runner.log').write_bytes(result.stdout+result.stderr)
 assert result.returncode==0 and inspect(runner)['State']['ExitCode']==0,'Canary failed; inspect evidence'
 report=json.loads((out/'result.json').read_text());assert report['passed']
 report.update(image=inspect(runner)['Image'],freshCluster=True,noPublishedPorts=all(not inspect(c)['HostConfig']['PortBindings'] for c in created))
 (out/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
finally:
 for c in reversed(created):
  assert inspect(c)['Config']['Labels'].get('sf.backofficer.rc')=='1'
  logs=sp.run(['docker','logs',c],capture_output=True)
  if c==runner:(out/'container.log').write_bytes(logs.stdout+logs.stderr)
  run(['docker','rm','--force',c])
 for n in reversed(networks):
  assert inspect(n)['Labels'].get('sf.backofficer.rc')=='1';run(['docker','network','rm',n])
 envfile.unlink(missing_ok=True)
