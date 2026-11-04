import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration } from '../../packages/access-control/src/collaboration';
import { ThreadAccessStore, ThreadAccessSession } from '../../packages/access-control/src/thread-access';
import { openServerDatabase } from '../../packages/storage-node/src/server/index';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { CodexEngineAdapter } from '../../apps/opencraft-daemon/src/codex-engine-adapter';
import { LocalHostResources } from '../../apps/local-agent-host/src/host-resources';
import { ProjectRepository } from '../../apps/local-agent-host/src/project-repository';
import { ConversationHistoryTransport } from '../../packages/app-host-server/src/conversation-history-transport';
import { ConversationHistory } from '../../packages/app-host-server/src/conversation-history';
import { createRoutedConversationExecution, callConversationHost } from '../../scripts/conversation-execution.mjs';
import { createSshHttpIngress } from '../../plugins/ssh-http-ingress/src/index.mjs';
import { run as sourceRun } from '../../apps/opencraft-cli/src/main';
import {pathToFileURL} from 'node:url';
// Optionally verify the fixed standalone client against this same local SSH/Native fixture.
const run = process.env.OPENCRAFT_OPTIONS_CLI ? (await import(pathToFileURL(process.env.OPENCRAFT_OPTIONS_CLI).href)).run as typeof sourceRun : sourceRun;
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import { createSshNativeRpcGateway } from '../../scripts/ssh-native-rpc-gateway.mjs';

