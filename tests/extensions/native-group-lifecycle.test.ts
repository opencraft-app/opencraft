import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openServerDatabase,SERVER_MIGRATIONS} from '@opencraft/storage-node/server';
import {openManagedDatabase} from '@opencraft/sqlite-node';
import {ActorStore} from '../../packages/access-control/src/actors';
import {Collaboration,type ConversationExecutionPort,type ExecutionReceipt} from '../../packages/access-control/src/collaboration';
import {ImChannelsAppServer} from '../../scripts/im-channels-appserver.mjs';
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';

async function fixture(t:test.TestContext,execution?:ConversationExecutionPort){
 const dir=await mkdtemp(join(tmpdir(),'native-lifecycle-')),storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors,execution),db=storage.database;
 const human=(subject:string)=>actors.resolveHuman({provider:'local',subject,displayName:subject,expiresAt:Date.now()+3600000})!;
 const owner=human('owner'),member=human('member'),other=human('other');
 const call=(context:typeof owner,method:string,params:Record<string,unknown>={})=>service.communicate(context,'opencraft/channels/'+method,params);
 const group=await call(owner,'group/create',{title:'Native group',memberActorIds:[member.actorId],clientRequestId:'group'});
 const get=(context=owner)=>call(context,'group/get',{channelId:group.id});
 const send=(context=owner,key='send')=>call(context,'messages/send',{channelId:group.id,clientMessageId:key,parts:[{type:'text',text:key}]});
 const history=(context=owner)=>call(context,'messages/list',{channelId:group.id});
 const source='test/provider/room',sync=(method:string,params:Record<string,unknown>={})=>service.synchronizeChannels({method,params:{incarnation:'initial',...params}});
 const bindings=[{source,channelId:group.id}],arrival={source,id:'provider-message',author:'remote',text:'remote message',at:1};
 t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});});
 return{dir,db,actors,service,owner,member,other,group,call,get,send,history,source,sync,bindings,arrival};
}

test('personal hiding is durable, actor-scoped and emits Inbox tombstones, without revoking access',async t=>{
 const f=await fixture(t);await f.send();
 const before=await f.service.syncInbox(f.member);assert.equal(before.changes.length,1);
 const hidden={channelId:f.group.id,hidden:true,clientRequestId:'hide'};
 await f.call(f.member,'group/list-state/set',hidden);await f.call(f.member,'group/list-state/set',hidden);
 assert.equal((await f.call(f.member,'list')).groups.length,0);
 assert.equal((await f.call(f.owner,'list')).groups.length,1);
 assert.equal((await f.get(f.member)).listState.hidden,true);
 assert.equal((await f.history(f.member)).messages.length,1);
 assert.equal((await f.service.syncInbox(f.member,before.cursor)).changes[0].item,null);
 await f.send(f.member,'hidden-send');assert.equal((await f.call(f.member,'list')).groups.length,0);
 await f.call(f.member,'group/list-state/set',{channelId:f.group.id,hidden:false,clientRequestId:'show'});
 assert.equal((await f.call(f.member,'list')).groups.length,1);
 await assert.rejects(f.call(f.other,'group/list-state/set',hidden),/channel_denied/);
 await assert.rejects(f.call(f.member,'group/list-state/set',{...hidden,hidden:false}),/idempotency/);
});

test('self leave immediately fences history/search/files, is retryable and cannot be undone by provider roster replay',async t=>{
 const f=await fixture(t);await f.send(f.member);
 const old=f.service.channels.memberEpoch(f.group.id,f.member.actorId);
 await f.call(f.owner,'attachments/send',{channelId:f.group.id,clientMessageId:'file',name:'note.txt',type:'text/plain',base64:Buffer.from('private').toString('base64')});
 const file=(await f.history()).messages.at(-1);
 await f.sync('configure',{bindings:f.bindings});await f.send(f.member,'queued-member');await f.send(f.owner,'queued-owner');
 await assert.rejects(f.call(f.owner,'group/leave',{channelId:f.group.id,clientRequestId:'owner-leave'}),/channel_owner_cannot_leave/);
 const leave={channelId:f.group.id,clientRequestId:'leave'};
 await f.call(f.member,'group/leave',leave);await f.call(f.member,'group/leave',leave);
 assert.equal(f.service.channels.memberEpoch(f.group.id,f.member.actorId),null);
 assert.equal((await f.call(f.member,'list')).groups.length,0);
 await assert.rejects(f.history(f.member),/channel_denied/);await assert.rejects(f.send(f.member,'late'),/channel_denied/);
 await assert.rejects(f.call(f.member,'attachments/get',{channelId:f.group.id,sequence:file.sequence}),/channel_denied/);
 assert.equal((await f.call(f.member,'search',{query:'send'})).matches.length,0);
 f.service.channels.projectExternalGroup(f.group.id,{add:[f.member.actorId]});
 assert.equal(f.service.channels.memberEpoch(f.group.id,f.member.actorId),null);
 // Explicit native invitation is new authority, not a replay of external presence.
 await f.call(f.owner,'group/member/set',{channelId:f.group.id,actorId:f.member.actorId,present:true,clientRequestId:'reinvite'});
 assert.notEqual(f.service.channels.memberEpoch(f.group.id,f.member.actorId),old);
 assert.equal((await f.history(f.member)).messages.length,4);
 assert.equal((await f.sync('claim')).text,'queued-owner','only the owner-authored queued write survives');
});

