#!/usr/bin/python3
"""LOCAL ONLY: opt-in real native built-in shell adoption/OOM benchmark.

No account credentials or remote inference. Run separately from the APP/native
priority/recovery smoke; this latency fixture has native as its service MainPID.
"""
import argparse
import json,os,select,socket,struct,subprocess,tempfile,time,threading,concurrent.futures,shutil,statistics,uuid
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--native', type=Path, required=True)
parser.add_argument('--allow-local-oom-drill', action='store_true', required=True)
args=parser.parse_args()
N=50
native=str(args.native.resolve(strict=True))
guard_path=str(Path(__file__).resolve().parents[2] / 'server-deployment/tool-memory-guard.py')
home=Path(tempfile.mkdtemp(prefix='native-adopt-bench-'));tag=uuid.uuid4().hex[:8];slice_name='join-delegate-bench-'+tag+'.service'
import http.server,gzip,shlex
requests_seen=[];calls_sent=False;fixture_ready=threading.Event()
class Fixture(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  global calls_sent
  raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
  if self.headers.get('Content-Encoding')=='gzip':raw=gzip.decompress(raw)
  body=json.loads(raw);requests_seen.append({'path':self.path,'toolNames':[x.get('name') for x in body.get('tools',[])]})
  fixture_ready.wait(10)
  events=[{'type':'response.created','response':{'id':'fixture-response'}}]
  if not calls_sent:
   calls_sent=True
   for i in range(50):
    command='/usr/bin/python3 -c '+shlex.quote('import time; a=bytearray('+str(256 if i==49 else 2)+'*1024*1024); time.sleep(2)')
    events.append({'type':'response.output_item.done','item':{'type':'function_call','call_id':'synthetic-'+str(i),'name':'exec_command','arguments':json.dumps({'cmd':command,'yield_time_ms':10000,'max_output_tokens':100})}})
  else:
   events.append({'type':'response.output_item.done','item':{'type':'message','role':'assistant','id':'done','content':[{'type':'output_text','text':'synthetic fixture done'}]}})
  events.append({'type':'response.completed','response':{'id':'fixture-response','usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}})
  data=''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=server.serve_forever,daemon=True).start()
cli_args=['exec','--json','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','-c','model_provider="fixture"','-c','model="fixture"','-c','model_providers.fixture.name="fixture"','-c','model_providers.fixture.base_url="http://127.0.0.1:'+str(server.server_port)+'/v1"','-c','model_providers.fixture.wire_api="responses"','-c','model_providers.fixture.requires_openai_auth=false','Run the fixed synthetic resource fixture.']
p=subprocess.Popen(['systemd-run','--quiet','--pipe','--wait','--unit='+slice_name,'--property=OOMPolicy=continue','--property=Delegate=yes','--property=DelegateSubgroup=app','--property=MemoryHigh=16G','--property=MemoryMax=16G','--setenv=HOME='+str(home),'--setenv=CODEX_HOME='+str(home),'--working-directory='+str(home),native,*cli_args],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,cwd=home,env={'PATH':os.environ['PATH'],'HOME':str(home),'CODEX_HOME':str(home)})
p.stdin.close()
for _ in range(100):
 try:
  native_pid=int(subprocess.check_output(['systemctl','show',slice_name,'-p','MainPID','--value'],text=True).strip())
  if native_pid:break
 except (ValueError,subprocess.CalledProcessError):pass
 time.sleep(.01)
owner=Path('/sys/fs/cgroup/system.slice')/slice_name
(owner/'cgroup.subtree_control').write_text('+memory +pids')
guard_process=subprocess.Popen(['/usr/bin/python3',guard_path,'--unit',slice_name,'--native-pid',str(native_pid),'--high-mib','256','--max-mib','256'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
records=[];scopes=[];stop=False
try:
 ready_until=time.monotonic()+10
 while time.monotonic()<ready_until:
  if select.select([guard_process.stdout],[],[],.1)[0]:
   item=json.loads(guard_process.stdout.readline());records.append(item)
   if item['event']=='ready':break
  if guard_process.poll() is not None:raise RuntimeError(guard_process.stderr.read())
 else:raise RuntimeError('guard readiness timeout')
 fixture_ready.set()
 completed=set();started=set();active=set();peak_concurrent=0;terminal=False;cli_events=[];deadline=time.monotonic()+90
 while time.monotonic()<deadline:
  if not select.select([p.stdout],[],[],1)[0]:
   if p.poll() is not None:break
   continue
  line=p.stdout.readline()
  if not line:break
  d=json.loads(line);cli_events.append(d)
  item=d.get('item',{})
  if item.get('type')=='command_execution':
   if d.get('type')=='item.started':started.add(item['id']);active.add(item['id']);peak_concurrent=max(peak_concurrent,len(active))
   if d.get('type')=='item.completed':completed.add(item['id']);active.discard(item['id'])
  if d.get('type') in ['turn.completed','turn.failed']:terminal=d.get('type')=='turn.completed';break
 time.sleep(.2);guard_process.terminate();guard_process.wait(timeout=5)
 records.extend(json.loads(line) for line in guard_process.stdout.read().splitlines())
 good=[r for r in records if r.get('event')=='adopted'];vals=sorted(r['delay_ms'] for r in good)
 out={'native':subprocess.check_output([native,'--version'],text=True).strip(),'boundary':'official native built-in exec_command via local deterministic Responses SSE fixture','concurrent_requested':N,'native_peak_parallel_tools':peak_concurrent,'native_turn_completed':terminal,'fixture_requests':requests_seen,'exit_codes':[x['item'].get('exit_code') for x in cli_events if x.get('type')=='item.completed' and x.get('item',{}).get('type')=='command_execution'],'completed':len(completed),'adopted':len(good),'connector':'fork events','topology':'Delegate=yes DelegateSubgroup=app; per-tool child cgroup in same owner','p50_ms':statistics.median(vals) if vals else None,'p99_ms':vals[min(len(vals)-1,int(len(vals)*.99))] if vals else None,'max_pre_adoption_anon_upper_bytes':max((r.get('pre_adoption_anon_upper_bytes',0) for r in good), default=0),'records':records}
 print(json.dumps(out,indent=2))
 assert terminal and len(completed)==N and peak_concurrent==N, 'all 50 native tools must complete and overlap'
 assert vals and out['p99_ms'] <= 70, 'normal-load adoption p99 exceeds latest steward 70ms allowance'
 assert out['max_pre_adoption_anon_upper_bytes'] < 64*2**20, 'sampled pre-adoption anon exceeds 64MiB'
finally:
 stop=True
 if guard_process.poll() is None:
  guard_process.terminate();guard_process.wait(timeout=5)
 p.terminate();p.wait(timeout=5);server.shutdown()
 subprocess.run(['systemctl','stop',slice_name],stderr=subprocess.DEVNULL,stdout=subprocess.DEVNULL)
 shutil.rmtree(home)
