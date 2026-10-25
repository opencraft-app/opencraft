import assert from 'node:assert/strict';
import { spawn, fork, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, cp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { zstdDecompressSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import {request as httpRequest} from 'node:http';
import {startCodexGenerationService} from '../../../apps/codex-core/src/generation-service';
import {CodexGenerationRegistry} from '../../../apps/codex-core/src/generation-registry';
import {SystemdGenerationSupervisor} from '../../../apps/codex-core/src/generation-supervisor';
import { AccountPoolStore, CodexCoreControlClient } from '@opencraft/account-pool-host';

// Opt-in real Native CLI. No real account, upstream, HOME, or existing service.
const executable=process.env.OPENCRAFT_CODEX_EXECUTABLE,mixedLegacyBundle=process.env.OPENCRAFT_ORCHESTRATION_LEGACY_BUNDLE;
if(!executable)throw Error('Set OPENCRAFT_CODEX_EXECUTABLE to the fixed CLI under test');
const drillParent=process.env.OPENCRAFT_ORCHESTRATION_DRILL_ROOT??(mixedLegacyBundle?'/run/opencraft-orchestration-drills':tmpdir());await mkdir(drillParent,{recursive:true,mode:0o755});
const root=await mkdtemp(join(drillParent,'orchestration-drill-'));
const cwd=resolve(import.meta.dirname,'../../..'),home=join(root,'home');await mkdir(home,{mode:0o700});
const authToken='synthetic-orchestration-control-'.repeat(3),records:any[]=[],children=new Set<ChildProcess>();
let recoveryRequests=0,allowRecovery=false;
const env={PATH:process.env.PATH,HOME:home,TMPDIR:root,LANG:'C.UTF-8',RUST_LOG:'error'};
const result:any={root,cliVersion:execFileSync(executable,['--version'],{encoding:'utf8'}).trim(),scenarios:[]};
const event=(response:ServerResponse,value:any)=>response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
function finish(response:ServerResponse,id:string,item:any){
  event(response,{type:'response.output_item.added',output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]})}});
  event(response,{type:'response.output_item.done',output_index:0,item});
  event(response,{type:'response.completed',response:{id,object:'response',status:'completed',output:[item],usage:{input_tokens:10,output_tokens:5,total_tokens:15}}});response.end();
}
const model=createServer(async(request,response)=>{
 try{
  if(request.url==='/usage'){response.end('{"plan_type":"pro"}');return;}
  if(request.url?.endsWith('/models')){response.end('{"data":[]}');return;}
  if(request.url!=='/responses'){response.writeHead(404);response.end();return;}
  const chunks=[];for await(const chunk of request)chunks.push(chunk);const raw=Buffer.concat(chunks);
  const bytes=request.headers['content-encoding']==='zstd'?zstdDecompressSync(raw):request.headers['content-encoding']==='gzip'?gunzipSync(raw):raw;
  const body=JSON.parse(bytes.toString()),inputs=body.input??[],outputs=inputs.filter((i:any)=>i.type==='function_call_output');
  const user=JSON.stringify(inputs.filter((i:any)=>i.role==='user').at(-1)??''),id=`response-${records.length}`;
  const rootMatch=/ROOT-(TELL|SPAWN|RECOVERY) ([0-9a-f-]{36})/.exec(user),childMatch=/CHILD-(TELL|SPAWN) ([0-9a-f-]{36})/.exec(user);
  records.push({user,outputs,tools:body.tools?.map((tool:any)=>tool.name??tool.type)});
  response.writeHead(200,{'content-type':'text/event-stream'});
  event(response,{type:'response.created',response:{id,object:'response',status:'in_progress',output:[]}});
  if(JSON.stringify(inputs.filter((item:any)=>item.role==='user')).includes('CHILD-RECOVERY')&&!user.includes('Generate a concise UI title')){
    recoveryRequests++;let text='';
    event(response,{type:'response.output_item.added',output_index:0,item:{type:'message',id:`message-${id}`,role:'assistant',status:'in_progress',content:[]}});
    while(!allowRecovery&&!response.destroyed){await delay(100);text+='tick ';event(response,{type:'response.output_text.delta',item_id:`message-${id}`,output_index:0,content_index:0,delta:'tick '});}
    if(response.destroyed)return;
    finish(response,id,{type:'message',id:`message-${id}`,role:'assistant',status:'completed',content:[{type:'output_text',text:text+'Recovered.',annotations:[]}]});return;
  }
  if(!outputs.length&&(rootMatch||childMatch)&&!user.includes('Generate a concise UI title')){
    const match=(rootMatch??childMatch)!,tool=rootMatch||match[1]==='SPAWN'?'thread_spawn':'thread_tell';
    assert.ok(body.tools.some((t:any)=>t.name===tool),'real Native must advertise '+tool);
    const args=rootMatch?{prompt:`CHILD-${match[1]} ${match[2]}`,title:'Synthetic child'}:match[1]==='SPAWN'?{prompt:'GRANDCHILD-DONE',title:'Synthetic grandchild'}:{threadId:match[2],message:'SYNTHETIC-DONE'};
    finish(response,id,{type:'function_call',id:`call-item-${id}`,call_id:`call-${id}`,name:tool,arguments:JSON.stringify(args)});return;
  }
  finish(response,id,{type:'message',id:`message-${id}`,role:'assistant',status:'completed',content:[{type:'output_text',text:user.includes('Generate a concise UI title')?'{"title":"Synthetic"}':'Synthetic task finished.',annotations:[]}]});
 }catch(error){records.push({error:String(error)});if(!response.headersSent)response.writeHead(500);response.end();}
});
async function listen(server:ReturnType<typeof createServer>){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return(server.address() as import('node:net').AddressInfo).port;}
const modelPort=await listen(model),reservation=createServer(),proxyPort=await listen(reservation);await new Promise<void>(resolve=>reservation.close(()=>resolve()));
const dataDirectory=join(root,'data'),gatewayDirectory=join(root,'gateway');await mkdir(gatewayDirectory);
const store=new AccountPoolStore({databasePath:join(dataDirectory,'account-pool.sqlite'),secretsDirectory:join(dataDirectory,'secrets')});
store.addAccount({id:'synthetic',provider:'codex',label:'Synthetic',upstreamAccountId:'synthetic',enabled:true,priority:0},{accessToken:'synthetic-no-upstream-access',refreshToken:null,expiresAt:null});store.close();
const endpoint=join(root,'accounts/control.sock'),appServerEndpoint=join(root,'execution/control.sock'),crashMarker=join(root,'crash-ready.json');
const common={authToken,executable,dataDirectory,runtimeDirectory:root};
const control=new CodexCoreControlClient(endpoint,authToken);
async function wait(check:()=>Promise<unknown>|unknown,label:string,timeout=30_000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{if(await check())return;}catch{}await delay(25);}throw Error('Timed out: '+label);}
async function owner(kind:string,options:object){
 const config=join(root,kind+'.json');await writeFile(config,JSON.stringify(options),{mode:0o600});
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/split-codex-owner.ts',kind,config],{cwd,env,stdio:['ignore','pipe','pipe']});children.add(child);
 let output='',errors='';child.stdout!.on('data',c=>output+=c);child.stderr!.on('data',c=>errors+=c);child.on('exit',()=>{children.delete(child);void writeFile(join(root,kind+'-stderr.log'),errors);});
 await wait(()=>output.includes('ready\n'),kind+' startup');return child;
}
async function stop(child:ChildProcess,signal:NodeJS.Signals='SIGTERM'){
 if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill(signal);
 const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);await done;clearTimeout(timeout);
}
let gateway:ChildProcess|undefined,core:ChildProcess|undefined,app:ChildProcess|undefined;
let routing:Awaited<ReturnType<typeof startCodexGenerationService>>|undefined,ownerControl=control;
const tokenFile=join(root,'synthetic-token'),registryDirectory=join(root,'registry');
async function admin(operation:string,params:object){return new Promise<any>((resolve,reject)=>{
 const request=httpRequest({socketPath:appServerEndpoint,path:'/generations',method:'POST',headers:{authorization:'Bearer '+authToken,'content-type':'application/json'}},response=>{const chunks:Buffer[]=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{const result=JSON.parse(Buffer.concat(chunks).toString());response.statusCode===200?resolve(result):reject(Error('Generation operation rejected'));});});request.on('error',reject);request.end(JSON.stringify({operation,params}));
});}

