import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { ThreadAccessStore, ThreadAccessSession } from '../../packages/access-control/src/thread-access';
import { openServerDatabase } from '../../packages/storage-node/src/server/index';
import { createConversation } from '../../apps/opencraft-cli/src/create';
import {resolveProject} from '../../apps/opencraft-cli/src/projects';
import { run } from '../../apps/opencraft-cli/src/main';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { COLLABORATION_CAPABILITIES } from '@opencraft/appserver-protocol/collaboration';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { prepareConversationCreation, createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';
import { CliSshTransport } from '../../apps/opencraft-cli/src/ssh';
import { LocalHostResources } from '../../apps/local-agent-host/src/host-resources';
import { ProjectRepository } from '../../apps/local-agent-host/src/project-repository';
import { AppHostServer } from '../../packages/app-host-server/src/index';

async function fixture(t: any) {
  const root=await mkdtemp(join(tmpdir(),'cli-create-'));
  let owner=await openServerDatabase(root), actors=new ActorStore(owner);
  const human=actors.resolveHuman({provider:'local',subject:'one',displayName:'One',expiresAt:Date.now()+60000})!;
  const other=actors.resolveHuman({provider:'local',subject:'two',displayName:'Two',expiresAt:Date.now()+60000})!;
  let access=new ThreadAccessStore(join(root,'access.sqlite'),actors);
  let count=0, inputs=0, admitted=true, failCreate=false, failFirst=false;
  const observations:any[]=[];
  const receipts=new Map<string,any>();
  const port: ConversationExecutionPort={serverId:'server',hostId:'host',
    directory:()=>({instanceId:'instance',servers:[{serverId:'server',engine:'codex',label:'Codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,create:true,initialPermissionMode:true}}]}),
    async prepareCreate(target,context) { observations.push({phase:'prepare',...context.controlObservation}); context.resourceOwner!.assertCurrent(); if(target.projectId!=='project' || target.cwd!=='/repo') throw Object.assign(Error('invalid_cwd'),{status:400}); return {cwd:'/repo',runtimeWorkspaceRoots:['/repo']}; },
    async create(_target,_settings,context) { observations.push({phase:'create',...context.controlObservation}); context.resourceOwner!.assertCurrent(); count++; if(failCreate) throw Error('lost native response'); const id='thread-'+count; access.created('server',id,context.actorContext); if(failFirst) access.set('server',id,'private',1,context.actorContext),admitted=false; return {threadId:id,nativeInitialObservation:{source:'native/thread/start' as const,observedAt:Date.now(),scope:'new-thread-subsequent' as const,permissionProfileId:':workspace',approvalPolicy:'on-request' as const}}; },
    async validate(){}, async receipt(_binding,id){return receipts.get(id)??null;},
    async add(_binding,id){inputs++; const receipt={id:'queue-'+id,state:'delivered',targetTurnId:'turn'};receipts.set(id,receipt);return receipt;},
    async steer(){},async cancel(){return false;},
  };
  let service: Collaboration;
  const reopen=async(hard=false)=>{if(service) await service.close(); if(hard){access.close();actors.close();await owner.close();owner=await openServerDatabase(root);actors=new ActorStore(owner);access=new ThreadAccessStore(join(root,'access.sqlite'),actors);} service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(context,ref)=>access.allows(ref.serverId,ref.threadId,context));return service;};
  await reopen();
  const body={serverId:'server',projectId:'project',cwd:'/repo',content:'first synthetic input',idempotencyKey:'key'};
  t.after(async()=>{await service.close();access.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
  return {root,observations,get owner(){return owner;},get actors(){return actors;},human,other,get access(){return access;},port,body,reopen,get service(){return service;},get counts(){return {count,inputs};},set admitted(v:boolean){admitted=v;},set failCreate(v:boolean){failCreate=v;},set failFirst(v:boolean){failFirst=v;}};
}
test('create is Actor/key scoped, persists one thread and first input through concurrency and restart',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:8},()=>f.service.createConversation(f.human,f.body)));
  const created=results.find(r=>r.ref)!;
  assert.equal(created.creationState,'created');assert.equal(created.firstMessageState,'accepted');assert.equal(created.taskOutcome,'unknown');
  assert.equal(f.access.read('server',created.ref!.threadId).creatorActorId,f.human.actorId);
  assert.equal(f.counts.count,1);
  assert.deepEqual(f.observations.filter(e=>e.phase==='create'),[{phase:'create',traceId:created.operationId,control:'create'}]);
  await f.service.pump();await f.service.pump();assert.equal(f.counts.inputs,1);
  await f.reopen(true);
  const replay=await f.service.createConversation(f.human,f.body);assert.deepEqual(replay.ref,created.ref);
  assert.equal(replay.firstMessage!.deliveryState,'submitted');
  for(const patch of [{content:'changed'},{cwd:'/other'},{projectId:'other'},{serverId:'other'}]) {
    if('serverId' in patch) f.port.owns=()=>true;
    await assert.rejects(f.service.createConversation(f.human,{...f.body,...patch}),/idempotency_key_reused/);
  }
  assert.equal(f.service.lookupCreation(f.other,'server','key').found,false);
  const before=f.counts; for(let i=0;i<3;i++) f.service.lookupCreation(f.human,'server','key');assert.deepEqual(f.counts,before);
  assert.equal(JSON.stringify(f.service.lookupCreation(f.human,'server','key')).includes(f.body.content),false);
  f.access.set('server',created.ref!.threadId,'private',1,f.human);
  assert.throws(()=>f.service.sendConversation(f.other,{reference:created.ref,content:'x',idempotencyKey:'other'}),/conversation_action_denied/);
});
test('lost native response and interrupted first admission remain unknown without replay',async t=>{
  const f=await fixture(t);f.failCreate=true;
  const result=await f.service.createConversation(f.human,f.body);assert.equal(result.creationState,'unknown');assert.equal(result.ref,null);
  await f.reopen(true);await f.service.createConversation(f.human,f.body);f.service.lookupCreation(f.human,'server','key');assert.deepEqual(f.counts,{count:1,inputs:0});
  // Simulate a crash after saving the only threadId, before first send commits.
  f.owner.database.prepare("UPDATE actor_conversation_creations SET creation_state='created',thread_id='known-thread' WHERE idempotency_key='key'").run();
  await f.reopen(true);const lookup=f.service.lookupCreation(f.human,'server','key');assert.ok(lookup.found);if(lookup.found){assert.equal(lookup.operation.ref!.threadId,'known-thread');assert.equal(lookup.operation.firstMessageState,'unknown');}
  await f.service.createConversation(f.human,f.body);assert.deepEqual(f.counts,{count:1,inputs:0});
});
test('denies stale/unadmitted Actor and bad workspace before native creation; send failure retains created thread',async t=>{
  const f=await fixture(t);
  f.admitted=false;await assert.rejects(f.service.createConversation(f.human,f.body),/actor_authentication_required/);f.admitted=true;
  await assert.rejects(f.service.createConversation({...f.human,generation:f.human.generation+1},f.body),/actor_authentication_required/);
  await assert.rejects(f.service.createConversation(f.human,{...f.body,cwd:'relative'}),/absolute_cwd_required/);
  await assert.rejects(f.service.createConversation(f.human,{...f.body,cwd:'/missing'}),/invalid_cwd/);assert.equal(f.counts.count,0);
  f.failFirst=true;await assert.rejects(f.service.createConversation(f.human,f.body));f.admitted=true;
  const lookup=f.service.lookupCreation(f.human,'server','key');assert.ok(lookup.found);if(lookup.found){assert.equal(lookup.operation.creationState,'created');assert.ok(lookup.operation.ref);assert.equal(lookup.operation.firstMessageState,'rejected');}
  assert.equal(f.counts.count,1);
});
test('workspace uses Server project catalog and canonical directories, rejects file/missing/outside symlink',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cli-cwd-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'repo'));await mkdir(join(root,'outside'));await symlink(join(root,'outside'),join(root,'repo','escape'));await writeFile(join(root,'repo','file'),'x');
  const invoke=async()=>({data:[{id:'project',roots:[{path:join(root,'repo')}]}],nextCursor:null});
  const target={serverId:'server',projectId:'project',cwd:join(root,'repo')};
  assert.equal((await prepareConversationCreation(invoke,target)).cwd,target.cwd);
  for(const cwd of [join(root,'missing'),join(root,'repo','file'),join(root,'repo','escape')]) await assert.rejects(prepareConversationCreation(invoke,{...target,cwd}));
  await assert.rejects(prepareConversationCreation(invoke,{...target,projectId:'absent'}));
});
test('protocol negotiates independent capabilities; lost responses use only lookup, delivered is not task completion',async t=>{
  const f=await fixture(t);
  let mutations=0,drop=false;
  const transport=new MemoryTransport({server:{async receive(raw,peer){const packet=JSON.parse(raw);if(packet.method==='initialize') peer.send(JSON.stringify({id:packet.id,result:{capabilities:{extensions:{'opencraft/collaboration':COLLABORATION_CAPABILITIES}}}}));
    else if(packet.method==='opencraft/collaboration') {if(packet.params.action==='create')mutations++;const result=await f.service.command(f.human,packet.params);if(drop && packet.params.action==='create') peer.close('lost response');else peer.send(JSON.stringify({id:packet.id,result}));}}}});
  const client=new CollaborationClient(transport);await client.connect();t.after(()=>client.close());
  const input={content:f.body.content,operationKey:'key',generated:false,timeoutMs:null};
  const created=await createConversation(client,{serverId:'server',projectId:'project',cwd:'/repo'},input,'https://example.invalid/');assert.ok(created.uiLink?.includes('conversation='));
  await f.service.pump();await f.service.pump();
  const delivered=await createConversation(client,{serverId:'server',projectId:'project',cwd:'/repo'},{...input,timeoutMs:100});assert.equal(delivered.firstMessage!.deliveryState,'submitted');assert.equal(delivered.taskOutcome,'unknown');
  const lookup=await client.lookupCreation('server','key');assert.ok(lookup.found);assert.equal(f.counts.count,1);
  // A transport loss after committing the operation does not make the CLI retry.
  drop=true;await assert.rejects(createConversation(client,{serverId:'server',projectId:'project',cwd:'/repo'},{...input,operationKey:'lost'}),(e:any)=>e.exitCode===7&&e.details.operationKey==='lost');
  assert.equal(mutations,3);assert.equal(f.service.lookupCreation(f.human,'server','lost').found,true);
});
test('old service and unsupported engines fail before mutation; CLI create requires explicit target and key',async()=>{
  let mutations=0;
  const transport=new MemoryTransport({server:{async receive(raw,peer){const packet=JSON.parse(raw);if(packet.method==='initialize') peer.send(JSON.stringify({id:packet.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,queue:true}}}}}));else if(packet.id)mutations++;}}});
  const client=new CollaborationClient(transport);await client.connect();
  await assert.rejects(createConversation(client,{serverId:'server',projectId:'project',cwd:'/repo'},{content:'x',operationKey:'k',generated:false,timeoutMs:null}),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(mutations,0);await client.close();
  for(const options of [[],['--server','s'],['--server','s','--project','p','--cwd','/repo']]) await assert.rejects(run(['thread','create','text',...options]),/Create needs/);
  await assert.rejects(run(['thread','create','text','--server','s','--project','p','--cwd','relative','--key','k']),/absolute/);
});

