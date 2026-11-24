import { observeNotificationRequest, notificationRejection, type NotificationRejection } from './diagnostics';
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import webpush from 'web-push';
import { AppServerRpcError } from '@opencraft/appserver-client';
import { periodicOwnerWork, timeoutOwnerWake, type OwnerWake, type PeriodicOwnerWork } from '@opencraft/owner-wake';
import type { PushStorePort } from './async-store';
import { DeliveryError, parseTarget, targetLabel, sendDestination, type NotificationMessage } from './destinations';
import type { NotificationTarget } from './store';
import type { PushBinding, PushDevice, PushSubscriptionData, PushWatch } from './store';

export interface TurnPushOptions {
  authenticate(request: IncomingMessage): PushBinding | null;
  current(binding: PushBinding): boolean;
  trustedOrigin(request: IncomingMessage): string | null;
  hosts: readonly string[];
  canRead?: (actorId: string, hostId: string, threadId: string) => boolean;
  read(hostId: string, method: string, params: Record<string,unknown>): Promise<unknown>;
  send?: (device: PushDevice, payload: string, keys: {publicKey:string;privateKey:string}) => Promise<unknown>;
  now?: () => number;
  /** Owner wake-up for the outbox pass; the default Node timeout one. The pass reads engine history, which has no
   * change notification, so it stays a fixed 5 s period. */
  wake?: OwnerWake;
  /** Canonical external entry at send time; never changes authentication or PWA scope. */
  publicBaseUrl?: () => string | Promise<string>;
  imTargets?: (binding: PushBinding) => Promise<Array<{channelId:string;senderId:string;label:string;methodId?:string;methodLabel?:string}>>;
  /** Trusted product policy; null defers readiness, false excludes this identity. */
  defaultTarget?: (request: IncomingMessage, binding: PushBinding, targets: Array<Extract<NotificationTarget,{kind:'im'}>>) => {policyId:string;target:Extract<NotificationTarget,{kind:'im'}>} | null | false;
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
function oversizedHistory(error: unknown): boolean {
  return (error as {code?:unknown})?.code === 'HISTORY_RESPONSE_TOO_LARGE'
    || error instanceof AppServerRpcError && (error.code === -32072 || (error.data as {code?:unknown})?.code === 'HISTORY_RESPONSE_TOO_LARGE');
}

/** Process-owned subscription API, authoritative-history observer and bounded outbox.
 * No execution store is reopened and no task is resubmitted by this service. */
export class TurnPushService {
  keys!: {publicKey:string;privateKey:string};
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly timer: PeriodicOwnerWork;
  private closed = false;
  private running: Promise<void> | null = null;
  private cursor = 0;
  private failures = 0;
  private degraded = false;
  private failureReason: 'history_response_too_large' | 'history_budget_exceeded' | 'notification_unavailable' | 'delivery_failed' | null = null;
  private readonly testTimes = new Map<string,number>();
  private readonly defaultJobs = new Map<string,Promise<void>>();
  private readonly defaultRetries = new Map<string,ReturnType<typeof setTimeout>>();
  private readonly defaultChecks = new Map<string,number>();
  constructor(readonly store: PushStorePort, private readonly options: TurnPushOptions) {
    this.now = options.now ?? Date.now;
    const keys=store.keys(() => webpush.generateVAPIDKeys());
    if(keys instanceof Promise)this.ready=keys.then(value=>{this.keys=value;});
    else {this.keys=keys;this.ready=Promise.resolve();}
    this.timer = periodicOwnerWork(options.wake ?? timeoutOwnerWake(),5000,() => { void this.tick(); });
  }
  /** Called only after an authenticated human connection is admitted. Optional product
   * policy supplies the verified recipient; this never sends or blocks engine work. */
  initializeDefaultsForRequest(request: IncomingMessage): void {
    try {
      if(this.closed || !this.options.defaultTarget)return;
      const binding=this.options.authenticate(request),origin=request.headers.origin;
      if(!binding || binding.context.credentialId!==null || !this.options.current(binding))return;
      // A notification default is not a reason to weaken origin or trust forwarded headers.
      const trusted=this.options.trustedOrigin(request);
      if(typeof origin!=='string' || request.headers['sec-fetch-site']==='cross-site')return;
      const parsed=new URL(origin);
      if(!['http:','https:'].includes(parsed.protocol) || parsed.origin!==origin || (origin!==trusted && parsed.host!==request.headers.host))return;
      const actorId=binding.context.actorId,key=createHash('sha256').update(JSON.stringify(binding)).digest('hex');
      if(this.defaultJobs.size>=4096 || this.defaultJobs.has(key) || this.now()<(this.defaultChecks.get(key)??0))return;
      if(this.defaultChecks.size>=4096)this.defaultChecks.delete(this.defaultChecks.keys().next().value!);
      this.defaultChecks.set(key,this.now()+30000);
      const retry=()=>{
        if(this.closed || this.defaultRetries.has(key))return;
        if(this.defaultRetries.size>=4096){const oldest=this.defaultRetries.keys().next().value!;clearTimeout(this.defaultRetries.get(oldest));this.defaultRetries.delete(oldest);}
        const timer=setTimeout(()=>{this.defaultRetries.delete(key);this.defaultChecks.delete(key);this.initializeDefaultsForRequest(request);},30000);timer.unref();this.defaultRetries.set(key,timer);
      };
      const job=(async()=>{
        await this.ready;
        let timeout:ReturnType<typeof setTimeout>|undefined;
        const available=await Promise.race([this.options.imTargets?.(binding)??[],new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(Error('notification_target_timeout')),5000);timeout.unref();})]).finally(()=>clearTimeout(timeout));
        const targets=available.map(t=>({kind:'im' as const,...t}));
        if(this.closed || !this.options.current(binding))return;
        const current=this.options.authenticate(request);
        if(!current || JSON.stringify(current)!==JSON.stringify(binding))return;
        const decision=this.options.defaultTarget!(request,binding,targets);
        if(!decision){if(decision===null)retry();return;}
        const selected=targets.find(t=>t.channelId===decision.target.channelId && t.senderId===decision.target.senderId);
        if(!selected){retry();return;}
        clearTimeout(this.defaultRetries.get(key));this.defaultRetries.delete(key);
        const devices=await this.store.devices(actorId),existing=devices.find(d=>d.target?.kind==='im' && d.target.channelId===selected.channelId && d.target.senderId===selected.senderId);
        if(this.closed || !this.options.current(binding))return;
        // Preserve saved routes/messages on reconnect. Explicit server-public-URL
        // configuration, when present, remains the notification link owner.
        const zh=/^zh(?:-|,|;|$)/iu.test(String(request.headers['accept-language']??''));
        const messages=existing?.messages??(zh?{completed:'OpenCraft · 本轮已完成',failed:'OpenCraft · 本轮执行失败',interrupted:'OpenCraft · 本轮已停止',body:'点击返回对应对话。',test:'OpenCraft · 通知已启用'}
          :{completed:'OpenCraft · Response complete',failed:'OpenCraft · Response failed',interrupted:'OpenCraft · Response stopped',body:'Click to return to the conversation.',test:'OpenCraft · Notifications enabled'});
        await this.store.initializeDefault(binding,decision.policyId,selected,existing?.origin??origin,existing?.basePath??'',existing?.locale??(zh?'zh-CN':'en-US'),messages);
      })().catch(()=>{retry(); /* Readiness/storage failures never affect admission. */ }).finally(()=>{this.defaultJobs.delete(key);});
      this.defaultJobs.set(key,job);
    } catch { /* Notification enrollment cannot reject a human connection. */ }
  }
  async initialize() { await this.ready; }
  get health() { return {state:this.degraded?'degraded':'ready',failures:this.failures,...(this.degraded?{reason:this.failureReason}: {})}; }
  private current(device: PushDevice) {
    try { return !this.closed && this.options.current(device.authorization); } catch { return false; }
  }
  private async payload(device: PushDevice, status: string, hostId?: string, threadId?: string, turnId?: string, threadTitle?: string) {
    const path = threadId ? `/local/${encodeURIComponent(threadId)}?${new URLSearchParams({hostId:hostId!})}` : '/settings/chat';
    // External channels use server configuration, including already saved targets.
    // Apple web push stays inside the origin/scope in which it was subscribed.
    const entry = device.target ? await this.options.publicBaseUrl?.() : '';
    const target = entry ? new URL(entry.replace(/\/+$/u,'') + path) : new URL(device.basePath + path, device.origin);
    return JSON.stringify({web_push:8030,notification:{title:threadTitle ? `${threadTitle} · ${device.messages[status]}` : device.messages[status],body:device.messages.body,
      lang:device.locale,tag:turnId?`opencraft-turn:${createHash('sha256').update(JSON.stringify([hostId,threadId,turnId])).digest('hex')}`:'opencraft-push-test',
      navigate:target.href,silent:false}});
  }
  private async send(device: PushDevice, payload: string, message?: NotificationMessage) {
    if (!this.current(device)) throw new Error('authorization_expired');
    if(device.target) {
      const notification=JSON.parse(payload).notification;
      const value=message??{id:'test:'+device.id+':'+randomUUID(),event:'notification.test',title:notification.title,body:notification.body,url:notification.navigate,status:'test'};
      if(device.target.kind==='im') {
        if(!this.options.sendIm)throw Error('im_unavailable');
        try {return await this.options.sendIm(device.authorization,device.target,value);} catch(error) {
          // A provider-specific failure remains a delivery error without exposing its text.
          throw Object.assign(new DeliveryError((error as {statusCode?:number})?.statusCode??502),{deliveryState:(error as {deliveryState?:string})?.deliveryState});
        }
      }
      return (this.options.sendExternal??sendDestination)(device.target,value);
    }
    if(!device.subscription)throw Error('invalid_subscription');
    return this.options.send ? this.options.send(device,payload,this.keys) : webpush.sendNotification(device.subscription,payload,{
      vapidDetails:{subject:device.origin,publicKey:this.keys.publicKey,privateKey:this.keys.privateKey},
      TTL:3600,timeout:10000,urgency:'normal',contentEncoding:'aes128gcm',
    });
  }
  private async *historyPages(watch: PushWatch, read: TurnPushOptions['read'], method: 'thread/items/list' | 'thread/turns/list') {
    let cursor: string | null = null, limit = 100, remaining = 500;
    const seen = new Set<string>();
    // Keep the normal 500-entry ceiling. Smaller pages may need more reads,
    // but even empty pages and a single oversized item have a finite budget.
    for (let requests = 0, pages = 0; requests < 27 && pages < 20 && remaining > 0 && !this.closed; requests++) {
      let result: Record<string,any>;
      const pageLimit = Math.min(limit,remaining);
      try {
        result = object(await read(watch.hostId,method,{threadId:watch.threadId,limit:pageLimit,sortDirection:'desc',
          ...(method==='thread/turns/list'?{itemsView:'notLoaded'}:{}),...(cursor?{cursor}:{})}));
      } catch (error) {
        if (!oversizedHistory(error) || pageLimit === 1) throw error;
        // Retry only this read, at the exact same opaque cursor. Never advance
        // past unread evidence or replay the user's submission.
        limit = Math.max(1,Math.floor(pageLimit/2));
        continue;
      }
      if (!Array.isArray(result.data)) return;
      if (result.data.length > pageLimit) throw new Error('invalid_history_page');
      pages++; remaining -= result.data.length;
      yield result;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) return;
      cursor = result.nextCursor; seen.add(cursor);
    }
    if (remaining > 0 && !this.closed) throw Object.assign(new Error('Notification history scan budget exceeded'),{code:'NOTIFICATION_HISTORY_BUDGET_EXCEEDED'});
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
      for await (const result of this.historyPages(watch,read,'thread/items/list')) {
        for (const entry of result.data) {
          const item = entry?.item;
          if (item?.type === 'userMessage' && item.clientId === watch.inputId && typeof entry.turnId === 'string' && entry.turnId) { turnId=entry.turnId; break; }
        }
        if (turnId) break;
      }
      if (!turnId) return;
      await this.store.bindTurn(watch.id,turnId);
    }
    for await (const result of this.historyPages(watch,read,'thread/turns/list')) {
      const turn = result.data.find((turn: any) => turn?.id === turnId);
      if (turn) {
        if (['completed','failed','interrupted'].includes(turn.status)) await this.store.finish(watch,turnId,turn.status);
        return;
      }
    }
  }
  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.work().catch(() => { this.failures++;this.degraded=true;this.failureReason='notification_unavailable'; }).finally(() => { this.running=null; });
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
      let value=reads.get(key);
      if(!value){
        value=this.options.read(hostId,method,params).then(raw=>{
          if(method!=='thread/items/list' && method!=='thread/turns/list')return raw;
          const page=object(raw);
          // Sharing a sweep must not retain tool bodies, images or message text.
          // Keep only exact-input attribution and terminal-status evidence.
          return {nextCursor:page.nextCursor,data:Array.isArray(page.data)?page.data.map(entry=>method==='thread/items/list'
            ? {turnId:entry?.turnId,item:{type:entry?.item?.type,clientId:entry?.item?.clientId}}
            : {id:entry?.id,status:entry?.status}):page.data};
        });
        reads.set(key,value);
      }
      return value;
    };
    const results=await Promise.allSettled(selected.map(watch => this.reconcile(watch,read)));
    this.degraded=results.some(result=>result.status==='rejected');
    this.failures+=results.filter(result=>result.status==='rejected').length;
    const rejected=results.find(result=>result.status==='rejected');
    this.failureReason=rejected?.status==='rejected' ? oversizedHistory(rejected.reason)?'history_response_too_large'
      : rejected.reason?.code==='NOTIFICATION_HISTORY_BUDGET_EXCEEDED'?'history_budget_exceeded':'notification_unavailable' : null;
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
        const payload=await this.payload(latest,delivery.status,delivery.hostId,delivery.threadId,delivery.turnId,threadTitle);
        const notification=JSON.parse(payload).notification;
        await this.send(latest,payload,{id:delivery.id,event:'turn.ended',title:notification.title,body:notification.body,url:notification.navigate,status:delivery.status,hostId:delivery.hostId,threadId:delivery.threadId,turnId:delivery.turnId});
        await this.store.settled(delivery.id,'sent');
      } catch (error) {
        this.failures++;this.degraded=true;
        this.failureReason='delivery_failed';
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
      if(path==='/__opencraft_notifications'){send(200,await this.notificationOperation(binding,origin!,input,request));return true;}
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
        await this.send(previous,await this.payload(previous,'test'));
        send(200,{sent:true});return true;
      }
      throw new Error('invalid_operation');
    } catch (error) {
      if(path==='/__opencraft_notifications') {
        // Only fixed codes cross the API boundary; never expose exception text or destinations.
        const code=error instanceof Error?error.message:'';
        const known:Record<string,number>={authorization_expired:401,invalid_destination:400,invalid_target:400,device_limit:400,not_found:404,destination_not_found:404,rate_limited:429,notification_storage_unavailable:503};
        if(error instanceof DeliveryError)send(502,{error:'notification_delivery_failed'});
        else if(Object.hasOwn(known,code))send(known[code]!,{error:code});
        else send(500,{error:'notification_operation_failed'});
      } else send(400,{error:'push_operation_failed'});
      return true;
    }
  }
  private async configuration(binding: PushBinding) {
    const devices=await this.store.devices(binding.context.actorId);
    let imTargets: Array<{channelId:string;senderId:string;label:string;methodId?:string;methodLabel?:string}>=[];
    try {imTargets=await this.options.imTargets?.(binding)??[];}catch { /* Keep other channels usable during IM outages. */ }
    return {defaultsAvailable:!!this.options.defaultTarget,actorId:binding.context.actorId,enabled:await this.store.master(binding.context.actorId),hosts:this.options.hosts,imTargets,
      destinations:devices.filter(device=>device.target).map(device=>({id:device.id,kind:device.target!.kind,label:targetLabel(device.target!),enabled:device.enabled,
        ...(device.target!.kind==='im'?{channelId:device.target!.channelId,senderId:device.target!.senderId,...(device.target!.methodId?{methodId:device.target!.methodId,methodLabel:device.target!.methodLabel}:{})}:{}),
        authorized:this.current(device)}))};
  }
  private async notificationOperation(binding: PushBinding, origin: string, input: Record<string,any>, request: IncomingMessage) {
    const actorId=binding.context.actorId;
    if(input.operation==='defaults') {
      if(!this.options.defaultTarget)return {...await this.configuration(binding),defaultsStatus:'complete'};
      const targets=(await this.options.imTargets?.(binding)??[]).map(target=>({kind:'im' as const,...target}));
      if(!this.options.current(binding))throw Error('authorization_expired');
      const decision=this.options.defaultTarget(request,binding,targets);
      if(!decision)return {...await this.configuration(binding),defaultsStatus:decision===false?'ineligible':'deferred'};
      // Only a current, verified transport target can enter the single preference store.
      const selected=targets.find(target=>target.channelId===decision.target.channelId && target.senderId===decision.target.senderId);
      if(!selected)throw Error('invalid_target');
      const locale=text(input.locale,64),messages=object(input.messages);
      if(Object.keys(messages).sort().join(',')!=='body,completed,failed,interrupted,test')throw Error('invalid_messages');
      for(const value of Object.values(messages))text(value,256);
      const basePath=typeof input.basePath==='string'?input.basePath:'';
      if(basePath!=='' && !/^\/(?:servers|__opencraft_servers)\/[A-Za-z0-9._-]{1,128}$/u.test(basePath))throw Error('invalid_base_path');
      await this.store.initializeDefault(binding,decision.policyId,selected,origin,basePath,locale,messages);
      return {...await this.configuration(binding),defaultsStatus:'complete'};
    } else if(input.operation==='master') {
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
        await this.send({...device,authorization:binding},await this.payload(device,'test'));
        return {sent:true};
      }else throw Error('invalid_operation');
    }
    return this.configuration(binding);
  }
  async close() {if(this.closed)return;this.closed=true;this.timer.close();for(const timer of this.defaultRetries.values())clearTimeout(timer);this.defaultRetries.clear();await this.running;await Promise.allSettled(this.defaultJobs.values());await this.store.close();}
}
