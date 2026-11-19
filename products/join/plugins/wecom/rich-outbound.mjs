import {createHash} from 'node:crypto';
import {reportCard} from './report-card.mjs';
const label=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max||!v.isWellFormed())throw Error('Invalid rich message text');return v.trim();};
const url=v=>{const u=new URL(label(v,2048));if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Invalid rich message URL');return u.href;};
const buttons=v=>{if(!Array.isArray(v)||!v.length||v.length>8)throw Error('Expected 1–8 shortcuts');return v.map(b=>({title:label(b.title,20),prompt:label(b.prompt,400)}));};
export function parseRichAction(text) {
  const m=/^\s*\/(富文本|快捷入口|消息卡片)\s+(\{[\s\S]*\})\s*$/u.exec(text);if(!m)return null;
  const v=JSON.parse(m[2]);
  if(m[1]==='快捷入口')return {kind:'custom-shortcuts',buttons:buttons(v.buttons)};
  if(m[1]==='消息卡片') {
    const card=reportCard({title:v.title,summary:v.summary,url:v.url,imageUrl:v.imageUrl,metrics:v.metrics});
    let sections=[];
    if(v.sections!==undefined){if(!Array.isArray(v.sections)||v.sections.length>4)throw Error('Too many card sections');sections=v.sections.map(s=>({title:label(s.title,26),desc:label(s.text,112)}));}
    if(card.card_type==='news_notice'&&sections.length)card.vertical_content_list=sections;
    if(v.links!==undefined){if(!Array.isArray(v.links)||v.links.length>3)throw Error('Too many card links');card.jump_list=v.links.map(l=>({type:1,title:label(l.title,18),url:url(l.url)}));}
    const actions=v.buttons?buttons(v.buttons):[];if(actions.some(b=>b.prompt.length>128))throw Error('Card menu prompt exceeds 128 characters');if(actions.length>2)throw Error('Card menu supports at most 2 actions');
    const quote=[...(card.card_type==='text_notice'?sections.map(s=>s.title+'：'+s.desc):[]),...(actions.length?['菜单指令（点击者自己的助理）：',...actions.map(b=>b.title+'：'+b.prompt)]:[])];
    if(quote.length)card.quote_area={type:0,title:card.card_type==='text_notice'&&sections.length?'详细内容':'菜单指令',quote_text:quote.join('\n')};
    return {kind:'rich-card',card,buttons:actions,...(sections.length?{sections}:{})};
  }
  if(!Array.isArray(v.parts)||!v.parts.length||v.parts.length>32)throw Error('Expected 1–32 rich parts');
  const parts=v.parts.map(p=>{
    if(p.type==='text')return {type:'text',text:label(p.text,4000)};
    if(p.type==='link')return {type:'link',title:label(p.title,80),url:url(p.url)};
    if(p.type==='button')return {type:'button',...buttons([{title:p.title,prompt:p.prompt}])[0]};
    if(p.type==='mention'){
      if(!Array.isArray(p.members)||!p.members.length||p.members.length>50||p.members.some(id=>typeof id!=='string'||! /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(id)||/^(wb|fw)/u.test(id)))throw Error('Mention current employee accounts only; @all is not allowed here');
      return {type:'mention',members:[...new Set(p.members)]};
    }
    throw Error('rich_text supports text, links, buttons and mentions; use 消息卡片 for pictures');
  });
  if(Buffer.byteLength(JSON.stringify(parts))>12000)throw Error('Rich message too large');
  return {kind:'rich-message',parts};
}
export const shortcutKey=(source,requestId,index)=>'oc-x-'+createHash('sha256').update(JSON.stringify([source,requestId,index])).digest('hex').slice(0,40);
export function richActionSummary(action) {
  if(action.kind==='rich-card')return [action.card.main_title.title,action.card.main_title.desc,...(action.sections??action.card.vertical_content_list??[]).map(s=>s.title+'：'+s.desc),...(action.card.jump_list??[]).map(l=>l.title+'：'+l.url),...action.buttons.map(b=>'[按钮] '+b.title)].filter(Boolean).join('\n');
  return (action.parts??action.buttons).map(p=>p.type==='text'?p.text:p.type==='link'?p.title+'：'+p.url:p.type==='mention'?p.members.map(id=>'@'+id).join(' '):'[按钮] '+p.title).join('\n');
}
export async function sendRichAction(svc,input,binding,signal) {
  const {source,owner,requestId}=input;
  // Validate again at the Relay boundary, not just the assistant parser.
  const command=input.kind==='rich-message'?'/富文本 '+JSON.stringify({parts:input.parts}):input.kind==='custom-shortcuts'?'/快捷入口 '+JSON.stringify({buttons:input.buttons}):null;
  const checked=command?parseRichAction(command):input;
  const register=async(b,index)=>{
    const key=shortcutKey(source,requestId,index);
    await svc.store.rememberShortcut(source,key,{prompt:b.prompt,title:b.title,owner,binding});return key;
  };
  if(input.kind==='rich-card'){
    const allowed=['card_type','source','main_title','horizontal_content_list','jump_list','card_action','card_image','vertical_content_list','quote_area'];
    const c=input.card;
    if(!c||!['text_notice','news_notice'].includes(c.card_type)||Object.keys(c).some(k=>!allowed.includes(k)))throw Error('Invalid rich card');
    // Reconstruct from the narrow public format; never forward caller-defined card handlers.
    const r=parseRichAction('/消息卡片 '+JSON.stringify({title:c.main_title?.title,summary:c.main_title?.desc,url:c.card_action?.url,imageUrl:c.card_image?.url,
      metrics:c.horizontal_content_list?.map(m=>({label:m.keyname,value:m.value})),sections:(input.sections??c.vertical_content_list)?.map(s=>({title:s.title,text:s.desc})),links:c.jump_list?.map(l=>({title:l.title,url:l.url})),buttons:input.buttons?.length?input.buttons:undefined}));
    const card={...r.card,task_id:'oc-rich-'+createHash('sha256').update(JSON.stringify([source,requestId])).digest('hex').slice(0,40)};
    const actions=[];for(const [i,b]of r.buttons.entries())actions.push({text:b.title,key:await register(b,i)});
    if(actions.length)card.action_menu={desc:'快捷操作',action_list:actions};
    return svc.transport.sendCard(source,card,signal);
  }
  const parts=checked.parts??checked.buttons.map(b=>({type:'button',...b})),wire=[];
  for(const [i,p]of parts.entries()) {
    if(p.type==='text')wire.push({type:'text',text:{content:p.text}});
    else if(p.type==='link')wire.push({type:'link',link:{type:'view',text:p.title,key:p.url,browser:0}});
    else if(p.type==='button'){wire.push({type:'text',text:{content:'\n按钮指令：'+p.prompt+'\n'}},{type:'link',link:{type:'click',text:p.title,key:await register(p,i)}});}
    else {
      const found=await svc.transport.userIds(p.members,signal),members=await svc.transport.chatMembers(source,signal);
      const ids=[...new Set(p.members.map(n=>found.get(n)).filter(id=>id&&members.includes(id)))];
      if(ids.length)wire.push({type:'mentioned',mentioned:{userlist:ids}});
    }
  }
  if(!wire.length)return 'rejected';
  if(Buffer.byteLength(JSON.stringify(wire))>16000||Buffer.byteLength(wire.filter(p=>p.type==='text').map(p=>p.text.content).join(''))>4000)throw Error('Rich message exceeds provider text budget');
  // Documented provider restriction: any link disables mentions in this message.
  // Send a separate real notification, never render a fake @ beside a link.
  if(wire.some(p=>p.type==='mentioned')&&wire.some(p=>p.type==='link')) {
    const status=await svc.transport.sendRichText(source,[...wire.filter(p=>p.type==='mentioned'),{type:'text',text:{content:' 请查看下面的消息。'}}],signal);
    if(status!=='delivered')return status;
    return svc.transport.sendRichText(source,wire.filter(p=>p.type!=='mentioned'),signal);
  }
  return svc.transport.sendRichText(source,wire,signal);
}
export async function shortcutEvent(svc,event) {
  if(!/^oc-x-[a-f0-9]{40}$/u.test(event.eventKey)||/^(wb|fw|external:)/u.test(event.author))return 'ignored';
  const action=await svc.store.shortcut(event.source,event.eventKey),binding=(await svc.store.snapshot(event.source)).binding;
  if(!action||!binding||!action.binding||binding.serverId!==action.binding.serverId||binding.humanKey!==action.binding.humanKey||binding.generation!==action.binding.generation)return 'retired';
  const members=await svc.transport.chatMembers(event.source,AbortSignal.any([svc.abort.signal,AbortSignal.timeout(3000)]));
  if(!members.includes(event.author))return 'not_member';
  return svc.ingest({source:event.source,id:'shortcut:'+event.id,author:event.author,sender:{id:event.author,displayName:event.author},text:action.prompt,at:event.at,mentioned:true});
}