test('Headless native create preserves trusted Actor/product context and UI access ownership without a parent',async t=>{
  const f=await fixture(t);const repo=join(f.root,'repo');await mkdir(repo);
  const directory=join(f.root,'projects');
  const {project}=await new ProjectRepository(directory).create({name:'Existing project',roots:[{path:repo}],idempotencyKey:'seed'});
  const resources=new LocalHostResources({projectDirectory:directory});
  let nativeCreates=0,modeAllowed=true,readOnlyAllowed=true,missingReadOnly=false;let unsupportedMethod:string|null=null,requirements:any=null;const seen:any[]=[];
  const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',
    createRpcAccessSession:(_hostId,context,emit)=>new ThreadAccessSession(f.access,()=>`server:machine:codex`,context.actorContext,emit,undefined,()=>context.resourceOwner?.assertCurrent()),
    createTransport(hostId){
      const listeners=new Set<(frame:string)=>void>();
      return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},
        async send(raw:string){return this.sendWithContext(raw,{sender:null});},
        async sendWithContext(raw:string,context:any){const packet=JSON.parse(raw);if(packet.id===undefined)return;seen.push({packet,context});let result:any={};
          if(packet.method==='project/list'){assert.equal(hostId,'opencraft-server','Codex native does not own the product project catalog');result=await resources.request(packet.method,packet.params);}
          if(packet.method===unsupportedMethod){for(const listener of listeners)listener(JSON.stringify({id:packet.id,error:{code:-32601,message:'Method not found'},...(packet.__opencraftClient?{__opencraftClient:packet.__opencraftClient}:{})}));return;}
          if(packet.method==='configRequirements/read')result={requirements};
          if(packet.method==='permissionProfile/list')result={data:[...(missingReadOnly?[]:[{id:':read-only',allowed:readOnlyAllowed}]),{id:':danger-full-access',allowed:true},{id:'opencraft:permission-mode:accept-edits',openCraftNativeProfileId:':workspace',openCraftMode:'accept-edits',allowed:modeAllowed}],nextCursor:null};
          if(packet.method==='thread/start'){assert.equal(hostId,'local-codex');nativeCreates++;result={thread:{id:'native-created'},activePermissionProfile:{id:packet.params.permissions ?? ':read-only'},approvalPolicy:packet.params.approvalPolicy};assert.equal(packet.params.projectId,undefined);assert.equal(packet.params.cwd,repo);assert.equal(packet.params.parentThreadId,undefined);}
          for(const listener of listeners)listener(JSON.stringify({id:packet.id,result,...(packet.__opencraftClient?{__opencraftClient:packet.__opencraftClient}:{})}));
        }};
    }});
  t.after(()=>host.close());
  const port=createRoutedConversationExecution(()=>host,{machineId:'machine',engines:['pi'],getInputs:async()=>null});
  const target={serverId:'server:machine:codex',projectId:project.id,cwd:repo};
  const context={sender:{kind:'employee' as const,loginName:'synthetic'},actorContext:f.human,executionPrincipal:{provider:'local',subject:'one'},validUntil:f.human.expiresAt,resourceOwner:{id:'synthetic',assertCurrent(){}}};
  const settings=await port.prepareCreate(target,context);const created=await port.create(target,settings,context);
  assert.equal(created.threadId,'native-created');assert.equal(nativeCreates,1);
  assert.equal(f.access.read(target.serverId,created.threadId).creatorActorId,f.human.actorId);
  const forwarded=seen.find(row=>row.packet.method==='thread/start').context;
  assert.deepEqual(forwarded.executionPrincipal,context.executionPrincipal);assert.equal(forwarded.actorContext.actorId,f.human.actorId);assert.deepEqual(forwarded.sender,context.sender);
  const unsupported={...target,serverId:'server:machine:pi'};
  await assert.rejects(port.prepareCreate(unsupported,context));assert.equal(nativeCreates,1);
  assert.equal(Object.hasOwn(settings,'initialOptions'),false);assert.equal(created.nativeInitialObservation,undefined,'effective default is not a requested initial observation');
  readOnlyAllowed=false;await assert.rejects(port.prepareCreate(target,context),{code:'permission_mode_disallowed'});await assert.rejects(port.create(target,settings,context),{code:'permission_mode_disallowed'});readOnlyAllowed=true;
  requirements={allowedSandboxModes:['workspace-write']};await assert.rejects(port.prepareCreate(target,context),{code:'permission_mode_disallowed'});requirements=null;
  requirements={allowedApprovalPolicies:['never']};await assert.rejects(port.create(target,settings,context),{code:'permission_mode_disallowed'});requirements=null;
  requirements={allowedPermissionProfiles:{':read-only':false}};await assert.rejects(port.create(target,settings,context),{code:'permission_mode_disallowed'});requirements=null;
  for(const method of ['permissionProfile/list','configRequirements/read']){unsupportedMethod=method;await assert.rejects(port.prepareCreate(target,context),{code:'unsupported_permission_mode'});await assert.rejects(port.create(target,settings,context),{code:'unsupported_permission_mode'});}unsupportedMethod=null;
  missingReadOnly=true;await assert.rejects(port.prepareCreate(target,context),{code:'unsupported_permission_mode'});await assert.rejects(port.create(target,settings,context),{code:'unsupported_permission_mode'});missingReadOnly=false;
  assert.equal(nativeCreates,1,'managed denial and old/unknown Host never fall back to a Native allocation');
  const explicit={...target,initialOptions:{permissionMode:'accept-edits' as const}};
  const prepared=await port.prepareCreate(explicit,context);
  modeAllowed=false;await assert.rejects(port.create(explicit,prepared,context),{code:'permission_mode_disallowed'});assert.equal(nativeCreates,1);
  modeAllowed=true;const chosen=await port.create(explicit,prepared,context);assert.equal(chosen.nativeInitialObservation.permissionProfileId,':workspace');assert.equal(nativeCreates,2);
  const calls=seen.filter(row=>row.packet.method==='thread/start');assert.equal(calls[0].packet.params.permissions,':read-only');assert.equal(calls[0].packet.params.sandbox,undefined);assert.equal(calls[0].packet.params.approvalPolicy,'on-request');
  assert.equal(calls[1].packet.params.permissions,':workspace');assert.equal(calls[1].packet.params.initialOptions,undefined);
  const full={...target,initialOptions:{permissionMode:'full' as const}},fullSettings=await port.prepareCreate(full,context);await port.create(full,fullSettings,context);assert.equal(nativeCreates,3);
  const fullCall=seen.filter(row=>row.packet.method==='thread/start').at(-1);assert.equal(fullCall.packet.params.permissions,':danger-full-access');assert.equal(fullCall.packet.params.approvalPolicy,'never');
  await rm(repo,{recursive:true});await assert.rejects(port.create(target,settings,context));assert.equal(nativeCreates,3);await mkdir(repo);
  context.resourceOwner.assertCurrent=()=>{throw Error('revoked');};await assert.rejects(port.create(target,settings,context));await assert.rejects(port.create(explicit,prepared,context));assert.equal(nativeCreates,3);
});

