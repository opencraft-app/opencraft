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
    const args = { driver: destination, prompt: 'Do the delegated task' };
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
 let collaboration=new Collaboration(join(root,'collaboration.sqlite'),actors,native,()=>now,()=>current),broker=new ThreadOrchestrationBroker(collaboration,execution,()=>now);
 collaboration.authorizeExecution(a,'parent','human-input',[{type:'text',text:'Delegate the review'}]);collaboration.executionStarted('parent','human-input','parent-turn');
 t.after(async()=>{await broker.close();await collaboration.close();actors.close();await rm(root,{recursive:true,force:true});});
 return {root,a,b,actors,native,execution,inputs,creations,states,get creates(){return creates;},get service(){return collaboration;},get broker(){return broker;},advance(ms:number){now+=ms;},dropCreate(){dropCreate=true;},revoke(){current=false;},
  async restart(){await broker.close();await collaboration.close();collaboration=new Collaboration(join(root,'collaboration.sqlite'),actors,native,()=>now,()=>current);broker=new ThreadOrchestrationBroker(collaboration,execution,()=>now);},
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
 const f=await fixture(t);f.dropCreate();await assert.rejects(f.invoke('spawn','thread_spawn',{prompt:'Review'}),/Gateway lost/);assert.equal(f.creates,1);
 await f.restart();const first=await f.invoke('spawn','thread_spawn',{prompt:'Review'});await f.service.pump();const replay=await f.invoke('spawn','thread_spawn',{prompt:'Review'});
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
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{prompt:'Review'}),op=f.service.orchestration.operation('parent:parent-turn:spawn')!;
 f.service.executionStarted(spawn.threadId,op.clientMessageId!,'child-turn');
 for(let i=0;i<7;i++)await f.invoke('tell-'+i,'thread_tell',{threadId:'parent',message:'Progress '+i},spawn.threadId,'child-turn');
 await assert.rejects(f.invoke('too-many','thread_tell',{threadId:'parent',message:'One more'},spawn.threadId,'child-turn'),error=>error instanceof CollaborationError&&error.status===429);
 assert.deepEqual(await f.invoke('spawn','thread_spawn',{prompt:'Review'}),spawn);assert.equal(f.creates,1);
});

test('recovery suppresses false parent interruptions and completion is delivered once after restart',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{prompt:'Review'});await f.service.pump();
 const recovering={threadId:spawn.threadId,turnId:'retry',rootTurnId:'root',state:'recovering' as const};f.states.set(spawn.threadId,recovering);f.broker.observe(recovering);f.advance(6000);await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,0);
 const complete={...recovering,state:'completed' as const,summary:'Review finished'};f.states.set(spawn.threadId,complete);f.broker.observe(complete);f.advance(2100);await f.restart();await f.broker.reconcile();await f.service.pump();
 const notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);assert.match(notices[0]!.input,/<opencraft_child_update/);assert.match(notices[0]!.input,/completed/);
 f.advance(10_000);await f.broker.reconcile();await f.service.pump();assert.equal(f.inputs.filter(input=>input.threadId==='parent').length,1);
 assert.equal(f.service.usageSubmission('parent',ACTOR_ID(notices[0]!.id))?.sourceKind,'system');
});
function ACTOR_ID(id:string){return 'actor-input:'+id;}

test('short wait returns a persistent ticket while an unavailable child is still recovering',async t=>{
 const f=await fixture(t),spawn=await f.invoke('spawn','thread_spawn',{prompt:'Review'});
 f.execution.snapshot=async()=>new Promise(()=>{});
 const started=Date.now(),result=await f.invoke('wait','thread_wait',{threadIds:[spawn.threadId],timeoutMs:20});assert.equal(result.settled,false);assert.ok(Date.now()-started<500);
 await f.restart();assert.equal(f.service.orchestration.wait(result.waitTicketId)?.state,'active');
});

test('inspect remains text-only and an absent or revoked delegation cannot use server tools',async t=>{
 const f=await fixture(t),read=await f.invoke('inspect','thread_inspect',{threadId:'other'});assert.equal(read.entries.length,2);assert.doesNotMatch(JSON.stringify(read),/PRIVATE TOOL OUTPUT/);
 await assert.rejects(f.invoke('missing','thread_tell',{threadId:'other',message:'x'},'unbound','turn'),error=>error instanceof CollaborationError&&error.status===403);
 f.revoke();await assert.rejects(f.invoke('revoked','thread_spawn',{prompt:'x'}),error=>error instanceof CollaborationError&&error.status===403);assert.equal(f.creates,0);
});

