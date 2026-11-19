import {createNativeMemberOwnerDirectory} from '../tencentoa/src/native-member-owner-directory.mjs';
import {deploymentPaths} from '../../../../scripts/container-deployment/paths.mjs';
import {syncHash} from './group-sync.mjs';
import {readGroupSync,writeGroupSync,reservedRemovalIdentities} from './group-sync-storage.mjs';
import {ownerPrivilegeRequired} from './operation-diagnostics.mjs';

const fail=code=>{throw Object.assign(Error(code),{code,status:403});};
const receiptPrefix='group-edit:';
const keyFor=id=>'wecom-group-edit:'+id.slice(receiptPrefix.length);

function describe(delivery) {
  if(delivery.state==='confirmed')return {state:'confirmed',message:'企业微信已核实此次修改。'};
  if(delivery.state==='local_only')return {state:'local_only',message:'此次修改仅在本群生效，未向企业微信发送。'};
  if(delivery.state==='unlinked')return {state:'needs_attention',message:'本群已修改；该成员尚未关联企业微信身份，企业微信群未修改。'};
  if(delivery.state==='conflict')return {state:'needs_attention',message:'本群已修改；企业微信里的同一项已被其他操作改动，请确认要保留的结果。'};
  if(delivery.reason==='connection_replaced_unknown')return {state:'unconfirmed',message:'企业微信连接已更换，旧操作的结果无法确认；不会自动重发。'};
  if(['rejected','cancelled','retired'].includes(delivery.state)) {
    if(delivery.state==='rejected'&&ownerPrivilegeRequired(delivery.diagnostics))return {state:'needs_attention',message:'本群已修改，但企业微信拒绝了此次操作：需要企业微信群主权限。请企业微信群主处理；不会自动重发，也不影响其他操作分别同步。'};
    const reasons={delivery_capacity:'企业微信待处理操作过多，本次未发送；请在恢复后确认实际状态。',connection_replaced:'企业微信连接已更换，旧操作未继续发送。',source_retired:'企业微信连接已解除。',owner_identity_missing:'群主尚未关联企业微信身份。',authorization_retired:'原操作人的授权已失效。',provider_title_limit:'群名超过企业微信的长度限制。'};
    return {state:'needs_attention',message:'本群已修改，但企业微信未完成。'+(reasons[delivery.reason]??'请检查企业微信群权限和实际结果。')};
  }
  if(['unknown','unavailable'].includes(delivery.state))return {state:'unconfirmed',message:'本群已修改；暂时无法确认企业微信是否完成，请勿重复提交。'};
  return {state:'pending',message:'本群已修改，企业微信尚未确认；系统会继续处理。'};
}

/** Business receipt, not the synchronization registry. A receipt describes this
 * operation's outcome, not a promise that nobody has changed the group since. */
export function groupEditStatus(service,db,context,binding,id) {
  service.channels.assertReadable(context,binding.channelId);
  const row=readGroupSync(db,binding.source),receipt=row?.editReceipts?.[id];
  if(!receipt||receipt.scope!==binding.scope||receipt.actorId!==context.actorId)fail('wecom_group_result_unavailable');
  const changes=receipt.changes.map(change=>{
    const operation=change.operationId&&row.operations.find(o=>o.id===change.operationId);
    const delivery=operation??change.delivery;
    return {...change.change,wecom:{...describe(delivery),...(delivery.diagnostics?{diagnostics:delivery.diagnostics}:{})}};
  });
  const states=changes.map(c=>c.wecom.state);
  const state=['needs_attention','unconfirmed','pending'].find(s=>states.includes(s))??(states.every(s=>s==='confirmed')?'confirmed':states.every(s=>s==='local_only')?'local_only':'partial');
  return {receiptId:id,local:{state:'applied'},wecom:{state},changes};
}

/** Inside the existing Worker transaction. Resolve registered identities, then
 * call the SAME native operations used by the UI; their hook owns propagation.
 * No direct provider write and no new membership authority are introduced. */
