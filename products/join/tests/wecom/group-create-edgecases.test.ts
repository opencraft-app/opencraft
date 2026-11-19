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

const create=(f:any,title='Launch')=>f.channel(f.alice,'group/create',{title,memberActorIds:[f.bob.actorId],clientRequestId:'g',wecom:true});
const pc=(f:any,id:string)=>JSON.parse(f.db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').get(id).value as string).pendingCreate;
const binding=(f:any)=>({serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),actorId:f.alice.actorId,source,epoch:1,title:'Launch',generation:'g',nativeGroup:true});

test('first creation claim freezes the current native title, not the title captured at group creation',async t=>{
 const f=await fixture(t),g:any=await create(f);
 await f.channel(f.alice,'group/rename',{channelId:g.id,title:'Latest title',clientRequestId:'rename'});
 const claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.equal(claim.title,'Latest title');
});
test('a member removed after identity settlement but before first claim is never invited',async t=>{
 const f=await fixture(t),g:any=await create(f);
 await f.call('join/wecom-sync/member-identity-settle',{channelId:g.id,corpId:'wxfixture'});
 await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
 const claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.deepEqual(claim.members,[]);
});
test('a known member added after identity settlement is included in the first request',async t=>{
 const f=await fixture(t),g:any=await create(f);
 f.service.actors.bindHuman(f.dave,{provider:'wecom.wxfixture',subject:'WC',displayName:'Dave',expiresAt:Date.now()+3600000});
 await f.call('join/wecom-sync/member-identity-settle',{channelId:g.id,corpId:'wxfixture'});
 await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.dave.actorId,present:true,clientRequestId:'add'});
 const claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.deepEqual([...claim.members].sort(),['WB','WC']);
});
test('a settlement without an attempt cannot erase the lease of a dispatched creation',async t=>{
 const f=await fixture(t),g:any=await create(f),claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id}),before=structuredClone(pc(f,g.id));
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,code:'response_lost',retryable:false});
 assert.deepEqual(pc(f,g.id),before);assert.equal(await f.call('join/wecom-sync/create-claim',{channelId:g.id}),null);
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:claim.attempt,code:'real_failure',retryable:false});assert.equal(pc(f,g.id).state,'failed');
});
test('an uncorrelated success cannot attach a dispatched creation',async t=>{
 const f=await fixture(t),g:any=await create(f),claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,binding:binding(f)});
 assert.ok(pc(f,g.id));assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=?').get(g.id).n,0);
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:claim.attempt,binding:binding(f)});
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=?').get(g.id).n,1);
});
test('claim-response loss does not manufacture a creation failure or release the committed claim',async t=>{
 const f=await fixture(t),g:any=await create(f);let captured:any,requests=0;
 const call=async(m:string,p:any)=>{const result:any=await f.call(m,p);if(m.endsWith('/create-claim')&&result){captured=result;throw Error('worker_response_lost');}return result;};
 const pump=createGroupSyncPump({corpId:'wxfixture',call,request:async()=>{requests++;throw Error('must_not_send');},onError:()=>{}});
 try{await pump.poll();assert.ok(captured);assert.equal(requests,0);assert.ok(pc(f,g.id).leaseUntil>Date.now());assert.equal(pc(f,g.id).attempts,0);assert.equal(await f.call('join/wecom-sync/create-claim',{channelId:g.id}),null);}
 finally{await pump.close();}
});
test('provider title shortening never cuts an emoji surrogate pair in half',async t=>{
 const f=await fixture(t),g:any=await create(f,'a'.repeat(59)+'😀');
 const claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.equal(claim.title.isWellFormed(),true);assert.ok(claim.title.length<=60);assert.equal(claim.title,'a'.repeat(59));
});
test('once dispatched, retries retain the immutable request while current edits are reconciled',async t=>{
 const f=await fixture(t),g:any=await create(f),first:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 await f.call('join/wecom-sync/create-settle',{channelId:g.id,attempt:first.attempt,code:'uncertain',retryable:true});
 await f.channel(f.alice,'group/rename',{channelId:g.id,title:'Later',clientRequestId:'later'});
 await f.channel(f.alice,'group/member/set',{channelId:g.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'retry'});
 const next:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});assert.equal(next.title,first.title);assert.deepEqual(next.members,first.members);assert.notEqual(next.attempt,first.attempt);
});
test('duplicate failure receipts cannot spend automatic retry attempts twice',async t=>{
 const f=await fixture(t),g:any=await create(f),claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 const result={channelId:g.id,attempt:claim.attempt,code:'unavailable',retryable:true};await f.call('join/wecom-sync/create-settle',result);const before=structuredClone(pc(f,g.id));
 await f.call('join/wecom-sync/create-settle',result);assert.deepEqual(pc(f,g.id),before);
});
test('a late failure for an already settled attempt cannot overwrite an owner retry before its next claim',async t=>{
 const f=await fixture(t),g:any=await create(f),claim:any=await f.call('join/wecom-sync/create-claim',{channelId:g.id});
 const result={channelId:g.id,attempt:claim.attempt,code:'failure',retryable:false};await f.call('join/wecom-sync/create-settle',result);
 await f.channel(f.alice,'group/sync/refresh',{channelId:g.id,clientRequestId:'new-retry'});const before=structuredClone(pc(f,g.id));
 await f.call('join/wecom-sync/create-settle',result);assert.deepEqual(pc(f,g.id),before);assert.ok(await f.call('join/wecom-sync/create-claim',{channelId:g.id}));
});
