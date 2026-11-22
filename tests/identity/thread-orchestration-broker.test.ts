import { OrchestrationRuntimeWorker } from '../../packages/access-control/src/orchestration-runtime-store';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration,CollaborationError,COLLABORATION_MIGRATIONS,type ConversationExecutionPort,type ExecutionReceipt } from '../../packages/access-control/src/collaboration';
import { ThreadOrchestrationBroker,type OrchestrationRuntimeSnapshot,type OrchestrationExecutionPort } from '../../packages/access-control/src/thread-orchestration-broker';
import { parsePrincipal } from '../../packages/identity-core/src/index';
import { encodeConversationRef } from '../../packages/appserver-protocol/src/collaboration';
import { openManagedDatabase } from '../../packages/sqlite-node/src/index';
import { ThreadOrchestrationLedger,type ThreadRelation } from '../../packages/access-control/src/orchestration-ledger';
const relation=(id:string,owner:string):ThreadRelation=>({threadId:id,serverId:'server',driverKind:'codex',ownerActorId:owner,parentThreadId:null,lifecycleOwnerThreadId:null,
 forkedFromId:null,visibility:'visible',engineHostGeneration:null,nativeSessionId:id,runtimeStatus:'idle',rootTurnId:null,turnId:null,delegationRevision:1,autoExchangeDepth:0,hasDirectUserInput:false,userInputExcerpt:null});

test('all Codex Pi and DSH ACP directions retain destination identity and one delegated child', async t => {
  for (const source of ['codex', 'pi', 'dsh'] as const) for (const destination of ['codex', 'pi', 'dsh'] as const) {
    const f = await fixture(t), prefix = { codex: 'codex_', pi: 'pi_', dsh: 'dsh_acp_' };
    const server = (id: string) => id.startsWith('pi_') ? 'server:pi' : id.startsWith('dsh_acp_') ? 'server:dsh-acp' : 'server';
    f.native.owns = id => ['server', 'server:pi', 'server:dsh-acp'].includes(id);
    f.native.serverForThread = server;
    const parent = prefix[source] + 'parent', turn = 'turn-' + source;
    f.service.authorizeExecution(f.a, parent, 'human:' + source); f.service.executionStarted(parent, 'human:' + source, turn);
    f.execution.create = async (_op, _source, settings) => ({ threadId: prefix[destination] + 'child', driverKind: destination });
    const args = { title:'Delegated review', driver: destination, prompt: 'Do the delegated task' };
    const child = await f.broker.invoke(parent, turn, 'spawn:' + source + ':' + destination, 'thread_spawn', args) as any;
    assert.deepEqual(await f.broker.invoke(parent, turn, 'spawn:' + source + ':' + destination, 'thread_spawn', args), child);
    const stored = f.service.orchestration.relation(child.threadId)!;
    assert.equal(stored.driverKind, destination); assert.equal(stored.serverId, server(child.threadId)); assert.equal(stored.parentThreadId, parent);
    await f.broker.invoke(parent, turn, 'tell:' + source + ':' + destination, 'thread_tell', { threadId: child.threadId, message: 'Continue' });
    const requests = f.service.database.prepare('SELECT server_id FROM actor_execution_requests WHERE thread_id=?').all(child.threadId);
    assert.equal(requests.length, 2); assert.ok(requests.every(row => row.server_id === server(child.threadId)));
    const op = f.service.orchestration.operation('spawn:' + source + ':' + destination)!;
    assert.equal(f.service.inputOrigin(child.threadId, op.clientMessageId!)?.senderConversation?.serverId, server(parent));
    assert.equal(f.service.usageSubmission(child.threadId, op.clientMessageId!)?.sourceKind, 'system');
  }
});

test('a tell binds the recipient own live delegation without inheriting the sender authority', async t => {
  const f = await fixture(t);
  f.service.authorizeExecution(f.b, 'recipient', 'human-b'); f.service.executionStarted('recipient', 'human-b', 'recipient-original');
  const result = await f.invoke('recipient-tell', 'thread_tell', { threadId: 'recipient', message: 'Please inspect' });
  const operation = f.service.orchestration.operationById(result.operationId)!;
  f.service.executionStarted('recipient', operation.clientMessageId!, 'recipient-next');
  assert.equal(f.service.delegation('recipient', 'recipient-next').context.actorId, f.b.actorId);
  assert.notEqual(f.service.delegation('recipient', 'recipient-next').context.actorId, f.a.actorId);
});
async function fixture(t:any){
 const root=await mkdtemp(join(tmpdir(),'oc-broker-')),actors=new ActorStore(join(root,'actors.sqlite'));
 const human=(subject:string)=>actors.resolveHuman(parsePrincipal({provider:'local',subject,displayName:subject,expiresAt:Date.now()+3_600_000})!)!;
 const a=human('a'),b=human('b');let now=Date.now(),creates=0,dropCreate=false,current=true;
 const receipts=new Map<string,ExecutionReceipt>(),inputs:Array<{threadId:string;id:string;input:string}>=[],creations=new Map<string,{threadId:string}>(),states=new Map<string,OrchestrationRuntimeSnapshot>();
 const native:ConversationExecutionPort={serverId:'server',hostId:'local-codex',async validate(){},async receipt(_binding,id){return receipts.get(id)??null;},
  async add(binding,id,input){if(!receipts.has(id)){inputs.push({threadId:binding.threadId,id,input});receipts.set(id,{id:'queue:'+id,state:'queued',targetTurnId:null});}return receipts.get(id)!;},async steer(){},async cancel(){return false;},
  async read(){return {entries:[{turnId:'t',role:'user',text:'Question'},{turnId:'t',role:'tool',text:'PRIVATE TOOL OUTPUT'},{turnId:'t',role:'assistant',text:'Answer'}],nextCursor:null};}};
 const execution:OrchestrationExecutionPort={async create(id,_source,_args,admit){if(!admit())throw new CollaborationError(403,'revoked');if(!creations.has(id)){const child={threadId:'child-'+(++creates)};creations.set(id,child);states.set(child.threadId,{threadId:child.threadId,turnId:null,rootTurnId:null,state:'starting'});}if(dropCreate){dropCreate=false;throw Error('Gateway lost after native creation');}return creations.get(id)!;},
  async snapshot(id){return states.get(id)??{threadId:id,turnId:null,rootTurnId:null,state:'active'};},async acknowledge(){}};
 let collaboration=new Collaboration(join(root,'collaboration.sqlite'),actors,native,()=>now,()=>current),storage=new OrchestrationRuntimeWorker(join(root,'collaboration.sqlite'));await storage.start();let broker=new ThreadOrchestrationBroker(collaboration,execution,()=>now,storage);
 collaboration.authorizeExecution(a,'parent','human-input',[{type:'text',text:'Delegate the review'}]);collaboration.executionStarted('parent','human-input','parent-turn');
 t.after(async()=>{await broker.close();await storage.close();await collaboration.close();actors.close();await rm(root,{recursive:true,force:true});});
 return {root,a,b,actors,native,execution,inputs,creations,states,get creates(){return creates;},get service(){return collaboration;},get broker(){return broker;},advance(ms:number){now+=ms;},dropCreate(){dropCreate=true;},revoke(){current=false;},
  async restart(){await broker.close();await storage.close();await collaboration.close();collaboration=new Collaboration(join(root,'collaboration.sqlite'),actors,native,()=>now,()=>current);storage=new OrchestrationRuntimeWorker(join(root,'collaboration.sqlite'));await storage.start();broker=new ThreadOrchestrationBroker(collaboration,execution,()=>now,storage);},
  invoke(key:string,name:string,args:Record<string,unknown>,source='parent',turn='parent-turn'){return broker.invoke(source,turn,`${source}:${turn}:${key}`,name,args) as Promise<any>;}};
}

