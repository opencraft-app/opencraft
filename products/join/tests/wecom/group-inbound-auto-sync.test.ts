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


async function attached(t:test.TestContext){
 const f=await fixture(t),binding={source,epoch:1,title:'Provider',actorId:f.alice.actorId,humanKey:syncHash(['wecom','wxfixture','WA']),serverId:'one',generation:'g',nativeGroup:false};
 const g:any=await f.call('mirrorBind',{corpId:'wxfixture',binding});
 await f.call('addSource',{binding:{source,channelId:g.channelId},incarnation:'attached',images:true});
 const status=()=>f.channel(f.alice,'group/sync/status',{channelId:g.channelId});
 const dbrow=()=>{const row=f.db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').get(g.channelId);return row?JSON.parse(row.value as string):null;};
 const entry=()=>f.db.prepare('SELECT epoch FROM actor_channel_sources WHERE source=?').get(source);
 let name='Provider',members=['WA','WB'];const events:any[]=[],errors:any[]=[];let time=Date.now();
 const request=async(action:string,p:any)=>{events.push([action,structuredClone(p)]);assert.equal(action,'group-sync');
  if(p.change?.kind==='name')name=p.change.name;
  if(p.change?.kind==='member')members=p.change.present?[...new Set([...members,p.change.userId])]:members.filter(id=>id!==p.change.userId);
  return{state:'confirmed',binding,snapshot:{externalId:'newroom',name,memberIds:[...members]}};
 };
 const pump=createGroupSyncPump({call:f.call,corpId:'wxfixture',request,now:()=>time,onError:(e:any)=>errors.push(e)});
 return{...f,binding,g,status,dbrow,entry,events,errors,pump,request,provider:()=>({name,members}),setProvider:(n:string,m:string[])=>{name=n;members=m},tick:async()=>{time+=60000;await pump.poll();}};
}

test('an externally created group automatically imports its existing roster and syncs names and membership both ways',async t=>{
 const f=await attached(t);assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),false);
 await f.tick();assert.deepEqual(f.errors,[]);assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),true);
 const row=f.dbrow();assert.equal(row.config.name,'both');assert.equal(row.config.members,'both');assert.equal(row.config.historyAccess,'full');assert.equal(row.config.initial,'external');
 assert.equal(f.service.channels.get(f.alice,f.g.channelId).title,'Provider');
 await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Native rename',clientRequestId:'rename'});await f.tick();assert.equal(f.provider().name,'Native rename');
 await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId:f.bob.actorId,present:false,clientRequestId:'remove'});await f.tick();assert.equal(f.provider().members.includes('WB'),false);
 f.setProvider('Provider rename',['WA','WB']);await f.tick();assert.equal(f.service.channels.get(f.alice,f.g.channelId).title,'Provider rename');assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),true);
 assert.deepEqual(f.errors,[]);
});
test('previous observation-only attachment upgrades and delivers the successful local rename exactly once',async t=>{
 const f=await attached(t);await f.channel(f.alice,'group/sync/refresh',{channelId:f.g.channelId,clientRequestId:'check'});
 await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'测试',clientRequestId:'rename'});
 assert.equal(f.dbrow().observationOnly,true);assert.equal(f.dbrow().operations.length,0);
 await f.tick();assert.equal(f.dbrow().observationOnly,undefined);assert.equal(f.dbrow().operations.filter((o:any)=>o.kind==='name').length,1);
 await f.tick();await f.tick();assert.equal(f.provider().name,'测试');assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),true);
 assert.equal(f.events.filter(([,p])=>p.change?.kind==='name').length,1);assert.deepEqual(f.errors,[]);
});
test('legacy explicit member removals are preserved instead of being undone by initial external import',async t=>{
 const f=await attached(t);await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId:f.bob.actorId,present:false,clientRequestId:'remove-before-sync'});
 await f.tick();assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),false);
 assert.deepEqual(f.dbrow().operations.map((o:any)=>[o.userId,o.present]),[['WB',false]]);
 await f.tick();assert.equal(f.provider().members.includes('WB'),false);assert.deepEqual(f.errors,[]);
});
test('legacy explicit additions absent from WeCom are delivered, including late-bound identities',async t=>{
 const f=await attached(t);f.setProvider('Provider',['WA']);
 for(const actorId of [f.bob.actorId,f.dave.actorId])await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId,present:true,clientRequestId:'add-'+actorId});
 await f.tick();assert.deepEqual(f.dbrow().localOnly,[f.dave.actorId]);
 await f.tick();assert.equal(f.provider().members.includes('WB'),true);assert.deepEqual(f.errors,[]);
});
test('only verified current bindings whose owner still belongs to the provider can enable synchronization',async t=>{
 const f=await attached(t),[intent]=await f.call('join/wecom-sync/adoption-list',{corpId:'wxfixture'}) as any[];
 const adopt=(p:any)=>f.call('join/wecom-sync/adopt-linked',{...intent,corpId:'wxfixture',binding:f.binding,snapshot:{externalId:'newroom',name:'Provider',memberIds:['WA','WB']},...p});
 await assert.rejects(adopt({binding:{...f.binding,actorId:f.bob.actorId}}),/binding_mismatch/);
 await assert.rejects(adopt({snapshot:{externalId:'newroom',name:'Provider',memberIds:['WB']}}),/owner_required/);
 await assert.rejects(adopt({sourceEpoch:'retired'}),/retired/);assert.equal(f.dbrow(),null);
});
test('a policy changed while provider read is in flight is not overridden by automatic initialization',async t=>{
 const f=await attached(t),[intent]=await f.call('join/wecom-sync/adoption-list',{corpId:'wxfixture'}) as any[];
 // Exercise the existing owner-only configuration owner, not direct database writes.
 const {groupSyncCli}=await import('../../plugins/wecom/group-sync-storage.mjs');
 groupSyncCli(f.service,f.db,f.alice,{source,channelId:f.g.channelId},{args:['sync','configure',JSON.stringify({name:'off'})],key:'explicit-off'});
 const result=await f.call('join/wecom-sync/adopt-linked',{...intent,corpId:'wxfixture',binding:f.binding,snapshot:{externalId:'newroom',name:'Provider',memberIds:['WA','WB']}});
 assert.equal(result,null);assert.equal(f.dbrow().config.name,'off');assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),false);
});
test('private chats, disconnected bindings, and explicitly paused groups are excluded',async t=>{
 const f=await attached(t);await f.tick();
 // The automatic policy is an initializer, never a replacement for explicit pause.
 const row=f.dbrow();row.paused=true;row.config.members='observe';f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),source);
 assert.deepEqual(await f.call('join/wecom-sync/adoption-list',{corpId:'wxfixture'}),[]);
 f.db.prepare('UPDATE actor_channel_sources SET active=0 WHERE source=?').run(source);
 assert.deepEqual(await f.call('join/wecom-sync/adoption-list',{corpId:'wxfixture'}),[]);
});
test('failed provider reads leave native access and the local title untouched',async t=>{
 const f=await attached(t),pump=createGroupSyncPump({call:f.call,corpId:'wxfixture',request:async()=>{throw Error('offline')},onError:()=>{}});
 await pump.poll();assert.equal(f.dbrow(),null);assert.equal(f.service.channels.isMember(f.g.channelId,f.bob.actorId),false);assert.equal(f.service.channels.get(f.alice,f.g.channelId).title,'Provider');
});

test('authenticated legacy Relay bindings without a generation remain supported',async t=>{
 const f=await attached(t),[intent]=await f.call('join/wecom-sync/adoption-list',{corpId:'wxfixture'}) as any[];
 const {generation,...legacy}=f.binding;
 const result:any=await f.call('join/wecom-sync/adopt-linked',{...intent,corpId:'wxfixture',binding:legacy,snapshot:{externalId:'newroom',name:'Provider',memberIds:['WA','WB']}});
 assert.equal(result.adopted,true);assert.equal(f.dbrow().config.members,'both');
 assert.equal(f.dbrow().providerBinding.generation,undefined);
});
