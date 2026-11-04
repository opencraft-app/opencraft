import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import {captureTransportMessageScope,type DuplexTransport,type TransportSubmissionContext} from '@opencraft/appserver-client/transport';
import {inspectSavedModel} from './model-capability-inspection.js';
import type {RuntimeModelInspectionParams} from '@opencraft/appserver-protocol';

const key=(value:Record<string,any>)=>JSON.stringify([value[LOGICAL_CLIENT_FIELD]??null,value.id]);
/** Host-owned settings capability: independent of the execution engine version. */
export class ModelCapabilityTransport implements DuplexTransport {
  private listeners=new Set<(frame:string)=>void>();
  private pending=new Map<string,number>();
  private active=0;
  private closed=false;
  private unsubscribe:()=>void;
  constructor(private readonly inner:DuplexTransport,private readonly source:Parameters<typeof inspectSavedModel>[1],
    private readonly inspect=inspectSavedModel){
    this.unsubscribe=inner.subscribeMessage(frame=>{
      let value;try{value=JSON.parse(frame)}catch{this.emit(frame);return;}
      if(!value.method&&this.pending.delete(key(value))&&Array.isArray(value.result?.providers)){
        value={...value,result:{...value.result,providers:value.result.providers.map((p:any)=>p.configuration?{...p,configuration:{...p.configuration,
          canInspectSaved:p.configuration.modelDeclarations===true&&!['asr','image'].includes(p.configuration.modelType)}}:p)}};
        frame=JSON.stringify(value);
      }
      const current=captureTransportMessageScope(inner);
      for(const listener of this.listeners){if(!current())break;listener(frame);}
    });
  }
  get status(){return this.inner.status;}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  captureMessageScope(){return captureTransportMessageScope(this.inner);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeRecoveryHint(listener:()=>void){return this.inner.subscribeRecoveryHint?.(listener)??(()=>{});}
  private emit(frame:string){if(!this.closed)for(const listener of this.listeners)listener(frame);}
  send(frame:string,signal?:AbortSignal){return this.sendWithContext(frame,{sender:null},signal);}
  async sendWithContext(frame:string,context:TransportSubmissionContext,signal?:AbortSignal){
    const value=JSON.parse(frame);
    if(value.method==='runtime/models/inspect'&&value.id!==undefined){
      if(this.active>=2)throw new Error('模型能力检查正在进行，请稍后重试');
      this.active++;
      try{
        if(this.closed||signal?.aborted)throw new Error('Cancelled');context.resourceOwner?.assertCurrent();
        const result=await this.inspect(value.params as RuntimeModelInspectionParams,this.source);
        context.resourceOwner?.assertCurrent();if(signal?.aborted)return;
        this.emit(JSON.stringify({...value,method:undefined,params:undefined,result}));
      }catch(error){
        if(signal?.aborted)return;
        try{context.resourceOwner?.assertCurrent();}catch{return;}
        const text=error instanceof Error?error.message:'';
        const message=/^(配置已更新|此连接没有可用|请先保存|当前协议|无效的|所选模型不在)/.test(text)?text:'模型能力检查失败，请检查已保存配置或重新获取';
        this.emit(JSON.stringify({...value,method:undefined,params:undefined,error:{code:-32000,message}}));
      }finally{this.active--;}
      return;
    }
    if(value.method==='runtime/providers/list'&&value.id!==undefined){
      for(const [id,deadline]of this.pending)if(deadline<Date.now())this.pending.delete(id);
      if(this.pending.size>=128)throw new Error('Too many model directory requests');
      this.pending.set(key(value),Date.now()+30000);
    }
    try{if(this.inner.sendWithContext)await this.inner.sendWithContext(frame,context,signal);else await this.inner.send(frame,signal);}
    catch(error){this.pending.delete(key(value));throw error;}
  }
  async close(){this.closed=true;this.pending.clear();this.listeners.clear();this.unsubscribe();await this.inner.close();}
}
