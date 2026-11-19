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

test('a native group created with wecom queues one linked provider group and replicates afterwards',async t=>{
  const f=await fixture(t);
  const group=await f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:[f.bob.actorId,f.dave.actorId],clientRequestId:'g1',wecom:true});
  assert.equal(f.service.channels.isMember(group.id,f.bob.actorId),true); // native first, immediately
  const pending=await f.call('join/wecom-sync/create-list',{corpId:'wxfixture'}) as any[];
  assert.deepEqual(pending.map(p=>[p.title,p.owner,p.members]),[['Launch','WA',['WB']]]); // dave has no WeCom identity
  assert.deepEqual(await f.call('join/wecom-sync/list',{corpId:'wxfixture'}),[]); // placeholder is not a provider group
  const requests:any[]=[];
  const pump=createGroupSyncPump({corpId:'wxfixture',onError:()=>{},call:f.call,request:async(action:string,p:any)=>{requests.push([action,p]);
    if(action==='native-chat-create')return{binding:{serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),actorId:f.alice.actorId,source,epoch:1,title:'Launch',generation:'g',nativeGroup:true}};
    if(action==='group-sync')return{state:'confirmed',snapshot:{externalId:'newroom',name:p.change?.name??'Launch',memberIds:['WA','WB']},binding:p.binding};
    throw Error('unexpected '+action);}});
  await pump.poll();
  assert.equal(requests.filter(r=>r[0]==='native-chat-create').length,1);
  assert.deepEqual(requests[0][1],{channelId:group.id,title:'Launch',owner:'WA',members:['WB']});
  const row=f.db.prepare('SELECT channel_id,active FROM actor_channel_sources WHERE source=?').get(source) as any;
  assert.deepEqual([row.channel_id,row.active],[group.id,1]);
  assert.deepEqual(await f.call('join/wecom-sync/create-list',{corpId:'wxfixture'}),[]);
  const [linked]=await f.call('join/wecom-sync/list',{corpId:'wxfixture'}) as any[];assert.equal(linked.channelId,group.id);
  // A later native rename becomes one outgoing provider operation.
  await f.channel(f.alice,'group/rename',{channelId:group.id,title:'Launch v2',clientRequestId:'r1'});
  const state=await f.call('join/wecom-sync/read',{source,sourceEpoch:linked.sourceEpoch}) as any;
  assert.deepEqual(state.operations.map((o:any)=>[o.kind,o.name]),[['name','Launch v2']]);
  // Replaying the same create request never queues a second provider group.
  await f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:[f.bob.actorId,f.dave.actorId],clientRequestId:'g1',wecom:true});
  assert.deepEqual(await f.call('join/wecom-sync/create-list',{corpId:'wxfixture'}),[]);
});

test('without the flag, or without a WeCom identity, groups stay native-only; failures retry then stop',async t=>{
  const f=await fixture(t);
  await f.channel(f.alice,'group/create',{title:'Plain',memberActorIds:[f.bob.actorId],clientRequestId:'p'});
  await f.channel(f.dave,'group/create',{title:'NoId',memberActorIds:[f.bob.actorId],clientRequestId:'n',wecom:true});
  assert.deepEqual(await f.call('join/wecom-sync/create-list',{corpId:'wxfixture'}),[]);
  const group=await f.channel(f.alice,'group/create',{title:'Flaky',memberActorIds:[f.bob.actorId],clientRequestId:'f',wecom:true});
  const d=await f.call('join/wecom-sync/create-settle',{channelId:group.id,code:'mirror_unavailable_http_403',deferred:true}) as any;assert.equal(d.state,'retry');
  assert.deepEqual(await f.call('join/wecom-sync/create-list',{corpId:'wxfixture'}),[]); // waits, attempts unchanged
  const r1=await f.call('join/wecom-sync/create-settle',{channelId:group.id,code:'mirror_unavailable_http_503'}) as any;assert.equal(r1.state,'retry');
  const r2=await f.call('join/wecom-sync/create-settle',{channelId:group.id,code:'identity_denied',retryable:false}) as any;assert.equal(r2.state,'failed');
  assert.equal(f.service.channels.isMember(group.id,f.bob.actorId),true);
});
