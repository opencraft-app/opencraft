import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import webpush from 'web-push';
import { PushStore, type PushBinding, type PushDevice, type PushSubscriptionData, type PushWatch } from './store';

export interface TurnPushOptions {
  authenticate(request: IncomingMessage): PushBinding | null;
  current(binding: PushBinding): boolean;
  trustedOrigin(request: IncomingMessage): string | null;
  hosts: readonly string[];
  read(hostId: string, method: string, params: Record<string,unknown>): Promise<unknown>;
  send?: (device: PushDevice, payload: string, keys: {publicKey:string;privateKey:string}) => Promise<unknown>;
  now?: () => number;
}
function object(value: unknown): Record<string,any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  return value as Record<string,any>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('invalid_input'); return value;
}
export function validatePushSubscription(raw: unknown): PushSubscriptionData {
  const value = object(raw), endpoint = text(value.endpoint,4096), url = new URL(endpoint), keys = object(value.keys);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.push.apple.com') || url.port || url.username || url.password || url.hash) throw new Error('invalid_endpoint');
  const key = (raw: unknown, length: number) => {
    const value = text(raw,128);
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || Buffer.from(value,'base64url').length !== length) throw new Error('invalid_key'); return value;
  };
  const p256dh = key(keys.p256dh,65);
  if (Buffer.from(p256dh,'base64url')[0] !== 4) throw new Error('invalid_key');
  return {endpoint,keys:{p256dh,auth:key(keys.auth,16)}};
}
function deviceId(subscription: PushSubscriptionData) { return createHash('sha256').update(JSON.stringify(subscription.endpoint)).digest('hex'); }

/** Process-owned subscription API, authoritative-history observer and bounded outbox.
 * No execution store is reopened and no task is resubmitted by this service. */
