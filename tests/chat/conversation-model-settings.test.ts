import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';
import {openServerDatabase} from '../../packages/storage-node/src/server/index';
import {parseConversationSettings,nativeConfiguration} from '@opencraft/appserver-protocol/collaboration';
import {createConversation} from '../../apps/opencraft-cli/src/create';
import {sendMessage} from '../../apps/opencraft-cli/src/send';
import {run} from '../../apps/opencraft-cli/src/main';

const ref={serverId:'server',threadId:'thread'},settings={model:'gpt-6.1-sol',reasoningEffort:'medium'};
async function fixture(t:any){
 const root=await mkdtemp('/tmp/oc-settings-');let owner=await openServerDatabase(root),actors=new ActorStore(owner);
 const human=actors.resolveHuman({provider:'synthetic',subject:'verified',displayName:'Synthetic',expiresAt:Date.now()+60000})!;
 let service:Collaboration,creates=0,captures=0,prepares=0,deny=false,lose=false,failSnapshot=false;
 const delivered=new Map<string,any>(),observed:any[]=[];
 const admission={serverId:'server',modelSettings:true,capture(){if(failSnapshot)throw Error('freeze failed');captures++;}};
 const trusted={inputAdmission:admission,submission:{sender:null,actorContext:human,resourceOwner:{id:'synthetic',assertCurrent(){}}}};
 const port:any={serverId:'server',hostId:'host',directory:()=>({instanceId:'instance',servers:[{serverId:'server',engine:'codex',capabilities:{create:true,modelSettings:true}}]}),
  prepareSettings:async()=>{prepares++;if(deny)throw Error('policy denied');},prepareCreate:async()=>({cwd:'/repo',runtimeWorkspaceRoots:['/repo']}),
  create:async(_t:any,value:any)=>{creates++;if(lose)throw Error('response lost');return {threadId:'created',nativeConfirmedConfiguration:nativeConfiguration({...value.inputSettings},'native/thread/start','creation')};},
  validate:async()=>{},receipt:async(_b:any,id:string)=>delivered.get(id)??null,add:async(b:any,id:string)=>{observed.push({thread:b.threadId,settings:service.inputSettings(b.threadId,'actor-input:'+id)});const r={id:'queue-'+id,state:'queued',targetTurnId:null};delivered.set(id,r);return r;},cancel:async()=>false};
 const reopen=async()=>{if(service)await service.close();actors.close();await owner.close();owner=await openServerDatabase(root);actors=new ActorStore(owner);service=new Collaboration(owner,actors,port);};
 service=new Collaboration(owner,actors,port);t.after(async()=>{await service.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
 const send=(key:string,value:any=settings)=>service.command(human,{action:'send',reference:ref,content:'synthetic',idempotencyKey:key,execution:{mode:'queue'},...(value?{settings:value}:{})},trusted);
 return {root,human,trusted,admission,port,send,reopen,get actors(){return actors;},get service(){return service;},get db(){return owner.database;},observed,get counts(){return {creates,captures,prepares};},set deny(v:boolean){deny=v;},set lose(v:boolean){lose=v;},set failSnapshot(v:boolean){failSnapshot=v;}};
}
test('canonical explicit settings and Native evidence keep absent/empty/current facts distinct',()=>{
 assert.deepEqual(parseConversationSettings({reasoningEffort:'medium',model:'gpt-6.1-sol'}),settings);
 for(const v of [{},{config:{}},{model:''},{model:' gpt-x'},{model:'x\ny'},{reasoningEffort:null}])assert.throws(()=>parseConversationSettings(v));
 assert.equal(nativeConfiguration({},'native/thread/start','creation'),null);
 assert.equal(nativeConfiguration({model:null,reasoningEffort:null},'native/thread/read','thread-last-persisted'),null);
 const native=nativeConfiguration({model:'other',reasoningEffort:'low'},'native/thread/read','thread-current')!;assert.equal(native.model,'other');assert.equal(native.scope,'thread-current');assert.ok(native.observedAt>0);
});
test('send freezes A/B settings atomically with request and fingerprints; restart/replay/lookup never relabel or re-admit',async t=>{
 const f=await fixture(t);const a:any=await f.send('a'),b:any=await f.send('b',{model:'gpt-6-luna',reasoningEffort:'low'});
 assert.equal(f.counts.captures,2);await f.reopen();
 assert.deepEqual(f.service.inputSettings('thread','actor-input:'+a.requestId),settings);
 assert.deepEqual(f.service.inputSettings('thread','actor-input:'+b.requestId),{model:'gpt-6-luna',reasoningEffort:'low'});
 assert.throws(()=>f.service.inputSettings('another','actor-input:'+a.requestId));assert.throws(()=>f.service.inputSettings('thread','actor-input:'+a.requestId,'other-server'));
 f.deny=true;const reads=f.counts.prepares;const replay:any=await f.send('a');assert.equal(replay.requestId,a.requestId);assert.equal(f.counts.prepares,reads);assert.equal(f.counts.captures,2);
 await assert.rejects(f.send('a',{...settings,reasoningEffort:'high'}),/idempotency_key_reused/);
 const lookup=f.service.lookupConversation(f.human,ref,'a');assert.equal(lookup.found,true);if(lookup.found){assert.deepEqual(lookup.receipt.requestedSettings,settings);assert.equal(lookup.receipt.actualTurnSettings,null);assert.equal(lookup.receipt.nativeConfirmedConfiguration,null);}
 await f.service.pump();assert.deepEqual(f.observed.map(x=>x.settings),[settings,{model:'gpt-6-luna',reasoningEffort:'low'}]);
});
test('snapshot failure rolls back request/key/settings; old inputs retain absence and explicit read failures propagate',async t=>{
 const f=await fixture(t);f.failSnapshot=true;await assert.rejects(f.send('fail'),/freeze failed/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM conversation_input_settings').get()!.n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_send_keys').get()!.n,0);
 f.failSnapshot=false;const old:any=await f.send('old',null);assert.equal(f.service.inputSettings('thread','actor-input:'+old.requestId),null);
 const explicit:any=await f.send('explicit');f.db.exec('DROP TABLE conversation_input_settings');assert.throws(()=>f.service.inputSettings('thread','actor-input:'+explicit.requestId),/no such table/);
});
test('create and its first input share immutable settings; unknown never replays or freezes a first input',async t=>{
 const f=await fixture(t),body={action:'create',serverId:'server',projectId:'project',cwd:'/repo',content:'first',idempotencyKey:'create',settings};
 const created:any=await f.service.command(f.human,body,f.trusted);assert.equal(created.creationState,'created');assert.deepEqual(created.requestedSettings,settings);assert.equal(created.nativeConfirmedConfiguration.scope,'creation');assert.equal(created.actualTurnSettings,null);assert.deepEqual(created.firstMessage.requestedSettings,settings);assert.equal(f.counts.captures,1);
 f.deny=true;await f.service.command(f.human,body,f.trusted);assert.equal(f.counts.creates,1);assert.equal(f.counts.captures,1);await assert.rejects(f.service.command(f.human,{...body,settings:{...settings,model:'other'}},f.trusted),/idempotency_key_reused/);
 f.deny=false;f.lose=true;const lost:any=await f.service.command(f.human,{...body,idempotencyKey:'lost'},f.trusted);assert.equal(lost.creationState,'unknown');assert.equal(lost.ref,null);await f.reopen();await f.service.command(f.human,{...body,idempotencyKey:'lost'},f.trusted);f.service.lookupCreation(f.human,'server','lost');assert.equal(f.counts.creates,2);assert.equal(f.counts.captures,1);
});
test('settings reject steer/source/old owner and unsupported CLI before mutation',async t=>{
 const f=await fixture(t);await assert.rejects(f.service.command(f.human,{action:'send',reference:ref,content:'x',idempotencyKey:'steer',settings,execution:{mode:'steer',expectedTurnId:'turn'}},f.trusted),/unsupported_capability/);
 assert.throws(()=>f.service.sendConversation(f.human,{reference:ref,content:'x',idempotencyKey:'source',settings},ref,null,true,f.admission),/unsupported_capability/);
 f.admission.modelSettings=false;await assert.rejects(f.send('old-owner'),/unsupported_capability/);assert.equal(f.counts.captures,0);
 const input={content:'x',operationKey:'k',generated:false,timeoutMs:null,settings};const client:any={require(){throw Object.assign(Error('unsupported'),{code:'UNSUPPORTED_CAPABILITY'});},send(){throw Error('mutation');},create(){throw Error('mutation');}};
 await assert.rejects(sendMessage(client,ref,input,{instanceId:'i',actorId:'a',recordsDirectory:join(f.root,'records')}));await assert.rejects(createConversation(client,{serverId:'server',projectId:'p',cwd:'/repo'},input));
 await assert.rejects(run(['thread','send','t','x','--key','k','--mode','steer','--expected-turn','turn','--model','gpt-6.1-sol']),(e:any)=>e.code==='UNSUPPORTED_CAPABILITY');
});

test('show confirms configuration only from a successful strict Native observation, never cached metadata',async t=>{
 const {AppHostServer}=await import('../../packages/app-host-server/src/index');
 const {createConversationExecution}=await import('../../scripts/conversation-execution.mjs');
 for(const fresh of [false,true]){
  const calls:string[]=[];
  const host=new AppHostServer({physicalHostLifetime:'server',createTransport(){const listeners=new Set<(raw:string)=>void>();return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){const m=JSON.parse(raw);if(m.id===undefined)return;calls.push(m.method);let result:any={};if(m.method==='initialize')result={capabilities:{extensions:{'opencraft/read-history':{sourceRead:true}}}};else if(m.method==='thread/read')result={thread:{id:'thread',status:{type:'idle'},model:m.params.sourceRead?'native-A':'cached-B',reasoningEffort:'medium'}};for(const fn of listeners)fn(JSON.stringify({id:m.id,...(m.params?.sourceRead&&!fresh?{error:{code:-32000,message:'synthetic read failed'}}:{result})}));}};}});t.after(()=>host.close());
  const port=createConversationExecution(()=>host,{serverId:'server',hostId:'codex'});const metadata=await port.metadata(ref);
  if(fresh){assert.equal(metadata.nativeConfirmedConfiguration?.model,'native-A');assert.equal(metadata.nativeConfirmedConfiguration?.scope,'thread-current');}else assert.equal(metadata.nativeConfirmedConfiguration,null);
  assert.equal(metadata.actualTurnSettings,null);assert.ok(calls.every(m=>['initialize','thread/read','opencraft/turn-recovery/read'].includes(m)));
 }
});


