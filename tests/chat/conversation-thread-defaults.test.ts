import {classify} from '../../apps/opencraft-cli/src/errors';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {THREAD_DEFAULTS_SCOPE,parseThreadDefaults,observeThreadDefaults,unknownThreadDefaults,type ThreadDefaultsBundle} from '@opencraft/appserver-protocol/collaboration';
import {applyThreadDefaults,assertDefaultsRequirements} from '../../apps/opencraft-daemon/src/thread-defaults-control';
import {setThreadDefaults} from '../../apps/opencraft-cli/src/thread-defaults';
import {run} from '../../apps/opencraft-cli/src/main';
import {CollaborationClient} from '../../packages/appserver-client/src/collaboration';
import {MemoryTransport} from '@opencraft/appserver-transport-memory';
import {ActorStore} from '../../packages/access-control/src/actors';
import {ThreadAccessStore} from '../../packages/access-control/src/thread-access';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {openServerDatabase} from '../../packages/storage-node/src/server';
const ref={serverId:'server',threadId:'thread'},bundle:ThreadDefaultsBundle={permissionMode:'accept-edits',mode:'plan',model:'gpt-6.1-sol',reasoningEffort:'medium'};
async function fixture(t:test.TestContext){
 const root=await mkdtemp('/tmp/thread-defaults-'),db=await openServerDatabase(root),actors=new ActorStore(db);
 const human=actors.resolveHuman({provider:'synthetic',subject:'owner',displayName:'Owner',expiresAt:Date.now()+60000})!,peer=actors.resolveHuman({provider:'synthetic',subject:'peer',displayName:'Peer',expiresAt:Date.now()+60000})!;
 const access=new ThreadAccessStore(join(root,'access.sqlite'),actors);access.created('server','thread',human);let allowed=true,writes=0,reads=0;
 const port:any={serverId:'server',hostId:'local-codex',directory:()=>({instanceId:'i',servers:[{serverId:'server',engine:'codex',capabilities:{threadDefaults:true,threadDefaultsObserve:true,modelSettings:true}}]}),
  async threadDefaults(_ref:any,value:any,context:any){context.resourceOwner.assertCurrent();assert.equal(context.executionPrincipal,undefined);if(value)writes++;else reads++;return value?{ref,scope:THREAD_DEFAULTS_SCOPE,requested:value,requestState:'acknowledged',includesAlreadyAcceptedInputs:true,includesOtherParticipantsInputs:true,observation:unknownThreadDefaults(ref),actualTurnSettings:null}:unknownThreadDefaults(ref);},
  async prepareSettings(){},async receipt(){return null;},async add(){throw Error('unexpected pump');},async cancel(){return false;}};
 const service=new Collaboration(db,actors,port,Date.now,()=>allowed,(context,r)=>access.allows(r.serverId,r.threadId,context));
 const trusted=(context:any)=>({submission:{sender:null,actorContext:context,resourceOwner:{id:'synthetic-connection',assertCurrent(){assert.equal(allowed,true);}}},inputAdmission:{serverId:'server',modelSettings:true,capture(){}}});
 const update=(context=human,value:any=bundle)=>service.command(context,{action:'threadDefaults',reference:ref,scope:THREAD_DEFAULTS_SCOPE,bundle:value},trusted(context));
 t.after(async()=>{await service.close();access.close();actors.close();await db.close();await rm(root,{recursive:true,force:true});});
 return {root,db,actors,access,service,port,human,peer,trusted,update,get writes(){return writes;},get reads(){return reads;},set allowed(value:boolean){allowed=value;}};
}
test('defaults require explicit complete bundle, and independent observation never echoes requested values',()=>{
 assert.deepEqual(parseThreadDefaults(bundle),bundle);
 for(const value of [{...bundle,mode:['plan']},{...bundle,permissionMode:['full']},{...bundle,config:{}},{...bundle,cwd:'/tmp'},{...bundle,model:undefined},{...bundle,reasoningEffort:''},{...bundle,instructions:'x'},{...bundle,serviceTier:'priority'}])assert.throws(()=>parseThreadDefaults(value));
 const read=observeThreadDefaults(ref,{thread:{id:'thread',model:'observed-model'}});assert.equal(read.model,'observed-model');assert.equal(read.mode,null);assert.equal(read.reasoningEffort,null);assert.equal(read.actualTurnSettings,null);assert.throws(()=>observeThreadDefaults(ref,{thread:{id:'other'}}));
});
test('empty Native ACK is independent from settings observation; lost ACK has at most one write',async()=>{
 let writes=0;const port={assertCurrent(){},prepare:async()=>({native:true}),write:async(_wire:any,admit:()=>boolean)=>{admit();writes++;return {};},observe:async()=>unknownThreadDefaults(ref)};
 const ack=await applyThreadDefaults(ref,bundle,port);assert.equal(ack.requestState,'acknowledged');assert.equal(ack.observation.model,null);assert.equal(ack.includesOtherParticipantsInputs,true);
 port.write=async(_wire,admit)=>{admit();writes++;throw Error('lost ACK');};const lost=await applyThreadDefaults(ref,bundle,port);assert.equal(lost.requestState,'unknown');assert.equal(writes,2);
 let calls=0;await assert.rejects(setThreadDefaults({setThreadDefaults:async()=>{calls++;return lost;}} as unknown as CollaborationClient,ref,bundle),{code:'THREAD_DEFAULTS_OUTCOME_UNKNOWN',retryable:false});assert.equal(calls,1);
});
test('managed requirements constrain the existing named profiles, not a new permission ceiling',()=>{
 assertDefaultsRequirements({requirements:null},bundle,{permissions:':workspace',approvalPolicy:'on-request'});
 for(const requirements of [{allowedApprovalPolicies:['never']},{allowedSandboxModes:['read-only']},{allowedPermissionProfiles:{':workspace':false}}])assert.throws(()=>assertDefaultsRequirements({requirements},bundle,{permissions:':workspace',approvalPolicy:'on-request'}));
 assert.throws(()=>assertDefaultsRequirements({},bundle,{}));
});
test('current shared human peer uses raw resource lane, private remains creator-only, Bot and untrusted contexts are denied',async t=>{
 const f=await fixture(t);await f.update(f.peer);assert.equal(f.writes,1);f.access.set('server','thread','private',1,f.human);await assert.rejects(f.update(f.peer),{status:403});await f.update();assert.equal(f.writes,2);
 const bot=f.actors.createSession('Synthetic bot',f.human.actorId),issued=f.actors.issueCredential(bot.id,Date.now()+60000,f.human.actorId),context=f.actors.authenticateSession(issued.token)!;
 await assert.rejects(f.update(context),{status:403});await assert.rejects(f.service.command(f.human,{action:'threadDefaults',reference:ref,scope:THREAD_DEFAULTS_SCOPE,bundle}),{status:403});assert.equal(f.writes,2);
 await f.service.command(f.human,{action:'threadDefaultsObserve',reference:ref},f.trusted(f.human));assert.equal(f.writes,2);assert.equal(f.reads,1);
});
test('defaults do not rewrite frozen full/partial/absent settings, keys, inputs or ownership; revoked final admission refuses mutation',async t=>{
 const f=await fixture(t);const ids:string[]=[];
 for(const [i,settings] of [{model:'gpt-6.1-sol',reasoningEffort:'medium'},{model:'gpt-6-luna'},{reasoningEffort:'low'},undefined].entries()){
  const sent:any=await f.service.command(f.human,{action:'send',reference:ref,content:'synthetic',idempotencyKey:'k'+i,execution:{mode:'queue'},...(settings?{settings}:{})},f.trusted(f.human));ids.push(sent.requestId);
 }
 const before=f.db.database.prepare('SELECT * FROM conversation_input_settings ORDER BY request_id').all();const messages=f.db.database.prepare('SELECT * FROM actor_messages ORDER BY id').all();
 await f.update();assert.deepEqual(f.db.database.prepare('SELECT * FROM conversation_input_settings ORDER BY request_id').all(),before);assert.deepEqual(f.db.database.prepare('SELECT * FROM actor_messages ORDER BY id').all(),messages);
 for(const id of ids)assert.equal(f.service.conversationDelivery(f.human,ref,id).actualTurnSettings,null);
 f.port.threadDefaults=async(_r:any,_b:any,c:any)=>{f.allowed=false;c.resourceOwner.assertCurrent();throw Error('unreachable');};await assert.rejects(f.update());assert.equal(f.writes,1);
});
test('legacy service does not receive a defaults write and CLI has no key/config/silent scope',async()=>{
 const calls:any[]=[];const transport=new MemoryTransport({server:{receive(raw,peer){const q=JSON.parse(raw);if(q.id===undefined)return;calls.push(q);peer.send(JSON.stringify({id:q.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1}}}}}));}}});
 const client=new CollaborationClient(transport);try{await client.connect();await assert.rejects(client.setThreadDefaults(ref,THREAD_DEFAULTS_SCOPE,bundle),{code:'UNSUPPORTED_CAPABILITY'});await assert.rejects(client.observeThreadDefaults(ref),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(calls.length,1);}finally{await client.close();}
 for(const argv of [['thread','defaults','x'],['thread','defaults','x','--observe-only','--model','x'],['thread','defaults','x','--key','x'],['thread','defaults','x','--config','x']])await assert.rejects(run(argv),{exitCode:2});
});