const executable=process.env.OPENCRAFT_OPTIONS_NATIVE;
for(const {queueAdmission,explicitSettings,omitPermission} of [{queueAdmission:false,explicitSettings:false,omitPermission:false},{queueAdmission:true,explicitSettings:false,omitPermission:false},{queueAdmission:true,explicitSettings:true,omitPermission:false},{queueAdmission:true,explicitSettings:false,omitPermission:true}]) test(`official 0.162 human public-key SSH -> Hub7 -> Host -> Native options; original queue admission=${queueAdmission}; explicit model=${explicitSettings}; omitted permission=${omitPermission}`, {skip:!executable,timeout:90000},async t=>{
 assert.equal(createHash('sha256').update(await readFile(executable!)).digest('hex'),'628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1');
 const cleanup:(()=>Promise<void>)[]=[];t.after(async()=>{for(const close of cleanup.reverse())await close();});
 const root=await mkdtemp(join(tmpdir(),'options-native-')),home=join(root,'home'),repo=join(root,'repo');await mkdir(home);await mkdir(repo);cleanup.push(()=>rm(root,{recursive:true,force:true}));let localStubRequests=0;
 const stub=createServer(async(req,res)=>{
   if(req.method!=='POST'){res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[]}');return;}
   for await(const _ of req){};localStubRequests++;
   const item={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:'synthetic done',annotations:[]}]};
   const response={id:'resp_fixture',object:'response',status:'in_progress',output:[]};
   const events=[{type:'response.created',response},{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'synthetic done'},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
   res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''));
 });stub.listen(0,'127.0.0.1');await once(stub,'listening');cleanup.push(async()=>{stub.closeAllConnections();await new Promise<void>(resolve=>stub.close(()=>resolve()));});
 await writeFile(join(home,'config.toml'),`model = "gpt-6.1-sol"\nmodel_context_window = 1000\nmodel_provider = "fixture"\napproval_policy = "on-request"\nsandbox_mode = "${omitPermission?'workspace-write':'read-only'}"\n[model_providers.fixture]\nname = "fixture"\nbase_url = "http://127.0.0.1:${(stub.address() as any).port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
 const db=await openServerDatabase(join(root,'server')),actors=new ActorStore(db);
 const human=actors.resolveHuman({provider:'fixture',subject:'employee',displayName:'Synthetic employee',expiresAt:Date.now()+120000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);let allowed=true,service:Collaboration;
 cleanup.push(async()=>{access.close();actors.close();await db.close();});
 const directory=join(root,'projects'),resources=new LocalHostResources({projectDirectory:directory});
 const {project}=await new ProjectRepository(directory).create({name:'Fixture',roots:[{path:repo}],idempotencyKey:'fixture'});
 const nativeCompleted=new Set<string>(),nativeCompletedTurns=new Set<string>(),nativeStarts:any[]=[],nativeAllocations:any[]=[];const pendingNative=new Map<any,any>();
 const makeAdapter=()=>new CodexEngineAdapter({executable:executable!,runtimeDirectory:repo,dataDirectory:join(root,'adapter'),nativeCodexHomeDirectory:home,
   upstreamBaseUrl:`http://127.0.0.1:${(stub.address() as any).port}`,fetch:async()=>Response.json({ok:true}),
   spawnAppServer:({env,cwd})=>{const child=spawn(executable!,['app-server'],{cwd,env:{...env,CODEX_HOME:home,HOME:home},stdio:['pipe','pipe','pipe']});
     const write=child.stdin.write.bind(child.stdin);let sent='';
     child.stdin.write=((chunk:any,...args:any[])=>{sent+=chunk.toString();let index;while((index=sent.indexOf('\n'))>=0){const line=sent.slice(0,index);sent=sent.slice(index+1);try{const packet=JSON.parse(line);if(packet.id!==undefined){pendingNative.set(packet.id,packet);}}catch{}}return (write as any)(chunk,...args);}) as any;
     let buffered='';child.stdout.on('data',chunk=>{buffered+=chunk.toString();let index;while((index=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,index);buffered=buffered.slice(index+1);try{const packet=JSON.parse(line);if(packet.method==='turn/completed'){nativeCompleted.add(packet.params.threadId);nativeCompletedTurns.add(packet.params.turn.id);}const request=pendingNative.get(packet.id);if(request)pendingNative.delete(packet.id);if(request?.method==='thread/start'&&packet.result)nativeAllocations.push({params:request.params,threadId:packet.result.thread.id});if(request?.method==='turn/start'&&packet.result)nativeStarts.push({params:request.params,turnId:packet.result.turn.id});}catch{}}});return child;},
   createMaintenanceClient:async()=>{throw Error('unused');},logDiagnostic:()=>{},
   collaboration:{...(queueAdmission?{serverId:'server:fixture:codex'}:{}),queuedContext:(thread,inputId,input)=>service.queuedReferenceContext(thread,inputId,input),continued:(thread,previous,turn)=>service.executionContinued(thread,previous,turn),continuing:(thread,previous,inputId)=>service.executionContinuing(thread,previous,inputId),inputDelegation:(thread,inputId,expected)=>service.inputDelegation(thread,inputId,expected),command:(context,body,trusted)=>service.command(context,body,trusted),prepare:(context,input)=>service.referenceContext(context,input),authorize:(context,thread,input)=>service.authorizeExecution(context,thread,input),started:(thread,input,turn)=>service.executionStarted(thread,input,turn),tool:(thread,turn,name,args)=>service.tool(thread,turn,name,args)},
   ...(queueAdmission?{collaborationInput:{available:()=>service.available,settingsAvailable:()=>service.modelSettingsAvailable,settings:(thread:string,id:string)=>service.inputSettings(thread,id),mode:(id:string)=>service.inputMode(id),authorize:(thread:string,id:string,mode:any,expected?:string)=>service.authorizeInput(thread,id,mode,expected)}}:{}),
 });
 let adapter=makeAdapter();let history=new ConversationHistoryTransport(adapter,new ConversationHistory(db.database,'local-codex'));
 const makeHost=()=>new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',hostDefinitions:[{hostId:'local-codex',label:'Codex'},{hostId:'opencraft-server',label:'Resources'}],
   createRpcAccessSession:(_id,context,emit)=>new ThreadAccessSession(access,()=>serverId,context.actorContext,emit,undefined,()=>context.resourceOwner?.assertCurrent()),
   createTransport(id){if(id==='local-codex')return history;
     const listeners=new Set<(frame:string)=>void>();return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){const packet=JSON.parse(raw);if(packet.id===undefined)return;const result=packet.method==='initialize'?{}:await resources.request(packet.method,packet.params);for(const fn of listeners)fn(JSON.stringify({id:packet.id,result,__opencraftClient:packet.__opencraftClient}));}};
   }});
 let host=makeHost();
 const serverId='server:fixture:codex',port=createRoutedConversationExecution(()=>host,{machineId:'fixture',engines:[],getInputs:async()=>null});
 const creationAttempts=t.mock.method(port,'create',port.create.bind(port)),inputAttempts=t.mock.method(port,'add',port.add.bind(port));
 service=new Collaboration(db,actors,port,Date.now,()=>allowed,(context,ref)=>access.allows(ref.serverId,ref.threadId,context));
 if(queueAdmission)service.start();
 let hostClosed=false;cleanup.push(async()=>{await service.close();if(!hostClosed)await host.close();});
 const context={sender:{kind:'employee' as const,loginName:'synthetic'},actorContext:human,...(queueAdmission?{executionPrincipal:{provider:'fixture',subject:'employee'}}:{}),validUntil:human.expiresAt,resourceOwner:{id:'fixture',assertCurrent(){if(!allowed)throw Error('revoked');}}};
 const hostKey=ssh2.utils.generateKeyPairSync('ed25519'),userKey=ssh2.utils.generateKeyPairSync('ed25519');let gateway:any;
 const ingress=createSshHttpIngress({hostKey:hostKey.private,authorizedKeys:{legacy:[hostKey.public]},httpPort:1,codexPort:1,resolveAuthorizedKeys:(username:string)=>username==='synthetic'?[userKey.public]:[],authorizeSession:()=>({submissionContext:context,isCurrent:()=>allowed}),createNativeSession:async(authorization:any)=>gateway=await createSshNativeRpcGateway(host,authorization)});
 const address=await ingress.listen({port:0}),client=new ssh2.Client();client.on('error',()=>{});let ws:WebSocket|undefined;
 cleanup.push(async()=>{ws?.terminate();client.destroy();await ingress.close();await gateway?.close();});
 const ready=once(client,'ready');client.connect({host:'127.0.0.1',port:address.port,username:'synthetic',privateKey:userKey.private});await ready;
 const channel=await new Promise<any>((resolve,reject)=>client.exec('codex app-server proxy',(error,stream)=>error?reject(error):resolve(stream)));channel.on('error',()=>{});
 ws=new WebSocket('ws://127.0.0.1/rpc',{createConnection:()=>channel});ws.on('error',()=>{});await once(ws,'open');let seq=0;
 const rpc=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(Error('timeout '+method)),20000);const receive=(raw:any)=>{const frame=JSON.parse(String(raw));if(frame.id===id){clearTimeout(timer);ws!.off('message',receive);resolve(frame);}};ws!.on('message',receive);ws!.send(JSON.stringify({id,method,params}));});
 const initialized=await rpc('initialize',{clientInfo:{name:'isolated-options-test',version:'1'},capabilities:{experimentalApi:true}});assert.ok(initialized.result,JSON.stringify(initialized));
 const cli=async(args:string[])=>{
   const keyPath=join(root,'identity'),knownHosts=join(root,'known_hosts'),sshConfig=join(root,'ssh_config'),config=join(root,'connections.json');
   await writeFile(keyPath,userKey.private,{mode:0o600});await writeFile(knownHosts,`[127.0.0.1]:${address.port} ${hostKey.public}\n`);
   await writeFile(sshConfig,`Host isolated-options\n  HostName 127.0.0.1\n  Port ${address.port}\n  User synthetic\n  IdentityFile ${keyPath}\n  IdentitiesOnly yes\n  UserKnownHostsFile ${knownHosts}\n`);
   await writeFile(config,JSON.stringify({schemaVersion:1,connections:{fixture:{sshAlias:'isolated-options',sshConfig,instanceId:'fixture'}}}));
   const previous=process.env.OPENCRAFT_CONFIG,execution=process.env.OPENCRAFT_THREAD_CLI_CONNECTION;process.env.OPENCRAFT_CONFIG=config;delete process.env.OPENCRAFT_THREAD_CLI_CONNECTION;
   try{return await run([...args,'--connection','fixture']) as any;}finally{if(previous===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=previous;if(execution===undefined)delete process.env.OPENCRAFT_THREAD_CLI_CONNECTION;else process.env.OPENCRAFT_THREAD_CLI_CONNECTION=execution;}
 };
 const body={action:'create',serverId,projectId:project.id,cwd:repo,content:'synthetic first input',idempotencyKey:'initial',...(omitPermission?{}:{initialOptions:{permissionMode:'accept-edits'}}),...(explicitSettings?{settings:{model:'gpt-6.1-sol',reasoningEffort:'medium'}}:{})};
 const createArgs=['thread','create','synthetic first input','--server',serverId,'--project',project.id,'--cwd',repo,'--key','initial',...(omitPermission?[]:['--permission-mode','accept-edits']),...(explicitSettings?['--model','gpt-6.1-sol','--reasoning-effort','medium']:[])];
 const created=queueAdmission?{result:await cli([...createArgs,'--wait','delivered','--timeout','20s'])}:await rpc('opencraft/collaboration',body);assert.ok(created.result,JSON.stringify(created.error));const operation=created.result;
 assert.equal(operation.creationState,'created');if(omitPermission){assert.equal(operation.requestedInitialOptions,undefined);assert.equal(operation.nativeInitialObservation,undefined);const saved=db.database.prepare('SELECT fingerprint,settings_json FROM actor_conversation_creations').get()!;assert.equal(saved.fingerprint,createHash('sha256').update(JSON.stringify(['create',{serverId,projectId:project.id,cwd:repo},body.content])).digest('hex'));assert.equal(Object.hasOwn(JSON.parse(String(saved.settings_json)),'initialOptions'),false);}else{assert.equal(operation.requestedInitialOptions.permissionMode,'accept-edits');assert.equal(operation.nativeInitialObservation.permissionProfileId,':workspace');}
 assert.deepEqual((await rpc('opencraft/collaboration',body)).result.ref,operation.ref);
 assert.ok((await rpc('opencraft/collaboration',{...body,initialOptions:{permissionMode:'full'}})).error);
 if(queueAdmission) {
   const requestId=operation.firstMessage.requestId,inputId='actor-input:'+requestId,threadId=operation.ref.threadId;
   const deadline=Date.now()+20000;while(!nativeCompleted.has(threadId)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
   assert.ok(nativeCompleted.has(threadId),'original queued input completed');
   const starts=nativeStarts.filter(row=>row.params.threadId===threadId);assert.equal(starts.length,1);const actual=starts[0],turnId=actual.turnId;
   assert.equal(actual.params.clientUserMessageId,inputId);assert.equal(actual.params.input.length,1);assert.equal(actual.params.input[0].type,'text');assert.ok(actual.params.input[0].text.endsWith(body.content));
   assert.equal(actual.params.permissions,undefined,'ordinary queued input uses the Native Thread initial setting');
   const frozen=db.database.prepare('SELECT model,reasoning_effort FROM conversation_input_settings WHERE request_id=?').get(requestId);
   if(explicitSettings){
     assert.equal(frozen?.model,'gpt-6.1-sol');assert.equal(frozen.reasoning_effort,'medium');
     assert.equal(actual.params.model,'gpt-6.1-sol');assert.equal(actual.params.effort,'medium');
     const allocation=nativeAllocations.find(row=>row.threadId===threadId);assert.equal(allocation.params.model,'gpt-6.1-sol');assert.equal(allocation.params.config.model_reasoning_effort,'medium');
     assert.equal(allocation.params.permissions,':workspace');assert.equal(allocation.params.initialOptions,undefined);assert.equal(allocation.params.inputSettings,undefined);
     assert.deepEqual(operation.requestedSettings,{model:'gpt-6.1-sol',reasoningEffort:'medium'});assert.equal(operation.nativeConfirmedConfiguration.scope,'creation');assert.equal(operation.nativeInitialObservation.scope,'new-thread-subsequent');
   }else{assert.equal(frozen,undefined);assert.equal(actual.params.model,undefined);assert.equal(actual.params.effort,undefined);}

   const hostDb=new DatabaseSync(join(root,'adapter','opencraft-host-state.sqlite'),{readOnly:true});
   let queued:any,snapshot:any,lease:any;
   try {
     queued=hostDb.prepare('SELECT * FROM opencraft_host_queue WHERE thread_id=? AND client_id=?').get(threadId,inputId);
     snapshot=hostDb.prepare('SELECT * FROM execution_submissions WHERE thread_id=? AND input_id=?').get(threadId,inputId);
     lease=hostDb.prepare('SELECT * FROM execution_leases WHERE thread_id=? AND input_id=?').get(threadId,inputId);
     assert.equal(queued.state,'delivered');assert.equal(queued.target_turn_id,turnId);assert.deepEqual(JSON.parse(queued.input_json),actual.params.input);
     assert.equal(snapshot.ownership,'human');assert.equal(snapshot.admission,'accepted');assert.deepEqual(JSON.parse(snapshot.principal_json),context.executionPrincipal);
     assert.equal(lease.turn_id,turnId);
     assert.equal(hostDb.prepare('SELECT count(*) AS n FROM opencraft_host_queue').get()!.n,1);
   }finally{hostDb.close();}
   const request=db.database.prepare('SELECT * FROM actor_execution_requests WHERE id=?').get(requestId)!;
   assert.equal(request.thread_id,threadId);assert.equal(request.requester_id,human.actorId);assert.equal(request.state,'submitted');
   const inputMessages=db.database.prepare('SELECT m.id,m.author_id,m.content FROM actor_execution_inputs i JOIN actor_messages m ON m.id=i.message_id WHERE i.request_id=?').all(requestId);
   assert.equal(inputMessages.length,1);assert.equal(inputMessages[0].author_id,human.actorId);assert.equal(inputMessages[0].content,body.content);assert.ok(actual.params.input[0].text.includes(String(inputMessages[0].id)));
   const catalog=await cli(['thread','options',encodeConversationRef(operation.ref)]);assert.equal(catalog.optionCatalog.initialWrite.serviceTier,false);
   const paths=(await readdir(join(home,'sessions'),{recursive:true})).filter(path=>path.endsWith('.jsonl')&&path.includes(threadId));assert.equal(paths.length,1);
   const rollout=(await readFile(join(home,'sessions',paths[0]),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
   const sample=[...rollout].reverse().find(row=>row.type==='event_msg'&&row.payload?.type==='token_count'&&row.payload.info?.last_token_usage);
   assert.ok(sample,'official Native records token usage');
   const beforeReadStarts=nativeStarts.length,beforeReadRequests=localStubRequests;
   const contextUsage=await cli(['thread','context',encodeConversationRef(operation.ref)]);
   assert.equal(contextUsage.status,'observed',JSON.stringify(contextUsage));
   assert.equal(contextUsage.usedTokens,sample.payload.info.last_token_usage.total_tokens);
   assert.equal(contextUsage.contextWindow,sample.payload.info.model_context_window);
   assert.equal(contextUsage.recordedAt,sample.timestamp);
   assert.equal(JSON.stringify(contextUsage).includes(home),false);
   await assert.rejects(cli(['thread','commands',encodeConversationRef(operation.ref)]),(error:any)=>error.code==='UNSUPPORTED_CAPABILITY'&&error.details.engine==='codex');
   assert.equal(nativeStarts.length,beforeReadStarts);assert.equal(localStubRequests,beforeReadRequests,'observation makes no model request');
   const turnContext=rollout.find(row=>row.type==='turn_context'&&row.payload.turn_id===turnId)?.payload;
   assert.ok(turnContext,'actual Turn has Native persisted context');assert.equal(turnContext.approval_policy,'on-request');assert.equal(turnContext.sandbox_policy.type,omitPermission?'read-only':'workspace-write');
   // Joint B1/D2 contract: read the original queued Turn, preserving independent creation observations.
   const ref=encodeConversationRef(operation.ref);
   for(const selector of [['--delivery',requestId],['--delivery-key','initial'],['--turn',turnId]]) {
     const shown=await cli(['thread','show',ref,...selector,'--include-turn-configuration']);
     assert.equal(shown.actualTurnSettings??null,null,'observation never fills legacy actualTurnSettings');
     const observation=shown.turnConfigurationObservation;
     assert.equal(observation.status,'observed');assert.equal(observation.turnId,turnId);
     assert.equal(observation.scope,'turn-first-recorded-context');
     assert.equal(observation.model,turnContext.model);assert.equal(observation.reasoningEffort,turnContext.effort??null);
   }
   const independent=await cli(['thread','lookup','--server',serverId,'--key','initial']);
   if(omitPermission) {
     assert.equal(independent.operation.requestedInitialOptions,undefined);
     assert.equal(independent.operation.nativeInitialObservation,undefined);
   } else {
     assert.equal(independent.operation.requestedInitialOptions.permissionMode,'accept-edits');
     assert.equal(independent.operation.nativeInitialObservation.scope,'new-thread-subsequent');
   }
   if(explicitSettings)assert.equal(independent.operation.nativeConfirmedConfiguration.scope,'creation');
   console.info('queued-turn-context',JSON.stringify({turnId,approvalPolicy:turnContext.approval_policy,sandboxPolicy:turnContext.sandbox_policy}));
   const repeat=await cli(createArgs);assert.deepEqual(repeat.ref,operation.ref);assert.equal(repeat.firstMessage.requestId,requestId);
   const lookup=await cli(['thread','lookup','--server',serverId,'--key','initial']);assert.equal(lookup.operation.firstMessage.requestId,requestId);
   assert.equal(nativeAllocations.filter(row=>row.threadId===threadId).length,1);assert.equal(nativeStarts.filter(row=>row.params.threadId===threadId).length,1);
   assert.ok(nativeAllocations.filter(row=>row.threadId!==threadId).every(row=>row.params.ephemeral===true),'background title allocations are ephemeral, not repeated user creation');
   let subsequent:any=null;
   if(omitPermission){
     const reopened=await rpc('thread/resume',{threadId,excludeTurns:true});assert.ok(reopened.result,JSON.stringify(reopened.error));
     const sent=await cli(['thread','send',encodeConversationRef(operation.ref),'synthetic subsequent input','--key','subsequent','--wait','delivered','--timeout','20s']);
     const next=nativeStarts.find(row=>row.params.clientUserMessageId==='actor-input:'+sent.requestId);assert.ok(next);
     const end=Date.now()+15000;while(!nativeCompletedTurns.has(next.turnId)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(nativeCompletedTurns.has(next.turnId));
     const again=(await readFile(join(home,'sessions',paths[0]),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
     const actualContext=again.find(row=>row.type==='turn_context'&&row.payload.turn_id===next.turnId)?.payload;assert.ok(actualContext);
     subsequent={requestId:sent.requestId,inputId:'actor-input:'+sent.requestId,turnId:next.turnId,approvalPolicy:actualContext.approval_policy,sandboxPolicy:actualContext.sandbox_policy,profileAfterResume:reopened.result.activePermissionProfile?.id};
     console.info('default-readonly-subsequent-proof',JSON.stringify(subsequent));
     assert.equal(actualContext.approval_policy,'on-request');assert.equal(actualContext.sandbox_policy.type,'read-only');
     assert.equal(next.params.permissions,undefined,'queue does not rewrite permissions');
     assert.equal((await cli(['thread','send',encodeConversationRef(operation.ref),'synthetic subsequent input','--key','subsequent'])).requestId,sent.requestId);
     assert.equal(nativeStarts.filter(row=>row.params.clientUserMessageId==='actor-input:'+sent.requestId).length,1);
   }
   await host.close();hostClosed=true;
   const child=spawn(executable!,['app-server'],{cwd:repo,env:{...process.env,CODEX_HOME:home,HOME:home},stdio:['pipe','pipe','pipe']});
   const replies=new Map<any,any>();let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk.toString();let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);try{const packet=JSON.parse(line);if(packet.id!==undefined)replies.set(packet.id,packet);}catch{}}});
   child.stderr.resume();let id=0;
   const read=async(method:string,params:any)=>{const key=++id;child.stdin.write(JSON.stringify({id:key,method,params})+'\n');const end=Date.now()+15000;while(!replies.has(key)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));const reply=replies.get(key);assert.ok(reply,'restart read response');assert.equal(reply.error,undefined,JSON.stringify(reply.error));return reply.result;};
   let resumed:any,resumedTurn:any;
   try {await read('initialize',{clientInfo:{name:'original-input-restart-proof',version:'1'},capabilities:{experimentalApi:true}});resumed=await read('thread/resume',{threadId,excludeTurns:true});const turns=await read('thread/turns/list',{threadId,limit:10,sortDirection:'desc',itemsView:'full'});resumedTurn=turns.data.find((turn:any)=>turn.id===turnId);assert.ok(resumedTurn,'original ACK Turn survives Native restart');assert.equal(resumedTurn.status,'completed');}
   finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await once(child,'exit');}}
   let restartedInput:any=null;
   if(omitPermission){
     adapter=makeAdapter();history=new ConversationHistoryTransport(adapter,new ConversationHistory(db.database,'local-codex'));host=makeHost();hostClosed=false;
     const sent=await cli(['thread','send',encodeConversationRef(operation.ref),'synthetic after restart','--key','after-restart','--wait','delivered','--timeout','20s']);
     const next=nativeStarts.find(row=>row.params.clientUserMessageId==='actor-input:'+sent.requestId);assert.ok(next);
     const end=Date.now()+15000;while(!nativeCompletedTurns.has(next.turnId)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(nativeCompletedTurns.has(next.turnId));
     const again=(await readFile(join(home,'sessions',paths[0]),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));const actualContext=again.find(row=>row.type==='turn_context'&&row.payload.turn_id===next.turnId)?.payload;assert.ok(actualContext);
     restartedInput={requestId:sent.requestId,inputId:'actor-input:'+sent.requestId,turnId:next.turnId,approvalPolicy:actualContext.approval_policy,sandboxPolicy:actualContext.sandbox_policy,nativeResumeProfile:resumed.activePermissionProfile?.id??null,nativeResumeSandbox:resumed.sandbox.type};
     console.info('default-readonly-restarted-original-queue-proof',JSON.stringify(restartedInput));
     assert.equal(actualContext.sandbox_policy.type,'read-only');assert.equal(actualContext.approval_policy,'on-request');assert.equal(next.params.permissions,undefined);
     assert.equal((await cli(['thread','send',encodeConversationRef(operation.ref),'synthetic after restart','--key','after-restart'])).requestId,sent.requestId);
     assert.equal(nativeStarts.filter(row=>row.params.clientUserMessageId==='actor-input:'+sent.requestId).length,1);
   }
   assert.equal(resumed.activePermissionProfile.id,omitPermission?':read-only':':workspace');assert.equal(resumed.approvalPolicy,'on-request');assert.equal(resumed.sandbox.type,omitPermission?'readOnly':'workspaceWrite');
   const recovered=await service.command(human,body) as any;assert.equal(recovered.firstMessage.requestId,requestId);assert.equal(recovered.ref.threadId,threadId);
   assert.equal(creationAttempts.mock.calls.length,1);assert.equal(inputAttempts.mock.calls.length,omitPermission?3:1);
   assert.equal(db.database.prepare('SELECT count(*) AS n FROM actor_conversation_creations').get()!.n,1);assert.equal(db.database.prepare('SELECT count(*) AS n FROM actor_execution_requests').get()!.n,omitPermission?3:1);
   const proof={omitPermission,subsequent,restartedInput,explicitSettings,serverSchemaVersion:db.database.prepare('SELECT max(version) AS v FROM schema_migrations').get()!.v,requestedModel:frozen?.model??null,requestedEffort:frozen?.reasoning_effort??null,nativeTurnModel:actual.params.model??null,nativeTurnEffort:actual.params.effort??null,nativeVersion:'0.162.1',scope:'new-thread-subsequent',actorId:human.actorId,requestId,inputId,queueId:queued.id,threadId,turnId,hubState:request.state,hostState:queued.state,frozenOwnership:snapshot.ownership,frozenPrincipal:JSON.parse(snapshot.principal_json),leaseTurnId:lease.turn_id,turnContext:{approvalPolicy:turnContext.approval_policy,sandboxPolicy:turnContext.sandbox_policy},afterRestart:{permissionProfileId:resumed.activePermissionProfile.id,approvalPolicy:resumed.approvalPolicy,turnId:resumedTurn.id,turnStatus:resumedTurn.status},creationAttempts:creationAttempts.mock.calls.length,inputAttempts:inputAttempts.mock.calls.length,nativeThreadStartsForOriginal:1,nativeTurnStartsForOriginal:1,auxiliaryEphemeralAllocations:nativeAllocations.filter(row=>row.threadId!==threadId).length,inputMessageId:inputMessages[0].id,frozenInputSha256:createHash('sha256').update(queued.input_json).digest('hex'),nativeInputSha256:createHash('sha256').update(JSON.stringify(actual.params.input)).digest('hex'),localStubRequests,externalModelRequests:0,manualTurnStarts:0};
   console.info('original-input-positive-proof',JSON.stringify(proof));
   if(process.env.OPENCRAFT_OPTIONS_PROOF_OUTPUT)await writeFile(explicitSettings?process.env.OPENCRAFT_OPTIONS_PROOF_OUTPUT:process.env.OPENCRAFT_OPTIONS_PROOF_OUTPUT.replace(/\.json$/u,'-permission-only.json'),JSON.stringify(proof,null,2)+'\n');
   return;
 }
 // Allocate a local synthetic Turn so Native owns a persisted session, independent of input delivery.
 const fixtureContext={...context,sender:null};
 const turn=await callConversationHost(host,{hostId:'local-codex',threadId:operation.ref.threadId},'synthetic-turn','turn/start',{input:[{type:'text',text:'local synthetic persistence fixture'}],model:'gpt-6.1-sol',effort:'low'},fixtureContext);
 assert.ok(turn.turn.id);
 const deadline=Date.now()+20000;
 while(!nativeCompleted.has(operation.ref.threadId) && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
 assert.ok(nativeCompleted.has(operation.ref.threadId),'local synthetic Turn completed');assert.ok(localStubRequests>0);
 const options=await rpc('opencraft/collaboration',{action:'options',reference:operation.ref});assert.ok(options.result,JSON.stringify(options.error));
 assert.ok(options.result.optionCatalog.permissionModes.values.some((row:any)=>row.mode==='accept-edits'&&row.allowed));assert.equal(options.result.optionCatalog.initialWrite.serviceTier,false);assert.equal(options.result.actualTurnSettings,null);
 // The negative fixture retains its known creation and separate rejected input.
 await assert.rejects(cli(createArgs),
   (error:any)=>error.code==='CREATION_REJECTED' && error.details.operation.ref.threadId===operation.ref.threadId && error.details.operation.requestedInitialOptions.permissionMode==='accept-edits');
 const cliOptions=await cli(['thread','options',encodeConversationRef(operation.ref)]);
 assert.equal(cliOptions.optionCatalog.initialWrite.permissionMode,true);
 const negative=service.lookupCreation(human,serverId,'initial');assert.ok(negative.found);
 if(negative.found){
   assert.equal(negative.operation.firstMessage!.deliveryState,'rejected');
   const proof={nativeVersion:'0.162.1',requestId:operation.firstMessage.requestId,inputId:'actor-input:'+operation.firstMessage.requestId,threadId:operation.ref.threadId,creationState:negative.operation.creationState,firstInputDelivery:negative.operation.firstMessage!.deliveryState,originalNativeTurnStarts:nativeStarts.filter(row=>row.params.clientUserMessageId==='actor-input:'+operation.firstMessage.requestId).length,alternateManualTurnId:turn.turn.id,alternateIsOriginal:false,localStubRequests,externalModelRequests:0};
   assert.equal(proof.originalNativeTurnStarts,0);console.info('original-input-negative-proof',JSON.stringify(proof));
   if(process.env.OPENCRAFT_OPTIONS_PROOF_OUTPUT)await writeFile(process.env.OPENCRAFT_OPTIONS_PROOF_OUTPUT.replace(/\.json$/u,'-negative.json'),JSON.stringify(proof,null,2)+'\n');
 }
 console.info('native-options-proof',JSON.stringify({nativeVersion:'0.162.1',externalModelRequests:0,localStubRequests,creationState:operation.creationState,firstMessageState:operation.firstMessageState,scope:options.result.optionCatalog.scope}));
 actors.setEnabled(human.actorId,false,'fixture');assert.ok((await rpc('opencraft/collaboration',{action:'options',reference:operation.ref})).error);
});