test('dissolution uses owner and revision authority, retains bounded history, rejects every write and never recreates from sync',async t=>{
 const f=await fixture(t);await f.sync('configure',{bindings:f.bindings,images:true});await f.send();
 const claim=await f.sync('claim');assert.ok(claim);
 const expected=(await f.get()).lifecycle.revision;
 await assert.rejects(f.call(f.member,'group/dissolve',{channelId:f.group.id,expectedRevision:expected,clientRequestId:'forged'}),/channel_denied/);
 await f.call(f.owner,'group/rename',{channelId:f.group.id,title:'Renamed',clientRequestId:'rename'});
 await assert.rejects(f.call(f.owner,'group/dissolve',{channelId:f.group.id,expectedRevision:expected,clientRequestId:'stale'}),/channel_revision_conflict/);
 const params={channelId:f.group.id,expectedRevision:(await f.get()).lifecycle.revision,clientRequestId:'close'};
 const closed=await f.call(f.owner,'group/dissolve',params);assert.equal(closed.lifecycle.state,'dissolved');assert.equal(closed.canSend,false);
 assert.deepEqual(await f.call(f.owner,'group/dissolve',params),closed);
 assert.equal((await f.history(f.member)).messages.length,1);
 assert.equal(f.service.channels.memberEpoch(f.group.id,f.owner.actorId),null);
 await assert.rejects(f.send(f.owner,'late-write'),/channel_dissolved/);
 for(const[method,body]of[
  ['group/rename',{title:'Revive'}],['group/member/set',{actorId:f.other.actorId,present:true}],
  ['attachments/send',{clientMessageId:'closed-file',name:'n.txt',type:'text/plain',base64:'eA=='}],
  ['attachments/upload',{clientMessageId:'closed-upload',name:'n.txt',type:'text/plain',base64:'eA==',total:1,offset:0}],
 ]as const)await assert.rejects(f.call(f.owner,method,{channelId:f.group.id,...(method.startsWith('group/')?{clientRequestId:'closed-'+method}:{}),...body}),/channel_dissolved|channel_denied/);
 assert.throws(()=>f.service.channels.projectExternalGroup(f.group.id,{name:'Replay',add:[f.other.actorId]}),/channel_dissolved/);
 await assert.rejects(f.sync('ingest',{source:f.source,arrival:f.arrival}),/channel_source_retired/);
 await assert.rejects(f.sync('addSource',{binding:f.bindings[0]}),/channel_dissolved/);
 await f.sync('configure',{bindings:f.bindings});assert.equal(await f.sync('claim'),null);
 await assert.rejects(f.sync('settle',{...claim,status:'delivered'}),/retired/);
 await f.sync('retireSource',{source:f.source});assert.equal(f.db.prepare('SELECT active FROM actor_channel_sources WHERE source=?').get(f.source)?.active,0);
 assert.equal((await f.history()).messages[0].status,'unknown','an already dispatched provider write is not falsely claimed unsent');
});

test('leaving then dissolution cannot restore the departed actor or affect another group or Bot',async t=>{
 const f=await fixture(t),bot=f.actors.createSession('Independent bot',f.owner.actorId);
 const other=await f.call(f.owner,'group/create',{title:'Other group',memberActorIds:[f.member.actorId,bot.id],clientRequestId:'other'});
 await f.call(f.member,'group/leave',{channelId:f.group.id,clientRequestId:'leave'});
 await f.call(f.owner,'group/dissolve',{channelId:f.group.id,expectedRevision:(await f.get()).lifecycle.revision,clientRequestId:'close'});
 await assert.rejects(f.get(f.member),/channel_denied/);
 assert.equal(f.actors.get(bot.id)?.enabled,true);
 assert.equal(f.service.channels.isMember(other.id,f.member.actorId),true);
 await f.call(f.member,'messages/send',{channelId:other.id,clientMessageId:'unrelated',parts:[{type:'text',text:'unaffected'}]});
});

test('actual AppServer acknowledges self leave and its duplicate, instead of failing its post-write read recheck',async t=>{
 const f=await fixture(t),server=new ImChannelsAppServer(()=>f.service),frames:any[]=[],context={actorContext:f.member,resourceOwner:{assertCurrent(){}}};
 await server.connect();t.after(()=>server.close());server.subscribeMessage((frame:string)=>frames.push(JSON.parse(frame)));
 async function rpc(id:number,method:string,params={}){
  await server.sendWithContext(JSON.stringify({jsonrpc:'2.0',id,method,params,[LOGICAL_CLIENT_FIELD]:'member-device'}),context);
  for(let n=0;n<200&&!frames.some(frame=>frame.id===id);n++)await new Promise(r=>setTimeout(r,10));
  const result=frames.find(frame=>frame.id===id);assert.ok(result,'AppServer reply '+id);return result;
 }
 assert.equal((await rpc(1,'initialize')).error,undefined);
 const params={channelId:f.group.id,clientRequestId:'appserver-leave'};
 assert.equal((await rpc(2,'opencraft/channels/group/leave',params)).result,null);
 assert.equal((await rpc(3,'opencraft/channels/group/leave',params)).result,null);
 assert.equal((await rpc(4,'opencraft/channels/group/get',{channelId:f.group.id})).error.message,'channel_denied');
});

