import { randomUUID } from 'node:crypto';
import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { assertModelPolicy, projectModels, readPolicy, resolvePolicySelection } from './native.mjs';
type V=Record<string,any>;
export function modelEngine(model:unknown,fallback='codex'):string {
  const id=String(model ?? '');
  return id.startsWith('pi:')?'pi':id.startsWith('dsh-model:')?'dsh':id.startsWith('dsh-acp:')?'dsh-acp':id.startsWith('acp:')?'acp':id.startsWith('claude-code:')?'claude-code':id.startsWith('gemini:')?'gemini':fallback;
}
/** Runs in the Server owner Worker; mapped model aliases may consult its SQLite policy. */
export function projectModelCatalog(path: string, fallback: string, models: V[]): V[] {
  const policy = readPolicy(path);
  return models.flatMap(model => projectModels(path,
    fallback === 'codex' ? 'codex' : modelEngine(model.model ?? model.id, fallback), [model], policy));
}

/** Gateway enforcement also protects old independent owners until handoff. */
export class ModelPolicyTransport implements DuplexTransport {
  private listeners=new Set<(frame:string)=>void>();
  private pending=new Map<string,{resolve:(value:V)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private requests=new Map<string,{method:string;epoch:number}>();
  private projectionEpoch = 0;
  constructor(private inner:DuplexTransport, private path:string, private fallback:string,
    private projectCatalog: (path: string, engine: string, models: V[]) => Promise<V[]>) {
    inner.subscribeStatus(status => {
      if (status.state !== 'open') this.projectionEpoch++;
    });
    inner.subscribeMessage(frame=>{
      const message=JSON.parse(frame);const key=String(message.id),requestKey=JSON.stringify([message[LOGICAL_CLIENT_FIELD] ?? null,message.id]),flight=this.pending.get(key);
      if(flight){clearTimeout(flight.timer);this.pending.delete(key);message.error?flight.reject(new Error(message.error.message)):flight.resolve(message.result);return;}
      const request = this.requests.get(requestKey);
      this.requests.delete(requestKey);
      if (request?.method === 'model/list' && Array.isArray(message.result?.data)) {
        const { epoch } = request;
        if (epoch !== this.projectionEpoch) return;
        void this.projectCatalog(path, fallback, message.result.data).then(data => {
          if (epoch !== this.projectionEpoch) return;
          this.emit({ ...message, result: { ...message.result, data } });
        }, () => {
          if (epoch !== this.projectionEpoch) return;
          delete message.result;
          this.emit({ ...message, error: { code: -32043, message: 'Model policy unavailable. Try again.' } });
        });
        return;
      }
      this.emit(message);
    });
  }
  private emit(message: V) { for (const listener of this.listeners) listener(JSON.stringify(message)); }
  get status(){return this.inner.status;}
  captureMessageScope(){return this.inner.captureMessageScope?.() ?? (()=>true);}
  connect(signal?:AbortSignal){return this.inner.connect(signal);}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener);}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  async close(){this.projectionEpoch++;this.requests.clear();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Transport closed'));}this.pending.clear();await this.inner.close();}
  private rpc(method:string,params:V,context:TransportSubmissionContext,logical:unknown):Promise<V>{
    const id='model-policy:'+randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Model policy selection unavailable'));},10000);
      this.pending.set(id,{resolve,reject,timer});
      const frame=JSON.stringify({id,method,params,...(logical?{[LOGICAL_CLIENT_FIELD]:logical}:{})});
      void (this.inner.sendWithContext?this.inner.sendWithContext(frame,context):this.inner.send(frame)).catch(error=>{clearTimeout(timer);this.pending.delete(id);reject(error);});
    });
  }
  send(frame:string,signal?:AbortSignal){return this.sendWithContext(frame,{sender:null},signal);}
  async sendWithContext(frame:string,context:TransportSubmissionContext,signal?:AbortSignal){
    signal?.throwIfAborted();
    const message=JSON.parse(frame),p=message.params ?? {};
    try {
      if((['turn/start','turn/steer','thread/queue/start','thread/queue/steer'].includes(message.method)||message.method==='thread/goal/set'&&!["paused","complete","blocked"].includes(p.status))&&readPolicy(this.path).rules.length){
        const logical=message[LOGICAL_CLIENT_FIELD];
        const thread=(await this.rpc('thread/read',{threadId:p.threadId,includeTurns:false},context,logical)).thread ?? {};
        const catalog=(await this.rpc('model/list',{},context,logical)).data ?? [];
        const engine=this.fallback === "codex" ? "codex" : modelEngine(p.collaborationMode?.settings?.model ?? p.model ?? thread.model,this.fallback);
        const {model,effort}=resolvePolicySelection(engine,p,thread,catalog);
        assertModelPolicy(this.path,engine,model,effort,catalog);
      }
      signal?.throwIfAborted();
      if(message.id!==undefined)this.requests.set(JSON.stringify([message[LOGICAL_CLIENT_FIELD] ?? null,message.id]),{method:message.method,epoch:this.projectionEpoch});
      if(this.inner.sendWithContext)await this.inner.sendWithContext(frame,context,signal);else await this.inner.send(frame,signal);
    }catch(error){
      if(message.id===undefined)throw error;
      const e=error as Error&{code?:number;data?:unknown};
      for(const listener of this.listeners)listener(JSON.stringify({id:message.id,error:{code:e.code ?? -32043,message:e.message,data:e.data},...(message[LOGICAL_CLIENT_FIELD]?{[LOGICAL_CLIENT_FIELD]:message[LOGICAL_CLIENT_FIELD]}:{})}));
    }
  }
}