test('an old Host missing defaults capability gets no mutation even under a newly capable Hub',async t=>{
 const {AppHostServer}=await import('../../packages/app-host-server/src/index');const {createRoutedConversationExecution}=await import('../../scripts/conversation-execution.mjs');const methods:string[]=[];
 const host=new AppHostServer({hostDefinitions:[{hostId:'local-codex',label:'legacy'}],createTransport(){const listeners=new Set<(s:string)=>void>();return{status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){const q=JSON.parse(raw);if(q.id===undefined)return;methods.push(q.method);for(const listener of listeners)listener(JSON.stringify({id:q.id,result:{capabilities:{extensions:{}}}}));}};}});t.after(()=>host.close());
 const port=createRoutedConversationExecution(()=>host,{machineId:'legacy',engines:[],getInputs:async()=>null});
 await assert.rejects(port.threadDefaults({serverId:'server:legacy:codex',threadId:'t'},bundle,{sender:null,actorContext:{actorId:'synthetic',generation:1,credentialId:null,expiresAt:Date.now()+60000},resourceOwner:{id:'synthetic',assertCurrent(){}}}),{code:'unsupported_capability'});assert.deepEqual(methods,['initialize']);
});

test('a Native crash immediately after ACK does not become a saved or Turn confirmation',async()=>{
 let writes=0,reads=0;const result=await applyThreadDefaults(ref,bundle,{assertCurrent(){},prepare:async()=>({}),write:async(_p,admit)=>{admit();writes++;return{};},observe:async()=>{reads++;throw Error('Native crashed after ACK');}});
 assert.equal(result.requestState,'acknowledged');assert.equal(result.observation.source,'unknown');assert.equal(result.observation.mode,null);assert.equal(result.actualTurnSettings,null);assert.equal(Object.hasOwn(result,'saved'),false);assert.equal(writes,1);assert.equal(reads,1);
});


