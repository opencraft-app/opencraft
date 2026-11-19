import {groupSyncCli} from './group-sync-storage.mjs';
import {groupEditStatus} from './group-edit.mjs';
import {readJson} from './durable-json.mjs';
import {deploymentPaths} from '../../../../scripts/container-deployment/paths.mjs';
import {join} from 'node:path';
import {groupOperationResult} from './outbound-files.mjs';
const deny=code=>{throw Object.assign(Error(code),{status:403,code});};
const text=(v,max=16000)=>{if(typeof v!=='string'||!v.trim()||v.length>max||!v.isWellFormed())deny('invalid_wecom_argument');return v;};
export function parseScopedWecom(argv) {
  if(!Array.isArray(argv)||argv.length>128||argv.some(a=>typeof a!=='string'||a.length>60000))deny('invalid_wecom_argv');
  const args=[],options={},allowed=['--group','--idempotency-key','--before','--limit'];
  for(let i=0;i<argv.length;i++)if(argv[i].startsWith('--')){const k=argv[i];if(k==='--json')continue;if(!allowed.includes(k)||options[k]!==undefined||argv[i+1]===undefined)deny('invalid_wecom_option');options[k]=argv[++i];}else args.push(argv[i]);
  return {args,group:options['--group'],key:options['--idempotency-key'],before:options['--before']===undefined?undefined:Number(options['--before']),limit:options['--limit']===undefined?undefined:Number(options['--limit'])};
}
export const wecomCapabilities=()=>({version:1,transport:'private assistant/conversation-bound CLI',commands:['groups','chat get','chat live','chat members','chat create','chat rename','chat add','chat remove','chat quit','history','search','file info','image get','status','send text','send md','send image','send file','send rich','card notice','card news','card buttons','card vote','card select','shortcuts','task list','task get','task stop','task rerun','daily pause','watch add','watch list','watch remove','collection list','collection get','collection close','collection export','collection cancel'],automatic:['inbound media/voice/forward callbacks','card verification and updates','assistant reply streaming','interaction summaries/deadlines/reminders/CSV export','member provider identity and robot recognition'],operatorOnly:['provider token','unscoped media IDs','arbitrary provider card handlers','arbitrary external private chats','unscoped directory lookup'],groupOperations:'chat rename/add/remove automatically use native group operations for adopted connections; USER is an RTX identity, never a display name or guessed provider userid; remove also accepts a unique directory reservation observed in this group; native owner permissions apply',mutations:'explicit --idempotency-key; status accepts messageId or receiptId; local.applied does not mean WeCom confirmed; only wecom.confirmed verifies an adopted group edit; do not echo technical states to users',cardSchema:'notice/news: report object; buttons: {buttons:[{title,prompt}]}; vote: {title,options,multiple?,deadline?,remindBeforeMinutes?,onClose?}; select: {title,questions:[{title,options}],deadline?,remindBeforeMinutes?,onClose?}'});
/** Existing communication Worker transaction. Only the authenticated Bot may use
 * its current scopes. A Human or a model-supplied identity cannot impersonate it. */
