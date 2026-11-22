import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelImage, ChannelMessagePresentation } from "@opencraft/appserver-protocol";
import type { ActorContext } from '@opencraft/identity-core/actors';
export interface ChannelSourceBinding { source: string; channelId: string }
export interface ChannelArrival { source: string; id: string; author: string; sender?: {id:string;displayName:string}; text:string; at:number; mediaId?:string; mediaIdentity?:string; inlineImage?:Uint8Array }
export interface ChannelSyncTransport {
  /** Stable operator-selected connection ID. Omitted IDs share the legacy singleton scope.
   * This is installation metadata, not a tenant or an authorization credential. */
  readonly connectionId?: string;
  /** Optional connection-owned personal Turn notification adapter. No group selection or credentials. */
  notifications?: {
    targets(actorId:string):Array<{channelId:string;senderId:string;label:string;methodId:string;methodLabel:string}>;
    send(actorId:string,target:{channelId:string;senderId:string},content:string,requestId:string,assertCurrent:()=>void):Promise<void>;
  };
  bindings: readonly ChannelSourceBinding[];
  /** Optional provider enrollment must finish before claiming durable work. */
  ready?():boolean;
  resolveBinding?(arrival:ChannelArrival):Promise<ChannelSourceBinding>;
  link?(context:ActorContext):Promise<unknown>;
  close?():Promise<void>;
  senderNames?(source:string,ids:readonly string[],signal:AbortSignal):Promise<ReadonlyMap<string,string>>;
  files?: true;
  send(input:{attachment?:{name:string;type:string;bytes:Uint8Array};source:string;requestId:string;text:string;author:string;presentation?:ChannelMessagePresentation;replyTo?:string;mentions?:{start:number;end:number;recipient:string}[]},signal:AbortSignal):Promise<'delivered'|'rejected'>;
  images?: {
    download(mediaId:string,signal:AbortSignal):Promise<Uint8Array>;
    upload(image:ChannelImage,signal:AbortSignal):Promise<string|null>;
    attribute(input:{source:string;requestId:string;author:string},signal:AbortSignal):Promise<'delivered'|'rejected'>;
    send(source:string,mediaId:string,signal:AbortSignal):Promise<'delivered'|'rejected'>;
  };
  subscribe(receive:(arrival:ChannelArrival)=>Promise<void>):()=>void;
  subscribeWithReceipt?(receive:(arrival:ChannelArrival)=>Promise<{messageId:string}>):()=>void;
  callback?:{path:string;handle(request:IncomingMessage,response:ServerResponse):Promise<void>};
}
export interface NativeChannelSyncPort {
  synchronizeChannels(command:{method:string;params:Record<string,unknown>}):Promise<any>;
  channels:{onChange(listener:()=>void):()=>void};
}
/** Only transport work lives here. The native channel owner admits messages,
 * claims durable sends and publishes all timeline changes through its Worker. */