test('valid defaults parse independently of the send-only model settings path',async()=>{
 const root=await mkdtemp('/tmp/defaults-cli-parse-'),previous=process.env.OPENCRAFT_CONFIG;process.env.OPENCRAFT_CONFIG=join(root,'config.json');
 try{await writeFile(process.env.OPENCRAFT_CONFIG,JSON.stringify({schemaVersion:1,connections:{}}));
  await assert.rejects(run(['thread','defaults','t','--scope',THREAD_DEFAULTS_SCOPE,'--permission-mode','read-only','--collaboration-mode','plan','--model',bundle.model,'--reasoning-effort',bundle.reasoningEffort]),{code:'CONNECTION_REQUIRED'});
 }finally{if(previous===undefined)delete process.env.OPENCRAFT_CONFIG;else process.env.OPENCRAFT_CONFIG=previous;await rm(root,{recursive:true,force:true});}
});


test('a resource gate rejection is unavailable, not an uncertain defaults write',async()=>{
 const denial={code:-32004,data:{code:'THREAD_NOT_FOUND'}};assert.equal(classify(denial).exitCode,3);
 let calls=0;await assert.rejects(setThreadDefaults({setThreadDefaults:async()=>{calls++;throw denial;}} as unknown as CollaborationClient,ref,bundle),error=>error===denial);assert.equal(calls,1);
});
