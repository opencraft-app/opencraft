import '../../plugins/wecom/assistant-install.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {openServerDatabase} from '@opencraft/storage-node/server';
import {ActorStore} from '../../../../packages/access-control/src/actors.js';
import {Collaboration} from '../../../../packages/access-control/src/collaboration.js';
import {ChannelSync} from '../../../../plugins/im/src/channel-sync.js';
import {createMirrorTarget} from '../../plugins/wecom/mirror/target.mjs';
import {humanKey} from '../../plugins/wecom/mirror/store.mjs';

async function fixture(t:test.TestContext,kind:'voice'|'forwarded'|'forwarded-text'|'forwarded-text-lua',known=false,deny=false){
 const dir=await fs.mkdtemp(join(tmpdir(),'mirror-first-media-'));
 const previous={OPENCRAFT_DATA_DIR:process.env.OPENCRAFT_DATA_DIR,OPENCRAFT_WORKSPACE_DIR:process.env.OPENCRAFT_WORKSPACE_DIR};
 process.env.OPENCRAFT_DATA_DIR=dir;process.env.OPENCRAFT_WORKSPACE_DIR=join(dir,'workspace');
 const storage=await openServerDatabase(dir),actors=new ActorStore(storage),service=new Collaboration(storage,actors);
 const human=actors.resolveHuman({provider:'local',subject:'Alice',displayName:'Alice',expiresAt:Date.now()+600000});
 await service.synchronizeChannels({method:'mirrorLink',params:{actorId:human.actorId,generation:human.generation,corpId:'wxfixture',userId:'Wei'}});
 const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
 const binding={serverId:'fixture',source,epoch:1,actorId:human.actorId,humanKey:humanKey('wxfixture','Wei'),title:'Fixture'};
 const base={source,id:'first',author:'Wei',sender:{id:'Wei',displayName:'Alice'},at:1234,mentioned:false,assistantEligible:false};
 const event=kind==='voice'?{...base,text:'[语音]',voice:{mediaId:'voice-one',format:'amr'}}:{...base,text:'群聊的聊天记录',
  nestedMedia:kind==='forwarded-text-lua'?{}:kind==='forwarded-text'?[]:[{path:'1.1',type:'file',mediaId:'file-one',name:'fixture.txt'}],
  forwardedRecord:{version:1,title:'群聊的聊天记录',entries:[{path:'1',sender:{id:'Wei',name:'Alice'},at:1234,parts:kind==='forwarded'?[{kind:'file',resource:'1.1',name:'fixture.txt'}]:[{kind:'text',text:'synthetic forwarded text'}]}]}};
 const second={...base,id:'second',at:1235,text:'after the media',nestedMedia:{}};
 let sync:ChannelSync|undefined,target:any,acked=0,transcribed=0,lostAck=false;
 const errors:any[]=[],calls:string[]=[];
 const count=()=>Number(storage.database.prepare('SELECT COUNT(*) AS n FROM actor_channel_external_messages').get()!.n);
 t.after(async()=>{await sync?.close();await service.close();actors.close();await storage.close();await fs.rm(dir,{recursive:true,force:true});for(const[k,v]of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 if(known){
  const b=await service.synchronizeChannels({method:'mirrorBind',params:{binding,corpId:'wxfixture'}});
  await service.synchronizeChannels({method:'addSource',params:{binding:b,incarnation:'old',images:false}});
  await service.synchronizeChannels({method:'ingest',params:{source,incarnation:'old',arrival:{...base,text:'[语音] already accepted'}}});
 }
 const collaboration={synchronizeChannels:async(c:any)=>{
  calls.push(c.method);
  if(c.method==='received'&&deny)throw Error('channel_denied');
  // Group metadata is orthogonal to durable message receipt; keep this fixture on native ingress.
  if(c.method.startsWith('join/wecom-sync/'))return [];
  return service.synchronizeChannels(c);
 }};
 const fetcher=async(url:URL,options:any)=>{
  const method=url.pathname.split('/').at(-1),p=JSON.parse(options.body);
  if(method==='link-poll')return Response.json({links:[]});
  if(method==='poll')return Response.json({deliveries:acked>=2?[]:[{binding,token:'lease',event:acked===0?event:second}]});
  if(method==='file')return new Response(Buffer.from('fixture attachment'));
  if(method==='ack'){
   assert.ok(storage.database.prepare('SELECT 1 FROM actor_channel_external_messages WHERE source=? AND external_id=? AND message_id=?').get(source,p.id,p.messageId),'ACK must follow native durable commit');
   if(lostAck){lostAck=false;throw Error('lost ACK');}
   acked++;
  }
  return Response.json({ok:true});
 };
 const start=async()=>{
  target=await createMirrorTarget({relayOrigin:'http://127.0.0.1',allowLoopbackInsecure:true,serverId:'fixture',credential:'a'.repeat(43),corpId:'wxfixture'},
   {collaboration},fetcher,{transcribe:async()=>{transcribed++;return 'synthetic transcript';},onError:(e:any,p:any)=>errors.push({error:e.message,...p})});
  sync=await ChannelSync.open(target,service);
 };
 const until=async(check:()=>boolean)=>{const end=Date.now()+7000;while(!check()){if(Date.now()>end)throw Error('not drained: '+JSON.stringify(errors));await sleep(10);}};

 return {start,until,count,calls,errors,storage,source,dir,get acked(){return acked;},get transcribed(){return transcribed;},
  loseAck(){lostAck=true;},async stop(){await sync?.close();sync=undefined;},get target(){return target;}};
}
for(const kind of ['voice','forwarded','forwarded-text','forwarded-text-lua'] as const)test(`new room first ${kind} reaches native SQLite before ACK and drains following text`,{timeout:15000},async t=>{
 const f=await fixture(t,kind);await f.start();await f.until(()=>f.acked===2);
 assert.equal(f.count(),2);assert.equal(f.calls.includes('received'),false,'a nonexistent native source cannot have prior receipts');
 assert.equal(f.errors.length,0);assert.equal(f.transcribed,kind==='voice'?1:0);
 const row=f.storage.database.prepare('SELECT COUNT(*) AS n FROM actor_channel_sources WHERE source=?').get(f.source)!;assert.equal(row.n,1);
});
test('known source recovers pre-journal voice without retranscribing or duplicating the committed message',{timeout:15000},async t=>{
 const f=await fixture(t,'voice',true);await f.start();await f.until(()=>f.acked===2);
 assert.ok(f.calls.includes('received'));assert.equal(f.transcribed,0);assert.equal(f.count(),2);assert.deepEqual(f.errors,[]);
});
test('fresh media survives lost ACK and restart with its frozen journal and exactly one native message',{timeout:15000},async t=>{
 const f=await fixture(t,'voice');f.loseAck();await f.start();await f.until(()=>f.count()===1);await f.stop();
 assert.equal(f.acked,0);await f.start();await f.until(()=>f.acked===2);
 assert.equal(f.count(),2);assert.equal(f.transcribed,1);assert.equal(f.errors.filter(e=>e.error==='lost ACK').length,1);
});
test('recovery errors on a known source are not swallowed and never ACK the queue',{timeout:15000},async t=>{
 const f=await fixture(t,'voice',true,true);await f.start();await f.until(()=>f.errors.length>0);await f.stop();
 assert.equal(f.acked,0);assert.equal(f.count(),1);assert.equal(f.transcribed,0);assert.deepEqual(f.errors,[{error:'channel_denied',stage:'prepare'}]);
});

test('text-only Lua forwarded record survives ACK loss and restart without duplicate admission',{timeout:15000},async t=>{
 const f=await fixture(t,'forwarded-text-lua');f.loseAck();await f.start();await f.until(()=>f.count()===1);await f.stop();
 assert.equal(f.acked,0);await f.start();await f.until(()=>f.acked===2);
 assert.equal(f.count(),2);assert.equal(f.transcribed,0);assert.equal(f.errors.filter(e=>e.error==='lost ACK').length,1);
});
