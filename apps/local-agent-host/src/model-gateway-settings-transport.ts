import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import {captureTransportMessageScope,type DuplexTransport,type TransportSubmissionContext} from '@opencraft/appserver-client/transport';
import {ModelGatewayStore} from '@opencraft/account-pool-host';
import {ModelConfigurationRepository} from './model-config/repository.js';
const reads=new Set(['model/list','runtime/providers/list','runtime/models/list','runtime/settings/describe']);
const configuration=(method:string)=>/^runtime\/(providers|models|settings|credentials)\//.test(method);
const key=(v:Record<string,any>)=>JSON.stringify([v[LOGICAL_CLIENT_FIELD]??null,v.id]);
/** The personal-key endpoint is not a bypass around legacy installation settings.
 * Revalidate the trusted caller on replies; hide other people's connections and
 * refuse unmetered probes and credential-reference reuse in gateway mode. */
export class ModelGatewaySettingsTransport implements DuplexTransport {
  private listeners=new Set<(frame:string)=>void>();
  private pending=new Map<string,{context:TransportSubmissionContext;method:string}>();
  private closed=false;
  private unsubscribe:()=>void;
  constructor(private readonly inner:DuplexTransport,private readonly path:string,private readonly directory:string,
    private readonly authority:(context:TransportSubmissionContext)=>{actor:string;administrator:boolean}|null) {
    this.unsubscribe=inner.subscribeMessage(frame=>{const value=JSON.parse(frame),request=this.pending.get(key(value));
      if(request&&!value.method){this.pending.delete(key(value));void this.reply(value,request,captureTransportMessageScope(inner));}else this.emit(frame);
    });
  }
  get status(){return this.inner.status;}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  captureMessageScope(){return captureTransportMessageScope(this.inner);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeRecoveryHint(listener:()=>void){return this.inner.subscribeRecoveryHint?.(listener)??(()=>{});}
  private emit(frame:string){if(!this.closed)for(const listener of this.listeners)listener(frame);}
  private failure(value:Record<string,any>){this.emit(JSON.stringify({id:value.id,...(value[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:value[LOGICAL_CLIENT_FIELD]}:{}),error:{code:-32003,message:'模型设置不可用或没有权限；个人连接请在模型服务中管理。'}}));}
  private current(context:TransportSubmissionContext){context.resourceOwner?.assertCurrent();const identity=this.authority(context);if(!identity)throw Error('authority');return identity;}
  private async protectedConnections(actor:string,all=false){
    const doc=await new ModelConfigurationRepository(fileStateDocumentStore(this.directory)).read(),store=new ModelGatewayStore(this.path);
    try{return doc.providers.filter(p=>p.catalogId?.startsWith('opencraft-human-')&&(all||!store.canUse(p.id,actor))).flatMap(p=>[p.id,...(p.credentialRef?[p.credentialRef]:[])]);}finally{store.close();}
  }
  private async reply(value:Record<string,any>,request:{context:TransportSubmissionContext;method:string},current:()=>boolean){
    try {
      const identity=this.current(request.context),hidden=new Set(await this.protectedConnections(identity.actor));
      if(this.current(request.context).actor!==identity.actor)throw Error('authority');
      const strip=(v:any):any=>{
        if(typeof v==='string') {
          if(hidden.has(v))return undefined;
          if(v.startsWith('configured/')){try{if(hidden.has(decodeURIComponent(v.slice(11).split('/')[0]??'')))return undefined;}catch{return undefined;}}
          return v;
        }
        if(Array.isArray(v))return v.map(strip).filter(x=>x!==undefined);
        if(!v||typeof v!=='object')return v;
        if(['provider','providerId','id','model','slug'].some(k=>typeof v[k]==='string'&&strip(v[k])===undefined))return undefined;
        return Object.fromEntries(Object.entries(v).filter(([k])=>!hidden.has(k)).flatMap(([k,x])=>{const clean=strip(x);return clean===undefined?[]:[[k,clean]];}));
      };
      value.result=strip(value.result);
      if(request.method==='runtime/providers/list'&&!identity.administrator&&value.result)delete value.result.creation;
      if(current())this.emit(JSON.stringify(value));
    }catch{if(current())this.failure(value);}
  }
  send(frame:string,signal?:AbortSignal){return this.sendWithContext(frame,{sender:null},signal);}
  async sendWithContext(frame:string,context:TransportSubmissionContext,signal?:AbortSignal){
    const value=JSON.parse(frame),method=String(value.method??'');
    try {
      if(method.startsWith('opencraft/codex/accounts/')) {
        const identity=this.current(context);
        if(method.startsWith('opencraft/codex/accounts/personal/')||!identity.administrator)throw Error('administrator');
      }
      if(configuration(method)) {
        const identity=this.current(context);
        if(!reads.has(method)) {
          if(!identity.administrator)throw Error('administrator');
          const protectedIds=new Set(await this.protectedConnections(identity.actor,true));
          const touches=(v:any):boolean=>typeof v==='string'?protectedIds.has(v):!!v&&typeof v==='object'&&Object.entries(v).some(([k,x])=>protectedIds.has(k)||touches(x));
          if(touches(value.params))throw Error('personal-owner');
          const latest=this.current(context);if(latest.actor!==identity.actor||!latest.administrator)throw Error('authority');
        }
      }
      signal?.throwIfAborted();
      if(reads.has(method)&&value.id!==undefined){this.current(context);if(this.pending.size>=128)throw Error('pending');this.pending.set(key(value),{context,method});}
      if(this.inner.sendWithContext)await this.inner.sendWithContext(frame,context,signal);else await this.inner.send(frame,signal);
    }catch{this.pending.delete(key(value));if(value.id!==undefined)this.failure(value);else throw Error('Model settings authorization required');}
  }
  async close(){this.closed=true;this.pending.clear();this.listeners.clear();this.unsubscribe();await this.inner.close();}
}
