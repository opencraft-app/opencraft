# Isolated synthetic native state database only; never uses a real account or model.
# Run with OPENCRAFT_TEST_CODEX_EXECUTABLE=/path/to/codex python3 <this file>.
# Measures native stdio RPC, not gateway/network/UI latency. 20% of rows are archived.
import subprocess,tempfile,pathlib,json,selectors,time,sqlite3,os,uuid
root=pathlib.Path(tempfile.mkdtemp(prefix='mention-native-bench-'))
(root/'home').mkdir();(root/'codex').mkdir();(root/'work').mkdir()
(root/'codex/config.toml').write_text('model="fixture"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="Local test only"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n')
env={'PATH':os.environ['PATH'],'HOME':str(root/'home'),'CODEX_HOME':str(root/'codex'),'CODEX_DISABLE_ANALYTICS':'1','RUST_LOG':'error'}
err=open(root/'stderr.log','w');p=subprocess.Popen([os.environ['OPENCRAFT_TEST_CODEX_EXECUTABLE'],'app-server','--listen','stdio://'],cwd=root/'work',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1)
seq=0
def rpc(method,params):
 global seq
 seq+=1; p.stdin.write(json.dumps({'id':seq,'method':method,'params':params})+'\n');p.stdin.flush()
 while True:
  line=p.stdout.readline()
  if not line:raise RuntimeError('native exited')
  r=json.loads(line)
  if r.get('id')==seq:
   if 'error' in r:raise RuntimeError(r['error'])
   return r['result']
try:
 rpc('initialize',{'clientInfo':{'name':'mention-benchmark','version':'1'},'capabilities':{'experimentalApi':True}})
 tid='no-seed-thread'
 db=sqlite3.connect(root/'codex/state_5.sqlite');db.row_factory=sqlite3.Row
 seed={'id':tid,'rollout_path':'unused','created_at':1700000000,'updated_at':1700000000,'source':'cli','model_provider':'fixture','cwd':str(root/'work'),'title':'fixture','name':'fixture','sandbox_policy':'{"type":"read-only"}','approval_mode':'never','first_user_message':'benchmark','preview':'benchmark','has_user_event':1,'archived':0,'created_at_ms':1700000000000,'updated_at_ms':1700000000000}
 print('ROOT',root,flush=True)
 results=[]
 for count in [1000,10000]:
  db.execute('delete from threads where id<>?',(tid,))
  cols=list(seed);sql='insert into threads ('+','.join('"'+c+'"' for c in cols)+') values ('+','.join('?' for c in cols)+')'
  for i in range(count):
   row=dict(seed);row['id']=str(uuid.uuid4());row['title']='性能方案 '+str(i);row['name']=row['title'];row['archived']=1 if i%5==0 else 0
   rollout=root/'codex'/'sessions'/('rollout-'+row['id']+'.jsonl');rollout.parent.mkdir(exist_ok=True);rollout.write_text(json.dumps({'timestamp':'2026-11-18T00:00:00Z','type':'session_meta','payload':{'id':row['id'],'cwd':str(root/'work'),'timestamp':'2026-11-18T00:00:00Z','source':'cli','model_provider':'fixture','cli_version':'0.167.2','originator':'benchmark'}})+'\n');row['rollout_path']=str(rollout);row['updated_at']=1700000000+i
   if 'updated_at_ms' in row:row['updated_at_ms']=(1700000000+i)*1000
   db.execute(sql,[row[c] for c in cols])
  db.commit()
  for term in ['', '方案', '不存在']:
   timings=[]
   for j in range(25):
    start=time.perf_counter();page=rpc('thread/list',{'limit':20,'searchTerm':term or None,'archived':False,'cursor':None,'useStateDbOnly':True,'sortKey':'updated_at','sortDirection':'desc'});timings.append((time.perf_counter()-start)*1000)
    assert len(page['data'])==(0 if term=='不存在' else 20), str(page)
    if term!='不存在':
     assert all(int(t['name'].split()[-1])%5!=0 for t in page['data'])
     assert page['data'][0]['name']=='性能方案 '+str(count-1)
   results.append({'rows':count,'term':term,'p50_ms':sorted(timings)[12],'p95_ms':sorted(timings)[23],'returned':len(page['data'])})
 print(json.dumps(results,ensure_ascii=False,indent=2),flush=True)
 pathlib.Path(os.environ.get('OPENCRAFT_BENCH_OUTPUT','native-search-bench-results.json')).write_text(json.dumps({'root':str(root),'results':results},ensure_ascii=False,indent=2))
finally:p.terminate();p.wait(timeout=10);err.close()