test('wait returns delivery learned by the last lookup and preserves partial success on rejection',async()=>{
  const operation:any={operationId:'id',operationKey:'key',serverId:'server',projectId:'project',cwd:'/repo',creationState:'created',ref:{serverId:'server',threadId:'t'},reference:'ref',firstMessageState:'accepted',firstMessage:{deliveryState:'queued'},taskOutcome:'unknown'};
  let mutations=0,reads=0;
  const client={require(){},async create(){mutations++;return operation;},async lookupCreation(){reads++;return {found:true,operation:{...operation,firstMessage:{deliveryState:'submitted'}}};}} as unknown as CollaborationClient;
  const input={content:'x',operationKey:'key',generated:false,timeoutMs:50};
  const delivered=await createConversation(client,{serverId:'server',projectId:'project',cwd:'/repo'},input);assert.equal(delivered.firstMessage!.deliveryState,'submitted');assert.equal(mutations,1);assert.equal(reads,1);
  const rejected={...client,require(){},async create(){return {...operation,firstMessageState:'rejected'};}} as unknown as CollaborationClient;
  await assert.rejects(createConversation(rejected,{serverId:'server',projectId:'project',cwd:'/repo'},input),(e:any)=>e.exitCode===8&&e.details.operation.ref.threadId==='t');
});

