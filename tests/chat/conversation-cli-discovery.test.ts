import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration } from '../../packages/access-control/src/collaboration';
import { ThreadAccessStore } from '../../packages/access-control/src/thread-access';
import { openServerDatabase } from '../../packages/storage-node/src/server/index';
import { createRoutedConversationExecution, callConversationHost } from '../../scripts/conversation-execution.mjs';
import { readProjects, readModels, readOptions } from '../../scripts/conversation-discovery.mjs';
import { ModelPolicyStore } from '../../packages/model-usage-policy/src/index';
import { ModelPolicyTransport } from '../../packages/model-usage-policy/src/transport';
import { ConversationHistoryTransport } from '../../packages/app-host-server/src/conversation-history-transport';
import { ConversationHistory } from '../../packages/app-host-server/src/conversation-history';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { LocalHostResources } from '../../apps/local-agent-host/src/host-resources';
import { ProjectRepository } from '../../apps/local-agent-host/src/project-repository';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { COLLABORATION_CAPABILITIES } from '../../packages/appserver-protocol/src/collaboration';
import { run } from '../../apps/opencraft-cli/src/main';
import { CliSshTransport } from '../../apps/opencraft-cli/src/ssh';

const serverId='server:fixture:codex',ref={serverId,threadId:'synthetic-thread'};
const model=(name:string)=>({id:name,model:name,hidden:false,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],serviceTiers:[{id:'fast',description:'ignored'}],credentials:'SECRET',endpoint:'SECRET'});
async function fixture(t:any, wrapped=false) {
 const root=await mkdtemp(join(tmpdir(),'cli-discovery-'));const owner=await openServerDatabase(root),actors=new ActorStore(owner);
 const human=actors.resolveHuman({provider:'synthetic',subject:'one',displayName:'One',expiresAt:Date.now()+60000})!;
 const other=actors.resolveHuman({provider:'synthetic',subject:'two',displayName:'Two',expiresAt:Date.now()+60000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors),policy=new ModelPolicyStore(join(root,'policy.sqlite'));
 const projects=new ProjectRepository(join(root,'projects'));for(let i=0;i<32;i++){const path=join(root,'repo-'+i);await mkdir(path);await projects.create({name:'Project '+i,roots:[{path}],idempotencyKey:'p'+i});}
 const resources=new LocalHostResources({projectDirectory:join(root,'projects')});
 const blockNotifications:(()=>void)[]=[];let unblock=()=>{};const blocked=new Promise<void>(resolve=>unblock=resolve);let blockHistory=false;
 const methods:{host:string;method:string;params:any}[]=[];let fail=false,hang=false,admitted=true,release:(()=>void)|null=null,delay=false;
 const host=new AppHostServer({hostId:'hub',hostDefinitions:[{hostId:'local-codex',label:'Codex'},{hostId:'opencraft-server',label:'Resources'}],createTransport(hostId){
   const listeners=new Set<(frame:string)=>void>();
   const inner={status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},
    async send(raw:string){const packet=JSON.parse(raw);if(packet.id===undefined)return;methods.push({host:hostId,method:packet.method,params:packet.params});let result:any={};
      if(packet.method==='initialize')result={capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}};
      else if(packet.method==='project/list'){assert.equal(hostId,'opencraft-server');result=await resources.request(packet.method,packet.params);}
      else if(packet.method==='model/list'){assert.equal(hostId,'local-codex');if(hang)return;if(fail)throw Error('provider unavailable');if(delay)await new Promise<void>(resolve=>release=resolve);result=packet.params.cursor?{data:[model('page-two')],nextCursor:null}:{data:[model('allowed'),model('blocked'),{...model('hidden'),hidden:true}],nextCursor:'page-two'};}
      else if(packet.method==='thread/read'){assert.equal(hostId,'local-codex');assert.equal(packet.params.includeTurns,false);assert.equal(packet.params.sourceRead,wrapped?undefined:true);result={thread:{id:ref.threadId,model:'allowed',reasoningEffort:'medium',cwd:root,preview:'SECRET',turns:[{text:'SECRET'}]}};}
      else if(packet.method==='permissionProfile/list')result={data:[{id:':read-only',allowed:true},{id:'opencraft:permission-mode:accept-edits',openCraftMode:'accept-edits',openCraftNativeProfileId:':workspace',allowed:true}],nextCursor:null};
      else if(packet.method==='configRequirements/read'){assert.equal(packet.params.threadId,undefined,'Native requirements schema has no threadId');result={requirements:null};}
      else if(packet.method==='collaborationMode/list')result={data:[{mode:'plan',developerInstructions:'SECRET'},{mode:'default'}]};
      else throw Error('unexpected method '+packet.method);
      for(const listener of listeners)listener(JSON.stringify({id:packet.id,result,...(packet.__opencraftClient?{__opencraftClient:packet.__opencraftClient}:{})}));
    }};
   const policyTransport=hostId==='local-codex'?new ModelPolicyTransport(inner,join(root,'policy.sqlite')):inner;
   if (!wrapped) return policyTransport;
   const history=new ConversationHistory(owner.database,hostId);
   const importResult=history.importResult.bind(history),revision=history.revision.bind(history);
   (history as any).importResult=async(...args:any[])=>{if(blockHistory)await blocked;return importResult(...args as Parameters<typeof importResult>);};
   history.revision=(threadId:string)=>{assert.equal(blockHistory,false,'catalog controls must not consult history SQL revisions');return revision(threadId);};
   blockNotifications.push(()=>{for(const listener of listeners)listener(JSON.stringify({method:'thread/started',params:{thread:{id:'history-block-'+hostId,ephemeral:false,turns:[]}}}));});
   return new ConversationHistoryTransport(policyTransport,history);

 }});
 let readiness='ready';
 const port=createRoutedConversationExecution(()=>host,{machineId:'fixture',engines:['pi'],getInputs:async()=>null,getCodexReadiness:()=>readiness});
 const service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(context,r)=>access.allows(r.serverId,r.threadId,context));
 t.after(async()=>{unblock();release?.();await service.close();await host.close();policy.close();access.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
 return {set readiness(value:string){readiness=value;},root,host,owner,actors,blockHistory(){blockHistory=true;for(const emit of blockNotifications)emit();},unblockHistory(){blockHistory=false;unblock();},human,other,access,policy,port,service,methods,set hang(v:boolean){hang=v;},set fail(v:boolean){fail=v;},set admitted(v:boolean){admitted=v;},set delay(v:boolean){delay=v;},release(){release?.();}};
}
test('real AppHost separates Host project directory and policy-filtered Native catalog, with pages and no mutation',async t=>{
 const f=await fixture(t);f.policy.write(0,[{engine:'codex',model:'blocked'},{engine:'codex',model:'allowed',effort:'low'}],'synthetic');
 const projects=await f.service.command(f.human,{action:'projects',serverId}) as any;assert.equal(projects.projects.length,30);assert.ok(projects.nextCursor);const projectTail=await f.service.command(f.human,{action:'projects',serverId,cursor:projects.nextCursor}) as any;assert.equal(projectTail.projects.length,2);assert.equal(projectTail.nextCursor,null);assert.equal(projects.source,'host/project/list');
 const first=await f.service.command(f.human,{action:'models',serverId}) as any;assert.deepEqual(first.models,[{id:'allowed',model:'allowed',reasoningEfforts:['medium'],serviceTiers:['fast']}]);assert.equal(first.nextCursor,'page-two');
 const second=await f.service.command(f.human,{action:'models',serverId,cursor:first.nextCursor}) as any;assert.equal(second.models[0].id,'page-two');assert.equal(second.nextCursor,null);
 assert.equal(JSON.stringify(first).includes('SECRET'),false);assert.equal(first.supported,true);assert.ok(first.observedAt>0);
 assert.ok(f.methods.every(row=>['initialize','project/list','model/list','runtime/client/disconnect'].includes(row.method)));
 const count=f.methods.length;await assert.rejects(f.service.command(f.human,{action:'models',serverId:'server:other:codex'}));await assert.rejects(f.service.command(f.human,{action:'models',serverId:'server:fixture:pi'}));assert.equal(f.methods.length,count);
 assert.equal(f.owner.database.prepare('SELECT count(*) AS n FROM actor_execution_requests').get()!.n,0);
});
test('options are authorized twice, private resources stay private and configuration is not Turn telemetry',async t=>{
 const f=await fixture(t);f.access.created(serverId,ref.threadId,f.human);f.access.set(serverId,ref.threadId,'private',1,f.human);
 const count=f.methods.length;await assert.rejects(f.service.command(f.other,{action:'options',reference:ref}),{status:403});assert.equal(f.methods.length,count);
 const result=await f.service.command(f.human,{action:'options',reference:ref}) as any;
 assert.equal(result.nativeConfirmedConfiguration.model,'allowed');assert.equal(result.nativeConfirmedConfiguration.scope,'thread-current-or-last-persisted');assert.equal(result.modelCatalog.models[0].model,'allowed');assert.equal(result.modelCatalog.nextCursor,'page-two');assert.equal(result.actualTurnSettings,null);assert.deepEqual(result.permissionCeiling,{supported:false,value:null,source:'unknown'});assert.equal(JSON.stringify(result).includes('SECRET'),false);
 f.admitted=false;await assert.rejects(f.service.command(f.human,{action:'options',reference:ref}),{status:403});
});
test('catalog rechecks revocation after delayed provider response; failures never fall back to defaults',async t=>{
 const f=await fixture(t);f.delay=true;const pending=f.service.command(f.human,{action:'models',serverId});
 while(!f.methods.some(row=>row.method==='model/list'))await new Promise(resolve=>setTimeout(resolve,1));
 f.admitted=false;f.release();await assert.rejects(pending,{status:401});f.admitted=true;f.delay=false;f.fail=true;await assert.rejects(f.service.command(f.human,{action:'models',serverId}));
 assert.equal(f.methods.some(row=>row.method==='turn/start'),false);
});
test('empty and malformed pages, unsupported source reads and unavailable provider remain explicit',async()=>{
 const projects=await readProjects(async()=>({data:[],nextCursor:null}),serverId,null);assert.deepEqual(projects.projects,[]);
 await assert.rejects(readModels(async()=>{throw Object.assign(Error('old Host'),{code:-32601});},serverId,null),{code:'unsupported_capability'});
 const empty=await readModels(async()=>({data:[],nextCursor:'more'}),serverId,null);assert.deepEqual(empty.models,[]);assert.equal(empty.nextCursor,'more');
 await assert.rejects(readModels(async()=>({data:[],nextCursor:'same'}),serverId,'same'));
 const unknown=await readOptions(async()=>{throw Object.assign(Error('old'),{code:'unsupported_capability'});},ref);assert.equal(unknown.supported,false);assert.equal(unknown.nativeConfirmedConfiguration,null);
 const absent=await readOptions(async method=>{if(method==='thread/read')return {thread:{id:ref.threadId}};throw Object.assign(Error('old Host'),{code:-32601});},ref);assert.equal(absent.nativeConfirmedConfiguration,null);
 await assert.rejects(readOptions(async()=>{throw Object.assign(Error('timeout'),{code:'TIMEOUT'});},ref));
});
test('old service client fails independently before issuing discovery requests',async()=>{
 const requests:any[]=[];const transport=new MemoryTransport({server:{receive(raw,peer){const packet=JSON.parse(raw);if(packet.id===undefined)return;requests.push(packet);peer.send(JSON.stringify({id:packet.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1,servers:true}}}}}));}}});
 const client=new CollaborationClient(transport);try{await client.connect();for(const read of [()=>client.projects(serverId),()=>client.models(serverId),()=>client.options(ref)])await assert.rejects(read(),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(requests.length,1);}finally{await client.close();}
});
test('CLI run routes all three reads, awaits responses and rejects invalid options',async t=>{
 const f=await fixture(t),old=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=join(f.root,'connections.json');
 await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,defaultConnection:'fixture',connections:{fixture:{sshAlias:'synthetic',instanceId:'fixture'}}}));
 t.after(()=>{if(old===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=old;});
 const listeners=new Set<(frame:string)=>void>();let closed=false;
 t.mock.getter(CliSshTransport.prototype,'status',()=>({state:closed?'closed':'open'}));
 t.mock.method(CliSshTransport.prototype,'connect',async()=>{closed=false;});
 t.mock.method(CliSshTransport.prototype,'subscribeMessage',(listener:any)=>{listeners.add(listener);return()=>listeners.delete(listener);});
 t.mock.method(CliSshTransport.prototype,'subscribeStatus',()=>()=>{});
 t.mock.method(CliSshTransport.prototype,'close',async()=>{closed=true;});
 t.mock.method(CliSshTransport.prototype,'send',async(raw:string)=>{
   const packet=JSON.parse(raw);if(packet.id===undefined)return;
   const result=packet.method==='initialize'?{capabilities:{extensions:{'opencraft/collaboration':COLLABORATION_CAPABILITIES}}}:await f.service.command(f.human,packet.params);
   assert.equal(closed,false);for(const listener of listeners)listener(JSON.stringify({id:packet.id,result}));
 });
 const projects=await run(['project','list','--server',serverId]) as any;assert.equal(projects.projects.length,30);assert.equal(closed,true);
 const models=await run(['server','models','--server',serverId,'--cursor','page-two']) as any;assert.equal(models.models[0].id,'page-two');assert.equal(closed,true);
 const options=await run(['thread','options','opencraft://conversation/v1/'+encodeURIComponent(serverId)+'/'+ref.threadId]) as any;assert.equal(options.nativeConfirmedConfiguration.model,'allowed');assert.equal(closed,true);
 f.readiness='unavailable';
 const unavailable=await run(['status','--server',serverId]) as any;assert.equal(unavailable.connectionState,'unavailable');assert.equal(unavailable.server.connectionState,'unavailable');
 const all=await run(['status']) as any;assert.equal(all.connectionState,'unavailable');
 f.readiness='ready';assert.equal((await run(['status','--server',serverId]) as any).connectionState,'ready');
 for(const argv of [['thread','options',ref.threadId,'--server',serverId,'--cwd','/tmp']])await assert.rejects(run(argv),{exitCode:2});
});
test('all-effort policy denials produce empty pages, and a stale generation cannot read',async t=>{
 const f=await fixture(t);f.policy.write(0,[{engine:'codex',effort:'low'},{engine:'codex',effort:'medium'}],'synthetic');
 const empty=await f.service.command(f.human,{action:'models',serverId}) as any;assert.deepEqual(empty.models,[]);assert.equal(empty.nextCursor,'page-two');
 f.actors.setEnabled(f.human.actorId,false,'synthetic');f.actors.setEnabled(f.human.actorId,true,'synthetic');const count=f.methods.length;await assert.rejects(f.service.command(f.human,{action:'projects',serverId}),{status:401});assert.equal(f.methods.length,count);
});