export class ChannelSync {
  private readonly incarnation=randomUUID();
  private readonly connectionId:string;
  private readonly abort=new AbortController();
  private readonly pending=new Set<Promise<unknown>>();
  private unsubscribe?:()=>void;
  private unwatch?:()=>void;
  private timer?:ReturnType<typeof setInterval>;
  private pumping?:Promise<void>;
  private downloading?:Promise<void>;
  private wakePending=false;
  private closing?:Promise<void>;
  private configurationAttempted=false;
  private constructor(readonly transport:ChannelSyncTransport,private readonly port:NativeChannelSyncPort){
    this.connectionId=ChannelSync.validateTransport(transport);
  }
  /** Preflight is side-effect free so composition can reject collisions before configure. */
  static validateTransport(transport:ChannelSyncTransport){
    const connectionId=transport?.connectionId??'legacy';
    if(!transport||typeof connectionId!=='string'||!/^[a-z0-9][a-z0-9._:-]{0,127}$/u.test(connectionId))throw Error('Invalid channel connection ID');
    if(transport.callback&&!/^\/__opencraft_im\/channel-callback\/[a-z0-9_-]{1,64}$/.test(transport.callback.path))throw Error('Invalid channel callback route');
    return connectionId;
  }
  static async open(transport:ChannelSyncTransport,port:NativeChannelSyncPort){
    const sync=new ChannelSync(transport,port);
    try{
      if(!port?.synchronizeChannels)throw Error('Native channels required');
      // Do not silently fall back to deployment-wide resets on an older owner.
      if(transport.connectionId!==undefined){
        const capability=await port.synchronizeChannels({method:'connectionCapabilities',params:{}});
        if(capability?.version!==1)throw Error('Channel connection isolation unavailable');
      }
      sync.configurationAttempted=true;
      await sync.call('configure',{bindings:transport.bindings,images:!!transport.images});
      sync.unsubscribe=transport.subscribeWithReceipt
        ? transport.subscribeWithReceipt(arrival=>sync.track(sync.ingest(arrival)))
        : transport.subscribe(async arrival=>{await sync.track(sync.ingest(arrival));});
      sync.unwatch=port.channels.onChange(()=>sync.wake());
      sync.timer=setInterval(()=>sync.wake(),1000);sync.timer.unref();sync.wake();
      return sync;
    }catch(error){await sync.close().catch(()=>{});throw error;}
  }
  private call(method:string,params:Record<string,unknown>={}){
    return this.port.synchronizeChannels({method,params:{...params,connectionId:this.connectionId,incarnation:this.incarnation}});
  }
  private track<T>(promise:Promise<T>):Promise<T>{
    this.pending.add(promise);void promise.then(()=>this.pending.delete(promise),()=>this.pending.delete(promise));return promise;
  }
  private async ingest(arrival:ChannelArrival){
    this.abort.signal.throwIfAborted();
    if(this.transport.resolveBinding) {
      const binding=await this.transport.resolveBinding(arrival);
      if(binding.source!==arrival.source)throw Error('channel_source_unbound');
      await this.call('addSource',{binding,images:!!this.transport.images});
    } else if(!this.transport.bindings.some(binding=>binding.source===arrival.source))throw Error('channel_source_unbound');
    // Label enrichment is optional; it does not decide identity or membership.
    if(arrival.sender&&this.transport.senderNames){
      const names=await this.transport.senderNames(arrival.source,[arrival.sender.id],AbortSignal.any([this.abort.signal,AbortSignal.timeout(2000)])).catch(()=>null);
      if(names?.has(arrival.sender.id))arrival={...arrival,sender:{...arrival.sender,displayName:names.get(arrival.sender.id)!}};
    }
    this.abort.signal.throwIfAborted();
    const receipt=await this.call('ingest',{source:arrival.source,arrival});
    if(typeof receipt?.messageId!=='string'||!receipt.messageId)throw Error('durable_receipt_required');
    if(arrival.inlineImage) {
      const image=await this.call('imageReady',{source:arrival.source,messageId:receipt.messageId,bytes:arrival.inlineImage});
      if(image?.ready!==true)throw Error('durable_image_receipt_required');
    }
    this.wake();return {messageId:receipt.messageId};
  }
  private wake(){
    if(this.abort.signal.aborted||this.transport.ready?.()===false)return;
    if(this.pumping)this.wakePending=true;
    else{
      this.wakePending=false;
      this.pumping=this.drain().catch(()=>{/* Durable queue survives storage/provider outages. */}).finally(()=>{
        this.pumping=undefined;if(this.wakePending)this.wake();
      });
    }
    if(!this.downloading&&this.transport.images){
      this.downloading=this.download().catch(()=>{}).finally(()=>{this.downloading=undefined;});
    }
  }
  private async drain(){
    while(!this.abort.signal.aborted&&this.transport.ready?.()!==false){
      const item=await this.call('claim');if(!item)return;
      const params={source:item.source,messageId:item.messageId,attemptId:item.attemptId};
      const signal=AbortSignal.any([this.abort.signal,AbortSignal.timeout(item.attachment?90000:30000)]);
      const message={source:item.source,requestId:item.messageId,text:item.text,author:item.author,...(Array.isArray(item.mentions)&&item.mentions.length?{mentions:item.mentions}:{}),
        ...(item.presentation?{presentation:item.presentation as ChannelMessagePresentation}:{}),
        ...(typeof item.replyTo==='string'?{replyTo:item.replyTo}:{})};
      let status:'delivered'|'rejected'|'unknown'='unknown';
      let handedOff=false;
      try{
        await this.call('check',params);signal.throwIfAborted();
        if(item.image){
          const images=this.transport.images;if(!images)throw Error('channel_images_unavailable');
          const mediaId=await images.upload(item.image,signal);
          if(!mediaId)status='rejected';
          else{
            await this.call('check',params);signal.throwIfAborted();
            await this.call('attribution',{...params,status:'sending'});
            handedOff=true;
            const attribution=await images.attribute(message,signal).catch(()=>'unknown' as const);
            await this.call('attribution',{...params,status:attribution});
            status=attribution;
            if(attribution==='delivered'){
              await this.call('check',params);signal.throwIfAborted();
              status='unknown';status=await images.send(item.source,mediaId,signal);
            }
          }
        }else {
          let attachment:{name:string;type:string;bytes:Uint8Array}|undefined;
          if(item.attachment){
            if(!this.transport.files||!Number.isSafeInteger(item.attachment.size)||item.attachment.size<0||item.attachment.size>20*1024*1024)throw Error('channel_files_unavailable');
            const bytes=new Uint8Array(item.attachment.size);let offset=0;
            do{const part=await this.call('attachmentChunk',{...params,offset});signal.throwIfAborted();
              if(part.name!==item.attachment.name||part.type!==item.attachment.type||part.size!==bytes.length||!(part.bytes instanceof Uint8Array)||part.bytes.length>65536||part.nextOffset!==offset+part.bytes.length||part.nextOffset>bytes.length||!part.bytes.length&&offset!==bytes.length)throw Error('invalid_attachment_chunk');
              bytes.set(part.bytes,offset);offset=part.nextOffset;
            }while(offset<bytes.length);
            attachment={name:item.attachment.name,type:item.attachment.type,bytes};
          }
          await this.call('check',params);signal.throwIfAborted();handedOff=true;
          status=await this.transport.send({...message,...(attachment?{attachment}:{})},signal);
        }
      }catch{status=handedOff?'unknown':'rejected';/* Never resend an uncertain external effect. */}
      await this.call('settle',{...params,status});
    }
  }
  private async download(){
    while(!this.abort.signal.aborted&&this.transport.ready?.()!==false){
      const item=await this.call('pendingImage');if(!item)return;
      let bytes:Uint8Array|undefined;
      for(let n=0;n<3&&!this.abort.signal.aborted;n++){
        try{bytes=await this.transport.images!.download(item.mediaId,AbortSignal.any([this.abort.signal,AbortSignal.timeout(15000)]));break;}catch{}
      }
      if(this.abort.signal.aborted)return;
      await this.call('imageReady',{source:item.source,messageId:item.messageId,bytes});
    }
  }
  close(){
    return this.closing??=this.dispose();
  }
  private async dispose(){
    this.abort.abort();clearInterval(this.timer);
    const failures:unknown[]=[];
    for(const cleanup of [this.unsubscribe,this.unwatch]) {
      try { cleanup?.(); } catch(error) { failures.push(error); }
    }
    await Promise.allSettled([...this.pending,this.pumping,this.downloading]);
    try { await this.transport.close?.(); } catch(error) { failures.push(error); }
    if(this.configurationAttempted)await this.call('deactivate').catch(()=>{});
    if(failures.length)throw new AggregateError(failures,'Channel connection shutdown failed');
  }
}
