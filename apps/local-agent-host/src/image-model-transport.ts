import {LOGICAL_CLIENT_FIELD} from '@opencraft/app-host-protocol';
import {captureTransportMessageScope,type DuplexTransport,type TransportSubmissionContext} from '@opencraft/appserver-client/transport';
import {IMAGE_GENERATION,ImageGenerationConfiguration} from './model-config/image-generation.js';

const key=(value:Record<string,any>)=>JSON.stringify([value[LOGICAL_CLIENT_FIELD]??null,value.id]);
const own=(id:unknown)=>typeof id==='string'&&id.startsWith('image-');
/** Application image settings stay available independently of the text engine version. */
export class ImageModelTransport implements DuplexTransport {
  private listeners=new Set<(frame:string)=>void>();
  private pending=new Map<string,{method:string;params:any;deadline:number;context:TransportSubmissionContext}>();
  private closed=false;
  private active=0;
  private unsubscribe:()=>void;
  constructor(private readonly inner:DuplexTransport,private readonly images:ImageGenerationConfiguration){
    this.unsubscribe=inner.subscribeMessage(frame=>{void this.receive(frame);});
  }
  get status(){return this.inner.status;}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  captureMessageScope(){return captureTransportMessageScope(this.inner);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeRecoveryHint(listener:()=>void){return this.inner.subscribeRecoveryHint?.(listener)??(()=>{});}
  private emit(frame:string,current:()=>boolean=()=>true){if(!this.closed)for(const listener of this.listeners){if(!current())break;listener(frame);}}
  private async receive(frame:string){
    const current=captureTransportMessageScope(this.inner);let value;try{value=JSON.parse(frame)}catch{this.emit(frame,current);return;}
    const pending=!value.method?this.pending.get(key(value)):undefined;
    if(!pending){this.emit(frame,current);return;}
    this.pending.delete(key(value));
    try{
      pending.context.resourceOwner?.assertCurrent();
      if(value.result){const doc=await this.images.read();
        if(pending.method==='runtime/providers/list'){
          const providers=await this.images.views(doc);
          value.result={...value.result,providers:[...value.result.providers,...providers],creation:{...value.result.creation,image:{api:IMAGE_GENERATION.api,baseURL:IMAGE_GENERATION.baseURL,model:IMAGE_GENERATION.model,revision:doc.revision}}};
        }else if(pending.method==='runtime/settings/describe')value.result={...value.result,namespaces:[...value.result.namespaces,{ns:IMAGE_GENERATION.ns,schema:{},value:this.images.profile(doc),applies:'live',secrets:[],revision:doc.revision}]};
        else if(pending.params.includeDisabled===true)value.result={...value.result,groups:[...value.result.groups,...doc.providers.map(p=>({id:p.id,name:p.name,models:p.models.map(m=>({...m,type:'image',name:m.name??m.id,enabled:p.enabled&&m.enabled}))}))]};
        frame=JSON.stringify(value);
      }
      pending.context.resourceOwner?.assertCurrent();this.emit(frame,current);
    }catch{try{pending.context.resourceOwner?.assertCurrent()}catch{return;}if(current())this.emit(JSON.stringify({...value,result:undefined,error:{code:-32000,message:'图像配置读取失败，请刷新重试'}}),current);}
  }
  send(frame:string,signal?:AbortSignal){return this.sendWithContext(frame,{sender:null},signal);}
  async sendWithContext(frame:string,context:TransportSubmissionContext,signal?:AbortSignal){
    const value=JSON.parse(frame),p=value.params??{},method=value.method;
    const candidate=p.target?.id??p.provider;
    const imageOwned=own(candidate)&&(await this.images.read()).providers.some(row=>row.id===candidate);
    const local=method==='runtime/providers/apply'&&(p.api===IMAGE_GENERATION.api||imageOwned)
      ||['runtime/providers/setEnabled','runtime/providers/delete','runtime/models/setEnabled','runtime/models/delete','runtime/models/check','runtime/models/inspect','runtime/models/discover'].includes(method)&&imageOwned
      ||method==='runtime/settings/mutate'&&p.ns===IMAGE_GENERATION.ns;
    if(local&&value.id!==undefined){
      if(this.active>=8)throw Error('图像配置操作正在进行，请稍后重试');this.active++;
      try{
        if(this.closed||signal?.aborted)return;context.resourceOwner?.assertCurrent();let result:any;
        if(method==='runtime/providers/apply')result=await this.images.apply(p);
        else if(method==='runtime/providers/setEnabled'){
          if(typeof p.enabled!=='boolean')throw Error('启用状态无效');const doc=await this.images.setEnabled(p.expectedRevision,p.provider,p.enabled);result={revision:doc.revision};
        }else if(method==='runtime/providers/delete'){
          const doc=await this.images.update(p.expectedRevision,doc=>{if(!doc.providers.some(row=>row.id===p.provider))throw Error('图像提供商不存在');doc.providers=doc.providers.filter(row=>row.id!==p.provider);});result={revision:doc.revision};
        }else if(method==='runtime/settings/mutate'){
          if(!Array.isArray(p.ops)||p.ops.length!==1||p.ops[0].op!=='set'||JSON.stringify(p.ops[0].path)!=='["defaultModel"]')throw Error('图像设置操作无效');
          const selection=p.ops[0].value;if(selection!==null&&(!selection||typeof selection.provider!=='string'||typeof selection.model!=='string'||Object.keys(selection).some(k=>!['provider','model'].includes(k))))throw Error('图像模型选择无效');
          const doc=await this.images.select(p.expectedRevision,selection);result={ns:IMAGE_GENERATION.ns,revision:doc.revision,value:this.images.profile(doc)};
        }else if(method==='runtime/models/setEnabled'||method==='runtime/models/delete'){
          if(method==='runtime/models/setEnabled'&&typeof p.enabled!=='boolean')throw Error('启用状态无效');
          const doc=await this.images.update(p.expectedRevision,doc=>{const provider=doc.providers.find(row=>row.id===p.provider);const model=provider?.models.find(row=>row.id===p.model);if(!provider||!model)throw Error('图像模型不存在');if(method==='runtime/models/delete')provider.models=provider.models.filter(row=>row.id!==p.model);else model.enabled=p.enabled;});result={revision:doc.revision};
        }else throw Error('图像模型不使用文本检测或聊天能力探测');
        context.resourceOwner?.assertCurrent();if(!signal?.aborted)this.emit(JSON.stringify({...value,method:undefined,params:undefined,result}));
      }catch(error){
        if(signal?.aborted)return;try{context.resourceOwner?.assertCurrent()}catch{return;}
        const message=error instanceof Error?error.message:'图像配置操作失败';
        this.emit(JSON.stringify({...value,method:undefined,params:undefined,error:{code:-32000,message:/^(图像|请先|更换地址|配置已|默认图像|启用状态)/u.test(message)?message:'图像配置操作失败，请刷新后重试'}}));
      }finally{this.active--;}
      return;
    }
    if(['runtime/providers/list','runtime/settings/describe','runtime/models/list'].includes(method)&&value.id!==undefined){
      for(const [id,row]of this.pending)if(row.deadline<Date.now())this.pending.delete(id);
      if(this.pending.size>=128)throw Error('Too many model directory requests');this.pending.set(key(value),{method,params:p,context,deadline:Date.now()+30000});
    }
    try{if(this.inner.sendWithContext)await this.inner.sendWithContext(frame,context,signal);else await this.inner.send(frame,signal)}catch(error){this.pending.delete(key(value));throw error;}
  }
  async close(){this.closed=true;this.pending.clear();this.listeners.clear();this.unsubscribe();await this.inner.close();}
}