export class TurnPushService {
  readonly keys: {publicKey:string;privateKey:string};
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private running: Promise<void> | null = null;
  private cursor = 0;
  private failures = 0;
  private degraded = false;
  private readonly testTimes = new Map<string,number>();
  constructor(readonly store: PushStore, private readonly options: TurnPushOptions) {
    this.now = options.now ?? Date.now;
    this.keys = store.keys(() => webpush.generateVAPIDKeys());
    this.timer = setInterval(() => { void this.tick(); },5000); this.timer.unref();
  }
  get health() { return {state:this.degraded?'degraded':'ready',failures:this.failures}; }
  private current(device: PushDevice) {
    try { return !this.closed && this.options.current(device.authorization); } catch { return false; }
  }
  private payload(device: PushDevice, status: string, hostId?: string, threadId?: string, turnId?: string) {
    const target = new URL(device.basePath + (threadId ? `/local/${encodeURIComponent(threadId)}?${new URLSearchParams({hostId:hostId!})}` : '/settings/chat'),device.origin);
    return JSON.stringify({web_push:8030,notification:{title:device.messages[status],body:device.messages.body,
      lang:device.locale,tag:turnId?`opencraft-turn:${createHash('sha256').update(JSON.stringify([hostId,threadId,turnId])).digest('hex')}`:'opencraft-push-test',
      navigate:target.href,silent:false}});
  }
  private send(device: PushDevice, payload: string) {
    if (!this.current(device)) throw new Error('authorization_expired');
    return this.options.send ? this.options.send(device,payload,this.keys) : webpush.sendNotification(device.subscription,payload,{
      vapidDetails:{subject:device.origin,publicKey:this.keys.publicKey,privateKey:this.keys.privateKey},
      TTL:3600,timeout:10000,urgency:'normal',contentEncoding:'aes128gcm',
    });
  }
  private async reconcile(watch: PushWatch, read: TurnPushOptions['read']) {
    const devices=this.store.devices(watch.actorId);
    if (!devices.some(device=>this.current(device))) {
      for(const device of devices)this.store.remove(device.id,device.actorId);
      return;
    }
    let turnId = watch.turnId;
    if (!turnId) {
      let cursor: string | null = null;
      for (let page=0; page<5; page++) {
        const result = object(await read(watch.hostId,'thread/items/list',{threadId:watch.threadId,limit:100,sortDirection:'desc',...(cursor?{cursor}:{})}));
        if (!Array.isArray(result.data)) return;
        for (const entry of result.data) {
          const item = entry?.item;
          if (item?.type === 'userMessage' && item.clientId === watch.inputId && typeof entry.turnId === 'string' && entry.turnId) { turnId=entry.turnId; break; }
        }
        if (turnId || result.nextCursor == null) break;
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) return;
        cursor=result.nextCursor;
      }
      if (!turnId) return;
      this.store.bindTurn(watch.id,turnId);
    }
    let cursor: string | null = null;
    for (let page=0; page<5; page++) {
      const result = object(await read(watch.hostId,'thread/turns/list',{threadId:watch.threadId,limit:100,sortDirection:'desc',itemsView:'notLoaded',...(cursor?{cursor}:{})}));
      if (!Array.isArray(result.data)) return;
      const turn = result.data.find((turn: any) => turn?.id === turnId);
      if (turn) {
        if (['completed','failed','interrupted'].includes(turn.status)) this.store.finish(watch,turnId,turn.status);
        return;
      }
      if (result.nextCursor == null || typeof result.nextCursor !== 'string' || result.nextCursor === cursor) return;
      cursor=result.nextCursor;
    }
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.work().catch(() => { this.failures++;this.degraded=true; }).finally(() => { this.running=null; });
    return this.running;
  }
  private async work() {
    this.store.prune();
    // Round-robin prevents a long-running thread or unavailable engine starving others.
    const all = this.store.watches(), selected: PushWatch[]=[];
    for (let n=0;n<Math.min(all.length,8);n++) selected.push(all[(this.cursor+n)%all.length]!);
    this.cursor=all.length?(this.cursor+selected.length)%all.length:0;
    const reads=new Map<string,Promise<unknown>>();
    const read:TurnPushOptions['read']=(hostId,method,params)=>{
      const key=JSON.stringify([hostId,method,params]);
      let value=reads.get(key);if(!value){value=this.options.read(hostId,method,params);reads.set(key,value);}return value;
    };
    const results=await Promise.allSettled(selected.map(watch => this.reconcile(watch,read)));
    this.degraded=results.some(result=>result.status==='rejected');
    this.failures+=results.filter(result=>result.status==='rejected').length;
    if (this.closed) return;
    for (const delivery of this.store.due()) {
      if (this.closed) break;
      if (!this.current(delivery.device)) { this.store.remove(delivery.device.id,delivery.device.actorId); continue; }
      try {
        await this.send(delivery.device,this.payload(delivery.device,delivery.status,delivery.hostId,delivery.threadId,delivery.turnId));
        this.store.settled(delivery.id,'sent');
      } catch (error) {
        this.failures++;this.degraded=true;
        const code = (error as {statusCode?:number})?.statusCode;
        if (code===404 || code===410) this.store.remove(delivery.device.id,delivery.device.actorId);
        else if (code && code!==429 && code<500) this.store.settled(delivery.id,'dead');
        else this.store.retry(delivery.id,delivery.attempts+1);
      }
    }
  }
  async handle(request: IncomingMessage,response: ServerResponse): Promise<boolean> {
    if (new URL(request.url ?? '/', 'http://push.invalid').pathname !== '/__opencraft_push') return false;
    const send = (status:number,value:unknown) => {response.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value));};
    const binding = this.options.authenticate(request);
    if (!binding || !this.options.current(binding) || binding.context.credentialId !== null) {send(401,{error:'human_authentication_required'});return true;}
    if (request.method==='GET') {send(200,{available:true,publicKey:this.keys.publicKey,actorId:binding.context.actorId,hosts:this.options.hosts});return true;}
    const origin = this.options.trustedOrigin(request);
    if (request.method!=='POST' || !origin || !origin.startsWith('https://') || request.headers.origin!==origin
      || request.headers['sec-fetch-site']==='cross-site' || request.headers['content-type']?.split(';')[0]!=='application/json') {send(403,{error:'same_origin_json_required'});return true;}
    try {
      const chunks: Buffer[]=[]; let size=0;
      for await (const chunk of request) {const bytes=Buffer.from(chunk);size+=bytes.length;if(size>16384){send(413,{error:'too_large'});return true;}chunks.push(bytes);}
      if (!this.options.current(binding)) {send(401,{error:'human_authentication_required'});return true;}
      const input=object(JSON.parse(Buffer.concat(chunks).toString())), subscription=validatePushSubscription(input.subscription), id=deviceId(subscription);
      if (input.expectedActorId !== binding.context.actorId) {send(409,{error:'account_changed'});return true;}
      const previous=this.store.get(id), owns=previous?.actorId===binding.context.actorId && JSON.stringify(previous.subscription)===JSON.stringify(subscription);
      if (input.operation==='unsubscribe') {if(owns)this.store.remove(id,binding.context.actorId);send(200,{enabled:false});return true;}
      if (input.operation==='status' && !owns) {send(200,{enabled:false});return true;}
      if (input.operation==='subscribe' || input.operation==='status') {
        const locale=text(input.locale,64), basePath=typeof input.basePath==='string'?input.basePath:'';
        if (basePath!=='' && !/^\/(?:servers|__opencraft_servers)\/[A-Za-z0-9._-]{1,128}$/u.test(basePath)) throw new Error('invalid_base_path');
        const messages=object(input.messages);
        if (Object.keys(messages).sort().join(',')!=='body,completed,failed,interrupted,test') throw new Error('invalid_messages');
        for (const value of Object.values(messages)) text(value,256);
        this.store.register(binding,subscription,origin,basePath,locale,messages);
        send(200,{enabled:true});return true;
      }
      if (input.operation==='test' && owns && previous) {
        if(this.now()-(this.testTimes.get(id)??0)<30000){send(429,{error:'rate_limited'});return true;}
        if(this.testTimes.size>=1024)this.testTimes.delete(this.testTimes.keys().next().value!);
        this.testTimes.set(id,this.now());
        await this.send(previous,this.payload(previous,'test'));
        send(200,{sent:true});return true;
      }
      throw new Error('invalid_operation');
    } catch {send(400,{error:'push_operation_failed'});return true;}
  }
  async close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);await this.running;this.store.close();}
}
