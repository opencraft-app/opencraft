import {sendRichAction,shortcutEvent} from '../rich-outbound.mjs';
import {interactionTiming,interactionCSV,interactionExportName,sendInteractionSummary} from './interaction-lifecycle.mjs';
import {createHash} from 'node:crypto';
import {interactionCard,checkedSubmission,submissionSummary,controlText} from '../interaction-actions.mjs';
import {describeChoice,answeredCard} from './cards.mjs';
import {humanKey} from './store.mjs';
const taskId=(source,id)=>'oc-a-'+createHash('sha256').update(JSON.stringify([source,id])).digest('hex').slice(0,40);
const signalFor=svc=>AbortSignal.any([svc.abort.signal,AbortSignal.timeout(3500)]);
export async function assistantAction(svc,server,input,signal) {
  const {source,owner,kind,requestId}=input;
  if(typeof owner!=='string'||!owner||typeof requestId!=='string'||requestId.length>256)throw Error('Invalid action');
  const members=await svc.transport.chatMembers(source,signal);
  if(!members.includes(owner))throw Error('denied');
  const binding=(await svc.store.snapshot(source)).binding;
  if(binding?.serverId!==server.id)throw Error('denied');
  if(['rich-message','custom-shortcuts','rich-card'].includes(kind))return sendRichAction(svc,input,binding,signal);
  if(kind==='collection-control') {
    if(!['close','export'].includes(input.action)||typeof input.taskId!=='string'||!/^oc-m-[a-f0-9]{40}$/u.test(input.taskId))throw Error('Invalid collection control');
    const card=await svc.store.card(source,input.taskId);
    if(!card?.multi||card.owner!==owner||card.binding?.serverId!==binding.serverId||card.binding?.humanKey!==binding.humanKey||card.binding?.generation!==binding.generation)throw Error('denied');
    if(card.deliveryStatus!=='delivered')return 'rejected';
    const before=await svc.store.submitCard(source,input.taskId,'');
    if(input.action==='export')return svc.transport.sendFile(source,interactionExportName(card),interactionCSV(card,before.answers),signal);
    if(before.closed)return 'delivered';
    const state=await svc.store.submitCard(source,input.taskId,'',undefined,true,Date.now(),'manual');
    const status=await sendInteractionSummary(svc,source,submissionSummary(card,state.answers,true),signal);
    await svc.store.ingest({source,id:'collection:'+requestId,author:owner,text:`[结束收集] ${card.main_title.title}，已提交 ${state.answers.length} 人。`,at:Date.now(),mentioned:false});
    return status;
  }
  if(kind==='quit-chat') {
    if(svc.transport.isDirect(source)||binding.humanKey!==humanKey(svc.corpId,owner))throw Error('Only the group binding owner may retire the bot');
    await svc.transport.sendMarkdown({source,text:'OpenCraft 即将退出本群，群绑定和待发送队列将清理；历史记录保留。'},signal);
    const status=await svc.transport.quitChat(source,signal);
    if(status==='delivered')await svc.store.retire(source,server.id,requestId);
    return status;
  }
  if(kind==='shortcuts')return svc.transport.sendShortcuts(source,signal);
  if(kind==='members') {
    const rows=await svc.transport.memberInfo(source,signal);
    return svc.transport.sendMarkdown({source,text:['群成员：',...rows.slice(0,100).map(r=>`${r.name}（${r.kind==='human'?'真人':r.kind==='robot'?'机器人':'客服号'}）`),...(rows.length>100?[`共${rows.length}位，仅显示前100位。`]:[])].join('\n')},signal);
  }
  let wire,stored;
  if(kind==='interaction') {
    wire=interactionCard(input.definition,JSON.stringify([source,requestId]));
    const timing=interactionTiming(input.definition);
    if(timing.deadlineAt)wire.main_title={...wire.main_title,desc:'截止：'+new Date(timing.deadlineAt).toISOString()};
    stored={...wire,multi:true,owner,binding,deliveryStatus:'pending',...timing,participants:[...new Set(members.filter(id=>!/^(wb|fw|external:)/u.test(id)))].slice(0,500)};
  } else if(kind==='task-card') {
    if(typeof input.taskKey!=='string'||!/^join:wecom:task-return:[a-f0-9]{64}$/u.test(input.taskKey)||!['queued','running','completed','failed','stopped'].includes(input.state))throw Error('Invalid task card');
    const actions=[{text:'查看进度',key:'oc-task-status'},...(input.state==='queued'?[]:input.state==='running'?[{text:'停止任务',key:'oc-stop'}]:[{text:'重新执行',key:'oc-rerun'}])];
    wire={card_type:'button_interaction',task_id:taskId(source,requestId),main_title:{title:String(input.title??'群聊任务').slice(0,36)},sub_title_text:({queued:'已提交，等待执行',running:'任务进行中',completed:'任务已完成',failed:'任务失败',stopped:'任务已停止'})[input.state],
      button_list:actions.map(a=>({...a,style:1})),action_menu:{desc:'任务操作',action_list:actions}};
    stored={...wire,owner,binding,control:{taskKey:input.taskKey}};
  } else throw Error('Unsupported action');
  await svc.store.rememberCard(source,wire.task_id,stored);
  if(stored.deadlineAt)await svc.store.scheduleInteraction(source,wire.task_id,stored.deadlineAt,stored.reminderAt);
  const status=await svc.transport.sendCard(source,wire,signal);
  if(kind==='interaction'&&status==='rejected')await svc.store.rememberCard(source,wire.task_id,{...stored,deliveryStatus:'rejected'});
  if(kind==='interaction'&&status==='delivered') {
    await svc.store.rememberCard(source,wire.task_id,{...stored,deliveryStatus:'delivered'});
    const controls={card_type:'button_interaction',task_id:wire.task_id+'-ctl',main_title:{title:'收集操作：'+wire.main_title.title.slice(0,25)},
      button_list:[{text:'查看汇总',key:'oc-results',style:1},{text:'结束收集',key:'oc-close',style:1},{text:'导出表格',key:'oc-export',style:1}]};
    await svc.store.rememberCard(source,controls.task_id,{...controls,multiControl:wire.task_id,owner,binding});
    await svc.transport.sendCard(source,controls,signal);
  }
  return status;
}
export async function interactionEvent(svc,event,card) {
  const binding=(await svc.store.snapshot(event.source)).binding;
  if(card.binding && (!binding||binding.serverId!==card.binding.serverId||binding.humanKey!==card.binding.humanKey||binding.generation!==card.binding.generation))return 'retired';
  const members=await svc.transport.chatMembers(event.source,signalFor(svc));
  if(!members.includes(event.author)||/^(wb|fw)/u.test(event.author))return 'not_member';
  if(card.multi||card.multiControl) {
    const target=card.multi?card:await svc.store.card(event.source,card.multiControl);
    if(!target?.multi)return 'retired';
    let close=false;
    if(card.multiControl) {
      if(!['oc-close','oc-results','oc-export'].includes(event.eventKey))return 'ignored';
      close=event.eventKey==='oc-close';
      if(close&&event.author!==target.owner)return 'not_owner';
    }
    if(card.multiControl&&event.eventKey==='oc-export') {
      const state=await svc.store.submitCard(event.source,target.task_id,event.author);
      const job=svc.transport.sendFile(event.source,interactionExportName(target),interactionCSV(target,state.answers),AbortSignal.any([svc.abort.signal,AbortSignal.timeout(60000)]));
      if(svc.track){svc.track(job.catch(()=>{}));return 'exporting';}return job;
    }
    let answer;
    if(card.multi) {
      const selected=checkedSubmission(target,event.selected);
      const names=await svc.transport.senderNames(event.source,[event.author],signalFor(svc)).catch(()=>new Map());
      answer={author:event.author,actor:names.get(event.author)??event.author,selected,choice:describeChoice(target,{...event,selected})};
      // An authenticated, valid submission proves the card was delivered, even
      // when its original send acknowledgement was lost. Never resend it.
      if(target.deliveryStatus!=='delivered')await svc.store.rememberCard(event.source,target.task_id,{...target,deliveryStatus:'delivered'});
    }
    const state=await svc.store.submitCard(event.source,target.task_id,event.author,answer,close);
    if(card.multi) {
      const replacement=state.closed?answeredCard(target,'本次收集','已结束'): {...target,main_title:{...target.main_title,desc:`已记录你的提交，当前共 ${state.answers.length} 人；可重新提交修改。`}};
      const {multi,owner,binding,deadlineAt,reminderAt,participants,deliveryStatus,...wire}=replacement;
      await svc.transport.updateCard(event.responseCode,wire,[event.author],signalFor(svc)).catch(()=>{});
      if(state.accepted)await svc.store.ingest({source:event.source,id:'card:'+event.id,author:event.author,text:`[${target.main_title.title}] ${answer.actor}：${answer.choice}`,at:event.at,mentioned:false});
    }else {
      const summary=submissionSummary(target,state.answers,state.closed);
      await svc.transport.updateCard(event.responseCode,{card_type:'button_interaction',main_title:card.main_title,sub_title_text:`已提交 ${state.answers.length} 人${state.closed?'，已结束':''}`,button_list:card.button_list},[event.author],signalFor(svc)).catch(()=>{});
      await sendInteractionSummary(svc,event.source,summary.slice(0,12000),signalFor(svc));
      await svc.store.ingest({source:event.source,id:'card:'+event.id,author:event.author,text:summary.slice(0,12000),at:event.at,mentioned:false});
    }
    return state.closed?'closed':'submitted';
  }
  if(card.control || event.eventKey==='oc-pause-daily') {
    if(card.owner!==event.author)return 'not_owner';
    const action=event.eventKey==='oc-task-status'?'status':event.eventKey==='oc-stop'?'stop':event.eventKey==='oc-rerun'?'rerun':event.eventKey==='oc-pause-daily'?'pause-daily':null;
    if(!action || action!=='pause-daily'&&!card.control?.taskKey)return 'ignored';
    const input={source:event.source,id:'card:'+event.id,author:event.author,text:controlText(action,card.control?.taskKey),at:event.at,mentioned:true};
    const stored=await svc.store.ingest(input);
    await svc.transport.updateCard(event.responseCode,{card_type:'text_notice',main_title:card.main_title,sub_title_text:'操作已提交给你的助理',card_action:{type:1,url:'https://work.weixin.qq.com'}},[event.author],signalFor(svc)).catch(()=>{});
    return stored;
  }
  return null;
}
