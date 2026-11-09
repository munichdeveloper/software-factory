"""Fresh local cluster acceptance. Uses only uniquely named/labeled disposable test resources."""
from pathlib import Path
import subprocess as sp,json,time,secrets,os,hashlib,sys

root=Path(__file__).resolve().parent.parent
directory=root/'.runtime/runtime-acceptance';directory.mkdir(parents=True,exist_ok=True)
name='sf-factory-acceptance';pg=name+'-db';server=name+'-temporal';runner=name+'-runner';label='sf.runtime.acceptance=1'
pg_image='postgres@sha256:5264710be20f409750ac6dc4e5706dcef929c87e241605463f0f9aefa932a8d9'
server_image='temporalio/server@sha256:7bf69188a6232fea14869b9cef3d94aa82a1601d99517f7e86c71f22da4e0670'
tools_image='temporalio/admin-tools@sha256:4a95866efba29d7e17ab012df5232795e8b0ad0f7d5f9d1ec4df321f7792a754'
real_github=sys.argv[1:] in (['--github'],['--publisher'],['--coding'])
publisher_fixture=sys.argv[1:]==['--publisher']
actual_coding=sys.argv[1:]==['--coding']
assert sys.argv[1:] in ([],['--github'],['--publisher'],['--coding']),'Unknown acceptance option'
github_input=sys.stdin.buffer.read(64001) if real_github else b''
assert not real_github or 100<len(github_input)<=64000,'Bounded credential input required'
created=[];network_created=False;egress_created=False;egress=name+'-github-egress'
def run(args,timeout=120,**kwargs):return sp.run(args,cwd=root,check=True,capture_output=True,timeout=timeout,**kwargs).stdout
def inspect(target):return json.loads(run(['docker','inspect',target]))[0]
for target in (pg,server,runner):
 assert sp.run(['docker','inspect',target],stdout=sp.DEVNULL,stderr=sp.DEVNULL).returncode!=0,'Refuse existing test container'