test('v3 control facts survive v4 authority upgrade without rewriting migration hashes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-broker-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'collaboration.sqlite');
 const before=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS.slice(0,3)}).database,ledger=new ThreadOrchestrationLedger(before);
 ledger.createThread(relation('kept','human://local/a'));const op=ledger.accept({toolCallKey:'k',delegationId:'d',issuerActorId:'human://local/a',kind:'tell',senderThreadId:'s',targetThreadId:'t',clientMessageId:null,mode:'queue',arguments:{message:'kept'}});ledger.finish('k',{done:true});
 const hashes=before.prepare('SELECT version,checksum FROM schema_migrations').all();before.close();
 const after=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;assert.deepEqual(after.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=3').all(),hashes);
 assert.equal(new ThreadOrchestrationLedger(after).relation('kept')?.ownerActorId,'human://local/a');assert.equal(new ThreadOrchestrationLedger(after).operation('k')?.operationId,op.operationId);after.close();
 const changed=new DatabaseSync(path);changed.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=4");changed.close();assert.throws(()=>openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}));
});

test('spawn replay after gateway loss creates one native child and queues one system input',async t=>{
 const f=await fixture(t);f.dropCreate();await assert.rejects(f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'}),/Gateway lost/);assert.equal(f.creates,1);
 await f.restart();const first=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});await f.service.pump();const replay=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});
 assert.deepEqual(replay,first);assert.equal(f.creates,1);assert.equal(f.inputs.filter(input=>input.threadId===first.threadId).length,1);
 const op=f.service.orchestration.operation('parent:parent-turn:spawn')!;
 assert.equal(f.service.usageSubmission(first.threadId,op.clientMessageId!)?.sourceKind,'system');assert.equal(f.service.inputOrigin(first.threadId,op.clientMessageId!)?.delegatorActorId,f.a.actorId);
 assert.match(f.inputs[0]!.input,/<opencraft_thread_message/);assert.equal(f.service.orchestration.relation(first.threadId)?.parentThreadId,'parent');
 f.service.executionStarted(first.threadId,op.clientMessageId!,'child-turn');assert.equal(f.service.delegation(first.threadId,'child-turn').context.actorId,f.a.actorId);
});

test('cross-user tell rejects with 403 until both send and queue are explicitly granted',async t=>{
 const f=await fixture(t);f.service.orchestration.createThread(relation('private-B',f.b.actorId));
 const tell=()=>f.invoke('tell','thread_tell',{threadId:'private-B',message:'Do the work'});
 await assert.rejects(tell,error=>error instanceof CollaborationError&&error.status===403);
 const resource=encodeConversationRef({serverId:'server',threadId:'private-B'});f.actors.setGrant(f.a.actorId,resource,'message.send',true,'test');await assert.rejects(tell,error=>error instanceof CollaborationError&&error.status===403);
 f.actors.setGrant(f.a.actorId,resource,'execution.queue',true,'test');const sent=await tell();await f.service.pump();assert.equal(sent.delivery,'queued');assert.equal(f.inputs.filter(input=>input.threadId==='private-B').length,1);
 const op=f.service.orchestration.operation('parent:parent-turn:tell')!;f.service.executionStarted('private-B',op.clientMessageId!,'incoming-turn');
 assert.throws(()=>f.service.delegation('private-B','incoming-turn'),/execution_delegation_required/,'incoming sender authority cannot propagate to a foreign conversation');
 await f.invoke('tell','thread_tell',{threadId:'private-B',message:'Do the work'});await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='private-B').length,1);
});

test('root delegation budget is shared with spawned descendants and replay consumes no additional writes',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'}),op=f.service.orchestration.operation('parent:parent-turn:spawn')!;
 f.service.executionStarted(spawn.threadId,op.clientMessageId!,'child-turn');
 for(let i=0;i<7;i++)await f.invoke('tell-'+i,'thread_tell',{threadId:'parent',message:'Progress '+i},spawn.threadId,'child-turn');
 await assert.rejects(f.invoke('too-many','thread_tell',{threadId:'parent',message:'One more'},spawn.threadId,'child-turn'),error=>error instanceof CollaborationError&&error.status===429);
 assert.deepEqual(await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'}),spawn);assert.equal(f.creates,1);
});