test('run keeps the CLI transport open until creation and delivered wait complete',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cli-create-run-'));const old=process.env.OPENCRAFT_CONFIG;
  const config=join(root,'connections.json');process.env.OPENCRAFT_CONFIG=config;
  await writeFile(config,JSON.stringify({schemaVersion:1,defaultConnection:'fixture',connections:{fixture:{sshAlias:'synthetic',instanceId:'instance',webUrl:'https://example.test/base/'}}}));
  t.after(async()=>{if(old===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=old;await rm(root,{recursive:true,force:true});});
  const listeners=new Set<(frame:string)=>void>();let closed=false,creates=0,reads=0,ambiguous=false;
  const serverId='server:21b6b553-92d1-460d-baf1-956779315d55:codex';
  const operation:any={operationId:'operation',operationKey:'key',serverId,projectId:'project',cwd:'/repo',creationState:'created',ref:{serverId,threadId:'created'},reference:'unused-display-reference',firstMessageState:'accepted',firstMessage:{deliveryState:'queued'},taskOutcome:'unknown'};
  t.mock.getter(CliSshTransport.prototype,'status',()=>({state:closed?'closed':'open'}));
  t.mock.method(CliSshTransport.prototype,'connect',async()=>{});
  t.mock.method(CliSshTransport.prototype,'subscribeMessage',(listener:any)=>{listeners.add(listener);return()=>listeners.delete(listener);});
  t.mock.method(CliSshTransport.prototype,'subscribeStatus',()=>()=>{});
  t.mock.method(CliSshTransport.prototype,'close',async()=>{closed=true;});
  t.mock.method(CliSshTransport.prototype,'send',async(raw:string)=>{
    const packet=JSON.parse(raw);if(packet.id===undefined)return;
    let result:any;
    if(packet.method==='initialize')result={capabilities:{extensions:{'opencraft/collaboration':COLLABORATION_CAPABILITIES}}};
    else if(packet.params.action==='servers')result={instanceId:'instance',actor:{id:'human',kind:'human',generation:1},servers:[{serverId,engine:'codex',capabilities:{create:true,projectDiscovery:true}}]};
    else if(packet.params.action==='projects'){assert.equal(packet.params.serverId,serverId);result={supported:true,source:'host',observedAt:0,serverId,projects:[{id:'project',name:'data',roots:[]},...(ambiguous?[{id:'other',name:'data',roots:[]}]:[])],nextCursor:null};}
    else if(packet.params.action==='create'){assert.equal(packet.params.projectId,'project');creates++;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false,'run must await the mutation before finally closes transport');result=operation;}
    else if(packet.params.action==='createLookup'){reads++;await new Promise(resolve=>setTimeout(resolve,10));assert.equal(closed,false);result=packet.params.idempotencyKey==='missing'?{found:false,serverId,operationKey:'missing',creationState:'unknown',taskOutcome:'unknown'}:{found:true,operation:{...operation,ref:packet.params.idempotencyKey==='unknown-ref'?null:operation.ref,firstMessage:{deliveryState:'submitted'}}};}
    else if(packet.params.action==='metadata'){assert.deepEqual(packet.params.reference,operation.ref);result={ref:operation.ref,attention:null};}
    for(const listener of listeners)listener(JSON.stringify({id:packet.id,result}));
  });
  const result=await run(['thread','create','first','--server',serverId,'--project','data','--cwd','/repo','--key','key','--wait','delivered','--timeout','1s']);
  assert.equal((result as any).firstMessage.deliveryState,'submitted');assert.equal(closed,true);assert.equal(creates,1);assert.equal(reads,1);
  const link=(result as any).uiLink;assert.ok(link);
  closed=false;const shown=await run(['thread','show',link]) as any;assert.deepEqual(shown.ref,operation.ref);
  for(const key of ['key','missing','unknown-ref']){closed=false;const lookup=await run(['thread','lookup','--server',serverId,'--key',key]) as any;assert.equal(lookup.uiLink,key==='key'?link:null);if(lookup.found)assert.equal(lookup.operation.uiLink,lookup.uiLink);}
  assert.equal(creates,1,'all lookup/show calls remain read-only');
  closed=false;ambiguous=true;await assert.rejects(run(['thread','create','first','--server',serverId,'--project','data','--cwd','/repo','--key','ambiguous']),{code:'AMBIGUOUS_PROJECT'});assert.equal(creates,1);
  closed=false;await assert.rejects(run(['thread','show',link,'--server','another-server']),{code:'UNKNOWN_SERVER'});
});

