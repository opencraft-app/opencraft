import '../../plugins/wecom/assistant-install.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openServerDatabase} from '@opencraft/storage-node/server';import {ActorStore} from '../../../../packages/access-control/src/actors';import {Collaboration} from '../../../../packages/access-control/src/collaboration';
import {syncHash} from '../../plugins/wecom/group-sync.mjs';
import {createGroupSyncPump} from '../../plugins/wecom/mirror/group-sync-target.mjs';

async function fixture(t:test.TestContext){
  const dir=await mkdtemp(join(tmpdir(),'wecom-create-')),old=process.env.OPENCRAFT_DATA_DIR,oldWs=process.env.OPENCRAFT_WORKSPACE_DIR;process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=dir+'-ws';
  const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors),db=storage.database;
  t.after(async()=>{await service.close();actors.close();await storage.close();await rm(dir,{recursive:true,force:true});if(old===undefined)delete process.env.OPENCRAFT_DATA_DIR;else process.env.OPENCRAFT_DATA_DIR=old;if(oldWs===undefined)delete process.env.OPENCRAFT_WORKSPACE_DIR;else process.env.OPENCRAFT_WORKSPACE_DIR=oldWs;});
  const human=(id:string)=>actors.resolveHuman({provider:'tencentoa',subject:id,displayName:id,expiresAt:Date.now()+3600000})!;
  const alice=human('alice'),bob=human('bob'),dave=human('dave');
  for(const [c,id] of [[alice,'WA'],[bob,'WB']] as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+3600000});
  const channel=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p);
  const call=(method:string,params:any)=>service.synchronizeChannels({method,params});
  return {service,db,alice,bob,dave,channel,call};
}
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','newroom']);


