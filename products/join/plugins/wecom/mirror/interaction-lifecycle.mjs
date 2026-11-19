import {submissionSummary} from '../interaction-actions.mjs';
import {utf8Chunks} from '../text-chunks.mjs';
const DAY=86400000;
export function interactionTiming(definition,now=Date.now()) {
  if(!definition.deadline)return {};
  const deadlineAt=Date.parse(definition.deadline);
  if(!Number.isFinite(deadlineAt)||deadlineAt<=now||deadlineAt>now+DAY)throw Error('Deadline must be within the next 24 hours');
  const reminderAt=definition.remindBeforeMinutes?deadlineAt-definition.remindBeforeMinutes*60000:undefined;
  if(reminderAt!==undefined&&reminderAt<=now)throw Error('Reminder must be in the future');
  return {deadlineAt,...(reminderAt?{reminderAt}:{})};
}
const cell=value=>{
  let s=String(value??'');
  // A workbook must never evaluate member names/answers as spreadsheet formulas.
  if(/^[\s\uFEFF]*[=+\-@]/u.test(s)||/^[\t\r\n]/u.test(s))s="'"+s;
  return '"'+s.replaceAll('"','""')+'"';
};
export function interactionCSV(card,answers) {
  const qs=card.checkbox?[card.checkbox]:card.select_list;
  const rows=[['参与者','账号',...qs.map(q=>q.title??card.main_title.title)],...answers.map(a=>[
    a.actor,a.author,...qs.map(q=>{const ids=a.selected.find(s=>s.questionKey===q.question_key)?.optionIds??[];return q.option_list.filter(o=>ids.includes(o.id)).map(o=>o.text).join('；');})])];
  return Buffer.from('\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n');
}
export const interactionExportName=card=>(card.main_title.title.replace(/[\\/\x00-\x1f\x7f<>:"|?*]/gu,'_').slice(0,36)||'收集结果')+'.csv';
export async function sendInteractionSummary(svc,source,text,signal) {
  for(const part of utf8Chunks(text,3800)){
    const status=await svc.transport.sendMarkdown({source,text:part},signal);
    if(status!=='delivered')return status;
  }
  return 'delivered';
}
export async function tickInteractions(svc,now=Date.now()) {
  if(typeof svc.store.dueInteractions!=='function')return;
  for(const job of await svc.store.dueInteractions(now)) {
    if(svc.stopped)break;
    if(!await svc.store.claimOnce('interaction-work:'+job.member,30000))continue;
    try {
      const card=await svc.store.card(job.source,job.taskId),binding=(await svc.store.snapshot(job.source)).binding;
      if(!card?.multi||card.deliveryStatus!=='delivered'||!binding||!card.binding||binding.serverId!==card.binding.serverId||binding.humanKey!==card.binding.humanKey||binding.generation!==card.binding.generation){await svc.store.finishInteractionSchedule(job.member);continue;}
      const state=await svc.store.submitCard(job.source,job.taskId,'',undefined,job.kind==='close',now,'deadline');
      if(state.closedReason==='manual'){await svc.store.finishInteractionSchedule(job.member);continue;}
      const signal=()=>AbortSignal.any([svc.abort.signal,AbortSignal.timeout(15000)]);
      const current=await svc.transport.chatMembers(job.source,signal());
      if(!current.includes(card.owner)){await svc.store.finishInteractionSchedule(job.member);continue;}
      if(job.kind==='close') {
        // Claim before an external send: a lost acknowledgement must not flood the group on retry.
        if(await svc.store.claimOnce('interaction-delivery:'+job.member,7*DAY)) {
          await sendInteractionSummary(svc,job.source,submissionSummary(card,state.answers,true).slice(0,12000),signal());
          await svc.store.ingest({source:job.source,id:job.taskId+':deadline',author:card.owner,text:`[自动结束] ${card.main_title.title}，已提交 ${state.answers.length} 人。`,at:now,mentioned:false});
        }
      }else if(!state.closed) {
        const submitted=new Set(state.answers.map(a=>a.author));
        const pending=(card.participants??[]).filter(id=>current.includes(id)&&!submitted.has(id)&&!/^(wb|fw|external:)/u.test(id));
        if(pending.length&&await svc.store.claimOnce('interaction-delivery:'+job.member,7*DAY)) {
          for(let i=0;i<pending.length;i+=50)await svc.transport.mentionMembers(job.source,pending.slice(i,i+50),`「${card.main_title.title}」即将截止，请在原卡片提交。`,signal());
        }
      }
      await svc.store.finishInteractionSchedule(job.member);
    }catch{ /* durable due entry retries; uncertain external notifications never replay */ }
  }
}
