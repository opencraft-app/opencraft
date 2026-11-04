import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration, type ConversationExecutionPort, type ExecutionReceipt} from '../../packages/access-control/src/collaboration';
import {encodeConversationRef,parseConversationRef,conversationLink} from '../../packages/appserver-protocol/src/collaboration';
const ref={serverId:'stable:server',threadId:'thread-B'}, source={serverId:ref.serverId,threadId:'thread-A'};
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'conversation-domain-'));
 const actors=new ActorStore(join(root,'actors.sqlite'));
 const human=actors.resolveHuman({provider:'local',subject:'one',displayName:'One',expiresAt:Date.now()+60000})!;
 const session=actors.createSession('executor','operator'),proof=actors.issueCredential(session.id,Date.now()+60000,'operator');
 const context=actors.authenticateSession(proof.token)!;
 const receipts=new Map<string,ExecutionReceipt>(), inputs:string[]=[];
 let dropped=false, admitted=true;
 const port:ConversationExecutionPort={serverId:ref.serverId,hostId:'current-route',async discover(search){return {conversations:[],search};},async read(){return {entries:[{text:'actual history'}],watermark:'w'};},async validate(){},async receipt(_b,id){return receipts.get(id)??null;},async add(b,id,input){assert.equal(b.hostId,'current-route');inputs.push(input);const r={id:'queue-'+id,state:'queued',targetTurnId:null};receipts.set(id,r);if(dropped)throw Error('lost response');return r;},async steer(_b,id,_q,turnId){receipts.set(id,{id:'queue-'+id,state:'delivered',targetTurnId:turnId});},async cancel(_b,id){const r=receipts.get(id);if(r?.state!=='queued')return false;receipts.set(id,{...r,state:'discarded'});return true;}};
 const path=join(root,'collaboration.sqlite');let service=new Collaboration(path,actors,port,Date.now,()=>admitted);
 t.after(async()=>{await service.close();actors.close();await rm(root,{recursive:true,force:true});});
 return {actors,human,session,context,port,inputs,receipts,get service(){return service;},async restart(){await service.close();service=new Collaboration(path,actors,port,Date.now,()=>admitted);},drop(){dropped=true;},revoke(){admitted=false;}};
}
test('one stable reference codec ignores navigation hints and rejects invalid identities',()=>{
 const value=encodeConversationRef(ref);assert.deepEqual(parseConversationRef(value),ref);
 assert.deepEqual(parseConversationRef(conversationLink('https://example.com/servers/new-route/?token=secret',ref)),ref);
 assert.ok(!conversationLink('https://example.com/?token=secret',ref).includes('secret'));
 assert.equal(parseConversationRef('opencraft://conversation/v1/x/%00'),null);
 assert.equal(parseConversationRef('https://other/?conversation=not-a-ref'),null);
});
test('read is bounded by adapter, authorized independently, and creates no message or execution',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.service.discover(f.human,'',null),{conversations:[],search:''});
 await assert.rejects(f.service.readConversation(f.context,ref),/conversation_action_denied/);
 f.actors.setGrant(f.session.id,encodeConversationRef(ref),'conversation.read',true,'operator');
 const read=await f.service.readConversation(f.context,ref);assert.equal(read.externalContext,true);assert.equal(f.inputs.length,0);
 assert.throws(()=>f.service.sendConversation(f.context,{reference:ref,content:'x',idempotencyKey:'x'}),/conversation_action_denied/);
 await assert.rejects(f.service.readConversation(f.human,{...ref,serverId:'another-server'}),/conversation_action_denied/);
});
test('conversation admission shares the existing idempotency ledger, retains source and reconciles lost receipts after restart',async t=>{
 const f=await fixture(t), body={reference:ref,content:'review',idempotencyKey:'same'};
 const sent=f.service.sendConversation(f.human,body,source);
 f.actors.setGrant(f.human.actorId,f.session.id,'message.send',true,'operator');
 assert.throws(()=>f.service.send(f.human,{targetActorId:f.session.id,content:'review',idempotencyKey:'same'}),/idempotency_key_reused/);
 assert.deepEqual(f.service.sendConversation(f.human,body,source),{...sent,replayed:true});
 assert.throws(()=>f.service.sendConversation(f.human,{...body,content:'different'},source),/idempotency_key_reused/);
 f.drop();await f.service.pump();assert.equal(f.service.getRequest(f.human,sent.requestId!).state,'unknown');
 await f.restart();
 assert.deepEqual(f.service.sendConversation(f.human,body,source),{...sent,replayed:true});
 assert.throws(()=>f.service.sendConversation(f.human,body,{...source,threadId:'other-source'}),/idempotency_key_reused/);
 await f.service.pump();assert.equal(f.inputs.length,1);
 assert.equal(f.inputs[0],`<opencraft_thread_message from="${encodeConversationRef(source)}" reply_expectation="none">\nreview\n</opencraft_thread_message>`);
 assert.deepEqual(f.service.inputOrigin(ref.threadId,'actor-input:'+sent.requestId)?.senderConversation,source);
 assert.equal(f.service.getRequest(f.human,sent.requestId!).state,'queued');
 const r=f.receipts.get(sent.requestId!)!;f.receipts.set(sent.requestId!,{...r,state:'delivered',targetTurnId:'turn-1'});
 await f.service.pump();assert.equal(f.service.getRequest(f.human,sent.requestId!).state,'submitted');
});
test('revocation and cancellation fence the same Host queue before claim',async t=>{
 const f=await fixture(t);
 const first=f.service.sendConversation(f.human,{reference:ref,content:'cancel',idempotencyKey:'cancel'});
 await f.service.pump();await f.service.cancel(f.human,first.requestId!,()=>{});assert.equal(f.service.getRequest(f.human,first.requestId!).state,'cancelled');
 const second=f.service.sendConversation(f.human,{reference:ref,content:'revoke',idempotencyKey:'revoke'});
 await f.service.pump();f.revoke();assert.equal(f.service.authorizeInput(ref.threadId,'actor-input:'+second.requestId,'queue'),false);
 await f.service.pump();assert.equal(f.service.getRequest(f.human,second.requestId!).state,'rejected');
});
test('tool authority is immutable per Turn, persists without a viewer and cannot be forged or acquire a reply loop',async t=>{
 const f=await fixture(t);
 f.service.authorizeExecution(f.human,source.threadId,'original-input');f.service.executionStarted(source.threadId,'original-input','original-turn');
 await f.restart();
 const read=await f.service.tool(source.threadId,'original-turn','read_thread',{reference:encodeConversationRef(ref)});assert.ok(read);
 await assert.rejects(f.service.tool(source.threadId,'unbound-turn','read_thread',{reference:encodeConversationRef(ref)}),/execution_delegation_required/);
 await assert.rejects(f.service.tool(source.threadId,'original-turn','read_thread',{reference:encodeConversationRef(ref),actorId:'forged'}),/unexpected_field/);
 f.service.executionContinued(source.threadId,'original-turn','capacity-retry-turn');
 for(let i=0;i<8;i++)await f.service.tool(source.threadId,'original-turn','send_message_to_thread',{reference:encodeConversationRef(ref),message:'task',idempotencyKey:'tool-'+i});
 await assert.rejects(f.service.tool(source.threadId,'capacity-retry-turn','send_message_to_thread',{reference:encodeConversationRef(ref),message:'task',idempotencyKey:'overflow'}),/budget_exhausted/);
 await assert.rejects(f.service.tool(ref.threadId,'message-triggered-turn','send_message_to_thread',{reference:encodeConversationRef(source),message:'ack',idempotencyKey:'auto-reply'}),/execution_delegation_required/);
 f.actors.setEnabled(f.human.actorId,false,'operator');
 await assert.rejects(f.service.tool(source.threadId,'original-turn','read_thread',{reference:encodeConversationRef(ref)}),/revoked/);
});

