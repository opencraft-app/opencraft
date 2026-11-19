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
  const alice=human('101'),bob=human('102'),dave=human('103');
  for(const [c,id] of [[alice,'WA']] as const)actors.bindHuman(c,{provider:'wecom.wxfixture',subject:id,displayName:id,expiresAt:Date.now()+3600000});
  const channel=(c:any,op:string,p:any={})=>service.communicate(c,'opencraft/channels/'+op,p);
  const call=(method:string,params:any)=>service.synchronizeChannels({method,params});
  return {service,db,alice,bob,dave,channel,call};
}

import {resolveNativeMemberIdentities} from '../../plugins/wecom/native-member-target.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','newroom']);
function provider(f:any,events:any[]){
 let memberIds=['WA'],binding:any;
 return async(action:string,p:any)=>{
  events.push([action,p]);
  if(action==='native-member-resolve')return{corpId:'wxfixture',members:p.members.map((m:any)=>({...m,rtx:'verified'+m.subject,userId:'W'+m.subject,expiresAt:Date.now()+30000}))};
  if(action==='native-chat-create'){memberIds=['WA',...p.members];binding={serverId:'one',humanKey:syncHash(['wecom','wxfixture','WA']),actorId:f.alice.actorId,source,epoch:1,title:'Launch',generation:'g',nativeGroup:true};return{binding};}
  if(action==='group-sync'){
   if(p.change?.kind==='member')memberIds=p.change.present?[...new Set([...memberIds,p.change.userId])]:memberIds.filter(id=>id!==p.change.userId);
   return{state:'confirmed',snapshot:{externalId:'newroom',name:'Launch',memberIds},binding:p.binding??binding};
  }throw Error(action);
 };
}
test('verified RTX identity is linked before new provider group creation; repeated polls do not create or add twice',async t=>{
 const f=await fixture(t),events:any[]=[],request=provider(f,events),group:any=await f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:[f.bob.actorId],clientRequestId:'g1',wecom:true});
 const pump=createGroupSyncPump({onError:(e:any)=>{throw e;},corpId:'wxfixture',call:f.call,request,resolveNativeMembers:(g:any)=>resolveNativeMemberIdentities(f.service,request,'wxfixture',g)});
 await pump.poll();
 assert.deepEqual(events.find(([a])=>a==='native-chat-create')[1].members,['W102']);
 assert.equal(f.service.actors.findHuman({provider:'wecom.wxfixture',subject:'W102'})?.id,f.bob.actorId);
 await pump.poll();assert.equal(events.filter(([a])=>a==='native-chat-create').length,1);
 assert.deepEqual((await f.call('join/wecom-sync/member-identity-list',{corpId:'wxfixture'})) as any[],[]);
 assert.equal(f.service.channels.isMember(group.id,f.bob.actorId),true);
});
test('previously skipped creation member and later native add are both repaired through ordinary group operations',async t=>{
 const f=await fixture(t),events:any[]=[],request=provider(f,events),group:any=await f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:[f.bob.actorId],clientRequestId:'g1',wecom:true});
 const old=createGroupSyncPump({onError:(e:any)=>{throw e;},corpId:'wxfixture',call:f.call,request});await old.poll();
 await f.channel(f.alice,'group/member/set',{channelId:group.id,actorId:f.dave.actorId,present:true,clientRequestId:'add-dave'});
 let clock=Date.now();
 const pump=createGroupSyncPump({onError:(e:any)=>{throw e;},corpId:'wxfixture',call:f.call,request,now:()=>clock,resolveNativeMembers:(g:any)=>resolveNativeMemberIdentities(f.service,request,'wxfixture',g)});
 await pump.poll();clock+=60000;await pump.poll();
 const additions=events.filter(([a,p])=>a==='group-sync'&&p.change?.kind==='member').map(([,p])=>p.change.userId);
 assert.deepEqual(additions.sort(),['W102','W103']);
 const [linked]=await f.call('join/wecom-sync/list',{corpId:'wxfixture'}) as any[];
 const state:any=await f.call('join/wecom-sync/read',linked);assert.ok(state.operations.every((o:any)=>o.state==='confirmed'));
 const row=JSON.parse(f.db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').get(group.id).value as string);
 assert.deepEqual(row.createdFrom.missing,[]);assert.deepEqual(row.localOnly,[]);
});
test('an in-flight directory lookup cannot re-add a removed member',async t=>{
 const f=await fixture(t),events:any[]=[],base=provider(f,events),group:any=await f.channel(f.alice,'group/create',{title:'Launch',memberActorIds:[f.bob.actorId],clientRequestId:'g1',wecom:true});
 const old=createGroupSyncPump({onError:(e:any)=>{throw e;},corpId:'wxfixture',call:f.call,request:base});await old.poll();
 const request=async(a:string,p:any)=>{if(a==='native-member-resolve')await f.channel(f.alice,'group/member/set',{channelId:group.id,actorId:f.bob.actorId,present:false,clientRequestId:'remove-bob'});return base(a,p);};
 const pump=createGroupSyncPump({onError:(e:any)=>{throw e;},corpId:'wxfixture',call:f.call,request,resolveNativeMembers:(g:any)=>resolveNativeMemberIdentities(f.service,request,'wxfixture',g)});await pump.poll();
 assert.equal(f.service.channels.isMember(group.id,f.bob.actorId),false);
 assert.equal(events.filter(([a,p])=>a==='group-sync'&&p.change?.present).length,0);
});
test('a returned identity for a different OA subject is rejected without creating any binding',async t=>{
 const f=await fixture(t);
 await assert.rejects(resolveNativeMemberIdentities(f.service,async()=>({corpId:'wxfixture',members:[{actorId:f.bob.actorId,subject:'999',rtx:'102',userId:'WRONG',expiresAt:Date.now()+30000}]}),'wxfixture',{owner:'WA',members:[{actorId:f.bob.actorId,subject:'102',rtxHint:'102'}]}),/wecom_member_evidence_invalid/);
 assert.equal(f.service.actors.findHuman({provider:'wecom.wxfixture',subject:'WRONG'}),null);
});
test('only provider-owned admission metadata crosses the Relay trust boundary; display labels are not forwarded',async t=>{
 const f=await fixture(t),calls:any[]=[];
 const group={owner:'WA',members:[{actorId:f.bob.actorId,subject:'102',rtxHint:'someone-else'}]};
 await resolveNativeMemberIdentities(f.service,async(a:string,p:any)=>{calls.push([a,p]);return{corpId:'wxfixture',members:[]};},'wxfixture',group,Date.now,(subject:string)=>subject==='102'?'realrtx':null);
 assert.deepEqual(calls[0],[ 'native-member-resolve',{owner:'WA',members:[{actorId:f.bob.actorId,subject:'102',rtx:'realrtx',identitySource:'ioa-admission'}]}]);
});
