// Real Tencent IM acceptance. Every identity, human or Agent, runs its own worker with the official SDK.
// Uses only identities created by this run (demo mode), temporary groups are dismissed at the end.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelaAPI,replyCustomData} from '../sdk/dist/index.js';
import {startPeer} from './lib/peer.mjs';

const base=process.env.VELA_TEST_URL??'http://127.0.0.1:8787';
const fixtures=new URL('./fixtures/',import.meta.url);
const stamp=Date.now();const work=join(tmpdir(),`vela-e2e-${stamp}`);
const reports=[];const pass=(name,detail)=>{reports.push({name,...(detail?{detail}:{})});console.log('PASS',name)};
const groups=[];const peers=[];

// ── Identity model: a natural person owns a device identity and several Agent identities ──
const alice=new VelaAPI(base);const aliceSession=await alice.demoSession(`验收 Alice ${stamp}`);alice.token=aliceSession.token;
const bob=new VelaAPI(base);const bobSession=await bob.demoSession(`验收 Bob ${stamp}`);bob.token=bobSession.token;
const aliceAgent=await alice.createIdentity(`Alice 的研究 Agent ${stamp}`,'agent');
const aliceAgent2=await alice.createIdentity(`Alice 的写作 Agent ${stamp}`,'agent');
const me=await alice.me();
assert.deepEqual(me.identities.map(i=>i.kind),['human','agent','agent']);
await assert.rejects(bob.issueIdentityToken(aliceAgent.id),e=>e.status===404);
const token=async(owner,id)=>(await owner.issueIdentityToken(id)).token;
const agentToken=await token(alice,aliceAgent.id);
await assert.rejects(new VelaAPI(base,agentToken).createIdentity('escalate','agent'),e=>e.status===403);
pass('一个自然人拥有设备身份 + 多个 Agent 身份；凭证互相隔离，Agent 凭证不能创建身份');