test('legacy Actor-target inputs preserve absence and original authorization without acquiring explicit settings',async t=>{
 const f=await fixture(t),source=f.actors.createSession('source','fixture'),target=f.actors.createSession('target','fixture');
 const credential=f.actors.issueCredential(source.id,Date.now()+60000,'fixture'),context=f.actors.authenticateSession(credential.token)!;
 for(const action of ['message.send','execution.queue'])f.actors.setGrant(source.id,target.id,action,true,'fixture');
 await f.service.bind(target.id,'thread',0,()=>{});
 const sent=f.service.send(context,{targetActorId:target.id,content:'legacy synthetic',idempotencyKey:'legacy',execution:{mode:'queue'}});
 assert.equal(f.service.inputSettings('thread','actor-input:'+sent.requestId),null);
 f.db.prepare('INSERT INTO conversation_input_settings VALUES(?,?,?)').run(sent.requestId,'gpt-6.1-sol','medium');
 assert.throws(()=>f.service.inputSettings('thread','actor-input:'+sent.requestId),/input_settings_unavailable/);
});


test('legacy absent and model-only unknown creation keys retain their original fingerprint without a Native retry',async t=>{
 const f=await fixture(t),target={serverId:'server',projectId:'project',cwd:'/repo'};
 for(const explicit of [false,true]){
  const key=explicit?'legacy-model':'legacy-absent',fingerprint=createHash('sha256').update(JSON.stringify(['create',target,'legacy',...(explicit?[settings]:[])])).digest('hex');
  f.db.prepare("INSERT INTO actor_conversation_creations VALUES(?,?,?,?,?,?,?,?,'unknown',NULL,'unknown',NULL,?)").run(f.human.actorId,key,'operation-'+key,fingerprint,target.serverId,target.projectId,target.cwd,JSON.stringify({cwd:'/repo',runtimeWorkspaceRoots:['/repo'],...(explicit?{inputSettings:settings}:{})}),Date.now());
  f.db.prepare('INSERT INTO actor_send_keys VALUES(?,?,?,NULL,NULL)').run(f.human.actorId,key,fingerprint);
  const body={action:'create',...target,content:'legacy',idempotencyKey:key,...(explicit?{settings}:{})};
  const replay:any=await f.service.command(f.human,body,f.trusted);assert.equal(replay.operationId,'operation-'+key);assert.equal(replay.creationState,'unknown');assert.equal(replay.ref,null);
  await assert.rejects(f.service.command(f.human,{...body,initialOptions:{permissionMode:'accept-edits'}},f.trusted),/idempotency_key_reused/);
 }
 assert.deepEqual(f.counts,{creates:0,captures:0,prepares:0});
});