test('recovery suppresses false parent interruptions and completion is delivered once after restart',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});await f.service.pump();
 const recovering={threadId:spawn.threadId,turnId:'retry',rootTurnId:'root',state:'recovering' as const};f.states.set(spawn.threadId,recovering);await f.broker.observe(recovering);f.advance(6000);await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,0);
 const complete={...recovering,state:'completed' as const,summary:'Review finished'};f.states.set(spawn.threadId,complete);await f.broker.observe(complete);f.advance(2100);await f.restart();await f.broker.reconcile();await f.service.pump();
 const notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);assert.match(notices[0]!.input,/<opencraft_child_update/);assert.match(notices[0]!.input,/completed/);
 f.advance(10_000);await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
 assert.equal(f.service.usageSubmission('parent',ACTOR_ID(notices[0]!.id))?.sourceKind,'system');
});
function ACTOR_ID(id:string){return 'actor-input:'+id;}

test('short wait returns a persistent ticket while an unavailable child is still recovering',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});
 f.execution.snapshot=async()=>new Promise(()=>{});
 const started=Date.now(),result=await f.invoke('wait','thread_wait',{threadIds:[spawn.threadId],timeoutMs:20});assert.equal(result.settled,false);assert.ok(Date.now()-started<500);
 await f.restart();assert.equal(f.service.orchestration.wait(result.waitTicketId)?.state,'active');
});

test('inspect remains text-only and an absent or revoked delegation cannot use server tools',async t=>{
 const f=await fixture(t),read=await f.invoke('inspect','thread_inspect',{threadId:'other'});assert.equal(read.entries.length,2);assert.doesNotMatch(JSON.stringify(read),/PRIVATE TOOL OUTPUT/);
 await assert.rejects(f.invoke('missing','thread_tell',{threadId:'other',message:'x'},'unbound','turn'),error=>error instanceof CollaborationError&&error.status===403);
 f.revoke();await assert.rejects(f.invoke('revoked','thread_spawn',{title:'Delegated review',prompt:'x'}),error=>error instanceof CollaborationError&&error.status===403);assert.equal(f.creates,0);
});

test('an exhausted root notifies once and direct human input is preserved in the parent notice',async t=>{
 const f=await fixture(t),child=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});
 f.service.authorizeExecution(f.a,child.threadId,'direct-input',[{type:'text',text:'Human correction'}]);f.service.executionStarted(child.threadId,'direct-input','human-turn');
 const state={threadId:child.threadId,turnId:'human-turn',rootTurnId:'human-root',state:'exhausted' as const};f.states.set(child.threadId,state);await f.broker.observe(state);f.advance(2100);
 await f.broker.reconcile();await f.service.pump();let notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);assert.match(notices[0]!.input,/Direct user input occurred/);
 assert.equal(f.service.orchestration.relation(child.threadId)?.userInputExcerpt,'Human correction');await f.restart();await f.broker.reconcile();await f.service.pump();notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);
});

test('a trusted captured delegation survives later steer while fresh calls use the new human authority',async t=>{
 const f=await fixture(t),original=f.service.delegation('parent','parent-turn').id;
 f.service.authorizeExecution(f.b,'parent','human-steer');f.service.executionStarted('parent','human-steer','parent-turn');assert.equal(f.service.delegation('parent','parent-turn').context.actorId,f.b.actorId);
 const result=await f.broker.invoke('parent','parent-turn','captured-call','thread_spawn',{title:'Delegated review',prompt:'Accepted before steer'},original) as any;
 assert.equal(f.service.orchestration.relation(result.threadId)?.ownerActorId,f.a.actorId);
 const next=await f.invoke('fresh','thread_spawn',{title:'Delegated review',prompt:'Accepted after steer'});assert.equal(f.service.orchestration.relation(next.threadId)?.ownerActorId,f.b.actorId);
});

test('automatic continuation retains bounded authority and exact persisted system identity after restart',async t=>{
 const f=await fixture(t),authority=f.service.delegation('parent','parent-turn');f.service.executionContinuing('parent','parent-turn','continuation-id');
 assert.equal(f.service.usageSubmission('parent','continuation-id')?.sourceKind,'system');assert.equal(f.service.inputDelegation('parent','continuation-id'),authority.id);
 await f.restart();f.service.executionStarted('parent','continuation-id','retry-turn');assert.equal(f.service.delegation('parent','retry-turn').id,authority.id);
 assert.equal(f.service.usageSubmission('parent','continuation-id')?.actorKind,'session');assert.equal(f.service.usageSubmission('parent','unknown-id'),null);
});

test('a transient snapshot error returns a durable unsettled wait instead of a tool failure',async t=>{
 const f=await fixture(t),child=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});f.execution.snapshot=async()=>{throw Error('Host temporarily detached');};
 const result=await f.invoke('wait','thread_wait',{threadIds:[child.threadId],timeoutMs:50});assert.equal(result.settled,false);assert.equal(f.service.orchestration.wait(result.waitTicketId)?.state,'active');
});

test('existing send tool receives the same durable reply after reconnect without an explicit model key',async t=>{
 const f=await fixture(t),args={reference:encodeConversationRef({serverId:'server',threadId:'other'}),message:'Review'};
 const first=await f.invoke('legacy','send_message_to_thread',args);await f.service.pump();await f.restart();const replay=await f.invoke('legacy','send_message_to_thread',args);await f.service.pump();
 assert.deepEqual(replay,first);assert.equal(f.inputs.filter(input=>input.threadId==='other').length,1);
});

test('concurrent aliases of one explicit spawn key share one side effect even after its Host receipt is ACKed',async t=>{
 const f=await fixture(t);let prepared=0,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 f.execution.prepare=async(_id,_source,args)=>{if(++prepared===2)await gate;return args;};f.execution.acknowledge=async id=>{f.creations.delete(id);return true;};
 const args={title:'Delegated review',prompt:'Create once',idempotencyKey:'shared'},a=f.invoke('alias-A','thread_spawn',args),b=f.invoke('alias-B','thread_spawn',args);
 const first=await a;release();assert.deepEqual(await b,first);assert.equal(f.creates,1);
 await f.restart();assert.deepEqual(await f.invoke('alias-B','thread_spawn',args),first);assert.equal(f.creates,1);
});

