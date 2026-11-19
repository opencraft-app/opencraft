import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import type { NotificationTarget } from './store';

export class DeliveryError extends Error {
  constructor(readonly statusCode: number) { super('notification_delivery_failed'); }
}
const blocked = new BlockList(), blockedV6 = new BlockList();
for (const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['100::',64],['2001::',32],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['fec0::',10],['ff00::',8]] as const) blockedV6.addSubnet(address,prefix,'ipv6');
export function publicAddress(address: string): boolean {
  const family=isIP(address);
  return !!family && !(family===4?blocked:blockedV6).check(address,family===4?'ipv4':'ipv6');
}
export function destinationUrl(value: unknown): URL {
  if(typeof value!=='string' || value.length>4096) throw Error('invalid_destination');
  let url: URL;
  try {url=new URL(value);} catch {throw Error('invalid_destination');}
  if(url.protocol!=='https:' || url.username || url.password || url.hash) throw Error('invalid_destination');
  const host=url.hostname.replace(/^\[|\]$/gu,'');
  if(host==='localhost' || !host.includes('.') && !isIP(host) || (isIP(host) && !publicAddress(host))) throw Error('invalid_destination');
  return url;
}
/** Accept copied GET examples as text only. Never interpret a shell command. */
export function barkUrl(input: unknown): string {
  if(typeof input!=='string' || input.length>8192) throw Error('invalid_destination');
  let value=input.trim();
  if(/^curl\s/u.test(value)) {
    const urls=value.match(/https:\/\/[^\s'"<>]+/gu);
    if(urls?.length!==1 || /(?:^|\s)(?:-d|--data|--request\s+(?!GET)|-X\s+(?!GET))/u.test(value)) throw Error('invalid_destination');
    value=urls[0]!;
  }
  const url=destinationUrl(value);
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts.length<1 || parts.length>3 || !/^[A-Za-z0-9_-]{6,256}$/u.test(parts[0]!)) throw Error('invalid_destination');
  // Example title/body are replaced by the notification, never sent literally.
  url.pathname='/'+parts[0];
  for(const key of ['ttl','badge']) {const value=url.searchParams.get(key);if(value!==null && (!/^\d+$/u.test(value)||!Number.isSafeInteger(Number(value))))throw Error('invalid_destination');}
  for(const key of ['title','body','device_key','device_keys','url','ciphertext']) url.searchParams.delete(key);
  return url.href;
}
export function parseTarget(raw: unknown): NotificationTarget {
  if(!raw || typeof raw!=='object') throw Error('invalid_destination');
  const value=raw as Record<string,unknown>;
  if(value.kind==='bark') return {kind:'bark',url:barkUrl(value.url)};
  if(value.kind==='webhook') {
    const url=destinationUrl(value.url).href;
    if(value.authorization!==undefined && (typeof value.authorization!=='string'||value.authorization.length>2048||/[\r\n]/u.test(value.authorization))) throw Error('invalid_destination');
    return {kind:'webhook',url,...(value.authorization?{authorization:value.authorization as string}:{})};
  }
  throw Error('invalid_destination');
}
export function targetLabel(target: NotificationTarget): string {
  return target.kind==='im'?target.label:`${new URL(target.url).hostname} / ••••••`;
}
export interface NotificationMessage {
  id: string; event: 'turn.ended'|'notification.test'; title: string; body: string; url: string;
  status: string; hostId?: string; threadId?: string; turnId?: string;
}
/** DNS is checked for every attempt and the selected address is pinned to TLS.
 * Redirects are never followed. Errors never contain the endpoint or credentials. */
export async function postNotification(url: URL, body: unknown, authorization?: string): Promise<Record<string,unknown>> {
  destinationUrl(url.href);
  const host=url.hostname.replace(/^\[|\]$/gu,'');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (()=>void) | undefined;
  let expired=false;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;abort?.();reject(new DeliveryError(503));},10000);timer.unref();});
  try {
    return await Promise.race([deadline,(async()=>{
      const addresses=await lookup(host,{all:true});
      if(expired)throw new DeliveryError(503);
      if(!addresses.length || addresses.some(item=>!publicAddress(item.address))) throw new DeliveryError(400);
      return await new Promise<Record<string,unknown>>((resolve,reject)=>{
        const bytes=Buffer.from(JSON.stringify(body));
        const req=request(url,{method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,...(authorization?{authorization}:{})},
          lookup:((_hostname: string,options: {all?:boolean},done: Function)=>options?.all?done(null,[addresses[0]!]):done(null,addresses[0]!.address,addresses[0]!.family)) as never,
        },res=>{
          const chunks:Buffer[]=[];let size=0;
          res.on('data',chunk=>{size+=chunk.length;if(size>65536){req.destroy();reject(new DeliveryError(502));}else chunks.push(chunk);});
          res.on('error',()=>reject(new DeliveryError(503)));
          res.on('end',()=>{
            const status=res.statusCode??503;
            if(status<200 || status>=300){reject(new DeliveryError(status));return;}
            try {const parsed=JSON.parse(Buffer.concat(chunks).toString()||'{}');resolve(parsed&&typeof parsed==='object'?parsed:{});} catch {resolve({});}
          });
        });
        abort=()=>req.destroy();
        req.on('error',()=>reject(new DeliveryError(503)));req.end(bytes);
      });
    })()]);
  } catch(error) {throw error instanceof DeliveryError?error:new DeliveryError(503);}
  finally {clearTimeout(timer);}
}
export async function sendDestination(target: Exclude<NotificationTarget,{kind:'im'}>, message: NotificationMessage,
  post: typeof postNotification=postNotification) {
  const url=new URL(target.url);
  if(target.kind==='webhook') {await post(url,message,target.authorization);return;}
  const deviceKey=url.pathname.slice(1);
  const parameters:Record<string,string|number>=Object.fromEntries(url.searchParams);
  for(const key of ['ttl','badge'])if(parameters[key]!==undefined)parameters[key]=Number(parameters[key]);
  url.pathname='/push';url.search='';
  const result=await post(url,{...parameters,device_key:deviceKey,title:message.title,body:message.body,url:message.url,group:parameters.group??'OpenCraft'});
  if(result.code!==200) throw new DeliveryError(typeof result.code==='number' && result.code>=400 && result.code<=599?result.code:502);
}