test('combined creation retains both observation scopes and the original first-input model snapshot across reopen',async t=>{
 const f=await fixture(t);f.port.directory=()=>({instanceId:'instance',servers:[{serverId:'server',engine:'codex',capabilities:{create:true,modelSettings:true,initialPermissionMode:true}}]});
 const create=f.port.create;f.port.create=async(target:any,value:any,context:any)=>({...await create(target,value,context),nativeInitialObservation:{source:'native/thread/start',observedAt:Date.now(),scope:'new-thread-subsequent',permissionProfileId:':workspace',approvalPolicy:'on-request'}});
 const body={action:'create',serverId:'server',projectId:'p',cwd:'/repo',content:'synthetic',idempotencyKey:'combined',settings,initialOptions:{permissionMode:'accept-edits'}};
 const result:any=await f.service.command(f.human,body,f.trusted);assert.equal(result.creationState,'created');assert.deepEqual(result.requestedSettings,settings);assert.deepEqual(result.requestedInitialOptions,body.initialOptions);
 assert.equal(result.nativeConfirmedConfiguration.scope,'creation');assert.equal(result.nativeInitialObservation.scope,'new-thread-subsequent');assert.equal(result.actualTurnSettings,null);
 const request=result.firstMessage.requestId;assert.deepEqual(f.service.inputSettings('created','actor-input:'+request),settings);
 await f.reopen();const lookup:any=f.service.lookupCreation(f.human,'server','combined');assert.deepEqual(lookup.operation.nativeInitialObservation,result.nativeInitialObservation);assert.deepEqual(lookup.operation.nativeConfirmedConfiguration,result.nativeConfirmedConfiguration);
 await f.service.command(f.human,body,f.trusted);assert.equal(f.counts.creates,1);assert.equal(f.counts.captures,1);
 await assert.rejects(f.service.command(f.human,{...body,settings:{model:'other'}},f.trusted),/idempotency_key_reused/);
 await assert.rejects(f.service.command(f.human,{...body,initialOptions:{permissionMode:'full'}},f.trusted),/idempotency_key_reused/);
});