test('create and uncertain receipts use the shared UI link and resolve the complete Server in the website',async()=>{
  const {creationLink}=await import('../../apps/opencraft-cli/src/create');
  const {conversationUiLink}=await import('../../apps/opencraft-cli/src/main');
  const {parseConversationRef}=await import('../../packages/appserver-protocol/src/collaboration');
  const {resolveConversationReferenceNavigation}=await import('../../apps/workbench-web/src/runtime/conversation-reference-navigation');
  const ref={serverId:'server:21b6b553-92d1-460d-baf1-956779315d55:codex',threadId:'thread/中文?#&'};
  const operation:any={operationId:'op',operationKey:'key',serverId:ref.serverId,projectId:'project',cwd:'/repo',creationState:'created',ref,reference:'ref',firstMessageState:'accepted',firstMessage:{deliveryState:'accepted'},taskOutcome:'unknown'};
  const webUrl='https://example.test/base/path/';
  const result=creationLink(operation,webUrl);assert.equal(result.uiLink,conversationUiLink(webUrl,ref));
  assert.deepEqual(parseConversationRef(result.uiLink!),ref);assert.equal(new URL(result.uiLink!).pathname,'/base/path/');
  for(const host of ['local','ssh:remote/员工']){
    const location=await resolveConversationReferenceNavigation(parseConversationRef(result.uiLink!)!,['wrong',host],async(id,method,params)=>{
      if(method==='opencraft/collaboration')return {ref:id===host?ref:{...ref,serverId:'another-server'}};
      assert.equal((params as any).includeTurns,false);return {thread:{id:ref.threadId}};
    });assert.equal(location.key.hostId,host);assert.equal(location.key.threadId,ref.threadId);
  }
  assert.equal(creationLink(operation).uiLink,null);assert.equal(creationLink({...operation,ref:null},webUrl).uiLink,null);
  const input={content:'first',operationKey:'key',generated:false,timeoutMs:null};
  for(const knownRef of [ref,null]){
    let mutations=0;const fake={require(){},async create(){mutations++;return {...operation,creationState:'unknown',firstMessageState:'unknown',ref:knownRef};}} as unknown as CollaborationClient;
    await assert.rejects(createConversation(fake,{serverId:ref.serverId,projectId:'project',cwd:'/repo'},input,webUrl),(e:any)=>{
      assert.equal(e.exitCode,7);assert.equal(e.details.operation.uiLink,conversationUiLink(webUrl,knownRef));return true;
    });assert.equal(mutations,1);
  }
});

