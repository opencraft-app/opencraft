import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';
import { WORKSPACE_CATALOG_METHOD, WORKSPACE_PLACEMENT_EXTENSION, OPENCRAFT_METHOD_ACCESS_EXTENSION,
  WORKSPACE_FILE_SCOPE_METHOD, type WorkspaceFileLocation, type WorkspaceCatalog } from '@opencraft/appserver-protocol';

/** Installed only with matched Native routing and the private
 * authority. Capability describes the protocol, not available compute capacity. */
export class HostWorkspaceCatalogTransport implements DuplexTransport {
  private readonly listeners = new Set<(frame:string)=>void>();
  private readonly initializing = new Set<string>();
  private readonly clients = new Set<string>();
  private readonly active = new Map<string,object>();
  private readonly removeMessage:()=>void;
  private readonly removeStatus:()=>void;
  private closed=false;private epoch=0;private closing?:Promise<void>;
  constructor(private readonly inner:DuplexTransport,
    private readonly read:(context:TransportSubmissionContext)=>Promise<WorkspaceCatalog>,
    private readonly readFileScope?: (context:TransportSubmissionContext,threadId:string)=>Promise<WorkspaceFileLocation>) {
    this.removeStatus=inner.subscribeStatus(status=>{if(status.state!=='open')this.reset()});
    this.removeMessage=inner.subscribeMessage(frame=>{
      const value=JSON.parse(frame),client=String(value[LOGICAL_CLIENT_FIELD]??'');
      if(!value.method&&this.initializing.delete(JSON.stringify([client,value.id]))&&!value.error) {
        this.clients.add(client);
        const result=value.result??={},capabilities=result.capabilities??={},extensions=capabilities.extensions??={};
        extensions[WORKSPACE_PLACEMENT_EXTENSION]={version:1,...(this.readFileScope?{fileScopeVersion:1}:{})};
        const access=extensions[OPENCRAFT_METHOD_ACCESS_EXTENSION];
        if(Array.isArray(access?.methods))access.methods=[...new Set([...access.methods,WORKSPACE_CATALOG_METHOD,...(this.readFileScope?[WORKSPACE_FILE_SCOPE_METHOD]:[])])];
      }
      this.emit(value);
    });
  }
  private reset(){this.epoch++;this.initializing.clear();this.clients.clear();this.active.clear()}
  private emit(value:unknown){if(!this.closed)for(const listener of this.listeners)listener(JSON.stringify(value))}
  get status(){return this.inner.status}
  connect(signal?:AbortSignal){return this.inner.connect(signal)}
  subscribeMessage(listener:(frame:string)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  subscribeStatus(listener:Parameters<DuplexTransport['subscribeStatus']>[0]){return this.inner.subscribeStatus(listener)}
  subscribeRecoveryHint(listener:()=>void){return this.inner.subscribeRecoveryHint?.(listener)??(()=>{})}
  captureMessageScope(){const epoch=this.epoch,scope=this.inner.captureMessageScope?.();return()=>!this.closed&&epoch===this.epoch&&(scope?scope():this.inner.status.state==='open')}
  send(frame:string,signal?:AbortSignal){return this.sendWithContext(frame,{sender:null},signal)}
  async sendWithContext(frame:string,context:TransportSubmissionContext,signal?:AbortSignal){
    if(this.closed)throw Error('Workspace catalog transport closed');
    signal?.throwIfAborted();
    const value=JSON.parse(frame),client=String(value[LOGICAL_CLIENT_FIELD]??''),key=JSON.stringify([client,value.id]);
    if(value.method==='initialize'){
      if(this.initializing.size>=256)throw Error('Workspace catalog initialization capacity');
      this.initializing.add(key);
    }
    if(value.method!==WORKSPACE_CATALOG_METHOD&&value.method!==WORKSPACE_FILE_SCOPE_METHOD){
      try{return this.inner.sendWithContext?await this.inner.sendWithContext(frame,context,signal):await this.inner.send(frame,signal)}
      catch(error){if(value.method==='initialize')this.initializing.delete(key);throw error}
    }
    if(typeof value.id!=='string'&&typeof value.id!=='number')throw Error('Catalog request requires an ID');
    const response={id:value.id,[LOGICAL_CLIENT_FIELD]:value[LOGICAL_CLIENT_FIELD],...(value.jsonrpc==='2.0'?{jsonrpc:'2.0'}:{})};
    if(this.active.has(key))throw Error('Duplicate catalog request');
    const epoch=this.epoch,scope=this.captureMessageScope(),operation={};
    const current=()=>!this.closed&&epoch===this.epoch&&scope()&&!signal?.aborted&&this.active.get(key)===operation&&this.clients.has(client);
    try{
      if(!this.clients.has(client)||this.active.size>=128)throw Error('Catalog unavailable');
      const params=value.params;
      const fileScope=value.method===WORKSPACE_FILE_SCOPE_METHOD;
      if(fileScope) {
        if(!this.readFileScope||!params||typeof params!=='object'||Array.isArray(params)
          ||Object.keys(params).length!==1||typeof params.threadId!=='string'
          ||!params.threadId||params.threadId.length>512||/[\x00-\x1f\x7f]/u.test(params.threadId))
          throw Error('Invalid file scope params');
      } else if(params!==undefined&&(!params||typeof params!=='object'||Array.isArray(params)||Object.keys(params).length))
        throw Error('Invalid catalog params');
      this.active.set(key,operation);
      context.resourceOwner?.assertCurrent();
      if(context.validUntil!==undefined&&context.validUntil<=Date.now())throw Error('Expired request');
      const result=fileScope?await this.readFileScope!(context,params.threadId):await this.read(context);
      context.resourceOwner?.assertCurrent();
      if(context.validUntil!==undefined&&context.validUntil<=Date.now())throw Error('Expired request');
      if(current())this.emit({...response,result});
    }catch{
      if(!this.closed&&epoch===this.epoch&&!signal?.aborted&&scope()&&(!this.active.has(key)||current()))
        this.emit({...response,error:{code:-32000,message:'Workspace catalog unavailable'}});
    }finally{if(this.active.get(key)===operation)this.active.delete(key)}
  }
  close(){return this.closing??=(async()=>{this.closed=true;this.reset();this.removeMessage();this.removeStatus();this.listeners.clear();await this.inner.close()})()}
}