export function wecomCliCommand(service,db,assistants,c,p,request) {
  if(Object.keys(p).some(k=>!['argv','scope'].includes(k)))deny('invalid_wecom_argument');
  const authority=assistants.readAuthority(c),cmd=parseScopedWecom(p.argv),[verb,sub,...tail]=cmd.args;
  if(p.scope!==undefined)request('authorize',{scope:p.scope});
  if(verb==='capabilities')return wecomCapabilities();
  const bindings=request('scopes',{}).filter(b=>p.scope===undefined||b.scope===p.scope).map(b=>({...b,source:request('authorize',{scope:b.scope}).source}));
  if(verb==='groups')return {groups:bindings.map(b=>({id:b.channelId,externalId:JSON.parse(b.source)[3]}))};
  const b=bindings.find(b=>b.channelId===cmd.group||JSON.parse(b.source)[3]===cmd.group?.replace(/^g:/u,''));if(!b)deny('wecom_group_denied');
  if(verb==='sync')return groupSyncCli(service,db,authority.context,b,cmd);
  const send=content=>request('reply',{scope:b.scope,id:text(cmd.key,80),text:content});
  if(verb==='history'||verb==='search')return request(verb,{scope:b.scope,...(cmd.before===undefined?{}:{before:cmd.before}),...(verb==='search'?{query:text(sub),...(cmd.limit===undefined?{}:{limit:cmd.limit})}:{})});
  if(verb==='chat'&&sub==='get')return {id:b.channelId,externalId:JSON.parse(b.source)[3],membershipSource:'native',members:service.channelMembers(authority.context,b.channelId)};
  if(verb==='chat'&&sub==='live')return {providerQuery:{scope:b.scope,query:{kind:'chat'}}};
  if(verb==='file'&&sub==='info'){
    const id=text(tail[0],33);if(!/^f[a-f0-9]{32}$/u.test(id))deny('invalid_wecom_file');const folder=join(deploymentPaths().dataDirectory,'join-wecom-inbound-files',id);
    if(readJson(join(folder,'source.json'))?.source!==b.source)deny('wecom_file_denied');const m=readJson(join(folder,'meta.json'));return {reference:id,name:m?.name,status:m?.original?'original_only':m?.status??'pending',bytes:m?.bytes,original:m?.original,parts:0};
  }
  if(verb==='status'){
    const id=text(sub,200);
    if(/^group-edit:[a-f0-9]{64}$/u.test(id))return groupEditStatus(service,db,authority.context,b,id);
    const row=db.prepare('SELECT m.* FROM actor_messages m JOIN join_wecom_assistant_replies rp ON rp.message_id=m.id JOIN join_wecom_assistant_requests q ON q.message_id=rp.request_id WHERE m.id=? AND q.scope=? AND q.assistant_id=?').get(id,b.scope,c.actorId);
    if(!row)deny('wecom_receipt_denied');return {messageId:id,deliveries:db.prepare('SELECT state FROM actor_channel_outbox WHERE message_id=?').all(id),operation:groupOperationResult(id)};
  }
  if(verb==='upload'){
    const f=JSON.parse(text(sub,60000));if(Object.keys(f).some(k=>!['name','offset','size','data','mode'].includes(k))||typeof f.data!=='string'||f.data.length>54616)deny('invalid_wecom_file');
    return request('file',{scope:b.scope,id:text(cmd.key,80),...f});
  }
  const member=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(v);
  if(verb==='collection'&&['close','export'].includes(sub)){
    const taskId=tail[0];if(typeof taskId!=='string'||!/^oc-m-[a-f0-9]{40}$/u.test(taskId))deny('invalid_wecom_collection');
    return send('/收集操作 '+JSON.stringify({action:sub,taskId}));
  }
  if(verb==='chat'){
    if(sub==='create'){text(tail[0],60);if(tail.slice(1).length>50||tail.slice(1).some(v=>!member(v)))deny('invalid_wecom_member');return request('chat',{scope:b.scope,id:text(cmd.key,80),title:tail[0],members:tail.slice(1)});}
    if(['rename','add','remove'].includes(sub)){const name=sub==='rename'?text(tail[0],128):undefined,members=name?[]:tail;if(!name&&!members.length||members.length>50||members.some(v=>!member(v)))deny('invalid_wecom_member');return request('edit',{scope:b.scope,id:text(cmd.key,80),add:sub==='add'?members:[],remove:sub==='remove'?members:[],...(name?{name}:{})});}
    if(sub==='members'||sub==='quit')return send(sub==='members'?'/群成员':'/退群');
  }
  if(verb==='send'&&['text','md'].includes(sub))return send(text(tail[0]));
  if(verb==='send'&&sub==='rich')return send('/富文本 '+text(tail[0],32000));
  if(verb==='card'){const format={notice:'图文',news:'图文',buttons:'快捷入口',vote:'投票',select:'表单'}[sub];if(!format)deny('wecom_use_managed_card_commands');return send('/'+format+' '+text(tail[0],32000));}
  if(verb==='shortcuts')return send('/快捷入口'+(sub?' '+text(sub,32000):''));
  deny('unsupported_wecom_command_use_capabilities');
}