test('create first input freezes once in its Native owner; restart/lookup/replay cannot relabel it',async t=>{
  const f=await fixture(t);
  const {OpenCraftHostStateDatabase}=await import('../../apps/opencraft-daemon/src/opencraft-host-state-database');
  const {ExecutionLeaseStore}=await import('../../apps/opencraft-daemon/src/execution-lease-store');
  const host=new OpenCraftHostStateDatabase(join(f.root,'native'));t.after(()=>host.close());
  const store=new ExecutionLeaseStore(host.database),snapshot={ownership:'human' as const,principal:{provider:'opaque',subject:'verified'}};
  let captures=0;
  const trusted={submission:{sender:null,actorContext:f.human,executionPrincipal:snapshot.principal},inputAdmission:{serverId:'server',capture(threadId:string,inputId:string){captures++;store.capture(threadId,inputId,snapshot,'accepted','queue');}}};
  const created=await f.service.command(f.human,{action:'create',...f.body},trusted) as any;
  const inputId='actor-input:'+created.firstMessage.requestId;
  assert.deepEqual(store.getSubmission(created.ref.threadId,inputId),snapshot);
  assert.equal(f.access.read('server',created.ref.threadId).creatorActorId,f.human.actorId);
  await f.reopen(true);
  const replay=await f.service.command(f.human,{action:'create',...f.body},{...trusted,inputAdmission:{serverId:'server',capture(){throw Error('must not recapture');}}}) as any;
  f.service.lookupCreation(f.human,'server','key');
  assert.deepEqual(replay.ref,created.ref);assert.equal(captures,1);
  assert.deepEqual(store.getSubmission(created.ref.threadId,inputId),snapshot);
  await assert.rejects(f.service.command(f.human,{action:'create',...f.body,content:'changed'},trusted),/idempotency_key_reused/);
  assert.equal(captures,1);
});

