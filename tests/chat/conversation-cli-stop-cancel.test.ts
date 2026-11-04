import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActorStore } from '../../packages/access-control/src/actors';
import { Collaboration, type ConversationExecutionPort } from '../../packages/access-control/src/collaboration';
import { ThreadAccessStore } from '../../packages/access-control/src/thread-access';
import { openServerDatabase } from '../../packages/storage-node/src/server';
import { stopConversation, stopObservation } from '../../apps/opencraft-daemon/src/conversation-stop';
import { stopThread, cancelQueue } from '../../apps/opencraft-cli/src/control';
import { InterruptedTurnRecovery, ProviderTurnRetry } from '../../packages/host-recovery/src/index';
import { CollaborationClient } from '../../packages/appserver-client/src/collaboration';
import { run } from '../../apps/opencraft-cli/src/main';
import { createRoutedConversationExecution } from '../../scripts/conversation-execution.mjs';
import { AppHostServer } from '../../packages/app-host-server/src/index';
import { MemoryTransport } from '@opencraft/appserver-transport-memory';
const ref={serverId:'server',threadId:'thread'}, turn='target-turn';
const observation=(status='inProgress',active:string|null=turn)=>({ref,targetTurnId:turn,turnState:status,activeTurnId:active,source:'native/thread/turns/list',observedAt:1} as any);
async function fixture(t:any) {
 const root=await mkdtemp(join(tmpdir(),'cli-controls-'));let owner=await openServerDatabase(root),actors=new ActorStore(owner);
 const human=actors.resolveHuman({provider:'opaque',subject:'one',displayName:'One',expiresAt:Date.now()+60000})!;
 const other=actors.resolveHuman({provider:'opaque',subject:'two',displayName:'Two',expiresAt:Date.now()+60000})!;
 let access=new ThreadAccessStore(join(root,'access.sqlite'),actors);let admitted=true,attempts=0,deletes=0;const receipts=new Map<string,any>();
 const port:ConversationExecutionPort={serverId:'server',hostId:'host',directory:()=>({instanceId:'i',servers:[{serverId:'server',engine:'codex',label:'Codex',connectionState:'ready',capabilities:{metadata:true,read:true,boundedRead:true,queue:true,steer:true,stop:true,stopObserve:true,queueCancel:true}}]}),
 async validate(){},async receipt(_binding,id){return receipts.get(id)??null;},async add(_binding,id){const row={id:'queue-'+id,state:'queued',targetTurnId:null};receipts.set(id,row);return row;},async steer(){},
 async cancel(_binding,id,_queue,assertCurrent){assertCurrent?.();deletes++;receipts.set(id,{...receipts.get(id),state:'discarded'});return true;},
 async stop(_ref,_target,context){context.resourceOwner!.assertCurrent();attempts++;return {ref,targetTurnId:turn,requestState:'acknowledged',observation:observation('inProgress')};},
 async observeStop(){return observation('interrupted',null);}};
 let service:Collaboration;
 const open=()=>service=new Collaboration(owner,actors,port,Date.now,()=>admitted,(context,r)=>access.allows(r.serverId,r.threadId,context));open();
 t.after(async()=>{await service.close();access.close();actors.close();await owner.close();await rm(root,{recursive:true,force:true});});
 return {root,port,human,other,access,receipts,get service(){return service;},get owner(){return owner;},get deletes(){return deletes;},get attempts(){return attempts;},set admitted(v:boolean){admitted=v;},async restart(){await service.close();access.close();actors.close();await owner.close();owner=await openServerDatabase(root);actors=new ActorStore(owner);access=new ThreadAccessStore(join(root,'access.sqlite'),actors);open();},send:(key='key')=>service.sendConversation(human,{reference:ref,content:'synthetic',idempotencyKey:key,execution:{mode:'queue'}})};
}
test('empty interrupt ACK and exact observation remain independent; observer never mutates',async()=>{
 let interrupts=0,reads=0;const result=await stopConversation(ref,turn,{assertCurrent(){},suppressRecovery(){},observe:async()=>{reads++;return observation();},interrupt:async admit=>{admit();interrupts++;return {};}});
 assert.equal(result.requestState,'acknowledged');assert.equal(result.observation.turnState,'inProgress');assert.equal(interrupts,1);assert.equal(reads,2);
 assert.equal(stopObservation(ref,turn,{data:[{id:'new',status:'inProgress'}]}).turnState,'unknown');
});
test('stale targets and a new Turn at final admission do not send or suppress the new recovery',async()=>{
 let attempts=0,suppression=0;const port={assertCurrent(){},observe:async()=>observation('completed','new'),interrupt:async(admit:()=>boolean)=>{admit();attempts++;},suppressRecovery(){suppression++;}};
 await assert.rejects(stopConversation(ref,turn,port),{code:'stale_turn'});assert.equal(attempts,0);assert.equal(suppression,0);
 port.observe=async()=>observation();port.assertCurrent=()=>{if(++attempts>=3)throw Error('revoked before write');};
 await assert.rejects(stopConversation(ref,turn,port));assert.equal(suppression,0);
});
test('lost stop response preserves unknown even if a read proves interrupted; CLI never replays',async()=>{
 let reads=0,writes=0;const result=await stopConversation(ref,turn,{assertCurrent(){},suppressRecovery(){},observe:async()=>observation(reads++?'interrupted':'inProgress',reads>1?null:turn),interrupt:async admit=>{admit();writes++;throw Error('lost');}});
 assert.equal(result.requestState,'unknown');assert.equal(result.observation.turnState,'interrupted');
 const client={stop:async()=>result,observeStop:async()=>observation('interrupted',null)} as unknown as CollaborationClient;
 await assert.rejects(stopThread(client,ref,turn),{code:'CONTROL_OUTCOME_UNKNOWN'});await stopThread(client,ref,turn,true);assert.equal(writes,1);
 let disconnectedWrites=0;await assert.rejects(stopThread({stop:async()=>{disconnectedWrites++;throw Error('closed');}} as unknown as CollaborationClient,ref,turn),{code:'CONTROL_OUTCOME_UNKNOWN'});assert.equal(disconnectedWrites,1);
});
test('stop/observe enforce current human, private resource and final revocation without a personal principal',async t=>{
 const f=await fixture(t);f.access.created('server','thread',f.human);f.access.set('server','thread','private',1,f.human);
 await assert.rejects(f.service.command(f.other,{action:'stop',reference:ref,expectedTurnId:turn}),{status:403});assert.equal(f.attempts,0);
 const done=await f.service.command(f.human,{action:'stop',reference:ref,expectedTurnId:turn}) as any;assert.equal(done.requestState,'acknowledged');
 const before=f.attempts;await f.service.command(f.human,{action:'stopObserve',reference:ref,expectedTurnId:turn});assert.equal(f.attempts,before);
 f.port.stop=async(_ref,_turn,context)=>{assert.equal(context.executionPrincipal,undefined);f.admitted=false;context.resourceOwner!.assertCurrent();throw Error('unreachable');};
 await assert.rejects(f.service.command(f.human,{action:'stop',reference:ref,expectedTurnId:turn}),{status:401});
});
test('cancel is original Actor/ref/queue scoped, durable and repeatable without new delete or changed input',async t=>{
 const f=await fixture(t),sent=f.send();const before=f.owner.database.prepare('SELECT * FROM actor_messages WHERE id=?').get(sent.messageId!);
 await f.service.pump();await assert.rejects(f.service.cancelConversation(f.other,ref,sent.requestId!),{status:404});await assert.rejects(f.service.cancelConversation(f.human,{...ref,threadId:'other'},sent.requestId!),{status:404});
 const cancelled=await f.service.cancelConversation(f.human,ref,sent.requestId!);assert.equal(cancelled.receipt.deliveryState,'cancelled');assert.equal(f.deletes,1);
 await f.restart();const repeat=await f.service.cancelConversation(f.human,ref,sent.requestId!);assert.equal(repeat.cancellationState,'cancelled');assert.equal(f.deletes,1);
 assert.deepEqual(f.owner.database.prepare('SELECT * FROM actor_messages WHERE id=?').get(sent.messageId!),before);assert.equal(f.service.lookupConversation(f.human,ref,'key').found,true);
});
test('claim/unknown and a lost delete ACK never authorize a second deletion',async t=>{
 const f=await fixture(t),first=f.send('claimed');await f.service.pump();f.receipts.set(first.requestId!,{id:'q',state:'dispatching'});
 await assert.rejects(f.service.cancelConversation(f.human,ref,first.requestId!),{code:'execution_already_claimed'});assert.equal(f.deletes,0);
 const second=f.send('lost');await f.service.pump();f.port.cancel=async()=>{throw Error('lost delete ACK');};
 const unknown=await f.service.cancelConversation(f.human,ref,second.requestId!);assert.equal(unknown.cancellationState,'unknown');assert.equal(unknown.receipt.deliveryState,'unknown');
 let retried=0;f.port.cancel=async()=>{retried++;return true;};
 for(const state of ['queued','discarded','dispatching']){f.receipts.set(second.requestId!,{id:'q',state});await f.service.pump();await f.restart();await f.service.pump();assert.equal(f.service.conversationDelivery(f.human,ref,second.requestId!).deliveryState,'unknown');assert.equal(f.owner.database.prepare('SELECT reason FROM actor_execution_requests WHERE id=?').get(second.requestId!)!.reason,'cancel_outcome_unknown');await assert.rejects(f.service.cancelConversation(f.human,ref,second.requestId!),{code:'execution_outcome_unknown'});}
 await assert.rejects(f.service.cancelConversation(f.human,ref,second.requestId!),{code:'execution_outcome_unknown'});await f.service.command(f.human,{action:'lookup',reference:ref,idempotencyKey:'lost'});assert.equal(retried,0);
 await assert.rejects(cancelQueue({cancelQueue:async()=>unknown} as unknown as CollaborationClient,ref,second.requestId!),{code:'CONTROL_OUTCOME_UNKNOWN'});
});
test('old collaboration services reject every control before any control RPC',async()=>{
 const calls:any[]=[];const transport=new MemoryTransport({server:{receive(raw,peer){const request=JSON.parse(raw);if(request.id===undefined)return;calls.push(request);peer.send(JSON.stringify({id:request.id,result:{capabilities:{extensions:{'opencraft/collaboration':{version:1}}}}}));}}});
 const client=new CollaborationClient(transport);try{await client.connect();for(const fn of [()=>client.stop(ref,turn),()=>client.observeStop(ref,turn),()=>client.cancelQueue(ref,'request')])await assert.rejects(fn(),{code:'UNSUPPORTED_CAPABILITY'});assert.equal(calls.length,1);}finally{await client.close();}
});