let rpc:(command:string,params?:unknown)=>Promise<any>;
async function startGateway(crashTool?:string){
 const config=join(root,'gateway.json');await writeFile(config,JSON.stringify({...common,root,gatewayDirectory,endpoint,crashMarker,crashTool,...(mixedLegacyBundle?{nativeHome:join(root,'modern/runtime')}:{})}),{mode:0o600});
 const child=fork(join(cwd,'tests/fixtures/orchestration-gateway.ts'),[config],{cwd,env,execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});gateway=child;children.add(child);
 let ready=false,seq=0,errors='';const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();
 child.stderr!.on('data',c=>{errors+=c;void appendFile(join(root,`gateway-live-${child.pid}.log`),c);});child.stdout!.resume();child.on('exit',()=>{children.delete(child);for(const value of pending.values())value.reject(Error('Gateway exited'));void writeFile(join(root,`gateway-${child.pid}.log`),errors);});
 child.on('message',(message:any)=>{if(message.ready)ready=true;else{const p=pending.get(message.id);pending.delete(message.id);message.error?p?.reject(Object.assign(Error(message.error.message),{code:message.error.code})):p?.resolve(message.result);}});
 rpc=(command,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});child.send({id,command,params});});
 await wait(()=>ready,'Gateway ready');return child;
}
try{
 core=await owner('core',{...common,endpoint,appServerEndpoint,proxyPort,nativeCodexHomeDirectory:join(root,'unused'),upstreamBaseUrl:`http://127.0.0.1:${modelPort}`});
 if(mixedLegacyBundle){
  await writeFile(tokenFile,authToken,{mode:0o600});
  await cp(dirname(dirname(executable!)),join(root,'cli'),{recursive:true});await copyFile(join(cwd,'apps/codex-core/dist/app-server.cjs'),join(root,'app-server.cjs'));
  const definition=(id:string,bundle:string)=>({id,endpoint:join(root,'execution',id,'control.sock'),runtimeDataDirectory:join(root,id),executable:join(root,'cli/bin/codex'),bundle,node:process.execPath,cwd:root});
  routing=await startCodexGenerationService({endpoint:appServerEndpoint,coreEndpoint:endpoint,tokenFile,token:authToken,dataDirectory,registryDirectory,systemdScope:'system',requireHostUsage:true,bootstrap:{generation:definition('legacy',mixedLegacyBundle)}});
  await admin('prepare',{definition:definition('modern',join(root,'app-server.cjs'))});await admin('activate',{id:'modern',expectedEpoch:1});
  ownerControl=new CodexCoreControlClient(join(root,'execution/modern/control.sock'),authToken);
 }else app=await owner('runtime',{...common,endpoint:appServerEndpoint,coreEndpoint:endpoint,waitForCore:true});
 const before=await ownerControl.health();assert.equal(before.callbackProtocolVersion,1);
 for(const kind of (process.env.OPENCRAFT_ORCHESTRATION_RECOVERY_ONLY?[]:mixedLegacyBundle?['SPAWN']:['TELL','SPAWN'])){
  await startGateway(kind==='TELL'?'thread_tell':'thread_spawn');
  await rpc('rpc',{method:'opencraft/token-usage/configure',arguments:{enabled:true}});
  const {thread}=await rpc('rpc',{method:'thread/start',arguments:{cwd:root,model:'gpt-test',approvalPolicy:'never',sandbox:'danger-full-access'}});
  if(mixedLegacyBundle)await admin('activate',{id:'legacy',expectedEpoch:2});
  await rpc('rpc',{method:'turn/start',arguments:{threadId:thread.id,clientUserMessageId:`human-${kind}`,input:[{type:'text',text:`ROOT-${kind} ${thread.id}`}]}});
  await wait(()=>readFile(crashMarker,'utf8').then(text=>JSON.parse(text).name===(kind==='TELL'?'thread_tell':'thread_spawn'),()=>false),'durable child tool before reply');
  const crashed=JSON.parse(await readFile(crashMarker,'utf8'));assert.notEqual(crashed.thread,thread.id);
  await stop(gateway!,'SIGKILL');const restartedAt=Date.now();await startGateway();
  await wait(async()=>{if(mixedLegacyBundle){const result=await rpc('rpc',{method:'thread/read',arguments:{threadId:crashed.thread,includeTurns:true}});return result.thread.turns.some((turn:any)=>turn.id===crashed.turn&&turn.status==='completed');}const state=await rpc('inspect',{threadId:crashed.thread});return state.state==='completed';},'original child Turn completion');
  const after=await ownerControl.health();assert.equal(after.codexPid,before.codexPid);assert.equal(after.appServerPid,before.appServerPid);
  const history=await rpc('rpc',{method:'thread/read',arguments:{threadId:crashed.thread,includeTurns:true}});
  const original=history.thread.turns.find((turn:any)=>turn.id===crashed.turn);assert.equal(original?.status,'completed');
  const state=await rpc('state'),operation=state.operations.find((op:any)=>op.operation_id===crashed.result.operationId);
  assert.ok(operation?.result_json);assert.equal(state.operations.filter((op:any)=>op.operation_id===operation.operation_id).length,1);
  const input=state.inputs.find((row:any)=>row.thread_id===operation.target_thread_id&&row.input_id===operation.client_message_id);assert.equal(JSON.parse(input.origin_json).usageSourceKind,'system');
  await wait(async()=>(await rpc('state')).requests.some((row:any)=>row.id===operation.client_message_id.slice('actor-input:'.length)&&row.state==='submitted'),'one target input accepted by Native');
  const targetHistory=await rpc('rpc',{method:'thread/read',arguments:{threadId:operation.target_thread_id,includeTurns:true}});
  if(kind==='SPAWN')assert.equal(state.threads.filter((child:any)=>child.parentThreadId===crashed.thread).length,1);
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(Date.now());let usage:any;
  await wait(async()=>{usage=await rpc('rpc',{method:'opencraft/token-usage/query',arguments:{serverId:'server',scope:'team',from:day,through:day,threadId:crashed.thread}});return BigInt(usage.summary.categories.system)>0n;},'system known Token dashboard category');
  if(mixedLegacyBundle){const directory=await control.generationDirectory(crashed.result.threadId);assert.equal(directory?.route?.generationId,'modern');}
  result.scenarios.push({kind,mixedLegacyDefault:!!mixedLegacyBundle,crashBeforeBrokerCommit:crashed.beforeBrokerCommit===true,threadId:crashed.thread,turnId:crashed.turn,toolCallKey:crashed.key,reconnectMs:Date.now()-restartedAt,nativePidUnchanged:true,operationCount:1,targetTurns:targetHistory.thread.turns.length,systemKnownTokens:usage.summary.categories.system});
  await stop(gateway!);gateway=undefined;
  // Only our own synthetic marker; the next case must reach its own operation.
  await writeFile(crashMarker,'{}');
 }
 if(!mixedLegacyBundle){
 await startGateway();
 const {thread:parent}=await rpc('rpc',{method:'thread/start',arguments:{cwd:root,model:'gpt-test',approvalPolicy:'never',sandbox:'danger-full-access'}});
 const {turn:parentTurn}=await rpc('rpc',{method:'turn/start',arguments:{threadId:parent.id,clientUserMessageId:'human-recovery',input:[{type:'text',text:`ROOT-RECOVERY ${parent.id}`}]}});
 await wait(()=>recoveryRequests>=1,'synthetic child streaming');
 let state=await rpc('state');const child=state.threads.find((row:any)=>row.parentThreadId===parent.id);assert.ok(child);
 const initial=await rpc('inspect',{threadId:child.threadId});assert.equal(initial.state,'active');
 const notices=(snapshot:any)=>snapshot.inputs.filter((row:any)=>row.thread_id===parent.id&&JSON.parse(row.origin_json).kind==='parent_system_notice');
 assert.equal(notices(state).length,0);
 const oldNative=(await control.health()).codexPid;process.kill(oldNative,'SIGKILL');await stop(app!);app=await owner('runtime',{...common,endpoint:appServerEndpoint,coreEndpoint:endpoint,waitForCore:true});
 try{await wait(()=>recoveryRequests>=2,'automatic recovery inference',20_000);}catch(error){
   result.debug={health:await control.health().catch(String),state:await rpc('state')};
   for(const method of ['thread/read','thread/resume','thread/goal/get','thread/turns/list'])try{result.debug[method]=await rpc('native',{method,arguments:{threadId:child.threadId,excludeTurns:true,includeTurns:false,limit:1,sortDirection:'desc',itemsView:'notLoaded'}});}catch(e){result.debug[method]=String(e);}
   throw error;
 }

 state=await rpc('state');assert.equal(notices(state).length,0,'no interrupted notice during automatic recovery');
 const running=await rpc('inspect',{threadId:child.threadId});assert.ok(['recovering','active'].includes(running.state));assert.equal(running.rootTurnId,initial.rootTurnId);
 const queued=await rpc('agentTell',{sourceThreadId:parent.id,sourceTurnId:parentTurn.id,threadId:child.threadId});
 await wait(async()=>(await rpc('request',queued)).queue_id,'durable Agent queue during recovery');
 process.kill((await control.health()).codexPid,'SIGKILL');await stop(app!);app=await owner('runtime',{...common,endpoint:appServerEndpoint,coreEndpoint:endpoint,waitForCore:true});
 await wait(()=>recoveryRequests>=3,'same-root retry despite a queued Agent input',30_000);
 const retry=await rpc('inspect',{threadId:child.threadId});assert.equal(retry.rootTurnId,initial.rootTurnId);assert.equal(notices(await rpc('state')).length,0);
 await rpc('cancelAgent',queued);
 allowRecovery=true;
 await wait(async()=>{const current=await rpc('inspect',{threadId:child.threadId});return current.state==='completed';},'recovered child completion');
 await wait(async()=>notices(await rpc('state')).length===1,'one parent completion notice');await delay(2200);assert.equal(notices(await rpc('state')).length,1);
 const final=await rpc('inspect',{threadId:child.threadId});assert.equal(final.rootTurnId,initial.rootTurnId);assert.notEqual(final.turnId,initial.turnId);
 result.scenarios.push({kind:'RECOVERY',threadId:child.threadId,rootTurnId:final.rootTurnId,originalTurnId:initial.turnId,continuedTurnId:final.turnId,parentNoticesDuringRecovery:0,parentNoticesAfterCompletion:1,queuedAgentDidNotCancelRecovery:true,nativeKilledOnlyInIsolatedEnvironment:true});
 }
 assert.equal(records.filter(record=>record.error).length,0,JSON.stringify(records.filter(record=>record.error)));
 result.passed=true;
}finally{
 allowRecovery=true;
 if(gateway)await stop(gateway);
 if(mixedLegacyBundle){try{await routing?.close();const registry=new CodexGenerationRegistry(registryDirectory),supervisor=new SystemdGenerationSupervisor({registryDirectory,coreEndpoint:endpoint,dataDirectory,tokenFile,token:authToken,scope:'system'});
  try{for(const generation of registry.list()){const identity=registry.metadata(`runtime:${generation.id}`);if(identity&&generation.state!=='retired')await supervisor.stop(generation,identity as any);}}finally{registry.close();}}catch(error){result.cleanupError=String(error);}
 }
 if(core)await stop(core);if(app)await stop(app);
 for(const child of children)await stop(child,'SIGKILL');model.closeAllConnections();await new Promise<void>(resolve=>model.close(()=>resolve()));
 await writeFile(join(root,'model-records.json'),JSON.stringify(records,null,2));await writeFile(join(root,'report.json'),JSON.stringify(result,null,2));
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
