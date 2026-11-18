import { observeNotificationRequest, notificationRejection, type NotificationRejection } from './diagnostics';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import webpush from 'web-push';
import type { PushStorePort } from './async-store';
import { DeliveryError, parseTarget, targetLabel, sendDestination, type NotificationMessage } from './destinations';
import type { NotificationTarget } from './store';
import { type PushBinding, type PushDevice, type PushSubscriptionData, type PushWatch } from './store';

export interface TurnPushOptions {
  authenticate(request: IncomingMessage): PushBinding | null;
  current(binding: PushBinding): boolean;
  trustedOrigin(request: IncomingMessage): string | null;
  hosts: readonly string[];
  canRead?: (actorId: string, hostId: string, threadId: string) => boolean;
  read(hostId: string, method: string, params: Record<string,unknown>): Promise<unknown>;
  send?: (device: PushDevice, payload: string, keys: {publicKey:string;privateKey:string}) => Promise<unknown>;
  now?: () => number;
  imTargets?: (binding: PushBinding) => Promise<Array<{channelId:string;senderId:string;label:string}>>;
  sendIm?: (binding: PushBinding, target: Extract<NotificationTarget,{kind:'im'}>, message: NotificationMessage) => Promise<void>;
  sendExternal?: typeof sendDestination;
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
  keys!: {publicKey:string;privateKey:string};
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private running: Promise<void> | null = null;
  private cursor = 0;
  private failures = 0;
  private degraded = false;
  private readonly testTimes = new Map<string,number>();
  constructor(readonly store: PushStorePort, private readonly options: TurnPushOptions) {
    this.now = options.now ?? Date.now;
    const keys=store.keys(() => webpush.generateVAPIDKeys());
    if(keys instanceof Promise)this.ready=keys.then(value=>{this.keys=value;});
    else {this.keys=keys;this.ready=Promise.resolve();}
    this.timer = setInterval(() => { void this.tick(); },5000); this.timer.unref();
  }
  async initialize() { await this.ready; }
  get health() { return {state:this.degraded?'degraded':'ready',failures:this.failures}; }
  private current(device: PushDevice) {
    try { return !this.closed && this.options.current(device.authorization); } catch { return false; }
  }
  private payload(device: PushDevice, status: string, hostId?: string, threadId?: string, turnId?: string, threadTitle?: string) {
    const target = new URL(device.basePath + (threadId ? `/local/${encodeURIComponent(threadId)}?${new URLSearchParams({hostId:hostId!})}` : '/settings/chat'),device.origin);
    return JSON.stringify({web_push:8030,notification:{title:threadTitle ? `${threadTitle} · ${device.messages[status]}` : device.messages[status],body:device.messages.body,
      lang:device.locale,tag:turnId?`opencraft-turn:${createHash('sha256').update(JSON.stringify([hostId,threadId,turnId])).digest('hex')}`:'opencraft-push-test',
      navigate:target.href,silent:false}});
  }
  private async send(device: PushDevice, payload: string, message?: NotificationMessage) {
    if (!this.current(device)) throw new Error('authorization_expired');
    if(device.target) {
      const notification=JSON.parse(payload).notification;
      const value=message??{id:'test:'+device.id,event:'notification.test',title:notification.title,body:notification.body,url:notification.navigate,status:'test'};
      if(device.target.kind==='im') {
        if(!this.options.sendIm)throw Error('im_unavailable');
        return this.options.sendIm(device.authorization,device.target,value);
      }
      return (this.options.sendExternal??sendDestination)(device.target,value);
    }
    if(!device.subscription)throw Error('invalid_subscription');
    return this.options.send ? this.options.send(device,payload,this.keys) : webpush.sendNotification(device.subscription,payload,{
      vapidDetails:{subject:device.origin,publicKey:this.keys.publicKey,privateKey:this.keys.privateKey},
      TTL:3600,timeout:10000,urgency:'normal',contentEncoding:'aes128gcm',
    });
  }
  private async reconcile(watch: PushWatch, read: TurnPushOptions['read']) {
    const devices=await this.store.devices(watch.actorId);
    if (!devices.some(device=>this.current(device))) {
      for(const device of devices) {
        if(device.target)await this.store.setEnabled(device.id,device.actorId,false);
        else await this.store.remove(device.id,device.actorId);
      }
      await this.store.retireWatch(watch.id);
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
      await this.store.bindTurn(watch.id,turnId);
    }
    let cursor: string | null = null;
    for (let page=0; page<5; page++) {
      const result = object(await read(watch.hostId,'thread/turns/list',{threadId:watch.threadId,limit:100,sortDirection:'desc',itemsView:'notLoaded',...(cursor?{cursor}:{})}));
      if (!Array.isArray(result.data)) return;
      const turn = result.data.find((turn: any) => turn?.id === turnId);
      if (turn) {
        if (['completed','failed','interrupted'].includes(turn.status)) await this.store.finish(watch,turnId,turn.status);
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
    await this.ready;
    await this.store.prune();
    // Round-robin prevents a long-running thread or unavailable engine starving others.
    const all = await this.store.watches(), selected: PushWatch[]=[];
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
    for (const delivery of await this.store.due()) {
      if (this.closed) break;
      if (!this.current(delivery.device)) {
        if(delivery.device.target)await this.store.setEnabled(delivery.device.id,delivery.device.actorId,false);
        else await this.store.remove(delivery.device.id,delivery.device.actorId);
        continue;
      }
      try {
        if (this.options.canRead?.(delivery.device.actorId,delivery.hostId,delivery.threadId) === false) { this.store.settled(delivery.id,'sent'); continue; }
        // Resolve only the exact delivery's Thread; never infer identity from the
        // active page or a recent Thread. A metadata failure must not hide its ID.
        let threadTitle = `#${delivery.threadId}`;
        try {
          const result = object(await read(delivery.hostId,'thread/read',{threadId:delivery.threadId,includeTurns:false}));
          const thread = object(result.thread);
          if (thread.id === delivery.threadId) {
            const label = [thread.name,thread.preview].find(value=>typeof value==='string' && value.trim());
            if (label) threadTitle = Array.from(label.replace(/\s+/gu,' ').trim()).slice(0,80).join('');
          }
        } catch { /* Keep the exact Thread identity when metadata is unavailable. */ }
        if (this.options.canRead?.(delivery.device.actorId,delivery.hostId,delivery.threadId) === false) { await this.store.settled(delivery.id,'sent'); continue; }
        const latest=await this.store.get(delivery.device.id);
        if(!latest || !latest.enabled || latest.bindingId!==delivery.device.bindingId || !await this.store.master(latest.actorId))continue;
        const payload=this.payload(latest,delivery.status,delivery.hostId,delivery.threadId,delivery.turnId,threadTitle);
        const notification=JSON.parse(payload).notification;
        await this.send(latest,payload,{id:delivery.id,event:'turn.ended',title:notification.title,body:notification.body,url:notification.navigate,status:delivery.status,hostId:delivery.hostId,threadId:delivery.threadId,turnId:delivery.turnId});
        await this.store.settled(delivery.id,'sent');
      } catch (error) {
        this.failures++;this.degraded=true;
        const code = (error as {statusCode?:number})?.statusCode;
        if (delivery.device.target?.kind==='im' && (error as {deliveryState?:string})?.deliveryState!=='not_sent') await this.store.settled(delivery.id,'dead');
        else if (!delivery.device.target && (code===404 || code===410)) await this.store.remove(delivery.device.id,delivery.device.actorId);
        else if (code && code!==429 && code<500) await this.store.settled(delivery.id,'dead');
        else await this.store.retry(delivery.id,delivery.attempts+1);
      }
    }
  }
  async handle(request: IncomingMessage,response: ServerResponse): Promise<boolean> {
    const path=new URL(request.url ?? '/', 'http://push.invalid').pathname;
    if(path!=='/__opencraft_push' && path!=='/__opencraft_notifications')return false;
    observeNotificationRequest(request,response);
    await this.ready;
    const send = (status:number,value:unknown) => {response.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(value));};
    const binding = this.options.authenticate(request);
    if (!binding || !this.options.current(binding) || binding.context.credentialId !== null) {send(401,{error:'human_authentication_required'});return true;}
    if (path==='/__opencraft_notifications' && request.method==='GET') {send(200,await this.configuration(binding));return true;}
    if (request.method==='GET') {send(200,{available:true,publicKey:this.keys.publicKey,actorId:binding.context.actorId,hosts:this.options.hosts});return true;}
    const trustedOrigin = this.options.trustedOrigin(request);
    // Match Actor/IM writes behind TLS termination. Identity providers may omit
    // trustedOrigin; a preserved Host still proves the browser's same-origin
    // scope. HTTP is supported for reverse proxies and local deployments.
    // Forwarded headers never grant authority.
    const origin = typeof request.headers.origin==='string' && ['http:','https:'].some(protocol=>request.headers.origin===`${protocol}//${request.headers.host}`)
      ? request.headers.origin : trustedOrigin;
    const rejection:NotificationRejection|null=request.method!=='POST'?'method_not_allowed':!origin?'trusted_origin_missing':!/^https?:\/\//u.test(origin)?'trusted_origin_invalid_protocol':
      !request.headers.origin?'origin_missing':request.headers.origin!==origin?'origin_mismatch':request.headers['sec-fetch-site']==='cross-site'?'cross_site':
      request.headers['content-type']?.split(';')[0]!=='application/json'?'content_type_invalid':null;
    if(rejection){notificationRejection(response,rejection);send(403,{error:'same_origin_json_required'});return true;}
    try {
      const chunks: Buffer[]=[]; let size=0;
      for await (const chunk of request) {const bytes=Buffer.from(chunk);size+=bytes.length;if(size>16384){send(413,{error:'too_large'});return true;}chunks.push(bytes);}
      if (!this.options.current(binding)) {send(401,{error:'human_authentication_required'});return true;}
      const input=object(JSON.parse(Buffer.concat(chunks).toString()));
      if(input.expectedActorId!==binding.context.actorId){send(409,{error:'account_changed'});return true;}
      if(path==='/__opencraft_notifications'){send(200,await this.notificationOperation(binding,origin!,input));return true;}
      const subscription=validatePushSubscription(input.subscription), id=deviceId(subscription);
      if (input.expectedActorId !== binding.context.actorId) {send(409,{error:'account_changed'});return true;}
      const previous=await this.store.get(id), owns=previous?.actorId===binding.context.actorId && JSON.stringify(previous.subscription)===JSON.stringify(subscription);
      if (input.operation==='unsubscribe') {if(owns)await this.store.remove(id,binding.context.actorId);send(200,{enabled:false});return true;}
      if (input.operation==='status' && !owns) {send(200,{enabled:false});return true;}
      if (input.operation==='subscribe' || input.operation==='status') {
        const locale=text(input.locale,64), basePath=typeof input.basePath==='string'?input.basePath:'';
        if (basePath!=='' && !/^\/(?:servers|__opencraft_servers)\/[A-Za-z0-9._-]{1,128}$/u.test(basePath)) throw new Error('invalid_base_path');
        const messages=object(input.messages);
        if (Object.keys(messages).sort().join(',')!=='body,completed,failed,interrupted,test') throw new Error('invalid_messages');
        for (const value of Object.values(messages)) text(value,256);
        await this.store.register(binding,subscription,origin!,basePath,locale,messages);
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
    } catch (error) {
      if(path==='/__opencraft_notifications') {
        // Only fixed codes cross the API boundary; never expose exception text or destinations.
        const code=error instanceof Error?error.message:'';
        const known:Record<string,number>={invalid_destination:400,invalid_target:400,device_limit:400,not_found:404,destination_not_found:404,rate_limited:429,notification_storage_unavailable:503};
        if(error instanceof DeliveryError)send(502,{error:'notification_delivery_failed'});
        else if(Object.hasOwn(known,code))send(known[code]!,{error:code});
        else send(500,{error:'notification_operation_failed'});
      } else send(400,{error:'push_operation_failed'});
      return true;
    }
  }
  private async configuration(binding: PushBinding) {
    const devices=await this.store.devices(binding.context.actorId);
    let imTargets: Array<{channelId:string;senderId:string;label:string}>=[];
    try {imTargets=await this.options.imTargets?.(binding)??[];}catch { /* Keep other channels usable during IM outages. */ }
    return {actorId:binding.context.actorId,enabled:await this.store.master(binding.context.actorId),hosts:this.options.hosts,imTargets,
      destinations:devices.filter(device=>device.target).map(device=>({id:device.id,kind:device.target!.kind,label:targetLabel(device.target!),enabled:device.enabled,
        ...(device.target!.kind==='im'?{channelId:device.target!.channelId,senderId:device.target!.senderId}:{}),
        authorized:this.current(device)}))};
  }
  private async notificationOperation(binding: PushBinding, origin: string, input: Record<string,any>) {
    const actorId=binding.context.actorId;
    if(input.operation==='master') {
      if(typeof input.enabled!=='boolean')throw Error('invalid_input');
      await this.store.setMaster(actorId,input.enabled);
    } else if(input.operation==='save') {
      const previous=input.id?await this.store.get(text(input.id)):null;
      if(input.id && (!previous?.target || previous.actorId!==actorId))throw Error('not_found');
      let target:NotificationTarget;
      if(input.target?.kind==='im') {
        const selected=(await this.options.imTargets?.(binding)??[]).find(item=>item.channelId===input.target.channelId && item.senderId===input.target.senderId);
        if(!selected)throw Error('invalid_target');
        target={kind:'im',...selected};
      }else if(previous?.target && !input.target?.url && previous.target.kind===input.target?.kind) {
        target=previous.target;
      }else target=parseTarget(input.target);
      const locale=text(input.locale,64),messages=object(input.messages);
      if(Object.keys(messages).sort().join(',')!=='body,completed,failed,interrupted,test')throw Error('invalid_messages');
      for(const value of Object.values(messages))text(value,256);
      const basePath=typeof input.basePath==='string'?input.basePath:'';
      if(basePath!=='' && !/^\/(?:servers|__opencraft_servers)\/[A-Za-z0-9._-]{1,128}$/u.test(basePath))throw Error('invalid_base_path');
      const device=await this.store.saveTarget(binding,target,origin,basePath,locale,messages,input.id,input.creationId===undefined?undefined:text(input.creationId,128));
      return {...await this.configuration(binding),savedId:device.id};
    }else {
      const device=await this.store.get(text(input.id));
      if(!device?.target || device.actorId!==actorId)throw Error('not_found');
      if(input.operation==='remove')await this.store.remove(device.id,actorId);
      else if(input.operation==='enable') {
        if(typeof input.enabled!=='boolean')throw Error('invalid_input');
        await this.store.setEnabled(device.id,actorId,input.enabled);
      }else if(input.operation==='test') {
        const key='actor:'+actorId;
        if(this.now()-(this.testTimes.get(key)??0)<30000)throw Error('rate_limited');
        if(this.testTimes.size>=1024)this.testTimes.delete(this.testTimes.keys().next().value!);
        this.testTimes.set(key,this.now());
        // Explicit tests may run while paused, but always require the current user binding.
        await this.send({...device,authorization:binding},this.payload(device,'test'));
        return {sent:true};
      }else throw Error('invalid_operation');
    }
    return this.configuration(binding);
  }
  async close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);await this.running;await this.store.close();}
}