test('target-aware user_stop survives restart without suppressing a different Turn or thread',async t=>{
 const root=await mkdtemp(join(tmpdir(),'stop-recovery-'));let starts=0;
 const port={serialize:async(_id:string,work:()=>Promise<any>)=>work(),inspect:async()=> 'lost' as const,
  continue:async(_turn:any,_current:()=>boolean,admit:()=>boolean)=>{assert.equal(admit(),true);starts++;return 'continued';},changed(){}};
 let recovery=new InterruptedTurnRecovery(root,port);t.after(async()=>{await recovery.close();await rm(root,{recursive:true,force:true});});
 recovery.started('target',turn);recovery.handled('target','user_stop','old');assert.equal(recovery.snapshot('target')!.state,'running');
 recovery.handled('target','user_stop',turn);recovery.started('other','other-turn');recovery.lost();await recovery.recover();assert.equal(starts,1);assert.equal(recovery.snapshot('target')!.handledReason,'user_stop');
 recovery.finished('other','continued');await recovery.close();recovery=new InterruptedTurnRecovery(root,port);await recovery.recover();assert.equal(starts,1);
 recovery.started('target','new-turn');recovery.handled('target','user_stop',turn);assert.equal(recovery.snapshot('target')!.state,'running');
 const retry=new ProviderTurnRetry(join(root,'provider'),{serialize:port.serialize,inspect:async()=> 'unknown' as const,continue:port.continue,changed(){}});t.after(()=>retry.close());
 retry.failed('target','new-turn',{kind:'overloaded'});retry.handled('target',turn);assert.equal(retry.snapshot('target')!.state,'waiting');retry.handled('target','new-turn');assert.equal(retry.snapshot('target')!.state,'handled');
});
test('cancel serializes behind pump and refuses a claim that wins the handoff',async t=>{
 const f=await fixture(t),sent=f.send();let enter=()=>{},release=()=>{};const entered=new Promise<void>(resolve=>enter=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.port.add=async(_binding,id)=>{enter();await held;f.receipts.set(id,{id:'q',state:'dispatching',targetTurnId:turn});return {id:'q',state:'queued',targetTurnId:null};};
 const pump=f.service.pump();await entered;const cancel=f.service.cancelConversation(f.human,ref,sent.requestId!);assert.equal(f.deletes,0);release();await pump;await assert.rejects(cancel,{code:'execution_already_claimed'});assert.equal(f.deletes,0);
});

test('legacy Host rejects control before Native mutation even when the Hub exposes the new public capability',async t=>{
 const methods:string[]=[];const host=new AppHostServer({hostDefinitions:[{hostId:'local-codex',label:'old'}],createTransport(){const listeners=new Set<(frame:string)=>void>();return {status:{state:'open' as const},async connect(){},async close(){},subscribeStatus(){return()=>{};},subscribeMessage(fn:any){listeners.add(fn);return()=>listeners.delete(fn);},async send(raw:string){const request=JSON.parse(raw);if(request.id===undefined)return;methods.push(request.method);for(const listener of listeners)listener(JSON.stringify({id:request.id,result:{capabilities:{extensions:{}}},...(request.__opencraftClient?{__opencraftClient:request.__opencraftClient}:{})}));}};}});t.after(()=>host.close());
 const execution=createRoutedConversationExecution(()=>host,{machineId:'legacy',engines:[],getInputs:async()=>null});const legacyRef={serverId:'server:legacy:codex',threadId:'t'};
 await assert.rejects(execution.stop(legacyRef,turn,{sender:null,resourceOwner:{id:'synthetic',assertCurrent(){}}}),{code:'unsupported_capability'});assert.deepEqual(methods,['initialize']);
 await assert.rejects(execution.cancel({serverId:legacyRef.serverId,hostId:'local-codex',threadId:'t',mode:'queue'},'r','q',()=>{}),{code:'unsupported_capability'});assert.deepEqual(methods,['initialize','initialize']);
 // Existing internal authorization cleanup retains its old Host contract.
 await execution.cancel({serverId:legacyRef.serverId,hostId:'local-codex',threadId:'t',mode:'queue'},'r','q');assert.equal(methods.at(-1),'thread/queue/delete');
});
test('control syntax has no fake key/force path, and queue deletion rechecks last Host admission',async t=>{
 for(const argv of [['thread','stop','t'],['thread','stop','t','--expected-turn','x','--key','fake'],['queue','cancel','t'],['queue','cancel','t','--request','r','--force']])await assert.rejects(run(argv),{exitCode:2});
 const f=await fixture(t),sent=f.send();await f.service.pump();f.port.cancel=async(_binding,_id,_queue,assertCurrent)=>{f.admitted=false;assertCurrent!();throw Error('unreachable');};
 await assert.rejects(f.service.cancelConversation(f.human,ref,sent.requestId!),{status:401});assert.equal(f.deletes,0);assert.equal(f.receipts.get(sent.requestId!)!.state,'queued');
});

for(const code of [undefined,-32600,-32601,-32602])test(`cancel unknown survives receipt failure ${code??'transport'} and restart without another delete`,async t=>{
 const f=await fixture(t),sent=f.send('lost-read');await f.service.pump();
 f.port.cancel=async()=>{throw Error('lost ACK');};await f.service.cancelConversation(f.human,ref,sent.requestId!);
 let repeated=0,reads=0;f.port.cancel=async()=>{repeated++;return true;};const receipt=f.port.receipt.bind(f.port);
 for(let restart=0;restart<2;restart++){
  if(restart)await f.restart();
  f.port.receipt=async(...args)=>{if(++reads%2===1)throw Object.assign(Error('receipt unavailable'),code===undefined?{}:{code});return receipt(...args);};
  await f.service.pump();assert.equal(reads,restart*2+1,'no catch reconciliation read or delete');
  f.port.receipt=receipt;await f.service.pump();reads++;
  assert.equal(f.owner.database.prepare('SELECT reason FROM actor_execution_requests WHERE id=?').get(sent.requestId!)!.reason,'cancel_outcome_unknown');
  assert.equal(f.service.conversationDelivery(f.human,ref,sent.requestId!).deliveryState,'unknown');
  await assert.rejects(f.service.cancelConversation(f.human,ref,sent.requestId!),{code:'execution_outcome_unknown'});assert.equal(repeated,0);
 }
 f.receipts.set(sent.requestId!,{id:'q',state:'delivered',targetTurnId:turn});await f.service.pump();assert.equal(f.service.conversationDelivery(f.human,ref,sent.requestId!).deliveryState,'submitted');assert.equal(repeated,0);
});