try {
 const start=Date.now();
 const [h1,h2,a1,a2]=await Promise.all([
  startPeer(base,await token(alice,aliceSession.identities[0].id),join(work,'h1')),
  startPeer(base,await token(bob,bobSession.identities[0].id),join(work,'h2')),
  startPeer(base,agentToken,join(work,'a1')),
  startPeer(base,await token(alice,aliceAgent2.id),join(work,'a2')),
 ]);
 peers.push(h1,h2,a1,a2);
 for(const [p,kind] of [[h1,'human'],[h2,'human'],[a1,'agent'],[a2,'agent']]){
  const caps=await p.capabilities();assert.equal(caps.identity.kind,kind);assert(caps.methods.includes('createGroup'));assert.equal(caps.messageTypes.length,11);
 }
 pass('4 个身份各自一个 worker、直连腾讯 IM 上线',{seconds:(Date.now()-start)/1000,pids:peers.map(p=>p.pid)});

 // ── One-to-one: every combination ──
 for(const [from,to,label] of [[h1,a1,'人 → Agent'],[a1,h1,'Agent → 人'],[a1,a2,'Agent → Agent'],[h1,h2,'人 → 人']]){
  const text=`${label} ${stamp}`;await from.text(to.id,text);
  await to.waitEvent(m=>m.payload?.text===text&&m.from===from.id);
 }
 pass('单聊：人→Agent、Agent→人、Agent→Agent、人→人');

 // ── Friends: ordinary request/confirm, identical for humans and Agents ──
 await h2.invoke('deleteFriend',a1.id);
 await a1.until(async()=>!(await a1.invoke('getFriends')).some(f=>f.userID===h2.id));
 await a1.invoke('addFriend',h2.id,{wording:'Agent 想加你为好友'});
 const request=await h2.until(async()=>(await h2.invoke('getFriendApplications')).find(a=>a.userID===a1.id&&a.direction==='incoming'));
 assert.equal(request.wording??request.word,'Agent 想加你为好友');
 await h2.invoke('acceptFriend',a1.id);
 await a1.until(async()=>(await a1.invoke('getFriends')).some(f=>f.userID===h2.id));
 pass('好友：Agent 发起申请 → 人类收到并确认 → 双向好友');

 // ── Group: all four speak, all four hear ──
 const group=await a1.invoke('createGroup',{name:`平等群聊 ${stamp}`,memberIDs:[h1.id,h2.id]});groups.push([a1,group.groupID]);
 await a1.invoke('addGroupMembers',group.groupID,[a2.id]);
 const members=await a1.invoke('getGroupMembers',group.groupID);
 assert.deepEqual(new Set(members.map(m=>m.userID)),new Set([a1.id,a2.id,h1.id,h2.id]));
 assert.equal(members.find(m=>m.userID===a1.id).role,'Owner');
 pass('Agent 建群并拉入人类和另一个 Agent');
 for(const speaker of [h1,h2,a1,a2]){
  const text=`group ${speaker.id.slice(0,2)} ${stamp}`;await speaker.text(group.groupID,text,'GROUP');
  for(const listener of [h1,h2,a1,a2].filter(p=>p!==speaker))await listener.waitEvent(m=>m.payload?.text===text&&m.from===speaker.id);
 }
 pass('群聊：人-人、人-Agent、Agent-人、Agent-Agent 互相收发');
 await assert.rejects(h2.invoke('removeGroupMembers',group.groupID,[a1.id]));
 pass('普通人类成员不能踢 Agent 群主（腾讯按普通成员权限拒绝）');
 await a1.invoke('setGroupMemberRole',group.groupID,h1.id,'Admin');
 await h1.until(async()=>(await h1.invoke('getGroupMembers',group.groupID)).find(m=>m.userID===h1.id)?.role==='Admin');
 await h1.invoke('removeGroupMembers',group.groupID,[h2.id]);
 await a1.invoke('removeGroupMembers',group.groupID,[a2.id]);
 const after=await a1.until(async()=>{const m=await a1.invoke('getGroupMembers',group.groupID);return m.length===2&&m});
 assert.deepEqual(new Set(after.map(m=>m.userID)),new Set([a1.id,h1.id]));
 pass('Agent 群主设人类为管理员；管理员踢人、群主踢 Agent');

 // ── Group reply policy ──
 const bots=await a1.invoke('createGroup',{name:`纯 Bot 群 ${stamp}`,memberIDs:[a2.id]});groups.push([a1,bots.groupID]);
 const botPolicy=await a2.invoke('groupReplyPolicy',bots.groupID);assert.equal(botPolicy.groupKind,'bot');assert.equal(botPolicy.effectiveMode,'all');
 const botLine=`纯 Bot 群普通消息 ${stamp}`;await a1.text(bots.groupID,botLine,'GROUP',{cloudCustomData:replyCustomData({chainId:'e2e',hops:0})});
 const botMessage=await a2.waitEvent(m=>m.payload?.text===botLine);
 assert.equal((await a2.prepareGroupReply(botMessage.ID)).shouldReply,true);
 await a1.invoke('setGroupReplyPolicy',group.groupID,'mention_context');
 for(let i=0;i<3;i++)await h1.text(group.groupID,`上下文 ${i} ${stamp}`,'GROUP');
 const ask=`@${a1.id} 总结一下 ${stamp}`;await h1.send({to:group.groupID,conversationType:'GROUP',type:'textAt',payload:{text:ask,atUserList:[a1.id]}});
 const trigger=await a1.waitEvent(m=>m.payload?.text===ask);
 const input=await a1.prepareGroupReply(trigger.ID);
 assert.equal(input.shouldReply,true);assert.equal(input.contextStatus,'complete');
 assert.deepEqual(input.context.slice(-3).map(m=>m.payload.text),[0,1,2].map(i=>`上下文 ${i} ${stamp}`));
 const quiet=`没有 @ 的消息 ${stamp}`;await h1.text(group.groupID,quiet,'GROUP');
 assert.equal((await a1.prepareGroupReply((await a1.waitEvent(m=>m.payload?.text===quiet)).ID)).reason,'not_mentioned');
 pass('群回复规则：纯 Bot 群每条触发；人机群 @ + 前 10 条上下文；未 @ 不触发');

 // ── Rich messages: all 11 SDK types, media uploaded natively from the Node worker ──
 const media=async(type,file,payload={})=>{
  const sent=await a1.send({to:h1.id,conversationType:'C2C',type,payload,attachment:{path:fileURL(file)}});
  const got=await h1.waitEvent(m=>m.ID===sent.data.message.ID,30000);
  const p=got.payload;const url=type==='image'?p.imageInfoArray?.[0]?.url??p.imageInfoArray?.[0]?.imageUrl:type==='audio'?p.url??p.remoteAudioUrl:type==='video'?p.videoUrl??p.remoteVideoUrl:p.fileUrl;
  assert.match(url,/^https:\/\//);const download=await fetch(url);assert(download.ok);assert((await download.arrayBuffer()).byteLength>0);
  return got;
 };
 const fileURL=name=>new URL(name,fixtures).pathname;
 const image=await media('image','vela.png');const audio=await media('audio','vela.wav');await media('video','vela.mp4');
 writeFileSync(join(work,'proof.txt'),`Vela file proof ${stamp}`);
 const sentFile=await a1.send({to:h1.id,conversationType:'C2C',type:'file',payload:{},attachment:{path:join(work,'proof.txt')}});
 const gotFile=await h1.waitEvent(m=>m.ID===sentFile.data.message.ID);assert.equal(await (await fetch(gotFile.payload.fileUrl)).text(),`Vela file proof ${stamp}`);
 assert.equal(audio.payload.second,1,'WAV duration is read by the worker');
 for(const [type,payload,check] of [
  ['location',{description:'深圳湾',latitude:22.5431,longitude:114.0579},p=>p.description==='深圳湾'],
  ['face',{index:1,data:'🙂'},p=>p.index===1],
  ['custom',{data:JSON.stringify({card:'task',id:stamp}),description:'任务卡片',extension:'vela'},p=>JSON.parse(p.data).id===stamp],
 ]){const sent=await a1.send({to:h1.id,conversationType:'C2C',type,payload});assert(check((await h1.waitEvent(m=>m.ID===sent.data.message.ID)).payload),type)}
 const history=await a1.invoke('getMessages',`C2C${h1.id}`);
 const ids=history.messageList.filter(m=>m.ID===image.ID||m.ID===sentFile.data.message.ID).map(m=>m.ID);assert.equal(ids.length,2);
 const merged=await a1.send({to:h1.id,conversationType:'C2C',type:'merger',payload:{title:'验收记录',abstractList:['图片','文件'],compatibleText:'聊天记录'},messageIDs:ids});
 const mergedGot=await h1.waitEvent(m=>m.ID===merged.data.message.ID);assert.equal(mergedGot.type,'TIMRelayElem');
 const forwarded=await a1.send({to:a2.id,conversationType:'C2C',type:'forward',payload:{},messageIDs:[ids[0]]});
 assert.equal((await a2.waitEvent(m=>m.ID===forwarded.data.message.ID)).type,'TIMImageElem');
 const regret=await a1.text(h1.id,`撤回验收 ${stamp}`);await h1.waitEvent(m=>m.ID===regret.data.message.ID);
 await a1.invoke('revokeMessage',regret.data.message.ID);
 await h1.waitEvent(m=>m.ID===regret.data.message.ID,15000,'MESSAGE_REVOKED');
 pass('丰富消息：text、textAt、image、audio、video、file、location、face、custom、merger、forward 全部送达；媒体由 Node worker 原生上传，可下载；撤回同步');

 // ── Durability: a worker that was offline catches up from Tencent roaming ──
 await a1.stop();
 const missed=`离线期间的消息 ${stamp}`;await h1.text(a1.id,missed);
 await new Promise(r=>setTimeout(r,1500));
 const back=await startPeer(base,agentToken,join(work,'a1'),{fresh:false});peers.push(back);
 const recovered=await back.request('/events?after=0&wait=0');
 assert(recovered.events.some(e=>e.event==='MESSAGE_RECEIVED'&&e.data.payload?.text===missed),'offline message recovered by backfill');
 groups.forEach(g=>{if(g[0]===a1)g[0]=back});
 pass('worker 离线期间的消息在重启后由漫游补拉进持久化 inbox');
} finally {
 for(const [owner,groupID] of groups)await owner.invoke('dismissGroup',groupID).catch(()=>{});
 await Promise.all(peers.map(p=>p.stop()));
}
mkdirSync(new URL('../.artifacts/',import.meta.url),{recursive:true});
writeFileSync(new URL('../.artifacts/e2e-result.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),base,SDKAppID:1600166071,runtime:'one Node worker per identity (official @tencentcloud/lite-chat 4.4.7 node build)',reports},null,2));
console.log(`${reports.length} real Tencent IM acceptance groups passed`);
process.exit(0);