test('created thread survives first snapshot failure; lookup and duplicate do not repair or grant it',async t=>{
  const f=await fixture(t);let captures=0;
  const trusted={submission:{sender:null,actorContext:f.human},inputAdmission:{serverId:'server',capture(){captures++;throw Error('Native owner unavailable');}}};
  const created=await f.service.command(f.human,{action:'create',...f.body},trusted) as any;
  assert.equal(created.creationState,'created');assert.ok(created.ref);assert.equal(created.firstMessageState,'unknown');assert.equal(created.firstMessage,null);
  const recovered=await f.service.command(f.human,{action:'create',...f.body},{...trusted,inputAdmission:{serverId:'server',capture(){captures++;}}}) as any;
  assert.deepEqual(recovered.ref,created.ref);assert.equal(captures,1);assert.deepEqual(f.counts,{count:1,inputs:0});
  const lookup=f.service.lookupCreation(f.human,'server','key');assert.ok(lookup.found);assert.equal(captures,1);
  assert.equal(f.owner.database.prepare('SELECT count(*) AS n FROM actor_execution_requests').get()!.n,0);
});

test('unknown Native creation and preexisting creation inputs never acquire a new admission snapshot',async t=>{
  const f=await fixture(t);let captures=0;
  const trusted={submission:{sender:null,actorContext:f.human},inputAdmission:{serverId:'server',capture(){captures++;}}};
  f.failCreate=true;
  const unknown=await f.service.command(f.human,{action:'create',...f.body},trusted) as any;
  assert.equal(unknown.creationState,'unknown');assert.equal(unknown.ref,null);assert.equal(captures,0);
  f.failCreate=false;
  await f.service.command(f.human,{action:'create',...f.body},trusted);f.service.lookupCreation(f.human,'server','key');
  assert.equal(captures,0);assert.equal(f.counts.count,1);
  const oldBody={...f.body,idempotencyKey:'old-no-snapshot'};
  const old=await f.service.createConversation(f.human,oldBody);
  await f.service.command(f.human,{action:'create',...oldBody},trusted);
  assert.ok(old.ref);assert.equal(captures,0,'new ingress cannot backfill a historical accepted create');
});

for(const known of [false,true])test(`uncertain creation keeps observed ref without first admission or replay (known=${known})`,async t=>{
 const f=await fixture(t);let attempts=0;
 f.port.create=async()=>{attempts++;if(known)f.access.created('server','known-created',f.human);throw Object.assign(Error('post-ACK failure'),{status:400,...(known?{threadId:'known-created'}:{})});};
 const first=await f.service.createConversation(f.human,f.body);assert.equal(first.creationState,'unknown');assert.equal(first.ref?.threadId,known?'known-created':undefined);assert.equal(first.firstMessageState,'unknown');assert.equal(first.firstMessage,null);assert.equal(f.counts.inputs,0);
 await f.reopen(true);const lookup=f.service.lookupCreation(f.human,'server','key');assert.equal(lookup.found,true);
 const repeat=await f.service.createConversation(f.human,f.body);assert.deepEqual(repeat.ref,first.ref);assert.equal(attempts,1);assert.equal(f.counts.inputs,0);
});

test('Host root errors preserve only observed IDs and never turn generic RPC codes into rejection receipts',async t=>{
 const {callConversationHost}=await import('../../scripts/conversation-execution.mjs');
 for(const scenario of [{stage:'operation',data:{resultUnknown:true,threadId:'observed'}},{stage:'operation',data:{threadId:'unproven'}},{stage:'operation',data:{resultUnknown:true,threadId:'invalid id'}},{stage:'init',data:{resultUnknown:true,threadId:'wrong-operation'}}]){
  const host=new AppHostServer({physicalHostLifetime:'server',createTransport(){const listeners=new Set<(raw:string)=>void>();return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){const m=JSON.parse(raw);if(m.id===undefined)return;const failed=scenario.stage==='init'||m.id==='operation';for(const fn of listeners)fn(JSON.stringify({id:m.id,...(failed?{error:{code:-32600,message:'synthetic',data:scenario.data}}:{result:{}})}));}};}});t.after(()=>host.close());
  await assert.rejects(callConversationHost(host,{hostId:'local-codex'},'create','thread/start',{},undefined,1000),(e:any)=>{assert.equal(e.status,undefined);assert.equal(e.threadId,scenario.stage==='operation'&&scenario.data.threadId==='observed'?'observed':undefined);return true;});
 }
});

