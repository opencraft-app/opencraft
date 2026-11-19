import {createHash} from 'node:crypto';
import {humanKey} from './store.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');

/** Narrow Relay operation, separate from group routing. The registered native
 * directory proves this recipient belongs to the requesting Server/Actor. */
export async function deliverTurnNotification(service,server,input) {
  if(service.forwardingOnly||typeof service.transport.sendDirectNotification!=='function')throw Error('unavailable');
  if(Object.keys(input).some(k=>!['actorId','recipient','content','requestId'].includes(k))
    ||typeof input.actorId!=='string'||!input.actorId||input.actorId.length>512
    ||typeof input.recipient!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(input.recipient)||/^(wb|fw)/iu.test(input.recipient)
    ||typeof input.content!=='string'||!input.content.trim()||!input.content.isWellFormed()||Buffer.byteLength(input.content)>5000
    ||typeof input.requestId!=='string'||!input.requestId||input.requestId.length>256)throw Error('invalid_notification');
  const current=async()=>{
    const row=await service.store.command('GET',service.store.prefix+'server:'+server.id);
    const directory=row&&JSON.parse(row);
    if(!directory||directory.id!==server.id||directory.humans?.[humanKey(service.corpId,input.recipient)]!==input.actorId)throw Error('denied');
  };
  await current();
  const key=service.store.prefix+'turn-notification:'+hash(JSON.stringify([server.id,input.requestId]));
  const fingerprint=hash(JSON.stringify([input.actorId,input.recipient,input.content]));
  // This is a bounded effect receipt, not another notification queue. Unknown
  // effects remain unknown and are never resent after an ACK loss or restart.
  const claim=await service.store.command('SET',key,JSON.stringify({fingerprint,status:'unknown'}),'NX','EX',604800);
  if(!claim){
    const saved=JSON.parse(await service.store.command('GET',key)||'null');
    if(!saved||saved.fingerprint!==fingerprint)throw Error('notification_request_conflict');
    return {status:saved.status};
  }
  try {
    await current();
    const status=await service.transport.sendDirectNotification(input.recipient,input.content,
      AbortSignal.any([service.abort.signal,AbortSignal.timeout(8000)]),current);
    const result={fingerprint,status:status==='delivered'?'delivered':'rejected'};
    await service.store.command('SET',key,JSON.stringify(result),'XX','EX',604800);
    return {status:result.status};
  } catch {return {status:'unknown'};}
}