test('queued user references retain the original authority and incoming messages gain none',async t=>{
 const f=await fixture(t),input=[{type:'text',text:'Read '+encodeConversationRef(ref)}];
 f.service.authorizeExecution(f.human,source.threadId,'queued-user');
 await f.restart();
 const context=await f.service.queuedReferenceContext(source.threadId,'queued-user',input);
 assert.match(JSON.stringify(context),/actual history/);
 assert.match(JSON.stringify(context),/external/i);
 assert.equal(await f.service.queuedReferenceContext(source.threadId,'actor-input:incoming',input),null);
 f.actors.setEnabled(f.human.actorId,false,'operator');
 await assert.rejects(f.service.queuedReferenceContext(source.threadId,'queued-user',input),/revoked/);
});

test('tail uses the same resource grant and rechecks revocation across the read',async t=>{
 const f=await fixture(t);let reads=0;
 f.port.readTail=async()=>{reads++;return {entries:[{text:'tail marker'}]};};
 const request={action:'read',reference:ref,bounded:true,tail:1};
 await assert.rejects(f.service.command(f.context,request),/conversation_action_denied/);assert.equal(reads,0);
 f.actors.setGrant(f.session.id,encodeConversationRef(ref),'conversation.read',true,'operator');
 assert.equal((await f.service.command(f.context,request) as any).history.entries[0].text,'tail marker');
 for(const invalid of [{...request,cursor:'old'}, {...request,tail:0}, {...request,tail:6}, {...request,bounded:false}])
   await assert.rejects(f.service.command(f.context,invalid),/invalid_tail/);
 f.port.readTail=async()=>{f.actors.setGrant(f.session.id,encodeConversationRef(ref),'conversation.read',false,'operator');return {entries:[{text:'must not leak'}]};};
 await assert.rejects(f.service.command(f.context,request),/conversation_action_denied/);
});