test('an unanswered actual Host lane times out without starting a Turn or manufacturing a catalog',async t=>{
 const f=await fixture(t);f.hang=true;
 await assert.rejects(readModels((method:string,params:any)=>callConversationHost(f.host,{hostId:'local-codex',threadId:''},'timeout-probe',method,params,undefined,20),serverId,null),{code:'discovery_unavailable'});
 assert.equal(f.methods.filter(row=>row.method==='model/list').length,1);assert.equal(f.methods.some(row=>row.method==='turn/start'),false);
});
test('options cannot publish a late observation after a shared resource becomes private',async t=>{
 const f=await fixture(t);f.access.created(serverId,ref.threadId,f.other);f.delay=true;
 const pending=f.service.command(f.human,{action:'options',reference:ref});
 while(!f.methods.some(row=>row.method==='model/list'))await new Promise(resolve=>setTimeout(resolve,1));
 f.access.set(serverId,ref.threadId,'private',1,f.other);f.release();await assert.rejects(pending,{status:403});
});

test('real resource/model policy/history transport composition stays read-only and responsive with blocked history writes',async t=>{
 const f=await fixture(t,true);f.policy.write(0,[{engine:'codex',model:'blocked'}],'synthetic');
 // Open both actual Host lanes before blocking their durable imports.
 await f.service.command(f.human,{action:'projects',serverId});await f.service.command(f.human,{action:'models',serverId});
 f.blockHistory();
 const projects=await f.service.command(f.human,{action:'projects',serverId}) as any;assert.equal(projects.projects.length,30);
 const models=await f.service.command(f.human,{action:'models',serverId}) as any;assert.deepEqual(models.models.map((m:any)=>m.id),['allowed']);
 const options=await f.service.command(f.human,{action:'options',reference:ref}) as any;assert.equal(options.nativeConfirmedConfiguration.model,'allowed');assert.equal(options.modelCatalog.models[0].id,'allowed');
 assert.equal(f.methods.some(row=>row.method==='turn/start'),false);f.unblockHistory();
});
test('option catalog is a bounded white list, with independent old-Host method support',async()=>{
 const invoke=async(method:string)=> {
   if(method==='thread/read')return {thread:{id:ref.threadId,cwd:'/fixture',model:'allowed'}};
   if(method==='configRequirements/read')return {requirements:{allowedApprovalPolicies:['on-request'],allowedSandboxModes:['read-only','workspace-write'],allowedPermissionProfiles:{':read-only':true,':workspace':false},modelProviders:{SECRET:true},additionalDeveloperInstructions:'SECRET'}};
   if(method==='permissionProfile/list')return {data:[{id:':read-only',allowed:true},{id:':workspace',allowed:true},{id:':danger-full-access',allowed:true},{id:'custom',allowed:true}],nextCursor:null};
   throw Object.assign(Error('old Host'),{code:-32601});
 };
 const result=await readOptions(invoke,ref),catalog=result.optionCatalog;
 assert.equal(catalog.scope,'new-thread-subsequent');
 assert.deepEqual(catalog.permissionModes.values.map((r:any)=>[r.mode,r.allowed]),[['read-only',true],['accept-edits',false],['full',false]]);
 assert.equal(catalog.collaborationModes.supported,false);assert.deepEqual(catalog.initialWrite,{permissionMode:false,serviceTier:false,plan:false});
 assert.equal(JSON.stringify(result).includes('SECRET'),false);
 await assert.rejects(readOptions(async(method:string)=>method==='configRequirements/read'?{requirements:{allowedSandboxModes:'invalid'}}:invoke(method),ref),{code:'discovery_unavailable'});
 let pages=0;
 await assert.rejects(readOptions(async(method:string)=>method==='permissionProfile/list'?{data:[],nextCursor:'page-'+(++pages)}:invoke(method),ref),{code:'discovery_unavailable'});assert.equal(pages,4);
});

