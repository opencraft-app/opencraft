import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelaAPI} from '../dist/index.js';
import {VelaIMClient} from '../dist/client.js';
import {Inbox} from '../dist/inbox.js';
import {startWorker} from '../dist/worker.js';
import {audioSeconds} from '../dist/audio.js';
import {fakeChat,hooks,credentials} from './fake-chat.mjs';

test('a new identity backfills from its creation time, not from its first worker start',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-inbox-initial-'));const inbox=new Inbox(join(dir,'inbox.sqlite'));
 try {assert.equal(inbox.syncTime(1000),1000);assert.equal(inbox.syncTime(),1000)}
 finally{inbox.close();rmSync(dir,{recursive:true,force:true})}
});

test('inbox persists across restarts, de-duplicates retransmissions and resolves edits/revocations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-inbox-'));const path=join(dir,'inbox.sqlite');
 let inbox=new Inbox(path);
 try {
  const first=inbox.syncTime();assert(Math.abs(first-Date.now()/1000)<5,'a new worker starts from now, never replays old history');
  const m={ID:'m1',type:'TIMCustomElem',conversationID:'GROUP@TGS#g',payload:{data:'opaque',extension:{nested:[1,2]}}};
  assert.equal(inbox.save('MESSAGE_RECEIVED',[m,m]),1);assert.equal(inbox.save('MESSAGE_RECEIVED',[m]),0);
  inbox.close();inbox=new Inbox(path);
  const events=inbox.events(0);assert.equal(events.length,1);assert.deepEqual(events[0].data,m);assert.equal(inbox.syncTime(),first);
  assert.equal(inbox.syncTime(123),first,'an existing watermark wins over the initial value');
  inbox.save('MESSAGE_MODIFIED',[{...m,atUserList:['a_self']}]);inbox.save('MESSAGE_MODIFIED',[{...m,atUserList:['a_self']}]);
  assert.deepEqual(inbox.message('m1').atUserList,['a_self']);assert.equal(inbox.events(events[0].seq).length,1);
  inbox.save('MESSAGE_REVOKED',[{ID:'m1'}]);assert.equal(inbox.message('m1').isRevoked,true);
  inbox.save('MESSAGE_RECEIVED',[{ID:'m2',conversationID:'C2Ch_x',sequence:42,payload:{text:'oops'}}]);
  inbox.save('MESSAGE_REVOKED',[{conversationID:'C2Ch_x',sequence:42,revoker:'h_x'}]);
  assert.equal(inbox.message('m2').isRevoked,true,'V4 revocations carry only conversation + sequence');
  assert.equal(inbox.events(0).at(-1).data.ID,'m2');
  assert.equal(inbox.message('unknown'),undefined);
 } finally {inbox.close();rmSync(dir,{recursive:true,force:true})}
});

test('audio duration is read from WAV headers',()=>{
 const rate=8000,seconds=3,data=rate*2*seconds;const wav=Buffer.alloc(44+data);
 wav.write('RIFF',0);wav.writeUInt32LE(36+data,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(data,40);
 assert.equal(audioSeconds(new Uint8Array(wav)),3);
 assert.equal(audioSeconds(new Uint8Array([1,2,3,4,5])),undefined);
});

test('vendored Node SDK carries every media patch',()=>{
 const source=readFileSync(new URL('../dist/vendor/lite-chat-node.mjs',import.meta.url),'utf8');
 for(const marker of ['(t.IN_BROWSER||t.IN_NODE)&&(n=e.name.slice(','"undefined"!=typeof HTMLInputElement','url:URL.createObjectURL(e),name:t',':{width:0,height:0}'])assert(source.includes(marker),marker);
});

test('worker serves only its owner over loopback, keeps a durable cursor and exposes only Vela operations',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-worker-'));
 const fake=fakeChat({getFriendList:{data:[{userID:'h_friend'}]},getConversationList:{data:{conversationList:[],isSyncCompleted:true}}});
 const api=new VelaAPI('http://unused','token');api.me=async()=>({identities:[{id:'a_self',kind:'agent',name:'Agent'}]});
 api.groupReplyPolicy=async groupID=>({groupID,groupKind:'bot',mode:'mention',effectiveMode:'all',contextMessages:0,canManage:true,memberCount:2,updatedAt:0});
 api.credentials=async()=>credentials('a_self');
 const client=new VelaIMClient(api,fake.TencentCloudChat,hooks);
 const worker=await startWorker({apiURL:'http://unused',token:'token',dir,client,log:()=>{}});
 const base=`http://127.0.0.1:${worker.port}`;
 const call=(path,body,secret=worker.secret)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+secret,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 try {
  await worker.ready;
  const runtime=JSON.parse(readFileSync(join(dir,'worker.json'),'utf8'));
  assert.equal(runtime.ready,true);assert.equal(runtime.userID,'a_self');assert.equal(runtime.port,worker.port);
  assert.equal(statSync(join(dir,'worker.json')).mode&0o077,0,'runtime secret is private to the Agent user');
  assert.equal((await call('/health',undefined,'wrong')).status,401);
  assert.equal((await (await call('/capabilities')).json()).identity.kind,'agent');
  assert.deepEqual(await (await call('/invoke',{method:'getFriends'})).json(),[{userID:'h_friend'}]);
  assert.equal((await call('/invoke',{method:'connect'})).status,400);
  assert.equal((await call('/call',{method:'deleteAllEverything'})).status,400);
  const sent=await (await call('/send',{to:'h_friend',conversationType:'C2C',type:'text',payload:{text:'hi'}})).json();assert.equal(sent.data.message.to,'h_friend');
  const waiting=call('/events?after=0&wait=5000').then(r=>r.json());
  fake.native.emit('onMessageReceived',[{ID:'g1',from:'a_peer',type:'TIMTextElem',conversationID:'GROUP@TGS#g',payload:{text:'bots talk'}}]);
  const batch=await waiting;assert.equal(batch.events.at(-1).event,'MESSAGE_RECEIVED');assert.equal(batch.cursor,batch.events.at(-1).seq);
  assert.deepEqual((await (await call(`/events?after=${batch.cursor}&wait=0`)).json()).events,[]);
  const prepared=await (await call('/group-reply',{messageID:'g1'})).json();assert.equal(prepared.shouldReply,true);assert.equal(prepared.policy.groupKind,'bot');
  assert.equal((await call('/group-reply',{messageID:'forged'})).status,404);
 } finally {
  await worker.close();
  assert.equal(existsSync(join(dir,'worker.json')),false);
  rmSync(dir,{recursive:true,force:true});
 }
});

test('worker refuses to keep running with a revoked identity credential',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-worker-revoked-'));const fake=fakeChat();
 const api=new VelaAPI('http://unused','revoked');api.credentials=async()=>{throw Object.assign(new Error('登录态已失效'),{status:401})};
 const client=new VelaIMClient(api,fake.TencentCloudChat,hooks);
 const exit=process.exit;let code;process.exit=c=>{code=c};
 try {
  await startWorker({apiURL:'http://unused',token:'revoked',dir,client,log:()=>{}});
  for(let i=0;i<50&&code===undefined;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(code,2);assert.equal(fake.calls.some(c=>c[0]==='login'),false);
 } finally {process.exit=exit;rmSync(dir,{recursive:true,force:true})}
});
