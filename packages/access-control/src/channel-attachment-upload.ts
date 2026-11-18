import { CHANNEL_ATTACHMENT_LIMIT, validChannelAttachment } from '@opencraft/appserver-protocol';
import type { ActorContext } from '@opencraft/identity-core/actors';
import type { Collaboration } from './collaboration';

type Upload = { actorId:string; fingerprint:string; bytes:Buffer; offset:number; touched:number; complete?:boolean };
const stores = new WeakMap<Collaboration,Map<string,Upload>>();
const CHUNK = 64 * 1024, BUDGET = 64 * 1024 * 1024, TTL = 15 * 60_000;
function fail(code:string):never {throw Object.assign(Error(code),{code});}
/** Bounded process-local transfer state. The existing sendAttachment transaction
 * remains the authority for immutable content, message identity and delivery. */
export function receiveChannelAttachment(service:Collaboration,c:ActorContext,p:Record<string,unknown>) {
  const {channelId,clientMessageId,name,type,text,total,offset,base64}=p;
  if(typeof channelId!=='string'||typeof clientMessageId!=='string'||!clientMessageId||clientMessageId.length>256
    ||typeof name!=='string'||typeof type!=='string'||!validChannelAttachment({name,type,bytes:new Uint8Array()})
    ||text!==undefined&&(typeof text!=='string'||text.length>4096)
    ||typeof total!=='number'||!Number.isSafeInteger(total)||total<0||total>CHANNEL_ATTACHMENT_LIMIT
    ||typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<0
    ||typeof base64!=='string'||base64.length>Math.ceil(CHUNK/3)*4)fail('invalid_input');
  const bytes=Buffer.from(base64 as string,'base64');
  if(bytes.toString('base64')!==base64||bytes.length>CHUNK||offset+bytes.length>total||(bytes.length===0&&total!==0))fail('invalid_input');
  if(!service.channels.get(c,channelId).canSend)fail('channel_denied');
  const key=JSON.stringify([c.actorId,c.generation,channelId,clientMessageId]);
  const fingerprint=JSON.stringify([channelId,clientMessageId,name,type,text??null,total]);
  let uploads=stores.get(service);if(!uploads)stores.set(service,uploads=new Map());
  const now=Date.now();for(const [id,item] of uploads)if(now-item.touched>TTL)uploads.delete(id);
  let upload=uploads.get(key);
  if(!upload){
    if(offset!==0)fail('channel_upload_expired');
    for (;;) {
      const live=[...uploads.values()];
      if(live.length<64 && live.filter(u=>u.actorId===c.actorId).length<4 && live.reduce((sum,u)=>sum+u.bytes.length,0)+total<=BUDGET) break;
      const retired=[...uploads].filter(([,u])=>u.complete).sort((a,b)=>a[1].touched-b[1].touched)[0];
      if(!retired)fail('channel_upload_capacity');uploads.delete(retired[0]);
    }
    upload={actorId:c.actorId,fingerprint,bytes:Buffer.alloc(total),offset:0,touched:now};uploads.set(key,upload);
  }
  if(upload.fingerprint!==fingerprint)fail('idempotency_conflict');
  if(offset>upload.offset)fail('channel_upload_offset');
  if(offset<upload.offset){
    if(offset+bytes.length>upload.offset||!upload.bytes.subarray(offset,offset+bytes.length).equals(bytes))fail('idempotency_conflict');
  }else{bytes.copy(upload.bytes,offset);upload.offset+=bytes.length;}
  upload.touched=now;
  const nextOffset=offset+bytes.length;
  if(nextOffset!==total)return {nextOffset};
  // Even a final-chunk replay goes through durable message dedupe and current
  // authorization; an in-memory receipt cannot outlive a rolled-back transaction.
  const receipt=service.sendAttachment(c,channelId,clientMessageId,{name,type,bytes:upload.bytes},text);
  upload.complete=true;
  return {nextOffset,receipt};
}