test('only first direct human acceptance invokes its matching execution owner; replay and automated input cannot backfill',async t=>{
 const f=await fixture(t);
 const {OpenCraftHostStateDatabase}=await import('../../apps/opencraft-daemon/src/opencraft-host-state-database');
 const {ExecutionLeaseStore}=await import('../../apps/opencraft-daemon/src/execution-lease-store');
 const directory=await mkdtemp(join(tmpdir(),'conversation-admission-'));
 let owner=new OpenCraftHostStateDatabase(directory);
 t.after(async()=>{owner.close();await rm(directory,{recursive:true,force:true});});
 const expected={principal:{provider:'local',subject:'one'},ownership:'human' as const};
 let captures=0;
 const admission={serverId:ref.serverId,capture(threadId:string,inputId:string){captures++;new ExecutionLeaseStore(owner.database).capture(threadId,inputId,expected,'accepted','queue');}};
 const body=(key:string)=>({reference:ref,content:'direct user request',idempotencyKey:key});
 const sent=f.service.sendConversation(f.human,body('direct'),null,null,true,admission);
 assert.deepEqual(new ExecutionLeaseStore(owner.database).getSubmission(ref.threadId,'actor-input:'+sent.requestId),expected);
 await f.restart();owner.close();owner=new OpenCraftHostStateDatabase(directory);
 const replay=f.service.sendConversation(f.human,body('direct'),null,null,true,{...admission,capture(){throw Error('must not recapture');}});
 assert.equal(replay.requestId,sent.requestId);
 assert.deepEqual(new ExecutionLeaseStore(owner.database).getSubmission(ref.threadId,'actor-input:'+sent.requestId),expected);
 assert.equal(captures,1);
 const old=f.service.sendConversation(f.human,body('old'));
 f.service.sendConversation(f.human,body('old'),null,null,true,admission);
 assert.equal(new ExecutionLeaseStore(owner.database).getSubmission(ref.threadId,'actor-input:'+old.requestId),null,'an old accepted request is not backfilled by a new context');
 for(const ownership of ['unowned','unknown'] as const){
   const legacyBody=body('legacy-'+ownership),legacy=f.service.sendConversation(f.human,legacyBody);
   const store=new ExecutionLeaseStore(owner.database);
   store.capture(ref.threadId,'actor-input:'+legacy.requestId,{principal:null,ownership},'accepted','queue');
   f.service.sendConversation(f.human,legacyBody,null,null,true,admission);
   assert.deepEqual(store.getSubmission(ref.threadId,'actor-input:'+legacy.requestId),{principal:null,ownership});
 }
 const automated=f.service.sendConversation(f.human,body('agent'),source,'bounded-delegation',false,admission);
 assert.equal(new ExecutionLeaseStore(owner.database).getSubmission(ref.threadId,'actor-input:'+automated.requestId),null,'even a human requester with agent/delegation provenance conveys no personal execution identity');
 for(const action of ['message.send','execution.queue']) f.actors.setGrant(f.session.id,encodeConversationRef(ref),action,true,'operator');
 f.service.sendConversation(f.context,body('session'),null,null,true,admission);
 f.service.sendConversation(f.human,body('foreign-owner'),null,null,true,{...admission,serverId:'another-server'});
 f.service.sendConversation(f.human,{...body('steer'),execution:{mode:'steer',expectedTurnId:'running'}},null,null,true,admission);
 assert.equal(captures,1,'session, another execution owner, and steer cannot acquire a human execution');
});

