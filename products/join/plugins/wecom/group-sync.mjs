import {createHash} from 'node:crypto';
export const syncHash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const GROUP_SYNC_DEFAULTS={name:'off',members:'observe',historyAccess:'none',initial:'preserve',pollMs:30000};
export function syncConfig(raw={}){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!Object.hasOwn(GROUP_SYNC_DEFAULTS,k)))throw Error('wecom_sync_invalid_config');
 const c={...GROUP_SYNC_DEFAULTS,...raw};
 if(!['off','inbound','both'].includes(c.name)||!['observe','inbound','both'].includes(c.members)||!['none','full'].includes(c.historyAccess)
  ||!['preserve','external'].includes(c.initial)||!Number.isInteger(c.pollMs)||c.pollMs<15000||c.pollMs>300000)throw Error('wecom_sync_invalid_config');
 if(c.members!=='observe'&&c.historyAccess!=='full')throw Error('wecom_sync_history_authorization_required');
 return c;
}
/** One strict provider GET. Labels never decide identity or whether a member disappeared. */
export function syncSnapshot(raw,source){
 let parts;try{parts=JSON.parse(source);}catch{throw Error('wecom_sync_invalid_source');}
 if(!Array.isArray(parts)||parts.length!==4||parts[0]!=='wecom-customer-service'||parts.some(x=>typeof x!=='string'||!x)||parts[3].startsWith('single:'))throw Error('wecom_sync_group_required');
 if(!raw||raw.externalId!==parts[3]||typeof raw.name!=='string'||(raw.name!==''&&!raw.name.trim())||raw.name.length>128||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(raw.name)||!raw.name.isWellFormed()
   ||!Array.isArray(raw.memberIds)||raw.memberIds.length>2000||raw.memberIds.some(x=>typeof x!=='string'||!x||x.length>256||/[\x00-\x20\x7f]/u.test(x))||new Set(raw.memberIds).size!==raw.memberIds.length)throw Error('wecom_sync_invalid_snapshot');
 return {externalId:raw.externalId,name:raw.name,memberIds:[...raw.memberIds].sort()};
}
export function syncDesired(snapshot,op){return op.kind==='name'?snapshot.name===op.name:snapshot.memberIds.includes(op.userId)===op.present;}
/** Check only the field being changed: a concurrent rename does not conflict with adding a member. */
export function syncBaseMatches(snapshot,op){return op.kind==='name'?snapshot.name===op.base:snapshot.memberIds.includes(op.userId)===op.base;}
export function syncOperation(raw){
 if(!raw||!['name','member'].includes(raw.kind))throw Error('wecom_sync_invalid_operation');
 if(raw.kind==='name'){
  if(Object.keys(raw).some(k=>!['kind','name'].includes(k))||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>60||/[\p{Cc}\p{Zl}\p{Zp}]/u.test(raw.name)||!raw.name.isWellFormed())throw Error('wecom_sync_invalid_operation');
  return {kind:'name',name:raw.name.trim()};
 }
 if(Object.keys(raw).some(k=>!['kind','userId','present'].includes(k))||typeof raw.userId!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/u.test(raw.userId)||/^(wb|fw)/u.test(raw.userId)||typeof raw.present!=='boolean')throw Error('wecom_sync_invalid_operation');
 return {kind:'member',userId:raw.userId,present:raw.present};
}
export const syncTerminal=s=>['confirmed','conflict','rejected','cancelled','retired'].includes(s);