test('granular managed approval policy remains observable and cannot grant a named mode',async()=>{
 const granular={sandbox_approval:true,rules:false,skill_approval:true,request_permissions:false,mcp_elicitations:true};
 const result=await readOptions(async(method:string)=> {
   if(method==='thread/read')return {thread:{id:ref.threadId,cwd:'/fixture'}};
   if(method==='configRequirements/read')return {requirements:{allowedApprovalPolicies:[{granular:{...granular,private:'SECRET'}}]}};
   if(method==='permissionProfile/list')return {data:[{id:':read-only',allowed:true}],nextCursor:null};
   throw Object.assign(Error('old Host'),{code:-32601});
 },ref);
 assert.deepEqual(result.optionCatalog.requirements.allowedApprovalPolicies,[{granular}]);
 assert.equal(result.optionCatalog.permissionModes.values[0].allowed,false);
 assert.equal(JSON.stringify(result).includes('SECRET'),false);
});

test('mixed approval union preserves named policy and rejects malformed granular fields',async()=>{
 const granular={sandbox_approval:true,rules:false,skill_approval:true,request_permissions:false,mcp_elicitations:true};
 const invoke=(policies:unknown[])=>async(method:string)=>{
   if(method==='thread/read')return {thread:{id:ref.threadId,cwd:'/fixture'}};
   if(method==='configRequirements/read')return {requirements:{allowedApprovalPolicies:policies}};
   if(method==='permissionProfile/list')return {data:[{id:':read-only',allowed:true}],nextCursor:null};
   throw Object.assign(Error('old Host'),{code:-32601});
 };
 const mixed=await readOptions(invoke(['on-request',{granular}]),ref);
 assert.deepEqual(mixed.optionCatalog.requirements.allowedApprovalPolicies,['on-request',{granular}]);
 assert.equal(mixed.optionCatalog.permissionModes.values[0].allowed,true);
 await assert.rejects(readOptions(invoke([{granular:{...granular,mcp_elicitations:'SECRET'}}]),ref),{code:'discovery_unavailable'});
 const {mcp_elicitations:_,...missing}=granular;
 await assert.rejects(readOptions(invoke([{granular:missing}]),ref),{code:'discovery_unavailable'});
});


test('CLI directory exposes execution loss despite a connected Host and observes recovery', async t => {
 const f = await fixture(t);
 const state = () => f.port.directory().servers.find((s:any) => s.engine === 'codex')!.connectionState;
 assert.equal(state(), 'ready');
 f.readiness = 'unavailable'; assert.equal(state(), 'unavailable');
 f.readiness = 'ready'; assert.equal(state(), 'ready');
});