test('an exhausted root notifies once and direct human input is preserved in the parent notice',async t=>{
 const f=await fixture(t),child=await f.invoke('spawn','thread_spawn',{prompt:'Review'});
 f.service.authorizeExecution(f.a,child.threadId,'direct-input',[{type:'text',text:'Human correction'}]);f.service.executionStarted(child.threadId,'direct-input','human-turn');
 const state={threadId:child.threadId,turnId:'human-turn',rootTurnId:'human-root',state:'exhausted' as const};f.states.set(child.threadId,state);f.broker.observe(state);f.advance(2100);
 await f.broker.reconcile();await f.service.pump();let notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);assert.match(notices[0]!.input,/Direct user input occurred/);
 assert.equal(f.service.orchestration.relation(child.threadId)?.userInputExcerpt,'Human correction');await f.restart();await f.broker.reconcile();await f.service.pump();notices=f.inputs.filter(input=>input.threadId==='parent');assert.equal(notices.length,1);
});

test('a trusted captured delegation survives later steer while fresh calls use the new human authority',async t=>{
 const f=await fixture(t),original=f.service.delegation('parent','parent-turn').id;
 f.service.authorizeExecution(f.b,'parent','human-steer');f.service.executionStarted('parent','human-steer','parent-turn');assert.equal(f.service.delegation('parent','parent-turn').context.actorId,f.b.actorId);
 const result=await f.broker.invoke('parent','parent-turn','captured-call','thread_spawn',{prompt:'Accepted before steer'},original) as any;
 assert.equal(f.service.orchestration.relation(result.threadId)?.ownerActorId,f.a.actorId);
 const next=await f.invoke('fresh','thread_spawn',{prompt:'Accepted after steer'});assert.equal(f.service.orchestration.relation(next.threadId)?.ownerActorId,f.b.actorId);
});

test('automatic continuation retains bounded authority and exact persisted system identity after restart',async t=>{
 const f=await fixture(t),authority=f.service.delegation('parent','parent-turn');f.service.executionContinuing('parent','parent-turn','continuation-id');
 assert.equal(f.service.usageSubmission('parent','continuation-id')?.sourceKind,'system');assert.equal(f.service.inputDelegation('parent','continuation-id'),authority.id);
 await f.restart();f.service.executionStarted('parent','continuation-id','retry-turn');assert.equal(f.service.delegation('parent','retry-turn').id,authority.id);
 assert.equal(f.service.usageSubmission('parent','continuation-id')?.actorKind,'session');assert.equal(f.service.usageSubmission('parent','unknown-id'),null);
});

test('a transient snapshot error returns a durable unsettled wait instead of a tool failure',async t=>{
 const f=await fixture(t),child=await f.invoke('spawn','thread_spawn',{prompt:'Review'});f.execution.snapshot=async()=>{throw Error('Host temporarily detached');};
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
 const args={prompt:'Create once',idempotencyKey:'shared'},a=f.invoke('alias-A','thread_spawn',args),b=f.invoke('alias-B','thread_spawn',args);
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
 const result=await f.invoke('spawn-ack','thread_spawn',{prompt:'Review'});await f.restart();assert.equal(f.service.pendingOrchestrationAcks().length,1);
 acknowledged=true;await f.broker.reconcile();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.service.pendingOrchestrationAcks().length,0);assert.equal(f.creates,1);assert.ok(attempts>=2);
 assert.deepEqual(await f.invoke('spawn-ack','thread_spawn',{prompt:'Review'}),result);
});

test('a definitive Native creation rejection has a durable failure and ACKs its cached error',async t=>{
 const f=await fixture(t);let rejected=0,acks=0;f.execution.create=async()=>{rejected++;return {rejected:{status:400}};};f.execution.acknowledge=async()=>{acks++;return true;};
 const call=()=>f.invoke('rejected-create','thread_spawn',{prompt:'Rejected'});await assert.rejects(call(),error=>error instanceof CollaborationError&&error.status===400);await f.restart();
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
 await assert.rejects(f.invoke('late-revoke','thread_spawn',{prompt:'Do not send'}),error=>error instanceof CollaborationError&&error.status===403);await f.service.pump();assert.equal(f.inputs.length,0);
 assert.equal(f.service.orchestration.threads()[0]?.ownerActorId,f.a.actorId);assert.equal(f.service.orchestration.operation('parent:parent-turn:late-revoke')?.state,'failed');assert.equal(acks,1);
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
 const f=await fixture(t),child=await f.invoke('stop-child','thread_spawn',{prompt:'Review'});f.broker.observe({threadId:child.threadId,turnId:'turn',rootTurnId:'root',state:'interrupted_by_user'});
 assert.equal(f.service.orchestration.relation(child.threadId)?.hasDirectUserInput,true);
});
