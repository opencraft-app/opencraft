import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync,statSync} from 'node:fs';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelaError} from '../dist/index.js';
import {VelaIMClient} from '../dist/client.js';
import {Inbox} from '../dist/inbox.js';
import {startWorker} from '../dist/worker.js';
import {audioSeconds} from '../dist/audio.js';
import {fakeChat,hooks,credentials} from './fake-chat.mjs';

const groupID='vg_0198f4c27a357f1486ab2e57552e473f';
const platformID='0198f4c2-7a35-7f14-86ab-2e57552e473f';

/** HTTP over the worker's Unix socket, the same way the plugin and CLI reach it. */
function socketCall(socketPath,path,body) {
 return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=request({socketPath,path,method:body===undefined?'GET':'POST',headers:payload?{'content-type':'application/json'}:{}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,json:JSON.parse(Buffer.concat(chunks).toString()||'null')}));
  });
  req.on('error',reject);if(payload)req.write(payload);req.end();
 });
}

function fakeBotAPI(overrides={}) {
 const calls=[];
 return {
  calls,identity:{id:'b',userId:'a_self',displayName:'助手',commandPolicy:'owner',ownerUserIds:['u_owner']},
  credentials:async()=>credentials('a_self'),
  me:async()=>({id:'b',userId:'a_self',displayName:'助手',commandPolicy:'owner',ownerUserIds:['u_owner','a_sibling']}),
  group:async id=>{calls.push(['group',id]);return {id,tencentGroupId:groupID,name:'g',replyMode:'mention',effectiveReplyMode:'all',contextMessages:0,state:'active',revision:1,members:[],viewerRole:'member'}},
  createGroup:async input=>{calls.push(['createGroup',input]);return {id:platformID,tencentGroupId:groupID}},
  ...overrides,
 };
}

test('a new inbox keeps an explicit initial watermark',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-inbox-initial-'));const inbox=new Inbox(join(dir,'inbox.sqlite'));
 try {assert.equal(inbox.syncTime(1000),1000);assert.equal(inbox.syncTime(),1000)}
 finally{inbox.close();rmSync(dir,{recursive:true,force:true})}
});

test('inbox persists across restarts, de-duplicates retransmissions and resolves edits/revocations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-inbox-'));const path=join(dir,'inbox.sqlite');
 let inbox=new Inbox(path);
 try {
  const m={ID:'m1',type:'TIMCustomElem',conversationID:'GROUP@TGS#g',payload:{data:'opaque'}};
  assert.equal(inbox.save('MESSAGE_RECEIVED',[m,m]),1);assert.equal(inbox.save('MESSAGE_RECEIVED',[m]),0);
  inbox.close();inbox=new Inbox(path);
  assert.equal(inbox.events(0).length,1);
  inbox.save('MESSAGE_REVOKED',[{ID:'m1'}]);assert.equal(inbox.message('m1').isRevoked,true);
 } finally {inbox.close();rmSync(dir,{recursive:true,force:true})}
});

