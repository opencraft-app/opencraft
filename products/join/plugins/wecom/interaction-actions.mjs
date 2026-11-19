import {parseRichAction} from './rich-outbound.mjs';
import {createHash} from 'node:crypto';
const label=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max||!v.isWellFormed())throw Error('Invalid interaction label');return v.trim();};
export function normalizeInteraction(v) {
  if(!v||typeof v!=='object'||!['poll','form'].includes(v.type))throw Error('Invalid interaction');
  const title=label(v.title,36);
  const timing={};
  if(v.onClose!==undefined)timing.onClose=label(v.onClose,2000);
  if(v.deadline!==undefined){
    if(typeof v.deadline!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(v.deadline)||!Number.isFinite(Date.parse(v.deadline)))throw Error('Invalid deadline; use ISO date with timezone');
    timing.deadline=new Date(v.deadline).toISOString();
  }
  if(v.remindBeforeMinutes!==undefined){
    if(!timing.deadline||!Number.isInteger(v.remindBeforeMinutes)||v.remindBeforeMinutes<1||v.remindBeforeMinutes>1440)throw Error('Reminder requires a deadline and 1–1440 minutes');
    timing.remindBeforeMinutes=v.remindBeforeMinutes;
  }
  const options=a=>{if(!Array.isArray(a)||a.length<2||a.length>10)throw Error('Expected 2–10 options');return a.map(x=>label(x,20));};
  if(v.type==='poll')return {type:'poll',title,...timing,options:options(v.options),multiple:v.multiple===true};
  if(!Array.isArray(v.questions)||!v.questions.length||v.questions.length>3)throw Error('Expected 1–3 questions');
  return {type:'form',title,...timing,questions:v.questions.map(q=>({title:label(q.title,20),options:options(q.options)}))};
}
export function parseInteractionAction(text) {
  const rich=parseRichAction(text);if(rich)return rich;
  if(/^\s*\/快捷入口\s*$/u.test(text))return {kind:'shortcuts'};
  if(/^\s*\/退群\s*$/u.test(text))return {kind:'quit-chat'};
  if(/^\s*\/群成员\s*$/u.test(text))return {kind:'members'};
  const collection=/^\s*\/收集操作 (\{[^\n]*\})\s*$/u.exec(text);
  if(collection){const v=JSON.parse(collection[1]);if(!v||Object.keys(v).some(k=>!['action','taskId'].includes(k))||!['close','export'].includes(v.action)||typeof v.taskId!=='string'||!/^oc-m-[a-f0-9]{40}$/u.test(v.taskId))throw Error('Invalid collection control');return{kind:'collection-control',action:v.action,taskId:v.taskId};}
  const task=/^\s*\/任务卡片 (\{[^\n]*\})\s*$/u.exec(text);
  if(task){const v=JSON.parse(task[1]);if(!/^join:wecom:task-return:[a-f0-9]{64}$/u.test(v.taskKey)||!['queued','running','completed','failed','stopped'].includes(v.state))throw Error('Invalid task card');return {kind:'task-card',taskKey:v.taskKey,state:v.state,title:label(v.title,36)};}
  const m=/^\s*\/(投票|表单)\s+(\{[\s\S]*\})\s*$/u.exec(text);
  return m?{kind:'interaction',definition:normalizeInteraction({...JSON.parse(m[2]),type:m[1]==='投票'?'poll':'form'})}:null;
}
export function interactionCard(definition,identity) {
  const d=normalizeInteraction(definition),task_id='oc-m-'+createHash('sha256').update(identity).digest('hex').slice(0,40);
  const options=a=>a.map((text,i)=>({id:'o'+i,text}));
  const base={task_id,main_title:{title:d.title},submit_button:{text:'提交',key:'submit'}};
  return d.type==='poll'?{...base,card_type:'vote_interaction',checkbox:{question_key:'q0',mode:d.multiple?1:0,option_list:options(d.options)}}
    :{...base,card_type:'multiple_interaction',select_list:d.questions.map((q,i)=>({question_key:'q'+i,title:q.title,option_list:options(q.options)}))};
}
export function checkedSubmission(card,selected) {
  const questions=card.checkbox?[card.checkbox]:card.select_list;
  if(!Array.isArray(selected)||selected.length!==questions.length)throw Error('Incomplete submission');
  return questions.map(q=>{
    const matches=selected.filter(s=>s.questionKey===q.question_key);
    if(matches.length!==1||!Array.isArray(matches[0].optionIds))throw Error('Invalid question');
    const ids=[...new Set(matches[0].optionIds)];
    if(!ids.length||ids.length>q.option_list.length||(q.mode!==1&&ids.length!==1)||ids.some(id=>!q.option_list.some(o=>o.id===id)))throw Error('Invalid option');
    return {questionKey:q.question_key,optionIds:ids};
  });
}
export function submissionSummary(card,answers,closed=false) {
  const questions=card.checkbox?[card.checkbox]:card.select_list;
  return [`${closed?'已结束':'收集中'}：${card.main_title.title}`,`已提交 ${answers.length} 人`,...questions.flatMap(q=>[
    q.title||card.main_title.title,...q.option_list.map(o=>`${o.text}：${answers.filter(a=>a.selected.some(s=>s.questionKey===q.question_key&&s.optionIds.includes(o.id))).length} 人`)]),
    ...answers.slice(0,100).map(a=>`${a.actor}：${a.choice}`),...(answers.length>100?['仅展示前100人明细。']:[])].join('\n');
}
export const controlText=(action,taskKey)=>'/企业微信操作 '+JSON.stringify({action,...(taskKey?{taskKey}:{})});
export function parseControl(text) {
  const m=/^\s*\/企业微信操作 (\{[^\n]*\})\s*$/u.exec(text);if(!m)return null;
  const v=JSON.parse(m[1]);if(!['status','stop','rerun','pause-daily'].includes(v.action)||Object.keys(v).some(k=>!['action','taskKey'].includes(k)))throw Error('Invalid control');
  if(v.action!=='pause-daily'&&(typeof v.taskKey!=='string'||!/^join:wecom:task-return:[a-f0-9]{64}$/u.test(v.taskKey)))throw Error('Invalid task control');return v;
}
