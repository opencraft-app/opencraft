import {richActionSummary} from './rich-outbound.mjs';
import {editConnectedGroup,groupEditResults} from './group-edit.mjs';
import {readGroupSync} from './group-sync-storage.mjs';
import {utf8Chunks} from './text-chunks.mjs';
import { parseInteractionAction } from './interaction-actions.mjs';
import { parseReport, reportSummary } from './report-card.mjs';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Collaboration } from '../../../../packages/access-control/src/collaboration.js';
import type { ActorContext } from '../../../../packages/identity-core/src/actors.js';
import type { PersonalAssistants } from '../../../../packages/access-control/src/personal-assistants.js';
import { wecomMention } from './assistant-mentions.mjs';
import { stageGroupFile, stageGroupFileChunk, stageGroupAction, finishGroupFileUpload, MAX_GROUP_FILE_BYTES } from './outbound-files.mjs';

type Row = Record<string, any>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = () => { throw Error('wecom_assistant_denied'); };
function actionOwner(service: Collaboration, r: Row): string {
  const provider='wecom.'+JSON.parse(r.source)[1];
  const bindings=service.actors.bindings(r.owner_id).filter(b=>b.provider===provider
    && service.actors.findHuman({provider,subject:b.subject})?.id===r.owner_id);
  if(bindings.length!==1)return denied();
  return bindings[0]!.subject;
}
const reasons: Record<string,string> = {
  identity: '请先在本服务器关联你自己的企业微信身份，再 @助理。',
  membership: '请先加入本群关联的原生群，再 @你自己的助理。',
  assistant: '请先在本服务器开通你自己的助理，再回群 @提问。',
  capacity: '你在本服务器的群助理会话已达到上限，请联系管理员。',
};
function current(service: Collaboration, db: DatabaseSync, r: Row) {
  const owner = service.actors.get(r.owner_id), bot = service.actors.get(r.assistant_id);
  const assignment = db.prepare("SELECT * FROM personal_assistants WHERE actor_id=? AND state='claimed'").get(r.assistant_id) as Row | undefined;
  const source = db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND active=1').get(r.source) as Row | undefined;
  return owner?.enabled && owner.kind==='human' && owner.generation===r.owner_generation && service.admittedActor(owner.id)
    && bot?.enabled && service.admittedActor(bot.id) && assignment?.owner_human_id===owner.id
    && assignment.is_default===1 && assignment.owner_generation===owner.generation && assignment.epoch===r.assistant_epoch
    && service.channels.memberEpoch(r.channel_id,owner.id)===r.member_epoch
    && source?.channel_id===r.channel_id && source?.epoch===r.source_epoch
    && (db.prepare('SELECT author_id FROM actor_messages WHERE id=?').get(r.message_id)?.author_id===owner.id
      ? service.actors.bindings(owner.id).some(b=>b.provider==='tencentoa')
      : service.actors.findHuman({provider:'wecom.'+JSON.parse(r.source)[1],subject:r.user_id})?.id===owner.id);
}
function output(service: Collaboration, db: DatabaseSync, r: Row, id: string, content: string, c?: ActorContext, payloadHash=hash(content)) {
  const messageId='wecom-assistant:'+hash([r.scope ?? r.message_id,id]);
  const prior=db.prepare('SELECT m.content,r.payload_hash FROM actor_messages m JOIN join_wecom_assistant_replies r ON r.message_id=m.id WHERE m.id=?').get(messageId);
  if(prior) { if(prior.content!==content||prior.payload_hash!==payloadHash)throw Error('idempotency_conflict');return {messageId}; }
  const author=c?.actorId??'external:wecom-assistant-notice';
  const name=c?`${service.actors.get(r.owner_id)!.displayName}的助理`:'OpenCraft';
  db.prepare(`INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,reply_to,created_at,target_kind,author_display_name)
    VALUES(?,(SELECT COALESCE(MAX(seq),0)+1 FROM actor_messages),?,?,?,?,?,?,'channel',?)`)
    .run(messageId,r.channel_id,author,r.channel_id,content,null,service.now(),name);
  db.prepare('INSERT INTO join_wecom_assistant_replies VALUES(?,?,?)').run(messageId,r.message_id,payloadHash);
  db.prepare(`INSERT INTO actor_channel_outbox(message_id,source,source_epoch,actor_generation,member_epoch,credential_id,actor_expires_at,state)
    VALUES(?,?,?,?,?,?,?,'queued')`).run(messageId,r.source,r.source_epoch,c?.generation??0,r.member_epoch??'',c?.credentialId??null,c?.expiresAt??service.now()+3600000);
  service.channels.changed({channelId:r.channel_id});
  return {messageId};
}
/** Called only inside trusted native ingress, in the SAME transaction as the message. */
export function admitWecomAssistant(service: Collaboration, db: DatabaseSync, arrival: Row, source: Row, messageId: string, nativeContext?: ActorContext) {
  const mention=wecomMention(arrival);if(mention?.kind!=='assistant')return;
  let parts;try { parts=JSON.parse(arrival.source); } catch { return; }
  if(!Array.isArray(parts)||parts.length!==4||parts[0]!=='wecom-customer-service'||!/^wx[a-z0-9]+$/iu.test(parts[1]))return;
  // Never use the group binder, a display name or client-supplied owner ID.
  const owner=nativeContext?service.actors.get(nativeContext.actorId):service.actors.findHuman({provider:'wecom.'+parts[1],subject:arrival.author});
  const member=owner&&service.channels.memberEpoch(String(source.channel_id),owner.id);
  const assistant=owner&&db.prepare("SELECT * FROM personal_assistants WHERE owner_human_id=? AND is_default=1 AND state='claimed'").get(owner.id) as Row | undefined;
  let reason=!owner?.enabled||owner.kind!=='human'||!service.admittedActor(owner.id)?'identity':!member?'membership':
    !assistant||assistant.owner_generation!==owner.generation||!service.actors.get(assistant.actor_id)?.enabled||!service.admittedActor(assistant.actor_id)?'assistant':null;
  const scope=reason?null:hash([source.source,source.epoch,owner!.id,owner!.generation,assistant!.epoch,member]);
  // Bound retained group runners per assignment; a revoked membership/claim does
  // not consume a slot. Capacity is explicit, never silently drop queued turns.
  if(!reason) {
    const scopes=db.prepare('SELECT * FROM join_wecom_assistant_requests WHERE assistant_id=? AND scope IS NOT NULL GROUP BY scope').all(assistant!.actor_id) as Row[];
    if(!scopes.some(r=>r.scope===scope)&&scopes.filter(r=>current(service,db,r)).length>=8)reason='capacity';
  }
  const r={message_id:messageId,scope:reason?null:scope,source:source.source,source_epoch:source.epoch,channel_id:source.channel_id,user_id:arrival.author,
    owner_id:owner?.id??null,owner_generation:owner?.generation??null,assistant_id:assistant?.actor_id??null,assistant_epoch:assistant?.epoch??null,member_epoch:member??null,reason};
  db.prepare('INSERT INTO join_wecom_assistant_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.message_id,r.scope,r.source,r.source_epoch,r.channel_id,r.user_id,r.owner_id,r.owner_generation,r.assistant_id,r.assistant_epoch,r.member_epoch,r.reason);
  if(reason)output(service,db,r,'notice',reasons[reason]!);
}
/** Native outbox calls this before sending and again after async provider work. */
export function wecomAssistantDeliveryAllowed(service: Collaboration, db: DatabaseSync, delivery: Row): boolean | undefined {
  const r=db.prepare('SELECT r.* FROM join_wecom_assistant_replies d JOIN join_wecom_assistant_requests r ON r.message_id=d.request_id WHERE d.message_id=?').get(delivery.message_id) as Row | undefined;
  if(!r)return undefined;
  if(delivery.source!==r.source||delivery.source_epoch!==r.source_epoch||delivery.channel_id!==r.channel_id||delivery.actor_expires_at<=service.now())return false;
  if(r.reason)return delivery.author_id==='external:wecom-assistant-notice';
  return !!current(service,db,r) && delivery.author_id===r.assistant_id && service.actors.isCurrent({actorId:delivery.author_id,generation:delivery.actor_generation,credentialId:delivery.credential_id,expiresAt:delivery.actor_expires_at});
}
/** Private Host IPC only; deliberately absent from public RPC/HTTP allowlists. */
export function wecomAssistantCommand(service: Collaboration, db: DatabaseSync, assistants: PersonalAssistants, c: ActorContext, method: string, p: Row) {
  const access=assistants.readAuthority(c);
  const operation=method.slice('join/wecom-assistant/'.length);
  const keys:Record<string,string[]>={scopes:[],'edit-results':['scope'],'edit-result-ack':['scope','receiptId','revision'],authorize:['scope'],'provider-grant':['scope'],activity:['scope','after','latest'],messages:['scope','after'],history:['scope','before'],image:['scope','messageId','offset'],search:['scope','query','before','limit'],reply:['scope','id','text'],file:['scope','id','name','data','offset','size','mode'],chat:['scope','id','title','members'],edit:['scope','id','add','remove','name']};
  if(!keys[operation]||Object.keys(p).some(k=>!keys[operation]!.includes(k)))return denied();
  if(operation==='scopes') {
    const rows=db.prepare('SELECT * FROM join_wecom_assistant_requests WHERE assistant_id=? AND scope IS NOT NULL GROUP BY scope').all(c.actorId) as Row[];
    return rows.filter(r=>current(service,db,r)).map(r=>({scope:r.scope,channelId:r.channel_id}));
  }
  if(typeof p.scope!=='string'||!/^[a-f0-9]{64}$/u.test(p.scope))return denied();
  const r=db.prepare('SELECT * FROM join_wecom_assistant_requests WHERE scope=? AND assistant_id=? LIMIT 1').get(p.scope,c.actorId) as Row | undefined;
  if(!r||!current(service,db,r))return denied();
  if(operation==='authorize')return {...access,source:r.source};
  if(operation==='edit-results'||operation==='edit-result-ack')return groupEditResults(service,db,access.context,{source:r.source,channelId:r.channel_id,scope:r.scope},operation==='edit-result-ack'?p:undefined);
  if(operation==='provider-grant')return {source:r.source,owner:actionOwner(service,r)};
  if(operation==='activity') {
    if(!Number.isSafeInteger(p.after)||p.after<0||p.latest!==undefined&&typeof p.latest!=='boolean')return denied();
    const latestSequence=(db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM actor_messages WHERE channel_id=?').get(r.channel_id) as Row).seq;
    const messages:Row[]=[];
    if(!p.latest)for(const row of db.prepare('SELECT id,seq,author_id,content,created_at FROM actor_messages WHERE channel_id=? AND seq>? ORDER BY seq LIMIT 50').all(r.channel_id,p.after)) {
      if(Buffer.byteLength(JSON.stringify([...messages,row]))>384*1024)break;
      messages.push(row);
    }
    return {latestSequence,messages};
  }
  if(operation==='messages') {
    if(!Number.isSafeInteger(p.after)||p.after<0)return denied();
    return db.prepare('SELECT m.id,m.seq,m.content,m.author_id,m.created_at,i.state AS image_state FROM join_wecom_assistant_requests r JOIN actor_messages m ON m.id=r.message_id LEFT JOIN actor_channel_images i ON i.message_id=m.id WHERE r.scope=? AND m.seq>? ORDER BY m.seq LIMIT 50').all(p.scope,p.after).map(({image_state,...m}:Row)=>({...m,...(image_state?{image:{state:image_state}}:{})}));
  }
  if(operation==='image') {
    if(typeof p.messageId!=='string'||!p.messageId||p.messageId.length>256||!Number.isSafeInteger(p.offset)||p.offset<0||p.offset>2097152)return denied();
    const m=db.prepare('SELECT m.seq FROM actor_messages m JOIN actor_channel_images i ON i.message_id=m.id WHERE m.id=? AND m.channel_id=? AND (i.source=? OR i.source IS NULL)').get(p.messageId,r.channel_id,r.source) as Row|undefined;
    if(!m)return denied();
    const image=service.channels.image(access.context,r.channel_id,m.seq);if(!image)return null;
    const bytes=Buffer.from(image.bytes as Uint8Array);if(!['image/png','image/jpeg'].includes(String(image.type))||!bytes.length||bytes.length>2097152||p.offset>=bytes.length)return denied();
    const part=bytes.subarray(p.offset,p.offset+65536);
    return {type:image.type,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:part.toString('base64'),nextOffset:p.offset+part.length};
  }
  if(operation==='history'||operation==='search') {
    if(p.before!==undefined&&(!Number.isSafeInteger(p.before)||p.before<1))return denied();
    const result=operation==='history'?service.channels.history(access.context,r.channel_id,p.before):service.channels.search(access.context,r.channel_id,p.query,p.before,p.limit);
    return {...result,messages:result.messages.map(({executionRequests:_,...message})=>message)};
  }
  if(operation==='chat') {
    // Only the requester's own assistant reaches here; the requester is the owner of the new group.
    if(typeof p.id!=='string'||!p.id||p.id.length>256||typeof p.title!=='string'||!p.title.trim()||p.title.length>60
      ||!Array.isArray(p.members)||p.members.length>50||!p.members.every((m:unknown)=>typeof m==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(m)))return denied();
    const requester=actionOwner(service,r);
    const receipt=output(service,db,r,p.id+':chat',`[建群] ${p.title}`,c,hash(['chat',p.title,p.members]));
    stageGroupAction(receipt.messageId,{kind:'create-chat',title:p.title.trim(),members:p.members,owner:requester});
    return receipt;
  }
  if(operation==='edit') {
    // The requester's own assistant edits the group it was asked in; the Relay checks membership again.
    const rtx=(v:unknown)=>Array.isArray(v)&&v.length<=50&&v.every(m=>typeof m==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{1,63}$/u.test(m));
    if(typeof p.id!=='string'||!p.id||p.id.length>256||!rtx(p.add)||!rtx(p.remove)
      ||(p.name!==undefined&&(typeof p.name!=='string'||!p.name.trim()||p.name.length>128||!p.name.isWellFormed()))||(!p.add.length&&!p.remove.length&&!p.name))return denied();
    // A pre-adoption receipt remains a replay of the old provider-only action;
    // enabling the connection must never execute that same request natively.
    const legacyId='wecom-assistant:'+hash([r.scope,p.id+':edit']);
    const legacy=db.prepare('SELECT payload_hash FROM join_wecom_assistant_replies WHERE message_id=?').get(legacyId);
    if(legacy&&readGroupSync(db,r.source)) {
      if(legacy.payload_hash!==hash(['edit',p.add,p.remove,p.name??null]))throw Error('idempotency_conflict');
      return {messageId:legacyId};
    }
    const edited=editConnectedGroup(service,db,access.context,{source:r.source,channelId:r.channel_id,scope:r.scope},p);
    if(edited)return edited;
    if(p.name!==undefined&&p.name.length>60)return denied();
    const requester=actionOwner(service,r);
    const line=['[群设置]',p.name?'群名改为 '+p.name:'',p.add.length?'拉入 '+p.add.join('、'):'',p.remove.length?'移出 '+p.remove.join('、'):''].filter(Boolean).join(' ');
    const receipt=output(service,db,r,p.id+':edit',line,c,hash(['edit',p.add,p.remove,p.name??null]));
    stageGroupAction(receipt.messageId,{kind:'edit-chat',add:p.add,remove:p.remove,...(p.name?{name:p.name.trim()}:{}),owner:requester});
    return receipt;
  }
  if(operation==='file') {
    const mode=p.mode??'auto';if(!['auto','image','file'].includes(mode))return denied();
    // The timeline shows a readable line; the transport sends the staged bytes in its place.
    if(typeof p.id!=='string'||!p.id||p.id.length>256||typeof p.name!=='string'||!p.name.trim()||p.name.length>160||/[\\/\x00-\x1f]/u.test(p.name)
      ||typeof p.data!=='string'||p.data.length>Math.ceil(MAX_GROUP_FILE_BYTES/3)*4)return denied();
    let bytes=Buffer.from(p.data,'base64');
    if(!bytes.length||bytes.length>MAX_GROUP_FILE_BYTES||bytes.toString('base64')!==p.data)return denied();
    const uploadId=p.offset!==undefined||p.size!==undefined?hash([p.scope,p.id]):undefined;
    if(uploadId) {
      const complete=stageGroupFileChunk(uploadId,p.name,bytes,p.offset,p.size,mode);
      if(!complete)return {pending:true};
      if(!(complete instanceof Uint8Array)) {
        const expected='wecom-assistant:'+hash([r.scope,p.id+':file']);
        if(complete.deliveredMessageId!==expected||!db.prepare('SELECT 1 FROM actor_channel_outbox WHERE message_id=?').get(expected))return denied();
        return {messageId:expected};
      }
      bytes=complete;
    }
    const receipt=output(service,db,r,p.id+':file',`[文件] ${p.name}`,c,hash(['file',p.name,hash(bytes.toString('base64')),...(mode==='auto'?[]:[mode])]));
    if(db.prepare("SELECT 1 FROM actor_channel_outbox WHERE message_id=? AND state='delivered'").get(receipt.messageId)) {
      if(uploadId)finishGroupFileUpload(uploadId,receipt.messageId);
    }else stageGroupFile(receipt.messageId,p.name,bytes,{uploadId,mode});
    return receipt;
  }
  if(typeof p.id!=='string'||!p.id||p.id.length>256||typeof p.text!=='string'||!p.text.trim()||p.text.length>65536||!p.text.isWellFormed())return denied();
  const action=parseInteractionAction(p.text);
  if(action){
    const owner=actionOwner(service,r);
    const receipt=output(service,db,r,p.id+':action',['rich-message','rich-card','custom-shortcuts'].includes(action.kind)?richActionSummary(action):'[群操作] '+(action.definition?.title??action.kind),c,hash(action));
    stageGroupAction(receipt.messageId,{...action,owner,requestId:receipt.messageId});
    return {...receipt,...(action.kind==='interaction'?{taskId:'oc-m-'+hash([r.source,receipt.messageId]).slice(0,40)}:{})};
  }
  const report=parseReport(p.text);
  if(report) {
    const receipt=output(service,db,r,p.id+':report',reportSummary(report),c,hash(report));
    stageGroupAction(receipt.messageId,{kind:'report',report,owner:actionOwner(service,r),requestId:receipt.messageId});
    return receipt;
  }
  // Preserve old admission IDs on an exact replay; new output is UTF-8 framed.
  const old=db.prepare('SELECT m.content,r.payload_hash FROM actor_messages m JOIN join_wecom_assistant_replies r ON r.message_id=m.id WHERE m.id=?').get('wecom-assistant:'+hash([r.scope,p.id+':0']));
  const legacy:string[]=[];let remaining=p.text;
  if(old)while(remaining.length){let end=Math.min(3500,remaining.length);if(end<remaining.length&&/[\uD800-\uDBFF]/u.test(remaining[end-1]!))end--;legacy.push(remaining.slice(0,end));remaining=remaining.slice(end);}
  const chunks=old&&old.payload_hash===hash(p.text)&&old.content===legacy[0]?legacy:utf8Chunks(p.text);
  const payloadHash=hash(p.text);let receipt;
  for(const [i,chunk] of chunks.entries())receipt=output(service,db,r,p.id+':'+i,chunk,c,payloadHash);
  return receipt;
}

/** Native @ in a linked room is also internal IOA behavior. A normal core group
 * keeps its existing execution semantics. The authenticated sender owns routing. */
export function admitNativeWecomAssistant(service: Collaboration, db: DatabaseSync, c: ActorContext, channelId: string, messageId: string, text: string, target?: string) {
  if(!service.actors.isCurrent(c)||service.actors.get(c.actorId)?.kind!=='human'||!service.actors.bindings(c.actorId).some(b=>b.provider==='tencentoa'))return false;
  const source=db.prepare('SELECT * FROM actor_channel_sources WHERE channel_id=? AND active=1').get(channelId) as Row | undefined;
  if(!source||!String(source.source).startsWith('["wecom-customer-service",'))return false;
  if(target) {
    const own=db.prepare("SELECT actor_id FROM personal_assistants WHERE owner_human_id=? AND is_default=1 AND state='claimed'").get(c.actorId);
    if(own?.actor_id!==target)return false;
  } else if(!/^@(助理|我的助理)(?:\s|$)/u.test(text.trim()))return false;
  if(db.prepare('SELECT 1 FROM join_wecom_assistant_requests WHERE message_id=?').get(messageId))return true;
  admitWecomAssistant(service,db,{source:source.source,author:c.actorId,mentioned:true,text},source,messageId,c);
  return true;
}

export function wecomAssistantReadGuard(db: DatabaseSync, assistants: PersonalAssistants, c: ActorContext, scope: unknown) {
  if(typeof scope!=='string')return undefined;
  const r=db.prepare('SELECT channel_id,member_epoch FROM join_wecom_assistant_requests WHERE scope=? AND assistant_id=? LIMIT 1').get(scope,c.actorId) as Row | undefined;
  if(!r)return undefined;
  return {epoch:assistants.readAuthority(c).epoch,groups:[{id:r.channel_id,epoch:r.member_epoch}]};
}
