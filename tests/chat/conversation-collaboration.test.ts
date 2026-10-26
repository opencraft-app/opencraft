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