test('audio duration is read from WAV headers',()=>{
 const rate=8000,seconds=3,data=rate*2*seconds;const wav=Buffer.alloc(44+data);
 wav.write('RIFF',0);wav.writeUInt32LE(36+data,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(data,40);
 assert.equal(audioSeconds(new Uint8Array(wav)),3);
});

test('vendored Node SDK carries every media patch',()=>{
 const source=readFileSync(new URL('../dist/vendor/lite-chat-node.mjs',import.meta.url),'utf8');
 for(const marker of ['(t.IN_BROWSER||t.IN_NODE)&&(n=e.name.slice(','"undefined"!=typeof HTMLInputElement','url:URL.createObjectURL(e),name:t',':{width:0,height:0}'])assert(source.includes(marker),marker);
});

test('worker serves over a private Unix socket, applies platform rules and forwards platform operations as the Bot',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-worker-'));
 const fake=fakeChat({getFriendList:{data:[{userID:'h_friend'}]},getConversationList:{data:{conversationList:[],isSyncCompleted:true}}});
 const api=fakeBotAPI();
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 const worker=await startWorker({apiURL:'http://unused',credentialFile:join(dir,'credential'),dir,client,api,log:()=>{}});
 const call=(path,body)=>socketCall(worker.socketPath,path,body);
 try {
  await worker.ready;
  const runtime=JSON.parse(readFileSync(join(dir,'worker.json'),'utf8'));
  assert.equal(runtime.ready,true);assert.equal(runtime.userID,'a_self');assert.equal(runtime.socket,worker.socketPath);
  assert.equal(statSync(worker.socketPath).mode&0o077,0,'only the Agent user can reach the worker');
  assert.equal(statSync(join(dir,'worker.json')).mode&0o077,0);
  assert.equal((await call('/capabilities')).json.identity.kind,'bot');
  assert.deepEqual((await call('/control')).json.owner.userIds,['u_owner','a_sibling']);
  assert.deepEqual((await call('/invoke',{method:'getFriends'})).json,[{userID:'h_friend'}]);
  assert.equal((await call('/invoke',{method:'createGroup'})).status,400);
  assert.equal((await call('/call',{method:'addGroupMember'})).status,400);
  const created=await call('/platform',{method:'createGroup',args:[{name:'评审',memberUserIds:['u_owner']}]});
  assert.equal(created.json.tencentGroupId,groupID);assert.equal(api.calls.at(-1)[0],'createGroup');
  assert.equal((await call('/platform',{method:'deleteEverything'})).status,400);

  fake.native.emit('onMessageReceived',[{ID:'g1',from:'a_peer',type:'TIMTextElem',conversationID:'GROUP'+groupID,payload:{text:'bots talk'}}]);
  const prepared=(await call('/group-reply',{messageID:'g1'})).json;
  assert.equal(prepared.shouldReply,true);assert.equal(prepared.policy.platformGroupId,platformID);
  assert.deepEqual(api.calls.filter(c=>c[0]==='group').map(c=>c[1]),[platformID]);
  await call('/group-reply',{messageID:'g1'});
  assert.equal(api.calls.filter(c=>c[0]==='group').length,1,'rules are cached until the platform announces a change');
  fake.native.emit('onMessageReceived',[{ID:'n1',from:'@TIM#SYSTEM',type:'TIMCustomElem',conversationID:'GROUP'+groupID,payload:{data:JSON.stringify({businessID:'vela_group_policy',replyMode:'mention'})}}]);
  await call('/group-reply',{messageID:'g1'});
  assert.equal(api.calls.filter(c=>c[0]==='group').length,2,'a policy notice invalidates the cached rules');

  fake.native.emit('onMessageReceived',[{ID:'f1',from:'h_x',type:'TIMTextElem',conversationID:'GROUP@TGS#foreign',payload:{text:'hello'}}]);
  const foreign=(await call('/group-reply',{messageID:'f1'})).json;
  assert.equal(foreign.policy.effectiveMode,'mention');assert.equal(foreign.reason,'not_mentioned');

  const sent=(await call('/send',{to:'h_friend',conversationType:'C2C',type:'text',payload:{text:'hi'},replyToMessageID:'g1'})).json;
  assert.equal(JSON.parse(sent.data.message.cloudCustomData).vela.hops,1,'a reply carries the next hop of the parent chain');
  assert.equal((await call('/group-reply',{messageID:'forged'})).status,404);
 } finally {
  await worker.close();
  assert.equal(existsSync(join(dir,'worker.json')),false);
  assert.equal(existsSync(worker.socketPath),false);
  rmSync(dir,{recursive:true,force:true});
 }
});

test('offline backfill hands the missed messages to the Agent oldest first across pages',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-worker-'));
 const now=Math.floor(Date.now()/1000);
 const message=(id,seq)=>({ID:id,from:'u_owner',type:'TIMTextElem',conversationID:'GROUP'+groupID,time:now-60+seq,sequence:seq,payload:{text:id}});
 // Cloud roaming returns the newest page first; each page lists its messages oldest first.
 const pages=[{messageList:[message('m3',3),message('m4',4)],nextMessageSeq:2},{messageList:[message('m1',1),message('m2',2)],isCompleted:true}];
 const fake=fakeChat({
  getConversationList:{data:{conversationList:[{type:'GROUP',conversationID:'GROUP'+groupID,lastMessage:{lastTime:now}}],isSyncCompleted:true}},
  getMessageListHopping:()=>({data:pages.shift()??{messageList:[],isCompleted:true}}),
 });
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 const worker=await startWorker({apiURL:'http://unused',credentialFile:join(dir,'credential'),dir,client,api:fakeBotAPI(),log:()=>{}});
 try {
  await worker.ready;
  const inbox=new Inbox(join(dir,'inbox.sqlite'));
  const received=inbox.events(0).filter(e=>e.event==='MESSAGE_RECEIVED').flatMap(e=>[e.data].flat().map(m=>m.ID));
  inbox.close();
  assert.deepEqual(received,['m1','m2','m3','m4']);
 } finally {await worker.close();rmSync(dir,{recursive:true,force:true})}
});

test('worker stops when the platform rejects the Bot credential',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'vela-worker-revoked-'));const fake=fakeChat();
 const api=fakeBotAPI({credentials:async()=>{throw new VelaError('Bot 凭据已失效','runtime_credential_revoked',401)}});
 const client=new VelaIMClient(fake.TencentCloudChat,hooks);
 const exit=process.exit;let code;process.exit=c=>{code=c};
 try {
  await startWorker({apiURL:'http://unused',credentialFile:join(dir,'credential'),dir,client,api,log:()=>{}});
  for(let i=0;i<50&&code===undefined;i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(code,2);assert.equal(fake.calls.some(c=>c[0]==='login'),false);
 } finally {process.exit=exit;rmSync(dir,{recursive:true,force:true})}
});