export function editConnectedGroup(service,db,context,binding,input) {
  const row=readGroupSync(db,binding.source);
  if(!row||row.observationOnly)return null; // A manual check never adopts legacy group edit behavior.
  service.channels.assertReadable(context,binding.channelId);
  const group=db.prepare('SELECT owner_id,peer_id FROM actor_channels WHERE id=?').get(binding.channelId);
  if(group?.owner_id!==context.actorId||group.peer_id!==null)fail('wecom_group_owner_required');
  const id=receiptPrefix+syncHash([binding.scope,input.id]),key=keyFor(id);
  const fingerprint=syncHash(['wecom-group-edit',input.name??null,input.add,input.remove]);
  const prior=db.prepare('SELECT fingerprint FROM actor_send_keys WHERE actor_id=? AND idempotency_key=?').get(context.actorId,key);
  if(prior) {
    if(prior.fingerprint!==fingerprint)fail('idempotency_conflict');
    // The native dedupe tombstone outlives the bounded result history. Never
    // replay an old action merely because its detailed receipt was evicted.
    if(!row.editReceipts?.[id])return {receiptId:id,local:{state:'applied'},wecom:{state:'unconfirmed'},message:'此次操作已受理，详细结果已过期；请检查当前群状态，不要重复提交。'};
    return groupEditStatus(service,db,context,binding,id);
  }
  let directory;
  const resolve=(rtx,present)=>{
    // CLI USER has always meant RTX. Do not guess provider IDs or display names,
    // and do not register/admit people as a side effect of editing a group.
    const legacy=service.actors.findHuman({provider:'tencentoa',subject:rtx});
    let association;
    try{directory??=createNativeMemberOwnerDirectory(deploymentPaths().dataDirectory);association=directory.resolve(rtx.toLowerCase());}
    catch{fail('wecom_member_identity_required');}
    if(association.state==='conflict')fail('wecom_member_identity_required');
    const mapped=association.state==='resolved'?service.actors.findHuman({provider:'tencentoa',subject:association.subject}):null;
    const actors=[...new Map([legacy,mapped].filter(a=>a?.kind==='human').map(a=>[a.id,a])).values()];
    if(actors.length>1)fail('wecom_member_identity_required');
    if(actors.length===1)return actors[0].id;
    if(!present) {
      const candidates=reservedRemovalIdentities(service,db,row).filter(c=>c.alias===rtx.toLowerCase());
      if(candidates.length===1)return candidates[0].actorId;
    }
    fail('wecom_member_identity_required');
  };
  let remove,add;
  try{remove=[...new Set(input.remove.map(rtx=>resolve(rtx,false)))];add=[...new Set(input.add.map(rtx=>resolve(rtx,true)))];}
  finally{directory?.close();}
  if(remove.some(id=>add.includes(id)))fail('wecom_member_change_conflict');
  const mutations=[...remove.map(actorId=>({kind:'member',actorId,present:false})),...add.map(actorId=>({kind:'member',actorId,present:true})),
    ...(input.name===undefined?[]:[{kind:'name',name:input.name.trim()}])];
  const changes=[];
  for(const [index,mutation] of mutations.entries()) {
    const requestKey=syncHash([id,index]);
    if(mutation.kind==='name')service.renameChannelGroup(context,binding.channelId,mutation.name,requestKey);
    else service.setChannelMember(context,binding.channelId,mutation.actorId,mutation.present,requestKey);
    const current=readGroupSync(db,binding.source);
    const operationId=syncHash([row.source,row.sourceEpoch,context.actorId,requestKey]);
    const operation=current.operations.find(o=>o.id===operationId);
    const mode=mutation.kind==='name'?current.config.name:current.config.members;
    changes.push({change:mutation,...(operation?{operationId,delivery:{state:operation.state,reason:operation.reason}}:{delivery:{state:mode==='both'?'unlinked':'local_only'}})});
  }
  // Reload after native hooks: saving the initial row would lose their journal.
  const updated=readGroupSync(db,binding.source);
  updated.editReceipts??={};
  updated.editReceipts[id]={scope:binding.scope,actorId:context.actorId,changes};
  // Bound by changes as well as requests: one batch may contain many members.
  // Keep this metadata below the private IPC budget, not just below a row count.
  while(Object.keys(updated.editReceipts).length>128||Object.values(updated.editReceipts).reduce((n,r)=>n+r.changes.length,0)>512)
    delete updated.editReceipts[Object.keys(updated.editReceipts)[0]];
  writeGroupSync(db,updated);
  db.prepare('INSERT INTO actor_send_keys VALUES(?,?,?,?,?)').run(context.actorId,key,fingerprint,null,null);
  return groupEditStatus(service,db,context,binding,id);
}

/** Durable terminal outcomes for the original assistant scope, not group notices. */
export function groupEditResults(service,db,context,binding,ack) {
  const row=readGroupSync(db,binding.source);if(!row)return [];
  const results=[];
  for(const [id,receipt] of Object.entries(row.editReceipts??{})) {
    if(receipt.scope!==binding.scope||receipt.actorId!==context.actorId)continue;
    const result=groupEditStatus(service,db,context,binding,id);
    if(!['needs_attention','partial'].includes(result.wecom.state)||result.changes.some(c=>['pending','unconfirmed'].includes(c.wecom.state)))continue;
    const revision=syncHash(result);
    if(ack) {
      if(ack.receiptId!==id||ack.revision!==revision)continue;
      receipt.reported=revision;writeGroupSync(db,row);return {acknowledged:true};
    }
    if(receipt.reported!==revision)results.push({...result,revision});
    if(results.length===8)break;
  }
  return ack?{acknowledged:false}:results;
}