test('capture failure rolls back Hub acceptance; an orphan frozen snapshot cannot authorize or launch input',async t=>{
 const f=await fixture(t);
 const {OpenCraftHostStateDatabase}=await import('../../apps/opencraft-daemon/src/opencraft-host-state-database');
 const {ExecutionLeaseStore}=await import('../../apps/opencraft-daemon/src/execution-lease-store');
 const directory=await mkdtemp(join(tmpdir(),'conversation-capture-fault-'));
 const owner=new OpenCraftHostStateDatabase(directory),store=new ExecutionLeaseStore(owner.database);
 t.after(async()=>{owner.close();await rm(directory,{recursive:true,force:true});});
 const captured:{threadId:string;inputId:string}[]=[];
 const body={reference:ref,content:'never admitted',idempotencyKey:'failed-capture'};
 assert.throws(()=>f.service.sendConversation(f.human,body,null,null,true,{serverId:ref.serverId,capture(threadId,inputId){
   store.capture(threadId,inputId,{principal:{provider:'local',subject:'one'},ownership:'human'},'accepted','queue');
   captured.push({threadId,inputId});throw Error('owner write failed');
 }}),/owner write failed/);
 assert.equal(f.service.lookupConversation(f.human,ref,body.idempotencyKey).found,false);
 assert.equal(captured.length,1);
 assert.equal(store.getSubmission(ref.threadId,captured[0]!.inputId)?.ownership,'human','a later Hub failure can leave an inert owner snapshot');
 assert.equal(f.service.authorizeInput(captured[0]!.threadId,captured[0]!.inputId,'queue',undefined,ref.serverId),false);
 await f.restart();await f.service.pump();
 assert.equal(f.inputs.length,0,'the native owner snapshot alone cannot create a runnable request');
});