function provider(f:any){
 const events:any[]=[],members=new Set<string>();let title='',created=false;
 const binding={serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),actorId:f.alice.actorId,source,epoch:1,title:'Launch',generation:'g',nativeGroup:true};
 const request=async(action:string,p:any)=>{
  events.push([action,structuredClone(p)]);
  if(action==='native-chat-create'){
   if(!created){created=true;title=p.title;for(const id of ['WA',...p.members])members.add(id);}
   return{binding};
  }
  if(action==='group-sync'){
   if(p.change?.kind==='name')title=p.change.name;
   if(p.change?.kind==='member'){if(p.change.present)members.add(p.change.userId);else members.delete(p.change.userId);}
   return{state:'confirmed',snapshot:{externalId:'newroom',name:title,memberIds:[...members]},binding};
  }
  throw Error(action);
 };
 return{request,events,members,binding,title:()=>title};
}
function pump(f:any,p:any,request=p.request){let time=Date.now();const errors:any[]=[];
 const instance=createGroupSyncPump({call:f.call,corpId:'wxfixture',request,resolveNativeMembers:async()=>{},now:()=>time,onError:(e:any)=>errors.push(e)});
 return{...instance,errors,async tick(){time+=60000;await instance.poll();}};
}
const create=(f:any,members=[f.bob.actorId])=>f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:members,clientRequestId:'g',wecom:true});
const status=(f:any,id:string,c=f.alice)=>f.channel(c,'group/sync/status',{channelId:id});
const row=(f:any,id:string)=>JSON.parse(f.db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').get(id).value as string);

test('queued rename is included in the first provider creation without a redundant rename',async t=>{
 const f=await fixture(t),g:any=await create(f),p=provider(f);
 await f.channel(f.alice,'group/rename',{channelId:g.id,title:'Renamed',clientRequestId:'rename'});
 const sync=pump(f,p);await sync.tick();assert.deepEqual(row(f,g.id).operations,[]);assert.equal(p.events.find(([a])=>a==='native-chat-create')[1].title,'Renamed');
 await sync.tick();assert.equal(p.title(),'Renamed');assert.equal(f.service.channels.get(f.alice,g.id).title,'Renamed');
 assert.equal(p.events.filter(([a])=>a==='native-chat-create').length,1);assert.deepEqual(sync.errors,[]);
});
test('in-flight member removal is delivered, without replacing unrelated provider membership',async t=>{
 const f=await fixture(t),g:any=await create(f),p=provider(f);
 const sync=pump(f,p,async(a:string,input:any)=>{
  const result=await p.request(a,input);
  if(a==='native-chat-create'){
   p.members.add('UNRELATED');
   await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
  }return result;
 });
 await sync.tick();assert.equal(f.service.channels.isMember(g.id,f.bob.actorId),false);
 assert.deepEqual(row(f,g.id).operations.map((o:any)=>[o.userId,o.present]),[['WB',false]]);
 await sync.tick();assert.equal(p.members.has('WB'),false);assert.equal(p.members.has('UNRELATED'),true);assert.deepEqual(sync.errors,[]);
});
test('in-flight additions include known members and retain unresolved identities for the existing resolver',async t=>{
 const f=await fixture(t),g:any=await create(f),p=provider(f);
 const known=f.service.actors.resolveHuman({provider:'tencentoa',subject:'known',displayName:'Known',expiresAt:Date.now()+3600000})!;
 f.service.actors.bindHuman(known,{provider:'wecom.wxfixture',subject:'WC',displayName:'Known',expiresAt:Date.now()+3600000});
 const sync=pump(f,p,async(a:string,input:any)=>{
  const result=await p.request(a,input);
  if(a==='native-chat-create')for(const actorId of [known.actorId,f.dave.actorId])await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId,present:true,clientRequestId:'add-'+actorId});
  return result;
 });
 await sync.tick();assert.deepEqual(row(f,g.id).createdFrom.missing,[f.dave.actorId]);
 await sync.tick();assert.equal(p.members.has('WC'),true);assert.deepEqual(sync.errors,[]);
});
test('creation status projects queued, in-flight and failed states, without leaking provider identity',async t=>{
 const f=await fixture(t),g:any=await create(f);
 let view:any=await status(f,g.id);assert.equal(view.state,'pending');assert.equal(view.canRefresh,true);
 const attempt:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 view=await status(f,g.id);assert.equal(view.state,'syncing');assert.equal(typeof view.lastAttemptAt,'number');
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:attempt.attempt,code:'identity_denied token=secret',retryable:false});
 view=await status(f,g.id);assert.equal(view.state,'error');assert.equal(view.canRefresh,true);
 assert.doesNotMatch(JSON.stringify(view),/WA|WB|token|secret|ownerId|memberUserIds/);
 const member:any=await status(f,g.id,f.bob);assert.equal(member.canRefresh,false);
 await assert.rejects(f.channel(f.bob,'group/sync/refresh',{channelId:g.id,clientRequestId:'forbidden'}),/wecom_sync_owner_required/);
 const retry:any=await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'retry'});assert.equal(retry.state,'pending');
});
test('manual creation retry reuses frozen payload, reconciles edits, and never creates a second provider group',async t=>{
 const f=await fixture(t),g:any=await create(f),p=provider(f);let lost=true;
 const sync=pump(f,p,async(a:string,input:any)=>{
  const result=await p.request(a,input);
  if(a==='native-chat-create'&&lost){lost=false;
   await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
   await f.channel(f.alice,'group/rename',{channelId:g.id,title:'After timeout',clientRequestId:'rename'});
   throw Error('response_lost');
  }return result;
 });
 await sync.tick();const frozen=structuredClone(row(f,g.id).pendingCreate.request);
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'retry'});
 await sync.tick();await sync.tick();await sync.tick();
 const requests=p.events.filter(([a])=>a==='native-chat-create').map(([,input])=>input);
 assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(requests[0],{channelId:g.id,...frozen});
 assert.equal(p.members.has('WB'),false);assert.equal(p.title(),'After timeout');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=?').get(g.id).n,1);
});
test('manual retry is idempotent and cannot override a live attempt or a newer failure',async t=>{
 const f=await fixture(t),g:any=await create(f);
 const first:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'while-running'});
 assert.equal(await f.call('join/wecom-sync/create-claim',{channelId:g.id}),null);
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:first.attempt,code:'failure',retryable:false});
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'retry-once'});
 const second:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.notEqual(second.attempt,first.attempt);
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:first.attempt,code:'stale',retryable:false});
 assert.equal((await status(f,g.id)).state,'syncing');
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:second.attempt,code:'failure',retryable:false});
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'retry-once'});
 assert.equal((await status(f,g.id)).state,'error');
});
test('the full 63-member selection survives the first batch limit and is delivered by ordinary member operations',async t=>{
 const f=await fixture(t),ids:string[]=[];
 for(let i=0;i<63;i++){
  const c=f.service.actors.resolveHuman({provider:'tencentoa',subject:'extra'+i,displayName:'Extra '+i,expiresAt:Date.now()+3600000})!;
  f.service.actors.bindHuman(c,{provider:'wecom.wxfixture',subject:'U'+i,displayName:'U'+i,expiresAt:Date.now()+3600000});ids.push(c.actorId);
 }
 const g:any=await create(f,ids),p=provider(f);
 assert.equal(row(f,g.id).pendingCreate.memberUserIds.length,49);assert.equal(row(f,g.id).pendingCreate.missing.length,14);
 await f.call('join/wecom-sync/member-identity-settle',{channelId:g.id,corpId:'wxfixture'});
 assert.equal(row(f,g.id).pendingCreate.missing.length,14);
 const sync=pump(f,p);await sync.tick();
 assert.equal(row(f,g.id).operations.length,14);assert.equal(row(f,g.id).createdFrom.missing.length,0);
 for(let i=0;i<14;i++)await sync.tick();
 assert.equal(p.members.size,64);for(let i=0;i<63;i++)assert.equal(p.members.has('U'+i),true);
 assert.equal(row(f,g.id).operations.every((o:any)=>o.state==='confirmed'),true);assert.deepEqual(sync.errors,[]);
});
test('an unbound pending member removed before attachment is not later re-added',async t=>{
 const f=await fixture(t),g:any=await create(f,[f.bob.actorId,f.dave.actorId]),p=provider(f);
 const sync=pump(f,p,async(a:string,input:any)=>{
  const result=await p.request(a,input);
  if(a==='native-chat-create')await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.dave.actorId,present:false,clientRequestId:'remove'});
  return result;
 });
 await sync.tick();assert.deepEqual(row(f,g.id).createdFrom.missing,[]);assert.deepEqual(row(f,g.id).operations,[]);
});

test('dissolution before provider creation prevents any external creation attempt',async t=>{
 const f=await fixture(t),g=await create(f),p=provider(f),worker=pump(f,p);
 await f.channel(f.alice,'group/dissolve',{channelId:g.id,expectedRevision:g.lifecycle.revision,clientRequestId:'close'});
 await worker.tick();assert.equal(p.events.length,0);assert.deepEqual(worker.errors,[]);
 assert.equal((await status(f,g.id)).state,'disconnected');
});
test('provider creation finishing after native dissolution records an inactive room tombstone, never a replacement group',async t=>{
 const f=await fixture(t),g=await create(f),p=provider(f);
 const claim=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.ok(claim?.attempt);
 await f.channel(f.alice,'group/dissolve',{channelId:g.id,expectedRevision:g.lifecycle.revision,clientRequestId:'close'});
 const result=await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:claim.attempt,binding:p.binding});assert.equal(result.state,'failed');
 assert.equal(f.db.prepare('SELECT active FROM actor_channel_sources WHERE source=?').get(source)?.active,0);
 await assert.rejects(f.call('mirrorBind',{corpId:'wxfixture',binding:p.binding}),/channel_denied/);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channels WHERE peer_id IS NULL').get()?.n,1);
});
