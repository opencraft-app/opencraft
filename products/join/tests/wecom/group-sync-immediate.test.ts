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


const wait=async(check:()=>boolean|Promise<boolean>)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('event-driven synchronization did not run');};
const watch=(f:any,pump=f.pump)=>f.service.channels.onChange((c:any)=>{if(c.directory||c.memberActorId)void pump.notify(c.channelId);});
const quiesce=async(f:any,pump=f.pump)=>{await pump.notify(f.g.channelId);await pump.close();};

test('committed rename wakes synchronization without a poll or advancing the 30-second clock',async t=>{
 const f=await attached(t);await f.tick();const remove=watch(f);const started=Date.now();
 try{await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Immediate rename',clientRequestId:'rename'});
 await wait(()=>f.provider().name==='Immediate rename');await f.pump.notify(f.g.channelId);
 assert.equal(f.dbrow().operations[0].state,'confirmed');assert.deepEqual(f.errors,[]);console.log('event rename latency ms',Date.now()-started);
 }finally{remove();await f.pump.close();}
});
test('rename, add and remove drain continuously rather than waiting one poll interval per edit',async t=>{
 const f=await attached(t);await f.tick();f.service.actors.bindHuman(f.dave,{provider:'wecom.wxfixture',subject:'WD',displayName:'Dave',expiresAt:Date.now()+60000});const remove=watch(f);
 try{
 await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Batch',clientRequestId:'r'});
 await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId:f.dave.actorId,present:true,clientRequestId:'a'});
 await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId:f.bob.actorId,present:false,clientRequestId:'d'});
 await wait(()=>f.provider().name==='Batch'&&f.provider().members.includes('WD')&&!f.provider().members.includes('WB'));
 await f.pump.notify(f.g.channelId);assert.equal(f.dbrow().operations.length,3);assert.equal(f.dbrow().operations.every((o:any)=>o.state==='confirmed'),true);assert.deepEqual(f.errors,[]);
 }finally{remove();await f.pump.close();}
});
test('edits arriving while a write is held are not lost and same-group provider writes never overlap',async t=>{
 const f=await attached(t);await f.tick();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);let writes=0,active=0,max=0;
 const request=async(a:string,p:any)=>{if(p.action==='apply'){active++;max=Math.max(max,active);if(++writes===1){started();await gate;}}
 try{return await f.request(a,p)}finally{if(p.action==='apply')active--;}};
 const pump=createGroupSyncPump({call:f.call,corpId:'wxfixture',request,onError:(e:any)=>f.errors.push(e)}),remove=watch(f,pump);
 try{await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'First',clientRequestId:'first'});await began;
 await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Second',clientRequestId:'second'});assert.equal(writes,1);
 release();await wait(()=>f.provider().name==='Second');await pump.notify(f.g.channelId);assert.equal(writes,2);assert.equal(max,1);assert.deepEqual(f.errors,[]);
 }finally{release();remove();await pump.close();}
});
test('an unrelated slow maintenance read cannot block an active edit in another group',async t=>{
 const f=await attached(t);await f.tick();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
 const call=(m:string,p:any)=>m.endsWith('/adoption-list')?Promise.resolve([{channelId:'other',source:'other',sourceEpoch:'other'}]):m.endsWith('/adopt-linked')&&p.source==='other'?Promise.resolve(null):f.call(m,p);
 const request=async(a:string,p:any)=>{if(p.source==='other'){started();await gate;return{}}return f.request(a,p)};
 const pump=createGroupSyncPump({call,corpId:'wxfixture',request,onError:(e:any)=>f.errors.push(e)}),remove=watch(f,pump),background=pump.poll();
 try{await began;await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Not blocked',clientRequestId:'r'});
 await wait(()=>f.provider().name==='Not blocked');await pump.notify(f.g.channelId);assert.deepEqual(f.errors,[]);
 }finally{release();await background;remove();await pump.close();}
});
test('a slow immediate operation does not hold notifications for another group',async t=>{
 const f=await attached(t);await f.tick();let release!:()=>void,started!:()=>void;const gate=new Promise<void>(r=>release=r),began=new Promise<void>(r=>started=r);
 const call=(m:string,p:any)=>m.endsWith('/immediate-work')&&p.channelId==='other'?Promise.resolve({kind:'attach',channelId:'other',source:'other',token:'once'}):m.endsWith('/adopt-linked')&&p.source==='other'?Promise.resolve(null):f.call(m,p);
 const request=async(a:string,p:any)=>{if(p.source==='other'){started();await gate;return{}}return f.request(a,p)};
 const pump=createGroupSyncPump({call,corpId:'wxfixture',request,onError:(e:any)=>f.errors.push(e)}),remove=watch(f,pump),other=pump.notify('other');
 try{await began;await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Independent',clientRequestId:'independent'});
 await wait(()=>f.provider().name==='Independent');await pump.notify(f.g.channelId);assert.deepEqual(f.errors,[]);
 }finally{release();await other;remove();await pump.close();}
});
test('status and readback notifications do not turn a successful write into a request loop',async t=>{
 const f=await attached(t);await f.tick();const remove=watch(f);
 try{await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Once',clientRequestId:'r'});await wait(()=>f.provider().name==='Once');await f.pump.notify(f.g.channelId);
 const count=f.events.length;for(let i=0;i<20;i++)f.service.channels.changed({channelId:f.g.channelId,directory:true});await f.pump.notify(f.g.channelId);
 assert.equal(f.events.length,count);assert.equal(f.events.filter(([,p])=>p.action==='apply').length,1);assert.deepEqual(f.errors,[]);
 }finally{remove();await f.pump.close();}
});
test('uncertain writes are not retried or verified in a hot loop by their own notifications',async t=>{
 const f=await attached(t);await f.tick();let applies=0,verifies=0;
 const request=async(a:string,p:any)=>{if(p.action==='apply')applies++;if(p.action==='verify')verifies++;return{state:'unknown',binding:f.binding,snapshot:{externalId:'newroom',name:'Provider',memberIds:['WA','WB']}}};
 const pump=createGroupSyncPump({call:f.call,corpId:'wxfixture',request,onError:(e:any)=>f.errors.push(e)}),remove=watch(f,pump);
 try{await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Unknown',clientRequestId:'r'});await wait(()=>f.dbrow().operations[0]?.state==='unknown');await pump.notify(f.g.channelId);
 for(let i=0;i<10;i++)f.service.channels.changed({channelId:f.g.channelId,directory:true});await pump.notify(f.g.channelId);
 assert.equal(applies,1);assert.equal(verifies,0);assert.deepEqual(f.errors,[]);
 }finally{remove();await pump.close();}
});
test('newly added unmapped members bypass the identity retry clock and use the verified resolver immediately',async t=>{
 const f=await attached(t);await f.tick();let resolutions=0;
 const {resolveNativeMemberIdentities}=await import('../../plugins/wecom/native-member-target.mjs');
 const request=async(a:string,p:any)=>{if(a==='native-member-resolve'){resolutions++;return{corpId:'wxfixture',members:p.members.map((m:any)=>({...m,rtx:'person'+m.subject,userId:'W'+m.subject,expiresAt:Date.now()+30000}))}}return f.request(a,p)};
 const pump=createGroupSyncPump({call:f.call,corpId:'wxfixture',request,now:()=>1000,resolveNativeMembers:(g:any)=>resolveNativeMemberIdentities(f.service,request,'wxfixture',g),onError:(e:any)=>f.errors.push(e)}),remove=watch(f,pump);
 try{
 for(const c of [f.dave,f.service.actors.resolveHuman({provider:'tencentoa',subject:'104',displayName:'Other',expiresAt:Date.now()+60000})!]){
  await f.channel(f.alice,'group/member/set',{channelId:f.g.channelId,actorId:c.actorId,present:true,clientRequestId:'add-'+c.actorId});
  const uid=c.actorId===f.dave.actorId?'W103':'W104';await wait(()=>f.provider().members.includes(uid));await pump.notify(f.g.channelId);
 }
 assert.equal(resolutions,2);assert.deepEqual(f.errors,[]);
 }finally{remove();await pump.close();}
});
test('permission failures and paused sources do not trigger an external update',async t=>{
 const f=await attached(t);await f.tick();const row=f.dbrow();row.paused=true;f.db.prepare('UPDATE join_wecom_group_sync SET value=? WHERE source=?').run(JSON.stringify(row),source);const remove=watch(f),before=f.events.length;
 try{await assert.rejects(f.channel(f.bob,'group/rename',{channelId:f.g.channelId,title:'Denied',clientRequestId:'denied'}),/owner_required|channel_denied/);
 await f.channel(f.alice,'group/rename',{channelId:f.g.channelId,title:'Paused',clientRequestId:'paused'});await f.pump.notify(f.g.channelId);assert.equal(f.events.length,before);
 }finally{remove();await f.pump.close();}
});
test('transport subscribes to committed channel changes and releases its listener on unsubscribe/close',async t=>{
 await fixture(t);
 const {createMirrorTarget}=await import('../../plugins/wecom/mirror/target.mjs');let listener:any,removes=0,work=0;
 const collaboration:any={channels:{onChange(fn:any){listener=fn;return()=>{listener=null;removes++;}}},synchronizeChannels:async({method}:any)=>{
  if(method==='mirrorDirectory')return{};if(method.endsWith('/immediate-work')){work++;return null;}return[];
 }};
 const fetcher=async(url:any)=>Response.json(String(url).endsWith('/link-poll')?{links:[]}:String(url).endsWith('/poll')?{deliveries:[]}:{});
 const transport=await createMirrorTarget({relayOrigin:'http://127.0.0.1/',allowLoopbackInsecure:true,serverId:'one',credential:'x'.repeat(43),corpId:'wxfixture'},{collaboration},fetcher);
 const stop=transport.subscribeWithReceipt(async()=>({messageId:'fixture'}));
 try{listener({channelId:'fixture',directory:true});await wait(()=>work===1);stop();assert.equal(listener,null);assert.equal(removes,1);}
 finally{await transport.close();}assert.equal(removes,1);
});
