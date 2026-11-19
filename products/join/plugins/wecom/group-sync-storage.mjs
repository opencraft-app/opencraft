import {randomUUID} from 'node:crypto';
import {safeDiagnostics,ownerPrivilegeRequired} from './operation-diagnostics.mjs';
import {syncConfig, syncHash, syncOperation, syncSnapshot, syncDesired, syncTerminal} from './group-sync.mjs';

const load = (db, source) => {
  const row = db.prepare('SELECT value FROM join_wecom_group_sync WHERE source=?').get(source);
  return row ? JSON.parse(row.value) : null;
};
const save = (db, row) => {
  // Preserve business outcomes when old terminal operations leave the diagnostic
  // journal. A delayed status read must not turn a known result into "pending".
  const operations=new Map(row.operations.map(o=>[o.id,o]));
  for(const receipt of Object.values(row.editReceipts??{}))for(const change of receipt.changes) {
    const operation=operations.get(change.operationId);
    if(operation)change.delivery={state:operation.state,reason:operation.reason,diagnostics:operation.diagnostics};
  }
  db.prepare('INSERT INTO join_wecom_group_sync(source,channel_id,value) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET channel_id=excluded.channel_id,value=excluded.value')
    .run(row.source, row.channelId, JSON.stringify(row));
};
export {load as readGroupSync,save as writeGroupSync};
const fail = code => { throw Object.assign(Error(code), {code, status:403}); };
const refreshPending = row => ['pending','running'].includes(row.refresh?.state);
function groupBinding(db, id) {
  const rows=db.prepare('SELECT * FROM actor_channel_sources WHERE channel_id=?').all(id).filter(r=>{
    try { const p=JSON.parse(r.source);return p.length===4&&p[0]==='wecom-customer-service'&&!p[3].startsWith('single:'); } catch { return false; }
  });
  return rows.length===1 ? rows[0] : null;
}
/** Latest intent per field wins. A healthy observation is not a failed write's receipt. */
function deliveryIssue(row) {
  if(!row)return;
  const latest=new Map();
  for(const op of row.operations) {
    const key=field(op),prior=latest.get(key);
    if(!prior||op.sequence>prior.sequence)latest.set(key,op);
  }
  const failed=[...latest.values()].filter(op=>['rejected','conflict'].includes(op.state)
    &&!(row.snapshot&&syncDesired(row.snapshot,op))).sort((a,b)=>b.sequence-a.sequence)[0];
  if(failed)return {action:failed.kind==='name'?'rename':failed.present?'add':'remove',
    reason:failed.state==='conflict'?'conflict':ownerPrivilegeRequired(failed.diagnostics)?'owner_required':'rejected'};
}
/** Member-visible projection. Never return provider IDs, credentials or the operation journal. */
export function groupSyncView(service,db,context,id) {
  service.channels.assertReadable(context,id);
  if(!db.prepare('SELECT 1 FROM actor_channels WHERE id=? AND peer_id IS NULL').get(id))return null;
  const creating=load(db,pendingSource(id));
  if(creating?.pendingCreate) {
    const pc=creating.pendingCreate;
    if(!service.channels.isActive(id))return {provider:'wecom',configured:false,canRefresh:false,state:'disconnected',lastSyncedAt:null,lastAttemptAt:pc.lastAttemptAt??null,name:'off',members:'observe',pendingOperations:0};
    const canRefresh=pc.ownerId===context.actorId&&service.actors.get(context.actorId)?.kind==='human'
      &&localUser(service,context.actorId,JSON.stringify(['wecom-customer-service',pc.corpId]))===pc.ownerUserId;
    return {provider:'wecom',mentionIngress:'text-only',configured:false,canRefresh,
      state:pc.state==='failed'?'error':(pc.leaseUntil??0)>Date.now()?'syncing':'pending',
      lastSyncedAt:null,lastAttemptAt:pc.lastAttemptAt??null,name:'both',members:'both',pendingOperations:pc.state==='failed'?0:1};
  }
  const binding=groupBinding(db,id);if(!binding)return null;
  const row=load(db,binding.source),connected=!!binding.active&&(!row||row.sourceEpoch===binding.epoch);
  const pending=row?.operations.filter(o=>!syncTerminal(o.state)).length??0;
  const issue=connected?deliveryIssue(row):undefined;
  const config=row?.config??syncConfig();
  const canRefresh=connected&&db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=? AND active=1').get(id).n===1&&service.actors.get(context.actorId)?.kind==='human'
    &&db.prepare('SELECT owner_id FROM actor_channels WHERE id=?').get(id)?.owner_id===context.actorId
    &&!!localUser(service,context.actorId,binding.source)&&!row?.paused;
  return {provider:'wecom',mentionIngress:'text-only',configured:!!row&&!row.observationOnly,canRefresh,
    state:!connected?'disconnected':row?.paused?'paused':row?.refresh?.state==='running'?'syncing':refreshPending(row??{})?'pending':
      issue||row?.lastError||row?.refresh?.state==='failed'&&!row.refresh.recoveredAt?'error':pending?'pending':row?.checkedAt?'idle':'never',
    lastSyncedAt:row?.lastSyncedAt??(row&&!Object.hasOwn(row,'lastSyncedAt')?row.checkedAt??null:null),lastAttemptAt:row?.lastAttemptAt??null,
    name:config.name,members:config.members,pendingOperations:pending,...(issue?{deliveryIssue:issue}:{})};
}
/** Durable, coalesced refresh intent. A click is not a provider success receipt. */
export function groupSyncRefresh(service,db,context,id,key) {
  owner(service,db,context,id);
  if(typeof key!=='string'||!key||key.length>80)fail('wecom_idempotency_key_required');
  const creating=load(db,pendingSource(id));
  if(creating?.pendingCreate) {
    const pc=creating.pendingCreate;
    if(localUser(service,context.actorId,JSON.stringify(['wecom-customer-service',pc.corpId]))!==pc.ownerUserId)fail('wecom_sync_identity_required');
    pc.retryReceipts??={};const receipt=syncHash([context.actorId,key]);
    if(!Object.hasOwn(pc.retryReceipts,receipt)) {
      pc.retryReceipts[receipt]=true;
      while(Object.keys(pc.retryReceipts).length>128)delete pc.retryReceipts[Object.keys(pc.retryReceipts)[0]];
      // A live attempt is never replaced. In particular, retain its immutable
      // provider request across explicit retries and uncertain responses.
      if((pc.leaseUntil??0)<=Date.now()){pc.state='queued';pc.attempts=0;pc.nextAt=0;delete pc.deferredSince;}
      save(db,creating);service.channels.changed({channelId:id,directory:true});
    }
    return groupSyncView(service,db,context,id);
  }
  const binding=groupBinding(db,id);
  if(!binding?.active||db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=? AND active=1').get(id).n!==1)fail('wecom_sync_binding_required');
  let row=load(db,binding.source);
  if(row&&row.sourceEpoch!==binding.epoch)fail('wecom_sync_retired');
  if(row?.paused)fail('wecom_sync_paused');
  if(!localUser(service,context.actorId,binding.source))fail('wecom_sync_identity_required');
  if(!row) {
    if(Number(db.prepare('SELECT count(*) AS n FROM join_wecom_group_sync').get().n)>=256)fail('wecom_sync_capacity');
    // No implicit configuration or history/access grant on the first check.
    row={source:binding.source,channelId:id,sourceEpoch:binding.epoch,sequence:0,operations:[],imported:{},identities:{},snapshot:null,configReceipts:{},
      observationOnly:true,config:syncConfig(),ownerId:context.actorId,ownerUserId:localUser(service,context.actorId,binding.source)};
  }
  row.refreshReceipts??={};const receipt=syncHash([context.actorId,key]);
  if(!Object.hasOwn(row.refreshReceipts,receipt)) {
    if(!refreshPending(row))row.refresh={id:receipt,requestedAt:Date.now(),state:'pending'};
    row.refreshReceipts[receipt]=row.refresh.id;
    while(Object.keys(row.refreshReceipts).length>128)delete row.refreshReceipts[Object.keys(row.refreshReceipts)[0]];
    save(db,row);service.channels.changed({channelId:id,directory:true});
  }
  return groupSyncView(service,db,context,id);
}
function finishRefresh(row,p,error) {
  const pending=row.operations.some(o=>!syncTerminal(o.state));
  if(!error&&!pending) {
    row.lastSyncedAt=Date.now();
    if(row.refresh?.state==='failed')row.refresh.recoveredAt=Date.now();
  }
  if(!refreshPending(row)||row.refresh.id!==p.refreshId)return;
  if(error||row.inflight&&row.operations.some(o=>o.id===row.inflight&&o.state==='unknown')) {
    row.refresh.state='failed';row.refresh.finishedAt=Date.now();
  } else if(pending)row.refresh.state='pending';
  else {row.refresh.state='succeeded';row.refresh.finishedAt=Date.now();}
}
const field = op => op.kind === 'name' ? 'name' : 'member:' + op.userId;
const value = (snapshot, op) => op.kind === 'name' ? snapshot.name : snapshot.memberIds.includes(op.userId);
const human = (service, source, userId) => service.actors.findHuman({provider:'wecom.' + JSON.parse(source)[1], subject:userId});
function owner(service, db, context, id) {
  service.channels.assertWritable(context, id);
  const group = db.prepare('SELECT * FROM actor_channels WHERE id=? AND peer_id IS NULL').get(id);
  if (!group || group.owner_id !== context.actorId || service.actors.get(context.actorId)?.kind !== 'human') fail('wecom_sync_owner_required');
  return group;
}
function active(db, row) {
  if(db.prepare('SELECT dissolved_at FROM actor_channel_lifecycles WHERE channel_id=?').get(row.channelId)?.dissolved_at!=null)return false;
  const source = db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND channel_id=? AND active=1').get(row.source, row.channelId);
  return !!source && source.epoch === row.sourceEpoch;
}
function localUser(service, actorId, source) {
  const ids = service.actors.bindings(actorId).filter(i => i.provider === 'wecom.' + JSON.parse(source)[1]).map(i => i.subject);
  return ids.length === 1 && !/^(wb|fw|external:)/u.test(ids[0]) ? ids[0] : null;
}
// Directory identities can name only a removal from the source that observed
// them. Revocation prevents admission, but must not prevent removing that person.
// These records never authorize an owner, public addition, or login binding.
export function reservedRemovalIdentities(service, db, row) {
  const provider='wecom.'+JSON.parse(row.source)[1], candidates=[];
  for(const [userId,actorId] of Object.entries(row.identities??{})) {
    if(!row.snapshot?.memberIds.includes(userId)||/^(wb|fw|external:)/iu.test(userId))continue;
    const reservation=db.prepare("SELECT alias FROM actor_human_reservations WHERE binding=? AND actor_id=? AND login_provider='tencentoa' AND state IN ('pending','revoked')").get(JSON.stringify([provider,userId]),actorId);
    const actor=service.actors.get(actorId);
    if(reservation&&actor?.kind==='human'&&!actor.enabled&&service.actors.bindings(actorId).length===0)
      candidates.push({userId,actorId,alias:reservation.alias});
  }
  return candidates.filter(c=>candidates.filter(other=>other.actorId===c.actorId).length===1);
}
function reservedRemovalUser(service, db, row, actorId) {
  return reservedRemovalIdentities(service,db,row).find(c=>c.actorId===actorId)?.userId??null;
}
function trim(row) {
  const ended = row.operations.filter(o => syncTerminal(o.state)).sort((a,b) => b.sequence-a.sequence).slice(0,128);
  row.operations = row.operations.filter(o => !syncTerminal(o.state)).concat(ended).sort((a,b) => a.sequence-b.sequence);

}
/** Called in the native mutation transaction. Remote availability never gates a local change. */
function queue(service, db, row, context, key, op) {
  if (typeof key !== 'string' || !key || key.length > 128) fail('wecom_idempotency_key_required');
  const id = syncHash([row.source,row.sourceEpoch,context.actorId,key]), digest = syncHash(op);
  const prior = row.operations.find(o => o.id === id);
  if (prior) { if (prior.digest !== digest) fail('idempotency_conflict'); return prior; }
  trim(row);
  const entry = {...op,id,digest,actorId:context.actorId,actorGeneration:context.generation,
    memberEpoch:service.channels.memberEpoch(row.channelId,context.actorId),ownerUserId:localUser(service,context.actorId,row.source),
    state:'queued',createdAt:Date.now(),sequence:++row.sequence};
  if (!active(db,row)) { entry.state='rejected'; entry.reason='source_retired'; }
  if (!entry.ownerUserId) { entry.state='rejected'; entry.reason='owner_identity_missing'; }
  if (op.kind==='name' && op.name.length>60) { entry.state='rejected'; entry.reason='provider_title_limit'; }
  // Keep local editing independent of bounded remote backlog. Never discard an
  // uncertain write or pretend that a rejected delivery will retry itself.
  if(row.operations.filter(o=>!syncTerminal(o.state)).length>=3968&&entry.state==='queued'){entry.state='rejected';entry.reason='delivery_capacity';}
  row.operations.push(entry);
  if(op.kind==='name')row.explicitLocalName=true;
  // An explicit local member grant is independently authorized, not owned by the external identity link.
  if (op.kind==='member') delete row.imported?.[op.userId];
  save(db,row);
  return entry;
}
function applyLocal(service, db, row, context, op) {
  if (op.kind==='name') service.channels.rename(context,row.channelId,op.name);
  else {
    const actor=human(service,row.source,op.userId);
    const removal=!op.present ? reservedRemovalIdentities(service,db,row).find(c=>c.userId===op.userId) : null;
    const actorId=removal?.actorId ?? (actor?.enabled&&service.admittedActor(actor.id) ? actor.id : null);
    if(!actorId)fail('wecom_sync_identity_required');
    service.channels.setMember(context,row.channelId,actorId,op.present);
    return actorId;
  }
}
export function groupSyncCli(service, db, context, binding, {args,key}) {
  const [,verb,...tail]=args;
  owner(service,db,context,binding.channelId);
  if(verb==='refresh')return groupSyncRefresh(service,db,context,binding.channelId,key);
  let row=load(db,binding.source);
  if (verb==='status') return row ? {...row,connected:active(db,row),native:{
    title:service.channels.get(context,row.channelId).title,
    memberActorIds:db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(row.channelId).map(m=>m.actor_id),
  }} : {source:binding.source,channelId:binding.channelId,configured:false};
  if (verb==='configure') {
    const config=syncConfig(JSON.parse(tail[0]??'{}'));
    const source=db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND channel_id=? AND active=1').get(binding.source,binding.channelId);
    if (!source || db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=?').get(binding.channelId).n!==1) fail('wecom_sync_binding_required');
    if (typeof key!=='string'||!key||key.length>80) fail('wecom_idempotency_key_required');
    const receipt=syncHash([source.epoch,context.actorId,key]),digest=syncHash(config);
    const priorConfig=row?.configReceipts?.[receipt]??(row?.sourceEpoch===source.epoch?row.configReceipts?.[syncHash([context.actorId,key])]:undefined);
    if(priorConfig){if(priorConfig!==digest)fail('idempotency_conflict');return row;}
    if(row&&row.channelId!==binding.channelId)fail('wecom_sync_binding_mismatch');
    if(row&&row.sourceEpoch!==source.epoch) {
      // Reconnection is a new delivery authority, never a retry of the old one.
      for(const op of row.operations)if(!syncTerminal(op.state)) {
        op.reason=['checking','unknown'].includes(op.state)?'connection_replaced_unknown':'connection_replaced';op.state='retired';
      }
      save(db,row); // Freeze prior business outcomes before clearing the old journal.
      row={source:binding.source,channelId:binding.channelId,sourceEpoch:source.epoch,sequence:0,operations:[],imported:row.imported??{},identities:{},snapshot:null,configReceipts:{},editReceipts:row.editReceipts??{}};
    }
    if (!row && Number(db.prepare('SELECT count(*) AS n FROM join_wecom_group_sync').get().n)>=256) fail('wecom_sync_capacity');
    row??={source:binding.source,channelId:binding.channelId,sourceEpoch:source.epoch,sequence:0,operations:[],imported:{},identities:{},snapshot:null,configReceipts:{}};
    if(row.operations.some(o=>!syncTerminal(o.state))&&syncHash(row.config)!==syncHash(config))fail('wecom_sync_configuration_pending');
    if(row.observationOnly){delete row.observationOnly;row.snapshot=null;row.identities={};row.observation=(row.observation??0)+1;}
    row.config=config;row.ownerId=context.actorId;row.ownerUserId=localUser(service,context.actorId,binding.source);
    if(!row.ownerUserId)fail('wecom_sync_identity_required');
    row.configReceipts[receipt]=digest;
    while(Object.keys(row.configReceipts).length>128)delete row.configReceipts[Object.keys(row.configReceipts)[0]];
    save(db,row);return row;
  }
  if(!row)fail('wecom_sync_binding_required');
  if(verb==='request') {
    const op=syncOperation(JSON.parse(tail[0]??'{}'));
    if((op.kind==='name'?row.config.name:row.config.members)!=='both')fail('wecom_sync_direction_denied');
    const id=syncHash([row.source,row.sourceEpoch,context.actorId,key]);
    if(row.operations.some(o=>o.id===id))return queue(service,db,row,context,key,op);
    const memberActorId=applyLocal(service,db,row,context,op);
    const result=queue(service,db,row,context,key,op);
    service.channels.changed({channelId:row.channelId,directory:true,...(op.kind==='member'?{memberActorId}:{})});
    return result;
  }
  if(verb==='cancel') {
    if(typeof key!=='string'||!key||key.length>80)fail('wecom_idempotency_key_required');
    const op=row.operations.find(o=>o.id===tail[0]);
    if(!op||!['queued','cancelled'].includes(op.state))fail('wecom_sync_cannot_cancel');
    op.state='cancelled';save(db,row);return op; // Local change remains. This cancels only its external delivery.
  }
  fail('wecom_sync_invalid_command');
}
/** Observe local mutations, never replace the native owner/capacity checks or native write. */
export function groupSyncMutation(service,db,context,id,key,mutation) {
  const rows=db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').all(id);
  for(const record of rows) {
    const row=JSON.parse(record.value);
    if((mutation.kind==='name'?row.config.name:row.config.members)!=='both')continue;
    owner(service,db,context,id);
    let op=mutation;
    if(mutation.kind==='member') {
      if(service.actors.get(mutation.actorId)?.kind!=='human')continue;
      for(const [id,actorId] of Object.entries(row.imported??{}))if(actorId===mutation.actorId)delete row.imported[id];
      const userId=localUser(service,mutation.actorId,row.source)
        ?? (!mutation.present ? reservedRemovalUser(service,db,row,mutation.actorId) : null);
      if(!userId) { row.localOnly=(row.localOnly??[]).filter(id=>id!==mutation.actorId);if(mutation.present)row.localOnly.push(mutation.actorId);save(db,row);continue; }
      op={kind:'member',userId,present:mutation.present};
    }
    queue(service,db,row,context,key,op);
  }
}
/** Diff complete observations; never replace the entire native roster. */
function project(service,db,row,snapshot,skip=new Set(),presentation) {
  if(!Object.hasOwn(row,'lastSyncedAt'))row.lastSyncedAt=row.checkedAt??null;
  const before=row.snapshot,first=!before,initialExternal=first&&row.config.initial==='external';
  const pending=new Set(row.operations.filter(o=>!syncTerminal(o.state)).map(field));
  const delta={add:[],remove:[]};row.imported??={};row.identities??={};
  // An unnamed provider group is observable, but cannot erase the native title.
  if(snapshot.name!==''&&row.config.name!=='off'&&!pending.has('name')&&!skip.has('name')&&(initialExternal||before&&before.name!==snapshot.name))delta.name=snapshot.name;
  if(row.config.members!=='observe') {
    const identities={},natives=new Set(db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(row.channelId).map(r=>r.actor_id));
    row.capacityBlocked=[];row.conflicts=[];
    for(const userId of snapshot.memberIds) {
      if(/^(wb|fw|external:)/u.test(userId))continue;
      const actor=human(service,row.source,userId) ?? service.actors.findReservedHuman({provider:'wecom.'+JSON.parse(row.source)[1],subject:userId});
      if(actor?.kind==='human'&&((actor.enabled&&service.admittedActor(actor.id))||service.actors.isReservedHuman(actor.id)))identities[userId]=actor.id;
    }
    const remove=(userId,actorId)=>{
      if(!actorId||pending.has('member:'+userId)||skip.has('member:'+userId))return;
      // Native ownership survives an external owner's departure. A remote endpoint cannot orphan the native group.
      const ownerId=db.prepare('SELECT owner_id FROM actor_channels WHERE id=?').get(row.channelId)?.owner_id;
      if(actorId===ownerId){row.conflicts.push({userId,reason:'native_owner_retained'});return;}
      if(natives.delete(actorId))delta.remove.push(actorId);
      delete row.imported[userId];
    };
    for(const [userId,actorId] of Object.entries(row.imported))if(identities[userId]!==actorId)remove(userId,actorId);
    if(before)for(const userId of before.memberIds)if(!snapshot.memberIds.includes(userId))remove(userId,row.identities[userId]);
    for(const [userId,actorId] of Object.entries(identities)) {
      const changed=initialExternal||before&&(!before.memberIds.includes(userId)||row.identities[userId]!==actorId);
      if(db.prepare('SELECT 1 FROM actor_channel_departures WHERE channel_id=? AND actor_id=?').get(row.channelId,actorId)){row.conflicts.push({userId,reason:'native_departure_retained'});delete row.imported[userId];continue;}
      if(!changed||natives.has(actorId)||pending.has('member:'+userId)||skip.has('member:'+userId))continue;
      if(natives.size>=64){row.capacityBlocked.push(actorId);continue;}
      natives.add(actorId);delta.add.push(actorId);row.imported[userId]=actorId;
    }
    // Retry capacity-blocked additions on later complete observations without treating other unchanged members as new joins.
    for(const actorId of row.previousCapacityBlocked??[])if(Object.values(identities).includes(actorId)&&!natives.has(actorId)){
      const userId=Object.keys(identities).find(id=>identities[id]===actorId);
      if(db.prepare('SELECT 1 FROM actor_channel_departures WHERE channel_id=? AND actor_id=?').get(row.channelId,actorId))continue;
      if(pending.has('member:'+userId)||skip.has('member:'+userId))continue;
      if(natives.size>=64){if(!row.capacityBlocked.includes(actorId))row.capacityBlocked.push(actorId);continue;}
      natives.add(actorId);delta.add.push(actorId);row.imported[userId]=actorId;
    }
    row.previousCapacityBlocked=row.capacityBlocked;row.identities=identities;
  }
  service.channels.projectExternalGroup(row.channelId,delta);
  if(before&&before.name!==snapshot.name)delete row.explicitLocalName;
  const labels=readPresentation(snapshot,presentation);
  // Keep last known names on a temporary read failure only while the complete roster is unchanged.
  row.presentation=labels??(!presentation&&before?.name===''&&JSON.stringify(before.memberIds)===JSON.stringify(snapshot.memberIds)?row.presentation:null);
  row.snapshot=snapshot;row.checkedAt=Date.now();row.lastError=null;
  return delta;
}
function nativeMemberIntent(service,db,row,corpId){
  if(!service.channels.isActive(row.channelId))return;
  const pc=row.pendingCreate;
  if(pc?(pc.corpId!==corpId||!['queued','retry'].includes(pc.state)):
    (JSON.parse(row.source)[1]!==corpId||row.config.members!=='both'||row.paused||row.observationOnly||!active(db,row)))return;
  const group=db.prepare('SELECT owner_id FROM actor_channels WHERE id=? AND peer_id IS NULL').get(row.channelId),ownerId=pc?.ownerId??row.ownerId;
  const actor=group&&service.actors.get(group.owner_id),source=JSON.stringify(['wecom-customer-service',corpId]);
  if(!actor?.enabled||actor.kind!=='human'||group.owner_id!==ownerId||!service.admittedActor(actor.id))return;
  const owner=localUser(service,actor.id,source);if(!owner)return;
  const native=db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(row.channelId).map(r=>r.actor_id);
  const intents=pc?native.filter(id=>id!==ownerId):[...new Set([...(row.createdFrom?.missing??[]),...(row.localOnly??[])])];
  const selected=intents.filter(id=>native.includes(id)&&service.actors.get(id)?.kind==='human');
  if(!selected.length&&!pc)return;
  const members=selected.filter(id=>!localUser(service,id,source)).flatMap(actorId=>{
    const person=service.actors.get(actorId);if(!person?.enabled||!service.admittedActor(actorId))return[];
    const subjects=service.actors.bindings(actorId).filter(b=>b.provider==='tencentoa'&&/^[1-9][0-9]*$/u.test(b.subject));
    return subjects.length===1?[{actorId,subject:subjects[0].subject}]:[];
  });
  return{channelId:row.channelId,owner,members:members.slice(0,32),selected,source,actor};
}
function nativeMemberIdentityList(service,db,corpId){
  return db.prepare('SELECT value FROM join_wecom_group_sync LIMIT 256').all().map(r=>JSON.parse(r.value))
    .map(row=>nativeMemberIntent(service,db,row,corpId)).filter(Boolean).map(({channelId,owner,members})=>({channelId,owner,members}));
}
function settleNativeMemberIdentities(service,db,p,changes){
  let queued=0;
  for(const entry of db.prepare('SELECT value FROM join_wecom_group_sync WHERE channel_id=?').all(p.channelId)){
    const row=JSON.parse(entry.value),intent=nativeMemberIntent(service,db,row,p.corpId);if(!intent)continue;
    const remaining=intent.selected.filter(id=>!localUser(service,id,intent.source));
    if(row.pendingCreate){
      if(!row.pendingCreate.request) {
        const users=[...new Set(intent.selected.map(id=>localUser(service,id,intent.source)).filter(Boolean))];
        row.pendingCreate.memberUserIds=users.slice(0,49);
        row.pendingCreate.missing=intent.selected.filter(id=>!row.pendingCreate.memberUserIds.includes(localUser(service,id,intent.source)));
      } // Once dispatched, the immutable request is reconciled at attachment.
    }else{
      const context={actorId:intent.actor.id,generation:intent.actor.generation,credentialId:null,expiresAt:Date.now()+60000};
      for(const actorId of intent.selected){
        const userId=localUser(service,actorId,intent.source);if(!userId||row.snapshot?.memberIds.includes(userId))continue;
        const epoch=service.channels.memberEpoch(row.channelId,actorId);if(!epoch)continue;
        queue(service,db,row,context,'rtx-member:'+syncHash([actorId,epoch]),{kind:'member',userId,present:true});queued++;
      }
      row.localOnly=remaining;
      if(row.createdFrom)row.createdFrom.missing=remaining;
    }
    save(db,row);changes.push({channelId:row.channelId,directory:true});
  }
  return{result:{queued},changes};
}
/** Join's verified group attachment policy. Explicit configurations and pauses retain their owner. */
function automaticAttachment(service,db,source,corpId) {
  let parts;try{parts=JSON.parse(source.source);}catch{return null;}
  if(!Array.isArray(parts)||parts.length!==4||parts.some(p=>typeof p!=='string')||parts[0]!=='wecom-customer-service'||parts[1]!==corpId||parts[3].startsWith('single:')||!source.active)return null;
  const row=load(db,source.source);
  if(row?.paused||row?.pendingCreate||(!row?.observationOnly&&row?.config?.name==='both'&&row?.config?.members==='both'&&row?.config?.historyAccess==='full'))return null;
  if(row&&!row.observationOnly&&Object.keys(row.configReceipts??{}).length)return null;
  const group=db.prepare('SELECT owner_id,title FROM actor_channels WHERE id=? AND peer_id IS NULL').get(source.channel_id);
  if(!group||db.prepare('SELECT count(*) AS n FROM actor_channel_sources WHERE channel_id=?').get(source.channel_id).n!==1)return null;
  const actor=service.actors.get(group.owner_id),userId=localUser(service,group.owner_id,source.source);
  if(!actor?.enabled||actor.kind!=='human'||!service.admittedActor(actor.id)||!userId||row&&row.ownerId!==actor.id)return null;
  return{row,group,actor,userId};
}
function automaticAttachmentList(service,db,corpId) {
  return db.prepare('SELECT * FROM actor_channel_sources WHERE active=1 LIMIT 256').all()
    .filter(source=>automaticAttachment(service,db,source,corpId)).map(source=>({source:source.source,sourceEpoch:source.epoch,channelId:source.channel_id}));
}
/** A current authenticated Relay read authorizes this installation-owned policy, never a public flag. */
function adoptLinkedGroup(service,db,p,changes) {
  const source=db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND active=1').get(p.source);
  if(!source||source.epoch!==p.sourceEpoch)fail('wecom_sync_retired');
  const intent=automaticAttachment(service,db,source,p.corpId);if(!intent)return{result:null,changes};
  const {actor,group,userId}=intent,b=p.binding;
  if(!b||b.source!==p.source||b.actorId!==actor.id||typeof b.serverId!=='string'||b.generation!==undefined&&typeof b.generation!=='string'
    ||b.humanKey!==syncHash(['wecom',p.corpId,userId]))fail('wecom_sync_binding_mismatch');
  const snapshot=syncSnapshot(p.snapshot,p.source);
  // The owner must still belong to the provider group; stale bindings cannot grant history.
  if(!snapshot.memberIds.includes(userId))fail('wecom_sync_owner_required');
  const context={actorId:actor.id,generation:actor.generation,credentialId:null,expiresAt:Date.now()+60000};
  const config=syncConfig({name:'both',members:'both',historyAccess:'full',initial:'external'});
  const row=groupSyncCli(service,db,context,{source:p.source,channelId:source.channel_id},{args:['sync','configure',JSON.stringify(config)],key:'auto-link:'+source.epoch});
  row.snapshot=null;row.identities={};row.presentation=null;row.observation=(row.observation??0)+1;row.providerBinding=b;
  row.attachment={version:1,at:Date.now(),sourceEpoch:source.epoch};
  const explicit=payload=>!!db.prepare('SELECT 1 FROM actor_send_keys WHERE actor_id=? AND fingerprint=?').get(actor.id,syncHash(payload));
  const enqueue=(field,op)=>queue(service,db,row,context,'inbound-adopt:'+syncHash(field),op);
  // Preserve successful local edits made while this legacy attachment only observed.
  // Do not infer a removal merely from the initial owner-only native roster.
  if(group.title!==snapshot.name&&explicit(['channel-rename',source.channel_id,group.title]))enqueue(['name',group.title],{kind:'name',name:group.title});
  const natives=new Set(db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(source.channel_id).map(r=>r.actor_id));
  for(const actorId of natives){
    if(actorId===actor.id||service.actors.get(actorId)?.kind!=='human'||!explicit(['channel-member',source.channel_id,actorId,true]))continue;
    const memberUserId=localUser(service,actorId,p.source);
    if(!memberUserId)row.localOnly=[...new Set([...(row.localOnly??[]),actorId])];
    else if(!snapshot.memberIds.includes(memberUserId))enqueue(['member',memberUserId],{kind:'member',userId:memberUserId,present:true});
  }
  for(const memberUserId of snapshot.memberIds){
    const member=human(service,p.source,memberUserId);
    if(member&&member.id!==actor.id&&!natives.has(member.id)&&explicit(['channel-member',source.channel_id,member.id,false]))
      enqueue(['member',memberUserId],{kind:'member',userId:memberUserId,present:false});
  }
  save(db,row);changes.push({channelId:source.channel_id,directory:true});
  return{result:{adopted:true},changes};
}
/** Read committed intent only. Status/readback notifications must never generate another write. */
function immediateWork(service,db,channelId,corpId){
  if(!service.channels.isActive(channelId))return null;
  const pending=load(db,pendingSource(channelId)),pc=pending?.pendingCreate;
  if(pc){
    if(pc.corpId!==corpId||!['queued','retry'].includes(pc.state)||(pc.nextAt??0)>Date.now())return null;
    return{kind:'create',channelId,token:syncHash(['create',pc.createdAt,Object.keys(pc.retryReceipts??{}).at(-1),
      db.prepare('SELECT title FROM actor_channels WHERE id=?').get(channelId)?.title,
      db.prepare('SELECT actor_id,epoch FROM actor_channel_members WHERE channel_id=? ORDER BY actor_id').all(channelId)])};
  }
  const binding=groupBinding(db,channelId);if(!binding?.active||JSON.parse(binding.source)[1]!==corpId)return null;
  const reference={source:binding.source,channelId,sourceEpoch:binding.epoch},row=load(db,binding.source);
  if(automaticAttachment(service,db,binding,corpId))return{...reference,kind:'attach',token:syncHash(['attach',binding.epoch,
    db.prepare('SELECT title FROM actor_channels WHERE id=?').get(channelId)?.title,
    db.prepare('SELECT actor_id,epoch FROM actor_channel_members WHERE channel_id=? ORDER BY actor_id').all(channelId)])};
  if(!row||row.paused||!active(db,row))return null;
  reference.pollMs=row.config.pollMs;
  const op=row.operations.find(o=>!syncTerminal(o.state));
  if(op?.state==='queued')return{...reference,kind:'group',token:syncHash(['queued',binding.epoch,op.id,op.dispatchCount??0,!!row.snapshot])};
  if(row.refresh?.state==='pending')return{...reference,kind:'group',token:syncHash(['refresh',binding.epoch,row.refresh.id])};
  // An uncertain in-flight write is recovered by bounded read-only polling, not a notification loop.
  if(op)return null;
  const identities=nativeMemberIntent(service,db,row,corpId);
  if(identities?.selected.length)return{...reference,kind:'identity',token:syncHash(['identity',binding.epoch,identities.selected.map(id=>
    [id,service.channels.memberEpoch(channelId,id),localUser(service,id,binding.source)])])};
  if(!row.snapshot&&!row.observationOnly)return{...reference,kind:'group',token:syncHash(['initial',binding.epoch])};
  return null;
}
/** Installation-only storage Worker entry. All state and native changes commit together. */
export function groupSyncCommand(service,db,{method,params:p}) {
  if(!method.startsWith('join/wecom-sync/'))return;
  const verb=method.slice('join/wecom-sync/'.length),changes=[];
  if(verb==='immediate-work')return{result:immediateWork(service,db,p.channelId,p.corpId),changes};
  if(verb==='adoption-list')return{result:automaticAttachmentList(service,db,p.corpId),changes};
  if(verb==='adopt-linked')return adoptLinkedGroup(service,db,p,changes);
  if(verb==='member-identity-list')return{result:nativeMemberIdentityList(service,db,p.corpId),changes};
  if(verb==='member-identity-settle')return settleNativeMemberIdentities(service,db,p,changes);
  if(verb==='list')return{result:db.prepare('SELECT value FROM join_wecom_group_sync LIMIT 256').all().map(x=>JSON.parse(x.value)).filter(r=>!r.pendingCreate)
    .filter(r=>!p.corpId||JSON.parse(r.source)[1]===p.corpId).map(r=>({source:r.source,channelId:r.channelId,sourceEpoch:r.sourceEpoch,paused:!active(db,r)||r.paused||r.observationOnly&&!refreshPending(r),pollMs:r.config.pollMs,refreshPending:refreshPending(r)})),changes};
  if(verb==='create-list') {
    const now=Date.now();
    return{result:db.prepare('SELECT value FROM join_wecom_group_sync LIMIT 256').all().map(x=>JSON.parse(x.value))
      .filter(r=>service.channels.isActive(r.channelId)&&r.pendingCreate&&r.pendingCreate.corpId===p.corpId&&['queued','retry'].includes(r.pendingCreate.state)&&(r.pendingCreate.nextAt??0)<=now)
      .map(r=>({channelId:r.channelId,title:r.pendingCreate.title,owner:r.pendingCreate.ownerUserId,members:r.pendingCreate.memberUserIds,attempt:r.pendingCreate.attempts})),changes};
  }
  if(verb==='create-claim')return createClaim(service,db,p,changes);
  if(verb==='create-settle') return createSettle(service,db,p,changes);
  if(verb==='adopt-created') {
    const existing=load(db,p.source);
    if(!existing&&p.binding?.nativeGroup!==true)return{result:null,changes};
    const source=db.prepare('SELECT * FROM actor_channel_sources WHERE source=? AND active=1').get(p.source);
    const b=p.binding,group=source&&db.prepare('SELECT owner_id FROM actor_channels WHERE id=? AND peer_id IS NULL').get(source.channel_id);
    if(!source||!group||b?.source!==p.source||b.actorId!==group.owner_id)fail('wecom_sync_binding_mismatch');
    if(existing&&existing.sourceEpoch===source.epoch)return{result:null,changes};
    const actor=service.actors.get(group.owner_id),userId=localUser(service,group.owner_id,p.source);
    if(!actor?.enabled||!service.admittedActor(actor.id)||!userId||b.humanKey!==syncHash(['wecom',JSON.parse(p.source)[1],userId]))fail('wecom_sync_identity_required');
    if(existing){
      if(existing.ownerId!==actor.id)fail('wecom_sync_owner_required');
       const renewed=groupSyncCli(service,db,{actorId:actor.id,generation:actor.generation,credentialId:null,expiresAt:Date.now()+60000},{source:p.source,channelId:source.channel_id},{args:['sync','configure',JSON.stringify(existing.config)],key:'reconnect:'+source.epoch});
       // Reattachment must not silently adopt a legacy group that was only checked manually.
       if(existing.observationOnly){renewed.observationOnly=true;save(db,renewed);}
      return{result:null,changes};
    }
    if(Number(db.prepare('SELECT count(*) AS n FROM join_wecom_group_sync').get().n)>=256)fail('wecom_sync_capacity');
    save(db,{source:p.source,channelId:source.channel_id,sourceEpoch:source.epoch,sequence:0,operations:[],imported:{},identities:{},snapshot:null,configReceipts:{},config:syncConfig({name:'both'}),ownerId:actor.id,ownerUserId:userId});
    return{result:null,changes};
  }
  const row=load(db,p.source);if(!row)fail('wecom_sync_binding_required');
  if(p.sourceEpoch!==row.sourceEpoch||!active(db,row))fail('wecom_sync_retired');
  const changed=delta=>{changes.push({channelId:row.channelId,directory:true});for(const memberActorId of [...delta.add,...delta.remove])changes.push({channelId:row.channelId,directory:true,memberActorId});};
  const binding=()=>{
    if(!p.binding||p.binding.humanKey!==syncHash(['wecom',JSON.parse(row.source)[1],row.ownerUserId]))fail('wecom_sync_binding_mismatch');
    if(row.providerBinding&&(row.providerBinding.generation!==p.binding.generation||row.providerBinding.serverId!==p.binding.serverId))fail('wecom_sync_binding_mismatch');
    row.providerBinding=p.binding;
  };
  if(verb==='read')return{result:row,changes};
  if(verb==='begin') {
    row.lastAttemptAt=Date.now();
    if(refreshPending(row)){row.refresh.state='running';row.refresh.startedAt=Date.now();}
    save(db,row);changes.push({channelId:row.channelId,directory:true});
    return{result:{refreshId:refreshPending(row)?row.refresh.id:null},changes};
  }
  if(verb==='error'){row.lastError={code:String(p.code??'unavailable').slice(0,160),at:Date.now()};finishRefresh(row,p,true);save(db,row);changes.push({channelId:row.channelId,directory:true});return{result:null,changes};}
  if(verb==='observe') {
    if(row.inflight)return{result:null,changes};
    row.observation=(row.observation??0)+1;save(db,row);return{result:{observation:row.observation,sequence:row.sequence},changes};
  }
  if(verb==='snapshot') {
    const snapshot=syncSnapshot(p.snapshot,row.source);
    if(p.sequence!==row.sequence||p.observation!==row.observation||row.inflight)fail('wecom_sync_stale_snapshot');
    binding();changed(project(service,db,row,snapshot,new Set(),p.presentation));finishRefresh(row,p);save(db,row);return{result:row,changes};
  }
  if(verb==='claim') {
    if(!row.snapshot||row.paused)return{result:null,changes};
    const op=row.operations.find(o=>!syncTerminal(o.state));if(!op)return{result:null,changes};
    const actor=service.actors.get(op.actorId),authorized=!!actor?.enabled&&actor.generation===op.actorGeneration&&service.admittedActor(actor.id)&&service.channels.memberEpoch(row.channelId,actor.id)===op.memberEpoch
      &&localUser(service,actor.id,row.source)===op.ownerUserId;
    const firstAttempt=op.state==='queued';
    if(firstAttempt) {
      if(!authorized){op.state='rejected';op.reason='authorization_retired';save(db,row);return{result:null,changes};}
      op.state='checking';op.writeDeadline=Date.now()+30000;op.base=value(row.snapshot,op);op.dispatchCount=(op.dispatchCount??0)+1;op.attempt=syncHash([op.id,op.sequence,op.dispatchCount]);row.inflight=op.id;save(db,row);
    }
    return{result:{...op,source:row.source,sourceEpoch:row.sourceEpoch,readOnly:!authorized||!firstAttempt},changes};
  }
  if(verb==='settle') {
    const op=row.operations.find(o=>o.id===p.id);
    if(!op||row.inflight!==op.id||op.attempt!==p.attempt||!['confirmed','conflict','rejected','unknown','not_started'].includes(p.state))fail('wecom_sync_attempt_retired');
    binding();
    if(p.snapshotUnavailable===true){
      if(p.state!=='unknown'||p.snapshot!==null)fail('wecom_sync_unverified_result');
      if(p.diagnostics)op.diagnostics=safeDiagnostics(p.diagnostics);
      op.state='unknown';op.checkedAt=Date.now();
      // Failed readback is not a new observation: retain all roster and presentation facts.
      finishRefresh(row,p,true);save(db,row);return{result:row,changes};
    }
    const snapshot=syncSnapshot(p.snapshot,row.source);
    if(p.state==='confirmed'&&!syncDesired(snapshot,op))fail('wecom_sync_unverified_result');
    if(p.state==='not_started'&&!(Date.now()>op.writeDeadline&&Date.now()<op.writeDeadline+6*86400000))fail('wecom_sync_unverified_retry');
    if(p.diagnostics)op.diagnostics=safeDiagnostics(p.diagnostics);
    op.state=p.state==='not_started'?'queued':p.state;op.checkedAt=Date.now();
    if(p.state!=='unknown')delete row.inflight;
    // The command's own field is a receipt, not a new external mutation (also never roll back a failed local write).
    changed(project(service,db,row,snapshot,new Set([field(op)]),p.presentation));finishRefresh(row,p,p.state==='rejected'||p.state==='conflict');save(db,row);return{result:row,changes};
  }
  fail('wecom_sync_invalid_command');
}

/** Cosmetic facts must cover the same complete provider roster, never the admitted native subset. */
function readPresentation(snapshot,value) {
  if(snapshot.name!==''||!value||value.membershipSource!=='provider'||value.externalId!==snapshot.externalId||value.name!==''
    ||!Array.isArray(value.memberIds)||!Array.isArray(value.members)||value.memberIds.length!==snapshot.memberIds.length
    ||value.members.length!==snapshot.memberIds.length||new Set(value.memberIds).size!==value.memberIds.length
    ||new Set(value.members.map(m=>m?.id)).size!==value.members.length)return null;
  const ids=new Set(snapshot.memberIds);
  if(value.memberIds.some(id=>!ids.has(id))||value.members.some(m=>!m||!ids.has(m.id)||typeof m.name!=='string'
    ||!m.name.trim()||m.name===m.id||m.name.length>128||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(m.name)||!m.name.isWellFormed()))return null;
  const names=new Map(value.members.map(m=>[m.id,m.name.trim()]));
  return {memberIds:snapshot.memberIds,names:snapshot.memberIds.map(id=>names.get(id))};
}
/** This hook runs only after native read admission. No identity resolution or writes. */
export function groupDisplayTitle(service,db,id) {
  const binding=groupBinding(db,id);if(!binding?.active)return null;
  const row=load(db,binding.source);
  if(!row||row.paused||row.observationOnly||row.sourceEpoch!==binding.epoch||row.config.name==='off'||row.explicitLocalName||row.snapshot?.name!==''||!row.presentation?.names.length
    ||row.operations.some(o=>o.kind==='name'&&!syncTerminal(o.state)))return null;
  return row.presentation.names.join(';');
}

const pendingSource=id=>JSON.stringify(['pending-create',id]);
// Keep the existing UTF-16 limit without emitting a dangling surrogate at its boundary.
const creationTitle=title=>title.slice(0,60).replace(/[\uD800-\uDBFF]$/u,'');
/** A native group asked for a linked WeCom group. Queue it beside the native write. */
export function groupSyncCreated(service,db,context,id,input) {
  const owner=service.actors.get(context.actorId);
  if(owner?.kind!=='human')return;
  const corps=[...new Set(service.actors.bindings(context.actorId).filter(i=>i.provider.startsWith('wecom.')).map(i=>i.provider.slice(6)))];
  if(corps.length!==1)return; // No unambiguous WeCom identity: the native group stays native-only.
  const corpId=corps[0],user=actorId=>localUser(service,actorId,JSON.stringify(['wecom-customer-service',corpId]));
  const ownerUserId=user(context.actorId);if(!ownerUserId)return;
  const memberUserIds=[],missing=[];
  for(const actorId of input.members){if(actorId===context.actorId||service.actors.get(actorId)?.kind!=='human')continue;const u=user(actorId);if(u)memberUserIds.push(u);else missing.push(actorId);}
  if(Number(db.prepare('SELECT count(*) AS n FROM join_wecom_group_sync').get().n)>=256)return;
  const firstBatch=[...new Set(memberUserIds)].slice(0,49);
  for(const actorId of input.members)if(actorId!==context.actorId&&service.actors.get(actorId)?.kind==='human'&&!firstBatch.includes(user(actorId))&&!missing.includes(actorId))missing.push(actorId);
  save(db,{source:pendingSource(id),channelId:id,operations:[],config:syncConfig({name:'off'}),
    pendingCreate:{state:'queued',corpId,title:creationTitle(input.title),ownerId:context.actorId,ownerUserId,memberUserIds:firstBatch,missing,attempts:0,createdAt:Date.now()}});
  service.channels.changed({channelId:id,directory:true});
}
/** Freeze one provider payload before I/O. Retries reuse it even if native edits continue. */
function createClaim(service,db,p,changes) {
  if(!service.channels.isActive(p.channelId))return{result:null,changes};
  const row=load(db,pendingSource(p.channelId)),pc=row?.pendingCreate,now=Date.now();
  if(!pc||!['queued','retry'].includes(pc.state)||(pc.nextAt??0)>now)return{result:null,changes};
  const group=db.prepare('SELECT owner_id,title FROM actor_channels WHERE id=? AND peer_id IS NULL').get(row.channelId);
  const actor=group&&service.actors.get(group.owner_id),source=JSON.stringify(['wecom-customer-service',pc.corpId]);
  if(!actor?.enabled||actor.kind!=='human'||actor.id!==pc.ownerId||!service.admittedActor(actor.id)||localUser(service,actor.id,source)!==pc.ownerUserId){
    pc.state='failed';pc.lastError={code:'wecom_sync_identity_required',at:now};save(db,row);
    changes.push({channelId:row.channelId,directory:true});return{result:null,changes};
  }
  if(!pc.request) {
    // Existing requests may already have succeeded at the Relay. Keep their
    // saved roster/title; explicit local changes are reconciled after binding.
    // The first handoff freezes the CURRENT committed intent, not the initial
    // draft or an identity lookup's earlier roster. Never invite someone already removed.
    const selected=db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(row.channelId)
      .map(m=>m.actor_id).filter(id=>id!==pc.ownerId&&service.actors.get(id)?.kind==='human');
    const user=id=>localUser(service,id,source);
    const members=[...new Set(selected.map(user).filter(Boolean))].slice(0,49);
    pc.title=creationTitle(group.title);pc.memberUserIds=members;
    pc.missing=selected.filter(id=>!members.includes(user(id)));
    pc.request={title:pc.title,owner:pc.ownerUserId,members};
    pc.sentMembers=members.flatMap(userId=>{
      const member=service.actors.findHuman({provider:'wecom.'+pc.corpId,subject:userId});
      return member?[{actorId:member.id,userId}]:[];
    });
  }
  pc.attempt=randomUUID();pc.lastAttemptAt=now;pc.leaseUntil=now+65000;pc.nextAt=pc.leaseUntil;
  save(db,row);changes.push({channelId:row.channelId,directory:true});
  return{result:{channelId:row.channelId,...pc.request,attempt:pc.attempt},changes};
}
function createSettle(service,db,p,changes) {
  const row=load(db,pendingSource(p.channelId));
  if(!row?.pendingCreate)return{result:null,changes};
  const pc=row.pendingCreate;
  // The claim lease also marks whether this attempt has already settled. A late
  // duplicate must not spend retries twice or overwrite a newer owner retry.
  if(p.attempt!==pc.attempt||pc.attempt&&!pc.leaseUntil||p.binding&&!pc.attempt)return{result:null,changes};
  delete pc.leaseUntil;
  if(!service.channels.isActive(row.channelId)) {
    // A remote creation may have completed before closure. Preserve its identity
    // as an inactive tombstone, or a later callback could mirror a second group.
    if(p.binding) {
      const b=p.binding,parts=JSON.parse(b.source);
      if(!Array.isArray(parts)||parts.length!==4||parts[0]!=='wecom-customer-service'||parts[1]!==pc.corpId||b.nativeGroup!==true
        ||b.actorId!==pc.ownerId||b.humanKey!==syncHash(['wecom',pc.corpId,pc.ownerUserId]))fail('wecom_sync_binding_mismatch');
      const old=db.prepare('SELECT channel_id FROM actor_channel_sources WHERE source=?').get(b.source);
      if(old&&old.channel_id!==row.channelId)fail('channel_binding_conflict');
      db.prepare('INSERT INTO actor_channel_sources VALUES(?,?,?,?,0,0) ON CONFLICT(source) DO UPDATE SET active=0').run(b.source,row.channelId,randomUUID(),'retired-create');
      pc.retiredSource=b.source;
    }
    pc.state='failed';pc.lastError={code:'channel_dissolved',at:Date.now()};save(db,row);
    return{result:{state:'failed'},changes};
  }
  if(!p.binding&&p.deferred===true) {
    // The Relay does not offer creation yet (older Relay or not authorized). Wait
    // without spending attempts, so a later Relay upgrade still creates the group.
    pc.deferredSince??=Date.now();pc.lastError={code:String(p.code??'unsupported').slice(0,160),at:Date.now()};
    if(Date.now()-pc.deferredSince>86400000)pc.state='failed';else{pc.state='retry';pc.nextAt=Date.now()+600000;}
    save(db,row);changes.push({channelId:row.channelId,directory:true});return{result:{state:pc.state},changes};
  }
  if(!p.binding) {
    pc.attempts++;pc.lastError={code:String(p.code??'unavailable').slice(0,160),at:Date.now()};
    // Bounded automatic retries; a terminal failure stays visible and never creates twice.
    if(pc.attempts<4&&p.retryable!==false){pc.state='retry';pc.nextAt=Date.now()+30000*2**pc.attempts;}else pc.state='failed';
    save(db,row);changes.push({channelId:row.channelId,directory:true});return{result:{state:pc.state},changes};
  }
  const b=p.binding,parts=JSON.parse(b.source);
  if(!Array.isArray(parts)||parts[0]!=='wecom-customer-service'||parts[1]!==pc.corpId||b.nativeGroup!==true)fail('wecom_sync_binding_mismatch');
  const group=db.prepare('SELECT owner_id FROM actor_channels WHERE id=? AND peer_id IS NULL').get(row.channelId);
  if(!group||group.owner_id!==pc.ownerId||b.actorId!==pc.ownerId||b.humanKey!==syncHash(['wecom',pc.corpId,pc.ownerUserId]))fail('wecom_sync_identity_required');
  const prior=db.prepare('SELECT channel_id FROM actor_channel_sources WHERE source=?').get(b.source);
  if(prior&&prior.channel_id!==row.channelId)fail('channel_binding_conflict');
  const incarnation=db.prepare("SELECT incarnation FROM actor_channel_sources WHERE active=1 AND source LIKE ? LIMIT 1").get('["wecom-customer-service","'+pc.corpId+'",%')?.incarnation??'native-create';
  const epoch=prior?db.prepare('SELECT epoch FROM actor_channel_sources WHERE source=?').get(b.source).epoch:randomUUID();
  db.prepare('INSERT INTO actor_channel_sources VALUES(?,?,?,?,1,0) ON CONFLICT(source) DO UPDATE SET active=1').run(b.source,row.channelId,epoch,incarnation);
  db.prepare('DELETE FROM join_wecom_group_sync WHERE source=?').run(row.source);
  // Every member was chosen natively, so names and membership replicate both ways.
  const linked={source:b.source,channelId:row.channelId,sourceEpoch:epoch,sequence:0,operations:[],imported:{},identities:{},snapshot:null,configReceipts:{},
    config:syncConfig({name:'both',members:'both',historyAccess:'full'}),ownerId:pc.ownerId,ownerUserId:pc.ownerUserId,providerBinding:b,createdFrom:{missing:[],at:Date.now()}};
  const context={actorId:pc.ownerId,generation:service.actors.get(pc.ownerId)?.generation,credentialId:null,expiresAt:Date.now()+60000};
  const natives=new Set(db.prepare('SELECT actor_id FROM actor_channel_members WHERE channel_id=?').all(row.channelId).map(r=>r.actor_id));
  const sent=pc.sentMembers??(pc.memberUserIds??[]).flatMap(userId=>{
    const member=service.actors.findHuman({provider:'wecom.'+pc.corpId,subject:userId});return member?[{actorId:member.id,userId}]:[];
  });
  const sentIds=new Set((pc.request?.members??pc.memberUserIds)??[]);
  const enqueue=(field,op)=>queue(service,db,linked,context,'create-reconcile:'+syncHash(field),op);
  // This is a diff against our own frozen creation request, not a replacement
  // of the provider roster. External joins and unrelated permissions survive.
  for(const {actorId,userId} of sent)if(!natives.has(actorId))enqueue(['member',userId],{kind:'member',userId,present:false});
  for(const actorId of natives){
    if(actorId===pc.ownerId||service.actors.get(actorId)?.kind!=='human')continue;
    const userId=localUser(service,actorId,b.source);
    if(!userId)linked.createdFrom.missing.push(actorId);
    else if(!sentIds.has(userId))enqueue(['member',userId],{kind:'member',userId,present:true});
  }
  const title=db.prepare('SELECT title FROM actor_channels WHERE id=?').get(row.channelId).title;
  if(title!==(pc.request?.title??pc.title))enqueue(['name'],{kind:'name',name:title});
  save(db,linked);
  changes.push({channelId:row.channelId,directory:true});
  return{result:{state:'linked',source:b.source},changes};
}