test('exact result resolves only original Actor/ref request, stays pending across reopen and rechecks revocation',async t=>{
 const f=await fixture(t);let called=0,block:(()=>void)|null=null;
 f.port.directory=()=>({instanceId:'fixture',servers:[{serverId:ref.serverId,label:'codex',engine:'codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,exactResult:true}}]});
 f.port.exactResult=async(_ref,turnId)=>{called++;if(block)await new Promise<void>(resolve=>{block=resolve;});return {turnId,turnState:'completed',matched:true,source:'native-transcript',watermark:'w',entries:[],nextCursor:null,complete:false,finalUnavailable:true,observedAt:Date.now()};};
 const a=f.service.sendConversation(f.human,{reference:ref,content:'A',idempotencyKey:'exact-A'});
 const b=f.service.sendConversation(f.human,{reference:ref,content:'B',idempotencyKey:'exact-B'});
 assert.equal((await f.service.exactResult(f.human,ref,{requestId:a.requestId},false,null)).turnId,null);assert.equal(called,0);
 await f.restart();await f.service.pump();
 const receipt=f.receipts.get(a.requestId!)!;f.receipts.set(a.requestId!,{...receipt,state:'delivered',targetTurnId:'original-A'});await f.service.pump();
 assert.equal((await f.service.exactResult(f.human,ref,{operationKey:'exact-A'},false,null)).turnId,'original-A');
 assert.equal((await f.service.exactResult(f.human,ref,{requestId:b.requestId},false,null)).matched,false);
 const other=f.actors.resolveHuman({provider:'local',subject:'other',displayName:'Other',expiresAt:Date.now()+60000})!;
 await assert.rejects(f.service.exactResult(other,ref,{requestId:a.requestId},false,null));
 await assert.rejects(f.service.exactResult(f.human,{...ref,threadId:'wrong'},{requestId:a.requestId},false,null));
 await assert.rejects(f.service.exactResult(f.human,ref,{turnId:'A',principal:'forged'},false,null));
 assert.equal((await f.service.exactResult(f.human,ref,{turnId:'explicit'},false,null)).turnId,'explicit');
 block=()=>{};const pending=f.service.exactResult(f.human,ref,{requestId:a.requestId},false,null);
 await new Promise(resolve=>setTimeout(resolve,0));f.revoke();block!();await assert.rejects(pending);
});


test('Turn configuration is opt-in, original Actor/ref scoped, pending across reopen, and ACL is rechecked',async t=>{
 const f=await fixture(t);let calls=0,release:(()=>void)|undefined;
 f.port.directory=()=>({instanceId:'fixture',servers:[{serverId:ref.serverId,label:'codex',engine:'codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,turnConfigurationObservation:true}}]});
 f.port.turnConfigurationObservation=async(_ref,turnId)=>{calls++;if(release)await new Promise<void>(resolve=>{release=resolve;});return {status:'observed',turnId,scope:'turn-first-recorded-context',source:'native-rollout/turn_context',model:'exact',reasoningEffort:'medium',recordedAt:'2026-11-03T00:00:00Z',observedAt:Date.now(),coverage:'complete-retained-prefix',initiality:'start-boundary-observed',watermark:'a'.repeat(64),path:'never expose',raw:'never expose'} as any;};
 const sent=f.service.sendConversation(f.human,{reference:ref,content:'A',idempotencyKey:'configuration-A'});
 assert.equal(f.service.conversationDelivery(f.human,ref,sent.requestId!).actualTurnSettings,null);assert.equal(calls,0);
 assert.equal((await f.service.turnConfigurationObservation(f.human,ref,{requestId:sent.requestId})).turnConfigurationObservation.status,'pending');assert.equal(calls,0);
 await f.restart();await f.service.pump();const receipt=f.receipts.get(sent.requestId!)!;f.receipts.set(sent.requestId!,{...receipt,state:'delivered',targetTurnId:'original-A'});await f.service.pump();
 const result=await f.service.turnConfigurationObservation(f.human,ref,{operationKey:'configuration-A'});assert.equal(result.turnConfigurationObservation.turnId,'original-A');assert.equal(result.turnConfigurationObservation.model,'exact');assert.equal(JSON.stringify(result).includes('never expose'),false);
 assert.equal((await f.service.turnConfigurationObservation(f.human,ref,{operationKey:'unknown'})).turnConfigurationObservation.status,'unknown');
 const other=f.actors.resolveHuman({provider:'local',subject:'other-configuration',displayName:'Other',expiresAt:Date.now()+60000})!;
 await assert.rejects(f.service.turnConfigurationObservation(other,ref,{requestId:sent.requestId}));
 await assert.rejects(f.service.turnConfigurationObservation(f.human,{...ref,threadId:'wrong'},{requestId:sent.requestId}));
 await assert.rejects(f.service.turnConfigurationObservation(f.human,ref,{turnId:'A',path:'forged'}));
 assert.equal((await f.service.turnConfigurationObservation(f.human,ref,{turnId:'explicit'})).turnConfigurationObservation.turnId,'explicit');
 const prior=f.port.directory;const count=calls;f.port.directory=()=>({instanceId:'fixture',servers:[]});
 assert.equal((await f.service.turnConfigurationObservation(f.human,ref,{turnId:'explicit'})).turnConfigurationObservation.status,'unsupported');assert.equal(calls,count);f.port.directory=prior;
 release=()=>{};const pending=f.service.turnConfigurationObservation(f.human,ref,{requestId:sent.requestId});await new Promise(resolve=>setImmediate(resolve));f.revoke();release!();await assert.rejects(pending);
});