test('initial permission intent shares creation fingerprint and durable owner without replay or borrowed authority',async t=>{
 const f=await fixture(t),body={...f.body,initialOptions:{permissionMode:'accept-edits'}};
 const created=await f.service.createConversation(f.human,body);
 assert.deepEqual(created.requestedInitialOptions,body.initialOptions);assert.equal(created.nativeInitialObservation!.permissionProfileId,':workspace');
 const stored=JSON.parse(String(f.owner.database.prepare('SELECT settings_json FROM actor_conversation_creations').get()!.settings_json));assert.deepEqual(stored.initialOptions,body.initialOptions);assert.equal(stored.nativeInitialObservation.source,'native/thread/start');
 await f.reopen(true);assert.deepEqual((await f.service.createConversation(f.human,body)).nativeInitialObservation,created.nativeInitialObservation);
 await assert.rejects(f.service.createConversation(f.human,{...body,initialOptions:{permissionMode:'full'}}),/idempotency_key_reused/);
 await assert.rejects(f.service.createConversation(f.human,f.body),/idempotency_key_reused/);assert.equal(f.counts.count,1);
 f.admitted=false;await assert.rejects(f.service.createConversation(f.human,body));
});
test('unknown initial create remains unknown after restart and never revalidates or resends',async t=>{
 const f=await fixture(t);f.failCreate=true;const body={...f.body,initialOptions:{permissionMode:'accept-edits'}};
 assert.equal((await f.service.createConversation(f.human,body)).creationState,'unknown');await f.reopen(true);
 assert.equal((await f.service.createConversation(f.human,body)).nativeInitialObservation,null);assert.equal(f.counts.count,1);
 for(const value of [{permissionMode:'auto'},{permissionMode:'custom'},{permissionMode:['full']},{serviceTier:'priority'},{permissionMode:'full',arbitrary:1},{}]) await assert.rejects(f.service.createConversation(f.human,{...f.body,idempotencyKey:'different',initialOptions:value}));
 assert.equal(f.counts.count,1);
});
test('CLI refuses unsupported sticky tier and unmapped modes before opening a connection',async()=>{
 for(const [flag,value] of [['--service-tier','priority'],['--permission-mode','auto'],['--permission-mode','custom']]) await assert.rejects(run(['thread','create','synthetic','--server','s','--project','p','--cwd','/repo','--key','k',flag,value]),{exitCode:6});
});

test('old collaboration service cannot receive initial settings even when legacy create is supported',async()=>{
 let mutations=0;
 const client=new CollaborationClient(new MemoryTransport({server:{receive(raw,peer){const p=JSON.parse(raw);if(p.method!=='initialize')mutations++;peer.send(JSON.stringify({id:p.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,create:true,createLookup:true}}}}}));}}}));
 try {await client.connect();await assert.rejects(async()=>client.create({serverId:'server',projectId:'project',cwd:'/repo',initialOptions:{permissionMode:'full'}},'synthetic','key'),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(mutations,0);}finally{await client.close();}
});


test('show uses the persisted Host project association after CLI create and restart',async t=>{
  const f=await fixture(t);
  f.port.metadata=async ref=>({ref,projectId:null,cwd:'/repo',runtime:'idle',currentTurnId:null,recovery:null,attention:null,observedAt:Date.now()});
  const created=await f.service.createConversation(f.human,f.body);
  assert.equal((await f.service.metadata(f.human,created.ref)).projectId,'project');
  await f.reopen(true);
  assert.equal((await f.service.metadata(f.human,created.ref)).projectId,'project');
  assert.equal((await f.service.metadata(f.human,{serverId:'server',threadId:'outside'})).projectId,null);
  f.access.set('server',created.ref!.threadId,'private',1,f.human);
  await assert.rejects(f.service.metadata(f.other,created.ref),/conversation_action_denied/);
});

const project=(id:string,name:string)=>({id,name,roots:[]});
function catalog(pages: ReturnType<typeof project>[][]) {
 return async(cursor?:string)=>({supported:true,source:'host',observedAt:0,serverId:'selected',projects:pages[Number(cursor??0)]!,nextCursor:Number(cursor??0)+1<pages.length?String(Number(cursor??0)+1):null});
}
test('project selector accepts unique names across pages and gives exact ID precedence',async()=>{
 assert.equal(await resolveProject('data',catalog([[],[project('uuid','data')]])),'uuid');
 assert.equal(await resolveProject('data',catalog([[project('other','data')],[project('data','another')]])),'data');
 await assert.rejects(resolveProject('data',catalog([[project('a','data')],[project('b','data')]])),{code:'AMBIGUOUS_PROJECT'});
 await assert.rejects(resolveProject('DATA',catalog([[project('a','data')]])),{code:'UNKNOWN_PROJECT'});
 await assert.rejects(resolveProject('absent',async()=>({...await catalog([[]])(),nextCursor:'same'})),{code:'PROJECT_CATALOG_INCOMPLETE'});
});
