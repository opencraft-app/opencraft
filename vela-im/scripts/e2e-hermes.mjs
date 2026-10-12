// Acceptance against the deployed Hermes Alpha and Beta. Each Hermes profile runs its own Vela worker on the host;
// this script plays a human visitor (and that visitor's own Agent) through local workers.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelaAPI,replyCustomData} from '../sdk/dist/index.js';
import {startPeer} from './lib/peer.mjs';

const base=process.env.VELA_TEST_URL;if(!base)throw new Error('Set VELA_TEST_URL to the deployed identity service');
const stamp=Date.now();const work=join(tmpdir(),`vela-hermes-${stamp}`);
const reports=[];const pass=(name,detail)=>{reports.push({name,...(detail?{detail}:{})});console.log('PASS',name)};
const owner=new VelaAPI(base);const session=await owner.demoSession(`Hermes 验收 ${stamp}`);owner.token=session.token;
const {participants}=await owner.participants();
const alpha=participants.find(p=>p.name==='Hermes Alpha').id,beta=participants.find(p=>p.name==='Hermes Beta').id;
const mine=await owner.createIdentity(`访客的 Agent ${stamp}`,'agent');
const tokenFor=async id=>(await owner.issueIdentityToken(id)).token;
const [human,agent]=await Promise.all([startPeer(base,await tokenFor(session.identities[0].id),join(work,'human')),startPeer(base,await tokenFor(mine.id),join(work,'agent'))]);
const groups=[];
const fromHermes=(id,check)=>m=>m.from===id&&check(m);
const said=text=>m=>String(m.payload?.text??'').includes(text);
const NUDGE='上一条请求还没有执行。请现在直接调用工具完成它，不要只描述计划。';
/** LLM turns are non-deterministic: if the expected effect does not appear, ask once more in the same chat. */
async function ask(to,prompt,effect,{timeout=120000,attempts=2,via=human}={}) {
 for(let attempt=1;;attempt++){
  await via.text(to,attempt===1?prompt:`${NUDGE}\n${prompt}`);
  try{return {result:await effect(timeout),attempts:attempt}}catch(e){if(attempt>=attempts)throw e}
 }
}
try {
 let marker=`单聊验收${stamp}`;
 let r=await ask(alpha,`这是插件验收。请只回复「${marker}」，不要调用工具。`,t=>human.waitEvent(fromHermes(alpha,said(marker)),t));
 pass('人 → Hermes Alpha 单聊，Alpha 以自己的 IM 身份回复',{attempts:r.attempts});

 marker=`工具发信${stamp}`;
 r=await ask(alpha,`这是插件验收。请调用 vela_send_message，to=${human.id}，conversation_type=C2C，payload={"text":"${marker}"}。然后回复「好」。`,t=>human.waitEvent(fromHermes(alpha,m=>m.payload?.text===marker),t));
 pass('Hermes 调用 vela_send_message 工具发送指定消息',{attempts:r.attempts});

 marker=`两跳验收${stamp}`;
 r=await ask(alpha,`这是插件验收。请调用 vela_send_message 给另一个 Agent ${beta} 发送文本：「请调用 vela_send_message，to=${human.id}，conversation_type=C2C，payload={"text":"${marker}"}，然后回复好。」发送后回复「已转达」。`,t=>human.waitEvent(fromHermes(beta,m=>m.payload?.text===marker),t),{timeout:180000});
 pass('Agent → Agent → 人：Alpha 用工具给 Beta 发消息，Beta 再用工具发给人类',{attempts:r.attempts});

 marker=`位置验收${stamp}`;
 r=await ask(alpha,`这是插件验收。请调用 vela_send_message，to=${human.id}，type=location，payload={"description":"${marker}","latitude":22.5431,"longitude":114.0579}。然后回复「好」。`,t=>human.waitEvent(fromHermes(alpha,m=>m.type==='TIMLocationElem'&&m.payload?.description===marker),t));
 pass('Hermes 通过工具发送富消息（位置）',{attempts:r.attempts});

 await human.invoke('deleteFriend',alpha).catch(()=>{});
 await human.until(async()=>!(await human.invoke('getFriends')).some(f=>f.userID===alpha));
 r=await ask(alpha,`这是插件验收。请调用 vela_friends，action=add，user_id=${human.id}，wording="Hermes 好友验收"。然后回复「已申请」。`,t=>human.until(async()=>(await human.invoke('getFriendApplications')).find(a=>a.userID===alpha&&a.direction==='incoming'),t));
 await human.invoke('acceptFriend',alpha);
 await human.until(async()=>(await human.invoke('getFriends')).some(f=>f.userID===alpha));
 pass('Hermes 用工具发起好友申请，人类确认后成为好友',{attempts:r.attempts,wording:r.result.wording??r.result.word});

 const groupName=`Hermes建群${stamp}`;
 r=await ask(alpha,`这是插件验收。请先调用 vela_groups，action=create，name="${groupName}"，member_ids=["${human.id}","${beta}"]；再调用 vela_group_members，action=remove，group_id=新群的 groupID，user_ids=["${beta}"]。完成后只回复「完成」。`,
  t=>human.until(async()=>{const g=(await human.invoke('getGroups')).find(g=>g.name===groupName);if(!g)return;const m=await human.invoke('getGroupMembers',g.groupID);return !m.some(x=>x.userID===beta)&&{group:g,members:m}},t),{timeout:180000});
 groups.push([human,r.result.group.groupID,'quit']);
 assert.deepEqual(new Set(r.result.members.map(m=>m.userID)),new Set([alpha,human.id]));
 assert.equal(r.result.members.find(m=>m.userID===alpha).role,'Owner');
 pass('Hermes 用工具建群（拉入人类和 Beta）并以群主身份踢出 Beta',{attempts:r.attempts});

 const mixed=await human.invoke('createGroup',{name:`人机混合群 ${stamp}`,memberIDs:[alpha,beta]});groups.push([human,mixed.groupID]);
 const mention=async(who,text,check)=>{
  for(let attempt=1;;attempt++){
   await human.send({to:mixed.groupID,conversationType:'GROUP',type:'textAt',payload:{text:`@${who} ${text}`,atUserList:[who]}});
   try{return await human.waitEvent(check,120000)}catch(e){if(attempt>=2)throw e}
  }
 };
 marker=`混合群@Beta${stamp}`;
 await mention(beta,`这是群聊验收，请只回复「${marker}」。`,fromHermes(beta,said(marker)));
 marker=`混合群@Alpha${stamp}`;
 await mention(alpha,`这是群聊验收，请只回复「${marker}」。`,fromHermes(alpha,said(marker)));
 const quiet=`没有@任何人的消息${stamp}`;await human.text(mixed.groupID,quiet,'GROUP');
 await new Promise(r=>setTimeout(r,25000));
 const after=await human.invoke('getMessages',`GROUP${mixed.groupID}`);
 const quietSeq=after.messageList.find(m=>m.payload?.text===quiet).sequence;
 assert(!after.messageList.some(m=>[alpha,beta].includes(m.from)&&m.sequence>quietSeq),'mention mode: no Hermes replies to an un-mentioned message');
 pass('人机混合群：@谁谁回复，未 @ 的消息两个 Hermes 都不回复');

 const bots=await agent.invoke('createGroup',{name:`纯 Bot 群 ${stamp}`,memberIDs:[alpha,beta]});groups.push([agent,bots.groupID]);
 marker=`Bot群${stamp}`;
 await agent.text(bots.groupID,`这是纯 Agent 群验收。收到后请只回复一次「${marker}」，不要调用工具。`,'GROUP',{cloudCustomData:replyCustomData({chainId:`bots-${stamp}`,hops:0})});
 const a=await agent.waitEvent(fromHermes(alpha,said(marker)),150000).catch(()=>null);
 const b=await agent.waitEvent(fromHermes(beta,said(marker)),150000).catch(()=>null);
 assert(a||b,'at least one Hermes answered without being mentioned');
 await new Promise(r=>setTimeout(r,40000));
 const botHistory=[];let next;for(let i=0;i<5;i++){const page=await agent.invoke('getMessages',`GROUP${bots.groupID}`,next?{nextReqMessageID:next}:{});botHistory.push(...page.messageList);if(page.isCompleted)break;next=page.nextReqMessageID}
 const hops=botHistory.filter(m=>[alpha,beta].includes(m.from)).map(m=>{try{return JSON.parse(m.cloudCustomData).vela.hops}catch{return null}});
 assert(hops.every(h=>h===null||h<=4),'automatic Agent replies stop at the hop limit (4 on this demo)');
 pass('纯 Bot 群：普通消息无需 @ 即触发 Hermes；Agent 互答受跳数上限约束',{alpha:!!a,beta:!!b,hermesMessages:hops.length,maxHop:Math.max(0,...hops.filter(h=>h!==null))});
} finally {
 for(const [peer,groupID,how] of groups)await peer.invoke(how==='quit'?'quitGroup':'dismissGroup',groupID).catch(()=>{});
 await human.stop();await agent.stop();
}
writeFileSync(new URL('../.artifacts/e2e-hermes-result.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),base,hermes:{alpha,beta},reports},null,2));
console.log(`${reports.length} deployed Hermes checks passed`);
process.exit(0);