test('additive lifecycle migration upgrades previous schema without changing groups and rejects checksum damage',async t=>{
 const root=await mkdtemp(join(tmpdir(),'lifecycle-upgrade-')),path=join(root,'server.sqlite');t.after(()=>rm(root,{recursive:true,force:true}));
 const old=openManagedDatabase({path,migrations:SERVER_MIGRATIONS.slice(0,-1)});
 old.database.prepare('INSERT INTO actor_channels(id,owner_id,title) VALUES(?,?,?)').run('group:previous','owner','Keep this history');
 old.database.prepare('INSERT INTO actor_channel_members VALUES(?,?,?)').run('group:previous','owner','epoch');old.database.close();
 const upgraded=openManagedDatabase({path,migrations:SERVER_MIGRATIONS});assert.equal(upgraded.outcome.status,'migrated');
 assert.equal(upgraded.database.prepare('SELECT title FROM actor_channels').get()?.title,'Keep this history');
 assert.equal(upgraded.database.prepare('SELECT epoch FROM actor_channel_members').get()?.epoch,'epoch');
 upgraded.database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run('damaged',SERVER_MIGRATIONS.at(-1)!.version);upgraded.database.close();
 assert.throws(()=>openManagedDatabase({path,migrations:SERVER_MIGRATIONS}),/checksum|history/i);
});

test('leave cancels only the departing member group-scoped queue, never another group or an already delivered input',async t=>{
 const receipts=new Map<string,ExecutionReceipt>(),cancelled:string[]=[];
 const execution:ConversationExecutionPort={hostId:'lifecycle-host',async validate(){},async receipt(_binding,id){return receipts.get(id)??null;},
  async add(_binding,id,_input,allowed){assert.ok(allowed?.());const receipt={id:'queued:'+id,state:'queued',targetTurnId:null};receipts.set(id,receipt);return receipt;},
  async steer(){assert.fail('no steering');},async cancel(_binding,id){cancelled.push(id);const r=receipts.get(id)!;receipts.set(id,{...r,state:'discarded'});return true;}};
 const f=await fixture(t,execution),bot=f.actors.createSession('Shared bot',f.owner.actorId);
 await f.service.bind(bot.id,'shared-thread',0,()=>{});
 for(const actor of [f.member,f.owner])f.actors.setGrant(actor.actorId,bot.id,'execution.queue',true,f.owner.actorId);
 await f.call(f.owner,'group/member/set',{channelId:f.group.id,actorId:bot.id,present:true,clientRequestId:'bot'});
 const other=await f.call(f.owner,'group/create',{title:'Unrelated work',memberActorIds:[bot.id,f.member.actorId],clientRequestId:'other'});
 const wake=(channelId:string,key:string)=>f.call(f.member,'messages/send',{channelId,clientMessageId:key,parts:[{type:'text',text:key}],wakeActorIds:[bot.id]});
 await wake(f.group.id,'departing');await wake(other.id,'unrelated');await f.service.pump();
 const requests=f.db.prepare('SELECT r.id,m.channel_id FROM actor_execution_requests r JOIN actor_channel_execution_membership m ON m.request_id=r.id').all();
 const departed=String(requests.find(r=>r.channel_id===f.group.id)!.id),retained=String(requests.find(r=>r.channel_id===other.id)!.id);
 await f.call(f.member,'group/leave',{channelId:f.group.id,clientRequestId:'self-leave'});await f.service.pump();
 assert.deepEqual(cancelled,[departed]);assert.equal(f.db.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(departed)?.state,'rejected');
 assert.equal(f.db.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(retained)?.state,'queued');assert.equal(f.actors.get(bot.id)?.enabled,true);
 // An already committed engine effect is factual; closure revokes further group
 // authority but must not report that this input never ran or kill the shared Bot.
 receipts.set(retained,{...receipts.get(retained)!,state:'delivered'});
 const summary=await f.call(f.owner,'group/get',{channelId:other.id});
 await f.call(f.owner,'group/dissolve',{channelId:other.id,expectedRevision:summary.lifecycle.revision,clientRequestId:'close-other'});await f.service.pump();
 assert.equal(f.db.prepare('SELECT state FROM actor_execution_requests WHERE id=?').get(retained)?.state,'submitted');assert.deepEqual(cancelled,[departed]);assert.equal(f.actors.get(bot.id)?.enabled,true);
});