test('wait rechecks target read permission after an asynchronous snapshot and does not expose revoked text',async t=>{
 const f=await fixture(t);f.service.orchestration.createThread(relation('private-B',f.b.actorId));
 const resource=encodeConversationRef({serverId:'server',threadId:'private-B'});f.actors.setGrant(f.a.actorId,resource,'conversation.read',true,'test');
 let release!:(value:OrchestrationRuntimeSnapshot)=>void;f.execution.snapshot=()=>new Promise(resolve=>release=resolve);
 const waiting=f.invoke('wait-revoke','thread_wait',{threadIds:['private-B'],timeoutMs:500});
 f.actors.setGrant(f.a.actorId,resource,'conversation.read',false,'test');release({threadId:'private-B',turnId:'private-turn',rootTurnId:'root',state:'completed',summary:'PRIVATE ASSISTANT TEXT'});
 await assert.rejects(waiting,error=>error instanceof CollaborationError&&error.status===403);
 assert.equal(f.service.orchestration.operation('parent:parent-turn:wait-revoke')?.result,null);
});

test('committed create receipts retry ACK durably after restart without requiring callback replay',async t=>{
 const f=await fixture(t);let acknowledged=false,attempts=0;
 f.execution.acknowledge=async()=>{attempts++;if(!acknowledged)throw Error('Gateway lost before ACK');return true;};
 const result=await f.invoke('spawn-ack','thread_spawn',{title:'Delegated review',prompt:'Review'});await f.restart();assert.equal(f.service.pendingOrchestrationAcks().length,1);
 acknowledged=true;await f.broker.reconcile();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.service.pendingOrchestrationAcks().length,0);assert.equal(f.creates,1);assert.ok(attempts>=2);
 assert.deepEqual(await f.invoke('spawn-ack','thread_spawn',{title:'Delegated review',prompt:'Review'}),result);
});

test('a definitive Native creation rejection has a durable failure and ACKs its cached error',async t=>{
 const f=await fixture(t);let rejected=0,acks=0;f.execution.create=async()=>{rejected++;return {rejected:{status:400}};};f.execution.acknowledge=async()=>{acks++;return true;};
 const call=()=>f.invoke('rejected-create','thread_spawn',{title:'Delegated review',prompt:'Rejected'});await assert.rejects(call(),error=>error instanceof CollaborationError&&error.status===400);await f.restart();
 await assert.rejects(call(),error=>error instanceof CollaborationError&&error.status===400);assert.equal(rejected,1);assert.ok(acks>=1);assert.equal(f.service.orchestration.threads().length,0);
});

test('a timed-out wait on a readable non-child survives restart and wakes its caller once',async t=>{
 const f=await fixture(t);f.states.set('peer',{threadId:'peer',turnId:'peer-turn',rootTurnId:'peer-root',state:'active'});
 const waited=await f.invoke('peer-wait','thread_wait',{threadIds:['peer'],timeoutMs:1});assert.equal(waited.settled,false);await f.restart();
 f.states.set('peer',{threadId:'peer',turnId:'peer-turn',rootTurnId:'peer-root',state:'completed',summary:'Peer result'});await f.broker.reconcile();f.advance(2100);await f.broker.reconcile();await f.service.pump();
 assert.equal(f.service.orchestration.wait(waited.waitTicketId)?.state,'satisfied');assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
 await f.restart();await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
});

test('revocation after confirmed creation records its owner and failure, sends no prompt and still ACKs',async t=>{
 const f=await fixture(t),create=f.execution.create;let acks=0;f.execution.create=async(...args)=>{const child=await create(...args);f.revoke();return child;};f.execution.acknowledge=async()=>{acks++;return true;};
 await assert.rejects(f.invoke('late-revoke','thread_spawn',{title:'Delegated review',prompt:'Do not send'}),error=>error instanceof CollaborationError&&error.status===403);await f.service.pump();assert.equal(f.inputs.length,0);
 assert.equal(f.service.orchestration.threads()[0]?.ownerActorId,f.a.actorId);assert.equal(f.service.orchestration.operation('parent:parent-turn:late-revoke')?.state,'failed');await f.broker.reconcile();assert.equal(acks,1);
});

test('a live wait abandoned by Gateway death still wakes once after the persistent target settles',async t=>{
 const f=await fixture(t);f.execution.snapshot=async()=>new Promise(()=>{});
 const waiting=f.invoke('crashed-wait','thread_wait',{threadIds:['peer'],timeoutMs:50});void waiting.catch(()=>{});await f.restart();await assert.rejects(waiting,error=>error instanceof CollaborationError&&error.status===403);
 const operation=f.service.orchestration.operation('parent:parent-turn:crashed-wait')!;assert.equal(operation.result,null);
 f.execution.snapshot=async id=>({threadId:id,turnId:'done',rootTurnId:'root',state:'completed'});await f.broker.reconcile();f.advance(2100);await f.broker.reconcile();await f.service.pump();
 assert.equal(f.service.orchestration.wait(operation.operationId)?.state,'satisfied');assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
 await f.restart();await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
});

test('a confirmed human stop marks direct intervention even when the child started from Agent input',async t=>{
 const f=await fixture(t),child=await f.invoke('stop-child','thread_spawn',{title:'Delegated review',prompt:'Review'});await f.broker.observe({threadId:child.threadId,turnId:'turn',rootTurnId:'root',state:'interrupted_by_user'});
 assert.equal(f.service.orchestration.relation(child.threadId)?.hasDirectUserInput,true);
});

