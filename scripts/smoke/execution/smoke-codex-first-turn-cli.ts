/** Opt-in existing-Core integration. Uses the test Host process backend, not production isolation. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {build} from 'esbuild';
import {BridgeHost,attachGateway} from '../../../apps/agent-bridge-host/src/index';
import {codexDeclaration} from '../../../apps/agent-bridge-host/src/codex-declaration';
import {CodexOwnerConnection} from '../../../apps/agent-bridge-host/src/codex-owner';
import {localTestBackend} from '../../../tests/agent-bridge/fixtures/local-backend';
import {createServerCodexBridge,createBridgeSessionMcp} from '../../../apps/opencraft-daemon/src/bridge-execution-admission';
import {ActorStore} from '../../../packages/access-control/src/actors';
import {Collaboration,type ConversationExecutionPort} from '../../../packages/access-control/src/collaboration';
import {OrchestrationRuntimeWorker} from '../../../packages/access-control/src/orchestration-runtime-store';
import {ThreadOrchestrationBroker,type OrchestrationExecutionPort} from '../../../packages/access-control/src/thread-orchestration-broker';
import {SessionCapabilities} from '../../../packages/session-capabilities/src/index';
import {SessionCapabilityMcp} from '../../../packages/session-capabilities/src/mcp';
import {hostExecutionCli,waitForExecutionCliBinding} from '../../../packages/session-capabilities/src/execution-cli';
import {executionCliSourceToken} from '../../../packages/session-capabilities/src/credentials';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import type {ThreadOrchestrationSnapshot} from '@opencraft/appserver-protocol/collaboration';

const configPath=process.env.OPENCRAFT_CODEX_CORE_CONFIG;
const outputPath=process.env.OPENCRAFT_P7A_EVIDENCE;
if(!configPath||!outputPath)throw Error('OPENCRAFT_CODEX_CORE_CONFIG and OPENCRAFT_P7A_EVIDENCE are required');
await mkdir(resolve('.local'),{recursive:true});
const root=await mkdtemp(join(resolve('.local'),'p7a-cli-')),task=join(root,'task');await mkdir(task);
const serverId='p7a-local',parent='bridge:codex:parent',key=randomBytes(32),token=randomBytes(32).toString('hex');
const frames:any[]=[],snapshots=new Map<string,ThreadOrchestrationSnapshot>(),receipts=new Map<string,any>(),queued=new Map<string,string>(),children=new Map<string,string>(),nativeIds=new Map<string,string>();
const recording:any={schemaVersion:2,model:'gpt-5.6-luna',reasoning:'low',commands:[],events:[],reservations:[],nativeEvidence:[]};
let host:BridgeHost|undefined,gateway:Awaited<ReturnType<typeof attachGateway>>|undefined,transport:any,mcp:SessionCapabilityMcp|undefined,broker:ThreadOrchestrationBroker|undefined,service:Collaboration|undefined,worker:OrchestrationRuntimeWorker|undefined,observer:CodexOwnerConnection|undefined;
const actors=new ActorStore(join(root,'actors.db'));
const human=actors.resolveHuman({provider:'local',subject:'validation',displayName:'Validation',expiresAt:Date.now()+3600000})!;
let sequence=0,serviceClosing:Promise<void>|undefined;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(read:()=>T|Promise<T>,ok:(v:T)=>boolean,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const v=await read();if(ok(v))return v;await sleep(50);}throw Error('Bounded live evidence deadline exceeded');}
async function request(method:string,params:any={},timeoutMs=180000){const id=++sequence;await transport.send(JSON.stringify({id,method,params,[LOGICAL_CLIENT_FIELD]:'validation'}));const frame=await until(()=>frames.find(f=>f.id===id),Boolean,timeoutMs);if(frame.error)throw Error(JSON.stringify(frame.error));return frame.result;}
async function history(threadId:string){return (await request('thread/read',{threadId,includeTurns:true})).thread.turns;}
async function create(threadId:string){
  const clientRequestId='create:'+threadId;
  await request('thread/start',{cwd:task,model:'gpt-5.6-luna',sandbox:'workspace-write',approvalPolicy:'never',config:{model_reasoning_effort:'low','sandbox_workspace_write.network_access':true},agentBridge:{threadId,clientRequestId}});
  const commandId='bridge-mutation:'+createHash('sha256').update(JSON.stringify([threadId,'thread/start',clientRequestId])).digest('hex');
  const receipt:any=await host!.query(commandId);nativeIds.set(threadId,receipt.response.result.thread.id);
  snapshots.set(threadId,{threadId,state:'starting',turnId:null,rootTurnId:null});
}
const start=(threadId:string,inputId:string,text:string)=>request('turn/start',{threadId,clientUserMessageId:inputId,input:[{type:'text',text}],effort:'low'});
try {
  const execution:ConversationExecutionPort={serverId,hostId:'local-validation',async validate(){},async receipt(_b,id){return receipts.get(id)??null;},
    async add(binding,id,text,canAdmit){
      if(canAdmit&&!canAdmit())return null;
      if(binding.mode==='steer'){queued.set(id,text);const r={id,state:'queued',targetTurnId:null};receipts.set(id,r);return r;}
      if(snapshots.get(binding.threadId)?.state==='active')return null;
      const r=await start(binding.threadId,'actor-input:'+id,text),receipt={id,state:'delivered',targetTurnId:r.turn.id};receipts.set(id,receipt);return receipt;
    },
    async steer(binding,id,_queue,expectedTurnId){await request('turn/steer',{threadId:binding.threadId,expectedTurnId,clientUserMessageId:'actor-input:'+id,input:[{type:'text',text:queued.get(id)!}]});receipts.set(id,{id,state:'steering',targetTurnId:expectedTurnId});},
    async cancel(){return false;},async read(ref){const turns=await history(ref.threadId);return {entries:turns.flatMap((t:any)=>t.items.filter((i:any)=>i.type==='agentMessage'||i.type==='userMessage').map((i:any)=>({turnId:t.id,role:i.type==='agentMessage'?'assistant':'user',text:i.text??i.content.map((p:any)=>p.text??'').join('\n')}))),nextCursor:null};},
  };
  service=new Collaboration(join(root,'collaboration.db'),actors,execution);
  worker=new OrchestrationRuntimeWorker(join(root,'collaboration.db'));await worker.start();
  const driver:OrchestrationExecutionPort={
    async prepare(_op,_parent,args,valid){assert.ok(valid());return {...args,cwd:task,driver:'codex',model:'gpt-5.6-luna',reasoningEffort:'low'};},
    async create(op,_parent,_settings,valid){assert.ok(valid());let id=children.get(op);if(!id){id='bridge:codex:child-'+children.size;await create(id);children.set(op,id);}return {threadId:id,driverKind:'codex',durability:'pending_first_turn'};},
    async snapshot(id){return snapshots.get(id)!;},
  };
  broker=new ThreadOrchestrationBroker(service,driver,Date.now,worker);
  const capabilities=new SessionCapabilities();capabilities.register({id:'validation-platform',tools:()=>[{name:'validation_read',approval:'preauthorized',description:'A non-orchestration platform tool',inputSchema:{type:'object'}}],async call(){return {value:'VALIDATION_PLATFORM_OK'};}});
  mcp=new SessionCapabilityMcp(capabilities,key,undefined,{authorizeExecution:async s=>{await service!.admittedExecution(s.threadId,s.execution!.inputId!);},threadCli:async(s,command)=>{
    await waitForExecutionCliBinding(()=>service!.admittedExecution(s.threadId,s.execution!.inputId!));const result=await broker!.cli(s,command);recording.commands.push({command:command.command,result});return result;
  }});await mcp.listen();
  const port=hostExecutionCli({directory:join(root,'cli'),endpoint:mcp.cliEndpoint,key,launcherEndpoint:()=>new URL('/thread-cli',gateway!.url).href});
  host=await BridgeHost.open({path:join(root,'host.db'),backend:localTestBackend(),policy:{id:'validation',capacity:{cpuMillis:16000,memoryBytes:32*1024**3}},executionCli:{...port,
    async reserve(scope){const lease=await port.reserve(scope);recording.reservations.push({threadId:scope.threadId,phase:'unbound'});return lease;},
    async issue(scope){const lease=await port.issue(scope);recording.reservations.push({threadId:scope.threadId,phase:'admitted'});return lease;},
  }});
  gateway=await attachGateway(host,token);
  const artifact=join(root,'codex.cjs');await build({entryPoints:[resolve('apps/agent-bridge-host/src/codex-main.ts')],outfile:artifact,bundle:true,platform:'node',format:'cjs'});
  recording.artifactSha256=createHash('sha256').update(await readFile(artifact)).digest('hex');
  await host.add({id:'validation',artifact,digest:recording.artifactSha256,provider:codexDeclaration,launch:{command:[process.execPath,artifact,resolve(configPath)],cwd:root,env:{}}});await host.activate('validation','');
  let legacyListener:(raw:string)=>void=()=>{};
  const legacy:any={status:{state:'open'},async connect(){},async close(){},subscribeStatus:()=>()=>{},subscribeMessage(l:any){legacyListener=l;return()=>{};},async send(raw:string){const f=JSON.parse(raw);legacyListener(JSON.stringify({id:f.id,[LOGICAL_CLIENT_FIELD]:'validation',result:{capabilities:{}}}));}};
  const initialMcp=createBridgeSessionMcp(mcp,id=>({serverId,threadId:id}),s=>capabilities.refresh(s));
  transport=createServerCodexBridge(legacy,{url:gateway.url,token,serverId,inboxPath:join(root,'gateway.db')},{...initialMcp,
    async prepareSessionMcp(threadId){const prepared=await initialMcp.prepareSessionMcp(threadId);assert.deepEqual(prepared.configuration?.tools,{validation_read:{approval_mode:'approve'}});recording.platformApproval={validation_read:{approval_mode:'approve'}};return prepared;},
    async admit(threadId,inputId,input){if(threadId===parent)service!.authorizeExecution(human,threadId,inputId,input,serverId);await service!.admittedExecution(threadId,inputId);return {serverId,threadId,execution:{inputId,executionId:inputId}};},
    sign:s=>executionCliSourceToken(key,s),started:(threadId,inputId,turnId)=>service!.executionStarted(threadId,inputId,turnId),
  });
  transport.subscribeMessage((raw:string)=>{const f=JSON.parse(raw);frames.push(f);const p=f.params;if(f.method==='turn/started'){snapshots.set(p.threadId,{threadId:p.threadId,state:'active',turnId:p.turn.id,rootTurnId:p.turn.id});recording.events.push({method:f.method,...p});}
    if(f.method==='turn/completed'){snapshots.set(p.threadId,{threadId:p.threadId,state:p.turn.status==='completed'?'completed':'failed',turnId:p.turn.id,rootTurnId:p.turn.id});recording.events.push({method:f.method,threadId:p.threadId,turn:p.turn});if(p.threadId===parent)serviceClosing??=service!.close();}
  });
  await transport.connect();await request('initialize',{capabilities:{extensions:{'opencraft/steer-evidence':{version:1}}}});service.start();await create(parent);
  await writeFile(join(task,'chain.py'),`import json,subprocess,time,os,urllib.parse
def call(*args):
 p=subprocess.run([os.environ['OPENCRAFT_THREAD_CLI'],*args],text=True,capture_output=True,timeout=35)
 if p.returncode: raise RuntimeError(p.stdout+p.stderr)
 return json.loads(p.stdout)
s=call('thread','spawn','--driver','codex','--prompt','Run python3 -c "import time;time.sleep(10);print(123)" once. Then reply P7A_CHILD_OK unless a steering message changes the final reply.','--idempotency-key','bounded-child')
r='opencraft://conversation/v1/p7a-local/'+urllib.parse.quote(s['threadId'],safe='')
for i in range(24):
 w=call('thread','wait',r,'--timeout','1000'); state=w['threads'][0]
 if state.get('state',state.get('status'))=='active':
  if not state.get('turnId'):
   shown=call('thread','show',r,'--turns','1')
   if shown.get('entries'): state['turnId']=shown['entries'][-1]['turnId']
  if state.get('turnId'): break
 time.sleep(.1)
else: raise RuntimeError('child not active')
t=call('thread','tell',r,'--message','After the command finishes reply exactly P7A_TELL_OK.','--delivery','native','--expected-turn',state['turnId'],'--idempotency-key','bounded-tell')
for i in range(24):
 w=call('thread','wait',r,'--timeout','5000')
 if w.get('settled'): break
else: raise RuntimeError('child not settled')
o=call('thread','output',r)
assert [e['text'].strip() for e in o['history']['entries'] if e['role']=='assistant'][-1]=='P7A_TELL_OK',o
print(json.dumps({'spawn':s,'tell':t,'wait':w,'output':o}))
`);
  await start(parent,'first-input','Run python3 chain.py once in the current directory. Do not retry on failure. After successful spawn/tell/wait/output reply exactly P7A_PARENT_OK.');
  await until(()=>snapshots.get(parent),s=>s?.state==='completed'||s?.state==='failed');
  recording.parentHistory=await history(parent);recording.childHistories=[];
  for(const id of children.values())recording.childHistories.push({threadId:id,turns:await history(id)});
  const config=JSON.parse(await readFile(configPath,'utf8'));
  observer=new CodexOwnerConnection(config.endpoint,config.token,()=>{},()=>{},()=>{});await observer.connect();recording.nativeUserAgent=(observer.serverInfo as any)?.userAgent;
  for(const [publicId,nativeId] of nativeIds){
    const r:any=await observer.request('thread/read',{threadId:nativeId,includeTurns:false});
    const selected:any[]=[];
    for(const line of (await readFile(r.thread.path,'utf8')).split('\n')){if(!line)continue;const v=JSON.parse(line),p=v.payload??{};
      if(v.type==='event_msg'&&['task_started','task_complete','user_message','agent_message'].includes(p.type))selected.push({type:v.type,payload:Object.fromEntries(Object.entries(p).filter(([k])=>['type','turn_id','root_turn_id','client_id','message','last_agent_message'].includes(k)))});
      if(v.type==='response_item'&&['custom_tool_call','custom_tool_call_output','function_call','function_call_output'].includes(p.type))selected.push({type:v.type,payload:p});
      if(v.type==='turn_context')selected.push({type:v.type,payload:Object.fromEntries(Object.entries(p).filter(([k])=>['model','effort','approval_policy','sandbox_policy'].includes(k)))});
    }
    recording.nativeEvidence.push({publicThreadId:publicId,nativeThreadId:nativeId,selected});
  }
  assert.equal(children.size,1);for(const c of ['spawn','tell','wait','output'])assert.ok(recording.commands.some((x:any)=>x.command===c));
  assert.equal(recording.nativeEvidence.flatMap((n:any)=>n.selected).filter((v:any)=>v.type==='event_msg'&&v.payload.type==='task_started').length,2);
  assert.equal(recording.childHistories[0].turns.length,1);
  const lastAssistant=(turns:any[])=>turns.flatMap(t=>t.items).filter(i=>i.type==='agentMessage').at(-1)?.text.trim();
  assert.equal(recording.childHistories[0].turns[0].status,'completed');
  assert.equal(recording.parentHistory.at(-1)?.status,'completed');
  assert.equal(lastAssistant(recording.childHistories[0].turns),'P7A_TELL_OK');
  assert.equal(lastAssistant(recording.parentHistory),'P7A_PARENT_OK');
  recording.result='passed';
} catch(error){recording.result='failed';recording.error=String(error);process.exitCode=1;}
finally{
  observer?.close();
  // Interrupt only this harness's still-active Turns before dropping transport custody.
  for(const snapshot of snapshots.values())if(snapshot.state==='active'&&snapshot.turnId) {
    await request('turn/interrupt',{threadId:snapshot.threadId,turnId:snapshot.turnId},5000).catch(()=>{});
  }
  recording.cleanup='completed';
  const closers=[()=>serviceClosing??service?.close(),()=>broker?.close(),()=>transport?.close(),
    ()=>gateway?.close(),()=>host?.close(),()=>mcp?.close(),()=>worker?.close(),()=>actors.close()];
  for(const close of closers)try{await close();}catch{recording.cleanup='failed';process.exitCode=1;}
  const sanitized=JSON.stringify(recording,null,2).replaceAll(root,'<validation-root>').replaceAll(resolve('.'),'<checkout>');
  try{await writeFile(resolve(outputPath),sanitized+'\n');}finally{await rm(root,{recursive:true,force:true});}
  console.log(JSON.stringify({result:recording.result,evidence:outputPath,error:recording.error}));
}
