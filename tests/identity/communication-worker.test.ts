import {OrchestrationRuntimeWorker} from '../../packages/access-control/src/orchestration-runtime-store';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {parsePrincipal} from '@opencraft/identity-core';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration} from '../../packages/access-control/src/collaboration';

async function fixture(t:test.TestContext){
 const dir=await mkdtemp(join(tmpdir(),'communication-worker-'));
 const storage=await openServerDatabase(dir), actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=(subject:string)=>actors.resolveHuman(parsePrincipal({provider:'local',subject,displayName:subject,expiresAt:Date.now()+60000})!)!;
 const alice=human('Alice'),bob=human('Bob');
 const bot=actors.createSession('Bot',alice.actorId),credential=actors.issueCredential(bot.id,Date.now()+60000,alice.actorId),botContext=actors.authenticateSession(credential.token)!;
 const call=(actor:typeof alice,method:string,params:Record<string,unknown>={})=>service.communicate(actor,'opencraft/channels/'+method,params);
 const group=await call(alice,'group/create',{title:'Room',memberActorIds:[bob.actorId,bot.id],clientRequestId:'room'});
 const send=(actor:typeof alice,id:string,text=id)=>call(actor,'messages/send',{channelId:group.id,clientMessageId:id,parts:[{type:'text',text}]});
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 return {storage,actors,service,alice,bob,bot,credential,botContext,call,group,send};
}
test('managed Worker delivers Human/Bot messages and empty channels without an execution Host',async t=>{
 const f=await fixture(t);assert.equal(f.service.hasExecution,false);f.service.start();await f.service.pump();
 const empty=await f.service.syncInbox(f.bob);assert.equal(empty.changes[0].item?.latestMessage,null);
 await f.send(f.botContext,'bot');
 assert.equal((await f.service.syncInbox(f.bob)).changes[0].item?.unreadCount,1);
 assert.equal((await f.service.syncInbox(f.botContext)).changes[0].item?.unreadCount,0);
 const receipts=await Promise.all(Array.from({length:8},()=>f.send(f.alice,'same')));
 assert.equal(new Set(receipts.map(x=>x.receipt.messageId)).size,1);
 await assert.rejects(f.send(f.alice,'same','different'),/idempotency/);
 assert.equal(f.storage.database.prepare('SELECT COUNT(*) AS n FROM actor_execution_requests').get()!.n,0);
 f.actors.setGrant(f.alice.actorId,f.bot.id,'message.send',true,'fixture');
 const dm=await f.call(f.alice,'direct/open',{actorId:f.bot.id});
 const row=(await f.service.syncInbox(f.alice)).changes.find(x=>x.channelId===dm.id)!;
 assert.equal(row.item?.kind,'direct');assert.equal(row.item?.latestMessage,null);
});
test('read frontier is monotonic across clients; removed members get tombstones and rejoin starts unread at admission',async t=>{
 const f=await fixture(t),first=await f.send(f.alice,'first');
 const original=await f.service.syncInbox(f.bob);
 await f.call(f.bob,'read',{channelId:f.group.id,throughSequence:first.receipt.sequence});
 const read=await f.service.syncInbox(f.bob,original.cursor);assert.equal(read.changes[0].item?.unreadCount,0);
 await f.send(f.alice,'second');
 await f.call(f.bob,'read',{channelId:f.group.id,throughSequence:0});
 assert.equal((await f.service.syncInbox(f.bob)).changes[0].item?.unreadCount,1);
 const change=(present:boolean,key:string)=>f.call(f.alice,'group/member/set',{channelId:f.group.id,actorId:f.bob.actorId,present,clientRequestId:key});
 const history=await f.call(f.bob,'sync',{channelId:f.group.id});
 await change(false,'remove');
 await assert.rejects(f.send(f.bob,'forbidden'),/channel_denied/);
 await assert.rejects(f.call(f.bob,'sync',{channelId:f.group.id}),/channel_denied/);
 const removed=await f.service.syncInbox(f.bob,read.cursor);assert.equal(removed.changes[0].item,null);
 await f.send(f.alice,'absent');await change(true,'rejoin');
 assert.equal((await f.service.syncInbox(f.bob,removed.cursor)).changes[0].item?.unreadCount,0);
 assert.equal((await f.call(f.bob,'sync',{channelId:f.group.id,cursor:history.cursor})).kind,'snapshot');
});
test('queued writes recheck revoked credentials and unavailable wakes roll back the message',async t=>{
 const f=await fixture(t);
 // Initialize the Worker identity cache before revoking from the Server owner.
 await f.send(f.botContext,'warmup');
 const rawWorker=new OrchestrationRuntimeWorker(f.storage.database.location()!);
 await rawWorker.communicate({context:f.botContext,method:'opencraft/channels/list',params:{}});
 f.actors.revokeCredential(f.credential.credentialId,f.alice.actorId);
 try { await assert.rejects(rawWorker.communicate({context:f.botContext,method:'opencraft/channels/list',params:{}}),/actor_authentication_required/); }
 finally { await rawWorker.close(); }
 await assert.rejects(f.send(f.botContext,'revoked'),/actor_authentication_required/);
 f.actors.setGrant(f.alice.actorId,f.bot.id,'execution.queue',true,'fixture');
 await assert.rejects(f.call(f.alice,'messages/send',{channelId:f.group.id,clientMessageId:'wake',parts:[{type:'text',text:'wake'}],wakeActorIds:[f.bot.id]}),/channel_wake_unavailable/);
 assert.equal(f.storage.database.prepare('SELECT COUNT(*) AS n FROM actor_messages').get()!.n,1);
});