test('UI control reads separate timed-out tool, delivery and child facts across restart',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review',visibility:'hidden'});
 f.states.set(spawn.threadId,{threadId:spawn.threadId,turnId:'child-turn',rootTurnId:'child-turn',state:'active'});
 await f.broker.observe(f.states.get(spawn.threadId)!);
 const wait=await f.invoke('wait','thread_wait',{threadIds:[spawn.threadId],timeoutMs:0});
 assert.equal(wait.settled,false);
 const calls=[{turnId:'parent-turn',itemId:'spawn'},{turnId:'parent-turn',itemId:'wait'}];
 const read=()=>f.service.orchestrationView(f.a,'parent',calls);
 const before=read();
 assert.equal(before.calls[1]!.toolCallStatus,'complete');
 assert.equal(before.calls[1]!.childRuntimeStatus[spawn.threadId],'active');
 assert.notEqual(before.calls[0]!.deliveryStatus,null);
 assert.equal(before.calls[1]!.deliveryStatus,null);
 assert.deepEqual(f.service.threadTopology(spawn.threadId),{parentThreadId:'parent',visibility:'hidden'});
 await f.restart();assert.deepEqual(read(),before);
 await f.broker.observe({threadId:spawn.threadId,turnId:'child-turn',rootTurnId:'child-turn',state:'recovering'});
 assert.equal(read().calls[1]!.childRuntimeStatus[spawn.threadId],'recovering');
 await f.broker.observe({threadId:spawn.threadId,turnId:'child-turn',rootTurnId:'child-turn',state:'completed'});
 assert.equal(read().calls[1]!.childRuntimeStatus[spawn.threadId],'completed');
 assert.equal(f.service.orchestration.operation('parent:parent-turn:wait')!.result && (f.service.orchestration.operation('parent:parent-turn:wait')!.result as any).settled,false);
});

test('UI ledger projection checks source and each child read authority and exact Native identities',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{title:'Delegated review',prompt:'Review'});
 await assert.rejects(f.service.command(f.b,{action:'orchestration',threadId:spawn.threadId,calls:[]}),/conversation_action_denied/);
 const op=f.service.orchestration.operation('parent:parent-turn:spawn')!;
 f.service.database.prepare('INSERT INTO opencraft_orchestration_tool_calls VALUES(?,?)').run('incarnation:parent:parent-turn:replayed',op.operationId);
 assert.deepEqual(f.service.orchestrationView(f.a,'parent',[{turnId:'parent-turn',itemId:'replayed'}]).calls[0]?.receiverThreadIds,[spawn.threadId]);
 assert.equal(f.service.orchestrationView(f.a,'parent',[{turnId:'other-turn',itemId:'spawn'}]).calls.length,0);
 const forOther=f.service.orchestrationView(f.b,'parent',[{turnId:'parent-turn',itemId:'spawn'}]);
 assert.deepEqual(forOther.calls[0]?.receiverThreadIds,[]);
 assert.deepEqual(forOther.calls[0]?.childRuntimeStatus,{});
 assert.equal(forOther.calls[0]?.deliveryStatus,null);
 assert.throws(()=>f.service.orchestrationView(f.a,'parent',Array(101).fill({turnId:'t',itemId:'i'})),/invalid_orchestration_calls/);
});


test('ordinary authorized wait targets retain independent runtime facts after polling and restart',async t=>{
 const f=await fixture(t);
 f.states.set('ordinary',{threadId:'ordinary',turnId:'ordinary-turn',rootTurnId:'ordinary-turn',state:'active'});
 const receipt=await f.invoke('ordinary-wait','thread_wait',{threadIds:['ordinary'],timeoutMs:1});await f.broker.reconcile();
 assert.equal(receipt.settled,false);assert.equal(f.service.orchestration.relation('ordinary'),null);
 const calls=[{turnId:'parent-turn',itemId:'ordinary-wait'}],read=()=>f.service.orchestrationView(f.a,'parent',calls);
 assert.equal(read().calls[0]!.childRuntimeStatus.ordinary,'active');
 await f.restart();assert.equal(read().calls[0]!.childRuntimeStatus.ordinary,'active');
 f.states.set('ordinary',{threadId:'ordinary',turnId:'ordinary-turn',rootTurnId:'ordinary-turn',state:'completed'});
 await f.broker.reconcile();assert.equal(read().calls[0]!.childRuntimeStatus.ordinary,'completed');
});

test('v4 to v5 display migration preserves receipts and rejects a changed v5 checksum',async t=>{
 const root=await mkdtemp(join(tmpdir(),'oc-view-upgrade-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'collaboration.sqlite');
 const old=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS.slice(0,4)}).database,ledger=new ThreadOrchestrationLedger(old);
 ledger.createThread(relation('kept','owner'));
 const op=ledger.accept({toolCallKey:'call',delegationId:'delegation',issuerActorId:'owner',kind:'wait',senderThreadId:'kept',targetThreadId:null,clientMessageId:null,mode:'wait',arguments:{threadIds:['ordinary']}});
 ledger.finish('call',{settled:false});const hashes=old.prepare('SELECT version,checksum FROM schema_migrations').all();old.close();
 const current=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;
 assert.deepEqual(current.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=4').all(),hashes);
 const views=new ThreadOrchestrationLedger(current);assert.deepEqual(views.operationById(op.operationId)?.result,{settled:false});
 views.observeRuntime({threadId:'ordinary',rootTurnId:'root',turnId:'turn',state:'active'});
 assert.equal(views.runtimeSnapshot('ordinary')?.state,'active');current.close();
 const reopen=openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}).database;
 assert.equal(new ThreadOrchestrationLedger(reopen).runtimeSnapshot('ordinary')?.rootTurnId,'root');
 reopen.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=5");reopen.close();
 assert.throws(()=>openManagedDatabase({path,migrations:COLLABORATION_MIGRATIONS}));
});


test('spawn defaults to a hidden subagent and preserves explicit visible conversations across restart', async t => {
 const f = await fixture(t);
 const hidden = await f.invoke('default-hidden', 'thread_spawn', {title:'Delegated review',prompt:'Review'});
 assert.deepEqual(f.service.threadTopology(hidden.threadId), {parentThreadId:'parent',visibility:'hidden'});
 await f.restart();
 assert.equal(f.service.orchestration.relation(hidden.threadId)?.visibility,'hidden');
 const visible = await f.invoke('explicit-visible','thread_spawn',{title:'Delegated review',prompt:'Independent long-lived work',visibility:'visible'});
 assert.deepEqual(f.service.threadTopology(visible.threadId), {parentThreadId:'parent',visibility:'visible'});
 await f.restart();
 assert.equal(f.service.orchestration.relation(visible.threadId)?.visibility,'visible');
 assert.equal(f.service.orchestration.relation(hidden.threadId)?.visibility,'hidden');
});