assert sp.run(['docker','network','inspect',name],stdout=sp.DEVNULL,stderr=sp.DEVNULL).returncode!=0,'Refuse existing test network'
if real_github:assert sp.run(['docker','network','inspect',egress],stdout=sp.DEVNULL,stderr=sp.DEVNULL).returncode!=0,'Refuse existing egress network'
sha=run(['git','rev-parse','HEAD']).decode().strip()
dirty=run(['git','status','--porcelain']).decode().strip()
assert not dirty,'Commit the reviewed source snapshot before running version-bound acceptance'
password=secrets.token_urlsafe(32)
envfile=directory/'test.env'
envfile.write_text('POSTGRES_USER=temporal_admin\nPOSTGRES_PASSWORD='+password+'\nDB=postgres12\nPOSTGRES_PWD='+password+'\nPOSTGRES_SEEDS='+pg+'\nDB_PORT=5432\nNUM_HISTORY_SHARDS=32\nBIND_ON_IP=0.0.0.0\nDYNAMIC_CONFIG_FILE_PATH=config/dynamicconfig/runtime.yaml\nSQL_HOST='+pg+'\nSQL_PORT=5432\nSQL_USER=temporal_admin\nSQL_PASSWORD='+password+'\nSQL_PLUGIN=postgres12\nRUNTIME_TEST_DATABASE_URL=postgresql://temporal_admin:'+password+'@'+pg+':5432/factory_runtime_acceptance\nSF_TEST_FACTORY_SHA='+sha+'\n')
os.chmod(envfile,0o600)
try:
 build=run(['docker','build','--label',label,'-t',name+':'+sha,'-f','operations/temporal-runtime/Dockerfile.test','.'],timeout=600)
 (directory/'build.log').write_bytes(build)
 run(['docker','network','create','--internal','--label',label,name]);network_created=True
 run(['docker','run','-d','--name',pg,'--label',label,'--network',name,'--memory','1g','--cpus','0.75','--tmpfs','/var/lib/postgresql/data:rw,size=768m','--env-file',str(envfile),pg_image]);created.append(pg)
 for _ in range(60):
  if sp.run(['docker','exec',pg,'pg_isready','-U','temporal_admin'],stdout=sp.DEVNULL,stderr=sp.DEVNULL).returncode==0:break
  time.sleep(1)
 for db in ('temporal','temporal_visibility','factory_runtime_acceptance'):run(['docker','exec',pg,'createdb','-U','temporal_admin',db])
 for db,schema in (('temporal','temporal'),('temporal_visibility','visibility')):
  base=['docker','run','--rm','--label',label,'--network',name,'--env-file',str(envfile),'--entrypoint','temporal-sql-tool',tools_image,'--db',db]
  run(base+['setup-schema','-v','0.0'])
  run(base+['update-schema','-d','/etc/temporal/schema/postgresql/v12/'+schema+'/versioned'])
 run(['docker','run','-d','--name',server,'--label',label,'--network',name,'--memory','1g','--cpus','0.75','--cap-drop','ALL','--security-opt','no-new-privileges','--env-file',str(envfile),
      '--mount','type=bind,source='+str(root/'operations/temporal-runtime/dynamicconfig.yaml')+',target=/etc/temporal/config/dynamicconfig/runtime.yaml,readonly',server_image]);created.append(server)
 cli=['docker','run','--rm','--label',label,'--network',name,'--entrypoint','temporal',tools_image]
 for _ in range(30):
  ready=sp.run(cli+['operator','namespace','list','--address',server+':7233'],capture_output=True,timeout=15)
  if ready.returncode==0:break
  time.sleep(1)
 assert ready.returncode==0,'Temporal did not become ready'
 run(cli+['operator','namespace','create','--address',server+':7233','--namespace','sf-factory-runtime-acceptance','--retention','1d'])
 runner_user=['--user',str(os.getuid())+':'+str(os.getgid())] if os.name=='posix' else []
 runner_args=['--name',runner,'--label',label,'--network',name,'--memory','2g','--cpus','1',*runner_user,'--env-file',str(envfile),
      '--mount','type=bind,source='+str(directory)+',target=/app/.runtime/runtime-acceptance']
 if real_github:
  run(['docker','network','create','--label',label,egress]);egress_created=True
  run(['docker','create','-i',*runner_args,'-e','SF_TEST_REAL_GITHUB=1',*(['-e','SF_TEST_PUBLISHER_FIXTURE=1'] if publisher_fixture else []),*(['-e','SF_TEST_REAL_CODING=1'] if actual_coding else []),name+':'+sha]);created.append(runner)
  run(['docker','network','connect',egress,runner])
  run(['docker','start','--attach','--interactive',runner],input=github_input,timeout=1800 if actual_coding else 300);github_input=b''
 else:
  run(['docker','run','-d',*runner_args,name+':'+sha]);created.append(runner)
 deadline=time.monotonic()+300
 while inspect(runner)['State']['Running']:
  assert time.monotonic()<deadline,'Acceptance deadline exceeded';time.sleep(1)
 state=inspect(runner)['State'];logs=run(['docker','logs',runner]);(directory/'runner.log').write_bytes(logs)
 assert state['ExitCode']==0,'Acceptance runner failed; inspect protected local runner.log'
 report=json.loads((directory/'result.json').read_text());assert report['passed'] and report['factorySha']==sha
 report['testImage']=inspect(runner)['Image'];report['freshCluster']=True;report['noPublishedPorts']=all(not inspect(c)['HostConfig']['PortBindings'] for c in created)
 report['githubEgress']=real_github
 report['sourceTree']=run(['git','rev-parse',sha+'^{tree}']).decode().strip();report['runnerSourceSha256']=hashlib.sha256(run(['git','show',sha+':scripts/runtime-acceptance.ts'])).hexdigest()
 (directory/'result.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
except Exception:
 for container in created:
  log=sp.run(['docker','logs',container],capture_output=True);(directory/(container+'.log')).write_bytes(log.stdout+log.stderr)
 raise
finally:
 for container in reversed(created):
  assert inspect(container)['Config']['Labels'].get('sf.runtime.acceptance')=='1'
  run(['docker','rm','--force',container])
 if network_created:
  assert inspect(name)['Labels'].get('sf.runtime.acceptance')=='1'
  run(['docker','network','rm',name])
 if egress_created:
  assert inspect(egress)['Labels'].get('sf.runtime.acceptance')=='1'
  run(['docker','network','rm',egress])
 if envfile.exists():envfile.unlink()
