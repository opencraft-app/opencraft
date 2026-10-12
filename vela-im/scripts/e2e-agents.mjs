// Acceptance for Agent registration + the multi-party chat scenarios against a deployed identity service whose
// Agent host runs Hermes. Two natural persons (A owns the Agents, B is a stranger) are played through local workers.
//   VELA_TEST_URL=http://127.0.0.1:18788 node scripts/e2e-agents.mjs              # demo-mode instance issues both owners
//   VELA_LIGHTVELA_TOKENS=<tokenA>,<tokenB> VELA_TEST_URL=... node scripts/e2e-agents.mjs
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {VelaAPI} from '../sdk/dist/index.js';
import {startPeer} from './lib/peer.mjs';

const base=process.env.VELA_TEST_URL;if(!base)throw new Error('Set VELA_TEST_URL to the identity service');
const agentURL=process.env.VELA_AGENT_URL??base;
const stamp=Date.now();const work=join(tmpdir(),`vela-agents-${stamp}`);
const reports=[];const pass=(name,detail)=>{reports.push({name,...(detail?{detail}:{})});console.log('PASS',name,detail?JSON.stringify(detail):'')};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function ownerSession(index,label) {
 const tokens=(process.env.VELA_LIGHTVELA_TOKENS??'').split(',').filter(Boolean);
 const api=new VelaAPI(base);
 const session=tokens[index]?await api.lightvelaSession(tokens[index],process.env.VELA_LIGHTVELA_REGION??'cn'):await api.demoSession(label);
 api.token=session.token;return {api,session,human:session.identities.find(i=>i.kind==='human')};
}
const A=await ownerSession(0,`验收主人 ${stamp}`);
const B=await ownerSession(1,`验收路人 ${stamp}`);
const t0=Date.now();
const {identity:alpha}=await A.api.createAgent(`验收甲 ${String(stamp).slice(-5)}`);
const {identity:beta}=await A.api.createAgent(`验收乙 ${String(stamp).slice(-5)}`);
let agents;
for(let i=0;i<120;i++){
 agents=(await A.api.agents()).agents.filter(a=>[alpha.id,beta.id].includes(a.id));
 if(agents.some(a=>a.state==='error'))throw new Error('agent provisioning failed: '+agents.map(a=>a.error).join('; '));
 if(agents.length===2&&agents.every(a=>a.state==='ready'))break;
 await sleep(2000);
}
assert(agents.every(a=>a.state==='ready'),'both Agents provisioned');
pass('创建 Agent：注册独立 IM 身份并在 Hermes 上开通 profile',{seconds:Math.round((Date.now()-t0)/1000),profiles:agents.map(a=>a.profile)});