test('timer sweeps back off unchanged children, slow stale starting ones, and still settle waits',async t=>{
 const f=await fixture(t);f.states.set('peer',{threadId:'peer',turnId:null,rootTurnId:null,state:'starting'});
 const waited=await f.invoke('paced-wait','thread_wait',{threadIds:['peer'],timeoutMs:1});assert.equal(waited.settled,false);
 const read=f.execution.snapshot;let reads=0;f.execution.snapshot=async id=>{if(id==='peer')reads++;return read(id);};
 const tick=async(count:number,step=500)=>{for(let i=0;i<count;i++){f.advance(step);await f.broker.reconcile(true);}};
 // 10 s of 500 ms timer ticks: 500 ms x4, 1 s x4, then 2 s -> about half the fixed-rate reads.
 await tick(20);assert.ok(reads>=8&&reads<=12,`unchanged child read ${reads} times in 10 s`);
 // Unchanged reads are capped at one per 5 s.
 reads=0;await tick(20,500*10);assert.ok(reads>=18&&reads<=20,`capped child read ${reads} times in 100 s`);
 // Still "starting" (no first turn) after 10 minutes: one read per 15 s.
 await tick(100,5000);reads=0;await tick(120);assert.ok(reads>=3&&reads<=5,`stale starting child read ${reads} times in 60 s`);
 // An explicit reconcile reads every target immediately.
 reads=0;await f.broker.reconcile();assert.equal(reads,1);
 // A settled child is still observed and wakes its waiter within one stale interval.
 f.states.set('peer',{threadId:'peer',turnId:'peer-turn',rootTurnId:'peer-root',state:'completed',summary:'Done'});
 await tick(32);f.advance(2100);await f.broker.reconcile(true);await f.service.pump();
 assert.equal(f.service.orchestration.wait(waited.waitTicketId)?.state,'satisfied');assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
});

test('a direct operation on a child makes the next timer sweep read it again',async t=>{
 const f=await fixture(t);f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 f.states.set('recipient',{threadId:'recipient',turnId:'r',rootTurnId:'r',state:'active'});
 const waited=await f.invoke('recipient-wait','thread_wait',{threadIds:['recipient'],timeoutMs:1});assert.equal(waited.settled,false);
 const read=f.execution.snapshot;let reads=0;f.execution.snapshot=async id=>{if(id==='recipient')reads++;return read(id);};
 for(let i=0;i<40;i++){f.advance(500);await f.broker.reconcile(true);}
 const before=reads;f.advance(10);await f.broker.reconcile(true);assert.equal(reads,before,'not due yet');
 await f.invoke('recipient-tell','thread_tell',{threadId:'recipient',message:'Please inspect'});
 const afterTell=reads;f.advance(10);await f.broker.reconcile(true);assert.equal(reads,afterTell+1,'tell clears the backoff');
});


test('a direct child operation racing a snapshot cannot restore stale backoff',async t=>{
 const f=await fixture(t);f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 f.states.set('recipient',{threadId:'recipient',turnId:'r',rootTurnId:'r',state:'active'});
 await f.invoke('race-wait','thread_wait',{threadIds:['recipient'],timeoutMs:1});
 const read=f.execution.snapshot;
 let pause=true,reads=0,release!:()=>void,reached!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
 f.execution.snapshot=async id=>{if(id==='recipient'){reads++;if(pause){reached();await gate;}}return read(id);};
 const sweep=f.broker.reconcile();await started;
 try{await f.invoke('race-tell','thread_tell',{threadId:'recipient',message:'Please inspect'});}
 finally{pause=false;release();await sweep;}
 const before=reads;f.advance(10);await f.broker.reconcile(true);
 assert.equal(reads,before+1,'late snapshot cannot overwrite direct-operation invalidation');
});

test('a transient paced snapshot failure is retried on the next tick without cached settlement',async t=>{
 const f=await fixture(t);f.states.set('peer',{threadId:'peer',turnId:null,rootTurnId:null,state:'starting'});
 const waited=await f.invoke('failure-wait','thread_wait',{threadIds:['peer'],timeoutMs:1});
 await f.broker.reconcile();
 const read=f.execution.snapshot;let failures=1,reads=0;
 f.execution.snapshot=async id=>{if(id==='peer'){reads++;if(failures-->0)throw Error('temporary');}return read(id);};
 f.advance(500);await f.broker.reconcile(true);
 assert.equal(f.service.orchestration.wait(waited.waitTicketId)?.state,'active');
 f.advance(500);await f.broker.reconcile(true);assert.equal(reads,2);
});

test('timer pumps back off an engine receipt that stays queued; explicit pumps and changes read at once',async t=>{
 const f=await fixture(t);
 await f.invoke('tell-paced','thread_tell',{threadId:'parent',message:'Queued behind a paused head'}).catch(()=>{});
 f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 await f.invoke('recipient-tell','thread_tell',{threadId:'recipient',message:'Please inspect'});await f.service.pump();
 const request=f.service.database.prepare("SELECT id FROM actor_execution_requests WHERE thread_id='recipient' AND state='queued'").get() as {id:string}|undefined;
 assert.ok(request,'the recipient input is queued in the engine');
 const native=f.native as any,receipt=native.receipt;let reads=0;native.receipt=async(binding:any,id:string)=>{if(id===request!.id)reads++;return receipt(binding,id);};
 for(let i=0;i<20;i++){f.advance(500);await f.service.pump(true);}
 assert.ok(reads>=8&&reads<=12,`unchanged queued receipt read ${reads} times in 10 s`);
 for(let i=0;i<60;i++){f.advance(500);await f.service.pump(true);}
 reads=0;for(let i=0;i<40;i++){f.advance(500);await f.service.pump(true);}assert.ok(reads>=3&&reads<=5,`capped at one per 5 s, read ${reads} in 20 s`);
 reads=0;await f.service.pump();assert.equal(reads,1,'explicit pump reads immediately');
});

