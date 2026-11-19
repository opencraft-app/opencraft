import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInteractionAction,interactionCard,checkedSubmission,submissionSummary,controlText,parseControl} from '../../plugins/wecom/interaction-actions.mjs';
import {assistantAction,interactionEvent} from '../../plugins/wecom/mirror/interactions.mjs';
import {humanKey} from '../../plugins/wecom/mirror/store.mjs';

test('poll/form definitions validate provider limits and exact submitted choices',()=>{
 const p=parseInteractionAction('/投票 {"title":"午饭","options":["面","饭"]}');
 const card=interactionCard(p.definition,'message');
 assert.equal(card.card_type,'vote_interaction');
 assert.deepEqual(checkedSubmission(card,[{questionKey:'q0',optionIds:['o1']}]),[{questionKey:'q0',optionIds:['o1']}]);
 assert.throws(()=>checkedSubmission(card,[{questionKey:'q0',optionIds:['o99']}]));
 assert.throws(()=>checkedSubmission(card,[{questionKey:'q0',optionIds:['o0','o1']}]));
 assert.throws(()=>checkedSubmission(card,[]));
 assert.throws(()=>parseInteractionAction('/表单 {"title":"确认","questions":[]}'));
 assert.equal(parseControl(controlText('stop','join:wecom:task-return:'+'a'.repeat(64))).action,'stop');
});
function fixture() {
 const cards=new Map(),answers=new Map(),seen=[],updates=[],sent=[];let closed=false,retired=false;
 const binding={serverId:'server',humanKey:humanKey('wxcorp','owner')};
 const svc={corpId:'wxcorp',abort:new AbortController(),
  store:{snapshot:async()=>({binding:retired?null:binding}),rememberCard:async(s,id,c)=>cards.set(id,c),card:async(s,id)=>cards.get(id),
   submitCard:async(s,id,author,answer,close)=>{closed ||=close;if(answer&&!closed)answers.set(author,answer);return {answers:[...answers.values()],accepted:!!answer&&!closed,closed};},
   ingest:async e=>{seen.push(e);return 'stored';},retire:async()=>{retired=true;}},
  transport:{chatMembers:async()=>['owner','alice','bob'],senderNames:async(s,ids)=>new Map(ids.map(id=>[id,id])),sendCard:async(s,c)=>{sent.push(c);return 'delivered';},
   sendMarkdown:async m=>{sent.push(m);return 'delivered';},updateCard:async(...a)=>updates.push(a),isDirect:()=>false,quitChat:async()=> 'delivered'}};
 return {svc,cards,seen,updates,sent,answers,binding};
}
test('two people submit independently, update their own answer, and only initiator can close',async()=>{
 const f=fixture(),source='source';
 await assistantAction(f.svc,{id:'server'},{source,owner:'owner',requestId:'request',kind:'interaction',definition:{type:'poll',title:'午饭',options:['面','饭']}},new AbortController().signal);
 const card=[...f.cards.values()].find(c=>c.multi),control=[...f.cards.values()].find(c=>c.multiControl);
 const event=(author,id,option)=>({source,author,id,taskId:card.task_id,selected:[{questionKey:'q0',optionIds:[option]}],at:1,responseCode:'code'});
 await interactionEvent(f.svc,event('alice','a','o0'),card);await interactionEvent(f.svc,event('bob','b','o1'),card);
 await interactionEvent(f.svc,event('alice','a2','o1'),card);
 assert.ok(f.updates.every(a=>!('deliveryStatus' in a[1])&&!('participants' in a[1])&&!('sub_title_text' in a[1])));
 assert.equal(f.answers.size,2);assert.deepEqual(f.updates.map(a=>a[2]),[['alice'],['bob'],['alice']]);
 assert.match(submissionSummary(card,[...f.answers.values()]),/饭：2 人/u);assert.ok(f.seen.every(e=>e.mentioned===false));
 assert.equal(await interactionEvent(f.svc,{...event('bob','close','o1'),eventKey:'oc-close'},control),'not_owner');
 assert.equal(await interactionEvent(f.svc,{...event('owner','close2','o1'),eventKey:'oc-close'},control),'closed');
 assert.equal(await interactionEvent(f.svc,event('bob','later','o0'),card),'closed');assert.equal(f.answers.get('bob').selected[0].optionIds[0],'o1');
});
test('task menu and retiring bot are restricted to the original owner',async()=>{
 const f=fixture(),source='source',key='join:wecom:task-return:'+'a'.repeat(64);
 await assistantAction(f.svc,{id:'server'},{source,owner:'owner',requestId:'task',kind:'task-card',taskKey:key,title:'构建',state:'running'},new AbortController().signal);
 const card=[...f.cards.values()][0],e={source,author:'bob',id:'e1',eventKey:'oc-stop',responseCode:'code',at:1};
 assert.equal(await interactionEvent(f.svc,e,card),'not_owner');assert.equal(f.seen.length,0);
 await interactionEvent(f.svc,{...e,author:'owner'},card);assert.equal(parseControl(f.seen[0].text).taskKey,key);
 await assert.rejects(assistantAction(f.svc,{id:'server'},{source,owner:'bob',requestId:'quit',kind:'quit-chat'},new AbortController().signal),/binding owner/u);
 assert.equal(await assistantAction(f.svc,{id:'server'},{source,owner:'owner',requestId:'quit',kind:'quit-chat'},new AbortController().signal),'delivered');
});

test('explicit collection continuation survives normalization but never enters provider card JSON',()=>{
 const action=parseInteractionAction('/投票 '+JSON.stringify({title:'时间',options:['一','二'],onClose:'结束后安排时间'}));assert.equal(action.definition.onClose,'结束后安排时间');assert.ok(!JSON.stringify(interactionCard(action.definition,'id')).includes('结束后安排时间'));assert.throws(()=>parseInteractionAction('/投票 '+JSON.stringify({title:'时间',options:['一','二'],onClose:'x'.repeat(2001)})));
});

test('queued task cards do not claim running; progress callbacks retain original owner and task key',async()=>{
 const f=fixture(),key='join:wecom:task-return:'+'a'.repeat(64);
 assert.equal(parseInteractionAction('/任务卡片 '+JSON.stringify({taskKey:key,title:'构建',state:'queued'})).state,'queued');
 await assistantAction(f.svc,{id:'server'},{source:'source',owner:'owner',requestId:'queued',kind:'task-card',taskKey:key,title:'构建',state:'queued'},new AbortController().signal);
 const card=[...f.cards.values()][0];assert.match(JSON.stringify(card),/等待执行/u);assert.ok(!JSON.stringify(card).includes('oc-stop'));assert.ok(JSON.stringify(card).includes('oc-task-status'));
 const e={source:'source',author:'bob',id:'status-event',eventKey:'oc-task-status',responseCode:'code',at:1};assert.equal(await interactionEvent(f.svc,e,card),'not_owner');assert.equal(f.seen.length,0);
 await interactionEvent(f.svc,{...e,author:'owner'},card);assert.equal(parseControl(f.seen[0].text).action,'status');assert.equal(parseControl(f.seen[0].text).taskKey,key);
});