const tokenFor=async(owner,id)=>(await owner.api.issueIdentityToken(id)).token;
const [a,b]=await Promise.all([startPeer(agentURL,await tokenFor(A,A.human.id),join(work,'a')),startPeer(agentURL,await tokenFor(B,B.human.id),join(work,'b'))]);
const groups=[];
const said=(from,marker)=>m=>m.from===from&&String(m.payload?.text??'').includes(marker);
/** LLM turns are non-deterministic; retry the prompt once if the expected reply does not arrive. */
async function expectReply(peer,send,check,{timeout=150000,attempts=2}={}) {
 for(let attempt=1;;attempt++){
  await send(attempt);
  try{return {message:await peer.waitEvent(check,timeout),attempts:attempt}}catch(e){if(attempt>=attempts)throw e}
 }
}
const mention=(peer,groupID,targets,text)=>peer.send({to:groupID,conversationType:'GROUP',type:'textAt',payload:{text:`${targets.map(t=>`@${t.name}`).join(' ')} ${text}`,atUserList:targets.map(t=>t.id)}});
try {
 const friends=await a.until(async()=>{const list=await a.invoke('getFriends');return [alpha.id,beta.id].every(id=>list.some(f=>f.userID===id))&&list},60000);
 pass('新 Agent 自动成为主人的好友',{friends:friends.length});

 let m=`单聊${stamp}`;
 let r=await expectReply(a,()=>a.text(alpha.id,`这是验收。请只回复「${m}」。`),said(alpha.id,m),{timeout:240000});
 pass('单 Agent - 单人（主人）单聊',{attempts:r.attempts});

 m=`路人甲${stamp}`;
 r=await expectReply(b,()=>b.text(alpha.id,`你好，我不是你的主人。这是验收，请只回复「${m}」。`),said(alpha.id,m));
 const m2=`路人乙${stamp}`;
 const r2=await expectReply(b,()=>b.text(beta.id,`你好，我不是你的主人。这是验收，请只回复「${m2}」。`),said(beta.id,m2));
 pass('多 Agent - 非主人单聊：陌生人分别与两个 Agent 单聊',{attempts:[r.attempts,r2.attempts]});

 const refused=await expectReply(b,()=>b.text(alpha.id,'/new'),x=>x.from===alpha.id&&String(x.payload?.text??'').includes('只有我的主人'),{timeout:60000,attempts:1});
 pass('非主人发送 Hermes 命令被拒绝（命令策略：仅主人）',{reply:refused.message.payload.text});

 const g1=await a.invoke('createGroup',{name:`多Agent单人 ${stamp}`,memberIDs:[alpha.id,beta.id]});groups.push(g1.groupID);
 m=`双Agent${stamp}`;
 await mention(a,g1.groupID,[alpha,beta],`这是群聊验收，请各自只回复「${m}」。`);
 const both=await Promise.all([a.waitEvent(said(alpha.id,m),150000),a.waitEvent(said(beta.id,m),150000)].map(p=>p.catch(()=>null)));
 assert(both.every(Boolean),'both Agents replied in the multi-Agent group');
 pass('多 Agent - 单人群聊：一条消息 @ 两个 Agent，两个都回复');

 const g2=await a.invoke('createGroup',{name:`单Agent多人 ${stamp}`,memberIDs:[B.human.id,alpha.id]});groups.push(g2.groupID);
 await b.until(async()=>(await b.invoke('getGroups')).some(g=>g.groupID===g2.groupID),30000);
 m=`路人群聊${stamp}`;
 r=await expectReply(b,()=>mention(b,g2.groupID,[alpha],`我是群里的另一个人，请只回复「${m}」。`),said(alpha.id,m));
 const m3=`主人群聊${stamp}`;
 const r3=await expectReply(a,()=>mention(a,g2.groupID,[alpha],`请只回复「${m3}」。`),said(alpha.id,m3));
 pass('单 Agent - 多人群聊：两个人分别 @ 同一个 Agent，都得到回复',{attempts:[r.attempts,r3.attempts]});

 const g3=await a.invoke('createGroup',{name:`多Agent多人 ${stamp}`,memberIDs:[B.human.id,alpha.id,beta.id]});groups.push(g3.groupID);
 await b.until(async()=>(await b.invoke('getGroups')).some(g=>g.groupID===g3.groupID),30000);
 const policy=await new VelaAPI(agentURL,await tokenFor(A,A.human.id)).groupReplyPolicy(g3.groupID);
 assert.equal(policy.groupKind,'mixed');
 m=`乙回复路人${stamp}`;
 r=await expectReply(b,()=>mention(b,g3.groupID,[beta],`请只回复「${m}」。`),said(beta.id,m));
 const m4=`甲回复主人${stamp}`;
 const r4=await expectReply(a,()=>mention(a,g3.groupID,[alpha],`请只回复「${m4}」。`),said(alpha.id,m4));
 const quiet=`没有@任何人${stamp}`;await a.text(g3.groupID,quiet,'GROUP');
 await sleep(25000);
 const history=await a.invoke('getMessages',`GROUP${g3.groupID}`);
 const quietSeq=history.messageList.find(x=>x.payload?.text===quiet).sequence;
 assert(!history.messageList.some(x=>[alpha.id,beta.id].includes(x.from)&&x.sequence>quietSeq),'no Agent answered an un-mentioned message');
 pass('多 Agent - 多人群聊：谁被 @ 谁回复，未 @ 的消息 Agent 不插话',{attempts:[r.attempts,r4.attempts],members:history.messageList.length});
} finally {
 for(const groupID of groups)await a.invoke('dismissGroup',groupID).catch(()=>{});
 await a.stop();await b.stop();
}
mkdirSync(new URL('../.artifacts/',import.meta.url),{recursive:true});
writeFileSync(new URL('../.artifacts/e2e-agents-result.json',import.meta.url),JSON.stringify({date:new Date().toISOString(),base,agents:[alpha.id,beta.id],reports},null,2));