test('an unconfirmed handoff stays unknown for review and is re-read at most every 30 s by timer pumps',async t=>{
 const f=await fixture(t);f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 const native=f.native as any;native.add=async()=>{throw Error('Engine restarted during reconciliation');};
 await f.invoke('recipient-tell','thread_tell',{threadId:'recipient',message:'Please inspect'});await f.service.pump();
 const request=f.service.database.prepare("SELECT id,state FROM actor_execution_requests WHERE thread_id='recipient'").get() as {id:string;state:string};
 assert.equal(request.state,'unknown');
 const receipt=native.receipt;let reads=0;native.receipt=async(binding:any,id:string)=>{if(id===request.id)reads++;return receipt(binding,id);};
 for(let i=0;i<400;i++){f.advance(500);await f.service.pump(true);}
 reads=0;for(let i=0;i<240;i++){f.advance(500);await f.service.pump(true);}
 assert.ok(reads>=3&&reads<=5,`unknown handoff read ${reads} times in 120 s`);
 assert.equal((f.service.database.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(request.id) as {state:string}).state,'unknown');
 reads=0;await f.service.pump();assert.equal(reads,1,'explicit pump reads immediately');
});

test('throwing receipt reads enter bounded recovery cooldown and resume without replaying input',async t=>{
 const f=await fixture(t);f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 const native=f.native as any;let adds=0;native.add=async()=>{adds++;throw Error('Engine restarted during reconciliation');};
 await f.invoke('recipient-tell','thread_tell',{threadId:'recipient',message:'Please inspect'});await f.service.pump();
 const request=f.service.database.prepare("SELECT id,state,reason FROM actor_execution_requests WHERE thread_id='recipient'").get() as {id:string;state:string;reason:string};
 assert.equal(request.state,'unknown');
 const receipt=native.receipt;let reads=0;native.receipt=async(_binding:any,id:string)=>{if(id===request.id)reads++;throw Error('Receipt lane unavailable');};
 for(let i=0;i<400;i++){f.advance(500);await f.service.pump(true);}
 assert.equal(reads,8,'unavailable observations are bounded before recovery cooldown');
 const health=f.service.getRequest(f.a,request.id).reconciliation as {state:string;failures:number;lastAttemptAt:number;nextAttemptAt:number};
 assert.equal(health.state,'recovery_required');assert.equal(health.failures,8);
 assert.equal(health.nextAttemptAt-health.lastAttemptAt,300_000);
 reads=0;for(let i=0;i<240;i++){f.advance(500);await f.service.pump(true);}
 assert.equal(reads,0,'timer pumps cannot bypass recovery cooldown');
 await f.service.pump();assert.equal(reads,0,'ordinary pumps cannot bypass a failed observation either');
 const after=f.service.database.prepare('SELECT state,reason FROM actor_execution_requests WHERE id=?').get(request.id) as {state:string;reason:string};
 assert.deepEqual({...after},{state:'unknown',reason:request.reason});
 native.receipt=async(binding:any,id:string)=>{if(id===request.id)reads++;return receipt(binding,id);};
 f.advance(300_000);await f.service.pump(true);
 assert.equal(reads,1,'expired cooldown permits a recovery observation');
 assert.deepEqual(f.service.getRequest(f.a,request.id).reconciliation,{state:'ready'});
 assert.equal(adds,1,'a missing recovery receipt cannot replay an ambiguous native input');
 assert.equal((f.service.database.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(request.id) as {state:string}).state,'unknown');
});


test('concurrent waits share one status read and reuse unchanged snapshots',async t=>{
 const f=await fixture(t);let reads=0;
 f.execution.snapshot=async id=>{reads++;await new Promise(resolve=>setTimeout(resolve,20));return {threadId:id,state:'active',turnId:'turn',rootTurnId:'turn'};};
 const results=await Promise.all([f.invoke('wait-one','thread_wait',{threadIds:['peer'],timeoutMs:650}),f.invoke('wait-two','thread_wait',{threadIds:['peer'],timeoutMs:650})]);
 assert.equal(reads,1);assert.ok(results.every(result=>result.settled===false));
});

test('failed status reads back off rather than retrying on every timer tick',async t=>{
 const f=await fixture(t);let reads=0;f.execution.snapshot=async()=>{reads++;throw Error('Host unavailable');};
 await f.invoke('failed-wait','thread_wait',{threadIds:['peer'],timeoutMs:1});
 for(let i=0;i<240;i++){f.advance(500);await f.broker.reconcile(true);}
 assert.ok(reads<15,`failure backoff made ${reads} calls in 120 seconds`);
 const before=reads;await f.broker.reconcile();assert.equal(reads,before+1,'explicit reconcile can revalidate immediately');
 f.execution.snapshot=async id=>({threadId:id,state:'completed',turnId:'done',rootTurnId:'done'});
 await f.broker.reconcile();assert.equal(f.service.orchestration.wait((f.service.orchestration.operation('parent:parent-turn:failed-wait')!.result as any).waitTicketId)?.state,'satisfied');
});

test('a tell invalidates an in-flight status read without reusing or caching the stale result',async t=>{
 const f=await fixture(t);f.service.authorizeExecution(f.b,'recipient','human-b');f.service.executionStarted('recipient','human-b','recipient-original');
 let release!:()=>void,reached!:()=>void,reads=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
 f.execution.snapshot=async id=>{const sequence=++reads;if(sequence===1){reached();await gate;return {threadId:id,state:'starting',turnId:null,rootTurnId:null};}return {threadId:id,state:'active',turnId:'new-turn',rootTurnId:'new-turn'};};
 const owner=f.broker as any,old=owner.readStatus('recipient');await started;
 try{
  await f.invoke('invalidate-status','thread_tell',{threadId:'recipient',message:'Please inspect'});
  const fresh=await owner.readStatus('recipient');assert.equal(fresh.state,'active');assert.equal(reads,2);
 }finally{release();}
 await assert.rejects(old,/superseded/);
 const current=await owner.readStatus('recipient');assert.equal(current.state,'active');assert.equal(reads,2,'stale completion cannot replace fresh cache');
});

