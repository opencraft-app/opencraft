import { createPublicKey, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RelayHub } from '../apps/relay-server/src/cluster-port.js';
import type { RelayRedis } from '../apps/relay-server/src/redis.js';
import type { RelayIngress } from '../apps/relay-server/src/server.js';
import { HUB_ENROLLMENT_PATH, type HubEnrollmentProof } from '../packages/hub-network/src/enrollment.js';
import { hubId, verified } from '../packages/hub-network/src/store.js';
import { publicOrigin } from '../packages/hub-network/src/contract.js';

export {HUB_ENROLLMENT_PATH};
export function internalSourceIp(address:string|undefined):string|null {
  const value=address?.startsWith('::ffff:')?address.slice(7):address;
  return value&&isIP(value)===4&&['9','10','11'].includes(value.split('.')[0]!)?value:null;
}
const json=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
export function createIpEnrollmentIngress(hub:RelayHub,redis?:RelayRedis,log:(event:{event:string;ip:string|null;status:number})=>void=event=>console.info(JSON.stringify(event)),reservedOrigins:readonly string[]=[]):RelayIngress {
  let closed=false;const pending=new Set<Promise<void>>(),seen=new Map<string,number>();
  async function claim(key:string) {
    const now=Date.now(),expiry=now+600000;
    if(redis) {
      return Number(await redis.evaluate(`redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[1]);if redis.call('EXISTS',KEYS[1])==1 then return 0 end;if redis.call('ZCARD',KEYS[2])>=8192 then return -1 end;redis.call('SET',KEYS[1],'1','PX',600000);redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]);return 1`,['ip-enrollment:nonce:'+key,'ip-enrollment:nonces'],[now,expiry,key]));
    }
    for(const [id,until]of seen){if(until>now)break;seen.delete(id);}
    if(seen.has(key))return 0;if(seen.size>=8192)return -1;seen.set(key,expiry);return 1;
  }
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const address=req.socket.remoteAddress;
    const mapped=address?.startsWith('::ffff:')?address.slice(7):address;
    const ip=mapped&&isIP(mapped)?mapped:address&&isIP(address)?address:null;
    const internal=internalSourceIp(address);
    let status=503;
    const deadline=setTimeout(()=>req.destroy(),10000);deadline.unref();
    const finish=(code:number,value:unknown)=>{status=code;if(res.destroyed)return;if(code>=400)res.setHeader('connection','close');json(res,code,value);};
    try {
      // This endpoint is served on the direct TLS peer entrance. Forwarded and
      // enterprise headers are deliberately not sources of network authority.
      if(!internal||!(req.socket as typeof req.socket&{encrypted?:boolean}).encrypted||req.headers.origin!==undefined)return finish(403,{error:'source_denied'});
      if(req.method!=='POST')return finish(405,{error:'method'});
      if(closed)return finish(503,{error:'unavailable'});
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>8192)return finish(413,{error:'request_too_large'});chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['audience','relay','hubId','publicKey','origin','timestamp','nonce','signature'].includes(k))
        ||body.audience!=='opencraft-hub-enrollment.v1'||body.relay!==hub.snapshot().endpoint||typeof body.hubId!=='string'||typeof body.publicKey!=='string'||body.publicKey.length>4096
        ||typeof body.origin!=='string'||!Number.isSafeInteger(body.timestamp)||Math.abs(Date.now()-Number(body.timestamp))>300000
        ||typeof body.nonce!=='string'||!/^[-_A-Za-z0-9]{43}$/u.test(body.nonce)||typeof body.signature!=='string'||body.signature.length>128)return finish(400,{error:'invalid_request'});
      if(body.origin)publicOrigin(body.origin);
      if(body.origin&&(reservedOrigins.includes(body.origin)||body.origin===hub.snapshot().endpoint))return finish(409,{error:'origin_unavailable'});
      if(createPublicKey(body.publicKey).asymmetricKeyType!=='ed25519'||hubId(body.publicKey)!==body.hubId)return finish(403,{error:'identity_denied'});
      const proof:HubEnrollmentProof={audience:'opencraft-hub-enrollment.v1',relay:String(body.relay),hubId:body.hubId,publicKey:body.publicKey,origin:body.origin,timestamp:Number(body.timestamp),nonce:body.nonce};
      if(!verified(proof,body.signature,body.publicKey))return finish(403,{error:'identity_denied'});
      const claimed=await claim(createHash('sha256').update(body.hubId+':'+body.nonce).digest('hex'));
      if(claimed!==1)return finish(claimed===0?409:503,{error:claimed===0?'replayed_request':'unavailable'});
      let revision=hub.snapshot().revision;
      for(let attempt=0;attempt<8;attempt++) {
        if(closed||res.destroyed)return finish(503,{error:'unavailable'});
        const result=await hub.command({action:'enroll',revision,peer:{hubId:body.hubId,publicKey:body.publicKey},origin:body.origin},'source-ip:'+ip);
        if('conflict'in result){revision=result.snapshot.revision;continue;}
        if(!('invitation'in result)||typeof result.invitation!=='string')throw Error('Enrollment unavailable');
        return finish(200,{invitation:result.invitation});
      }
      finish(503,{error:'unavailable'});
    }catch{if(!res.headersSent)finish(503,{error:'unavailable'});else res.destroy();}
    finally{clearTimeout(deadline);log({event:'relay_enrollment',ip,status});}
  }
  const ingress:RelayIngress=(req,res)=>{
    if(req.url!==HUB_ENROLLMENT_PATH)return false;
    const job=handle(req,res);pending.add(job);void job.finally(()=>pending.delete(job)).catch(()=>res.destroy());return true;
  };
  ingress.close=async()=>{closed=true;await Promise.allSettled([...pending]);seen.clear();};
  return ingress;
}