test('spawn requires a meaningful title before any native allocation or input', async t => {
  const f=await fixture(t);
  for(const [index,title] of [undefined,null,'',' \t ',42,'x'.repeat(257),'line\nbreak','bad\0title'].entries()) {
    await assert.rejects(f.invoke('invalid-title-'+index,'thread_spawn',{title,prompt:'Review'}),
      (error:unknown)=>error instanceof CollaborationError&&error.status===400&&error.code==='thread_title_required');
  }
  assert.equal(f.creates,0);assert.equal(f.inputs.length,0);
  let received:unknown;f.execution.prepare=async(_op,_source,args)=>{received=args.title;return args;};
  await f.invoke('valid-title','thread_spawn',{title:'  Review navigation  ',prompt:'Review'});
  assert.equal(received,'Review navigation');assert.equal(f.creates,1);
});

test('the title tool is self-only and replays its receipt without reverting a newer title', async t => {
  const f=await fixture(t);let title='',writes=0;
  f.execution.setTitle=async(_op,target,value,admit)=>{assert.equal(target,'parent');assert.ok(admit());title=value;writes++;};
  await assert.rejects(f.invoke('foreign-title','thread_set_title',{threadId:'private-B',title:'Not allowed'}),/unexpected_orchestration_field/);
  await assert.rejects(f.invoke('blank-title','thread_set_title',{title:' '}),/thread_title_required/);
  assert.deepEqual(await f.invoke('title-a','thread_set_title',{title:'  First task  '}),{threadId:'parent',status:'updated'});
  await f.invoke('title-b','thread_set_title',{title:'New task'});
  await f.restart();
  assert.deepEqual(await f.invoke('title-a','thread_set_title',{title:'  First task  '}),{threadId:'parent',status:'updated'});
  assert.equal(title,'New task');assert.equal(writes,2);assert.equal(f.inputs.length,0);
  f.revoke();await assert.rejects(f.invoke('revoked-title','thread_set_title',{title:'Denied'}),/execution_delegation/);
  assert.equal(writes,2);
});

test('a lost title save acknowledgement stays unconfirmed and never repeats the old write', async t => {
  const f=await fixture(t);let title='',writes=0;
  f.execution.setTitle=async(_op,_thread,value)=>{title=value;writes++;throw Error('lost after save');};
  const uncertain=await f.invoke('lost-title','thread_set_title',{title:'Original title'});
  assert.equal(uncertain.status,'unconfirmed');assert.equal(title,'Original title');
  f.execution.setTitle=async(_op,_thread,value)=>{title=value;writes++;};
  await f.invoke('new-title','thread_set_title',{title:'New title'});
  await f.restart();assert.deepEqual(await f.invoke('lost-title','thread_set_title',{title:'Original title'}),uncertain);
  assert.equal(title,'New title');assert.equal(writes,2);
});

test('tool schemas require titles and publish the mandatory self-title instruction',async()=>{
  const {THREAD_ORCHESTRATION_TOOLS,parseThreadTitle}=await import('@opencraft/appserver-protocol/collaboration');
  const spawn=THREAD_ORCHESTRATION_TOOLS.find(tool=>tool.name==='thread_spawn')!;
  assert.deepEqual(spawn.inputSchema.required,['title','prompt']);
  assert.ok(new RegExp(spawn.inputSchema.properties.title.pattern).test('Review navigation'));
  assert.ok(!new RegExp(spawn.inputSchema.properties.title.pattern).test('   '));
  const rename=THREAD_ORCHESTRATION_TOOLS.find(tool=>tool.name==='thread_set_title')!;
  assert.match(rename.description,/MUST call.*beginning of a new conversation/);
  assert.deepEqual(rename.inputSchema.required,['title']);assert.equal('threadId' in rename.inputSchema.properties,false);
  assert.equal(parseThreadTitle('  Readable task  '),'Readable task');assert.equal(parseThreadTitle('line\nbreak'),null);
});

test('a previously accepted spawn without a title can still finish after upgrade', async t => {
  const f = await fixture(t);
  const delegation = f.service.delegation('parent', 'parent-turn');
  const args = { prompt: 'Old delegated work', idempotencyKey: 'old-spawn' };
  const operation = f.service.orchestration.accept({
    toolCallKey: 'parent:parent-turn:pre-upgrade', delegationId: delegation.id, issuerActorId: f.a.actorId,
    kind: 'spawn', senderThreadId: 'parent', targetThreadId: null, clientMessageId: null,
    mode: 'start', arguments: args, idempotencyKey: args.idempotencyKey,
  });
  await f.restart();
  const result = await f.invoke('after-upgrade', 'thread_spawn', args);
  assert.equal(result.operationId, operation.operationId);
  assert.equal(f.creates, 1);
  assert.equal((await f.invoke('pre-upgrade', 'thread_spawn', args)).threadId, result.threadId);
});

test('self-title writes use the existing Host method and fixed source thread for every driver',async t=>{
  const {AppHostServer}=await import('@opencraft/app-host-server');
  const {createThreadOrchestrationExecution}=await import('@opencraft/access-control/thread-orchestration-execution');
  for(const threadId of ['codex-current','pi_current','dsh_acp_current']){
    const listeners=new Set<(frame:string)=>void>(),writes:any[]=[];
    let current=true,revokeOnInitialize=false;
    const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',createTransport:()=>({
      status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeStatus:()=>()=>{},
      subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
      async send(frame:string){const value=JSON.parse(frame);if(value.id===undefined)return;
        if(value.method==='initialize'){if(revokeOnInitialize)current=false;}
        else{assert.equal(value.method,'thread/name/set');writes.push(value.params);}
        for(const listener of listeners)listener(JSON.stringify({id:value.id,result:{},__opencraftClient:value.__opencraftClient}));
      },
    })});
    t.after(()=>host.close());
    const execution=createThreadOrchestrationExecution(()=>host,{enabled:['codex','pi','dsh-acp']});
    await execution.setTitle!('set-current',threadId,'Current task',()=>current);
    assert.equal(writes.length,1);assert.equal(writes[0].threadId,threadId);assert.equal(writes[0].name,'Current task');
    revokeOnInitialize=true;
    await assert.rejects(execution.setTitle!('revoked-during-initialize',threadId,'Denied',()=>current),/delegation revoked/);
    assert.equal(writes.length,1);
  }
});
