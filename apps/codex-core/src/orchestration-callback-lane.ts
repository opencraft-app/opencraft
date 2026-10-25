import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { removeStaleSocket } from './native-process.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tools = new Set(['thread_spawn','thread_tell','thread_inspect','thread_wait','read_thread','send_message_to_thread','get_thread_delivery']);
const idKey = (id: unknown) => JSON.stringify(id);
const send = (socket: WebSocket | null, value: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
interface Callback { message: Record<string, unknown>; answered: boolean; timer?: ReturnType<typeof setTimeout> }
interface Mutation { fingerprint: string; reply?: Record<string, unknown>; clients: {socket: WebSocket; id: unknown}[] }

/** The native WebSocket belongs to the APP Host, including while a gateway is absent.
 * Only an explicit tool operation can reuse a native mutation receipt. Ordinary
 * start/steer requests are never retried by this relay. */
class CallbackLane {
  private readonly upstream: WebSocket;
  private readonly opened: Promise<void>;
  private client: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private sequence = 0;
  private initialized = false;
  private initializeReply: Record<string, unknown> | null = null;
  private readonly pending = new Map<string,{socket:WebSocket;id:unknown;initialize:boolean;operation?:string;method?:string;threadId?:string;delegationId?:string|null}>();
  private readonly callbacks = new Map<string,Callback>();
  private readonly mutations = new Map<string,Mutation>();
  private readonly turnDelegations = new Map<string,string>();
  private readonly threadDelegations = new Map<string,string>();
  constructor(target: string, private readonly incarnation:string, private readonly disconnectWindowMs: number, private readonly replay: boolean, private readonly retired: () => void) {
    this.upstream = new WebSocket(`ws+unix://${target}:/`,{handshakeTimeout:5000});
    this.opened = new Promise((resolve,reject) => { this.upstream.once('open',resolve);this.upstream.once('error',reject);this.upstream.once('close',()=>reject(new Error('Native callback owner closed'))); });
    void this.opened.catch(()=>this.close());
    this.upstream.on('message',frame=>{
      let message:Record<string,unknown>;
      try { message=object(JSON.parse(String(frame))); } catch { this.close();return; }
      if (message.id!==undefined && typeof message.method!=='string') {
        const key=String(message.id),pending=this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        const reply=message.error ? {error:pending.operation?{...object(message.error),data:{...object(object(message.error).data),orchestrationRejected:true}}:message.error}:{result:message.result};
        if(!message.error && pending.threadId && ['turn/start','turn/steer'].includes(pending.method??'')) {
          const result=object(message.result),turnId=String(object(result.turn).id??result.turnId??'');
          if(turnId)this.bindDelegation(pending.threadId,turnId,pending.delegationId??null);
        }
        if (pending.initialize && !message.error) this.initializeReply=reply;
        if (pending.operation) {
          const mutation=this.mutations.get(pending.operation)!;mutation.reply=reply;
          for (const subscriber of mutation.clients) send(subscriber.socket,{id:subscriber.id,...reply});
          mutation.clients=[];
        } else send(pending.socket,{id:pending.id,...reply});
        return;
      }
      const params=object(message.params);
      const tid=typeof params.threadId==='string'?params.threadId:'';
      if(message.method==='turn/started' && tid) {
        const pending=[...this.pending.values()].reverse().find(value=>value.method==='turn/start'&&value.threadId===tid);
        this.bindDelegation(tid,String(object(params.turn).id??''),pending?pending.delegationId??null:this.threadDelegations.get(tid)??null);
      }
      if (message.method==='serverRequest/resolved') this.resolveCallback(idKey(params.requestId));
      if(message.method==='turn/completed' && tid) {
        const turnId=String(object(params.turn).id??'');this.turnDelegations.delete(JSON.stringify([tid,turnId]));
        for(const [key,callback] of this.callbacks) { const source=object(callback.message.params);if(source.threadId===tid&&source.turnId===turnId)this.resolveCallback(key); }
      }
      if(message.method==='thread/deleted'||message.method==='thread/archived'||message.method==='thread/unloaded'||message.method==='thread/status/changed'&&object(params.status).type==='notLoaded')this.threadDelegations.delete(tid);
      const isTool=this.replay && message.method==='item/tool/call' && tools.has(String(params.tool)) && !params.namespace;
      if (isTool && message.id!==undefined) {
        const key=idKey(message.id);
        const callId=typeof params.callId==='string' ? params.callId:key;
        const toolCallKey=`${this.incarnation}:${String(params.threadId)}:${String(params.turnId)}:${callId}`;
        message={...message,__opencraftToolCallKey:toolCallKey,__opencraftCallbackIncarnation:this.incarnation,
          __opencraftDelegationId:this.turnDelegations.get(JSON.stringify([params.threadId,params.turnId]))??null};
        this.callbacks.set(key,{message,answered:false});
        if (!this.ready) this.armCallback(key);
      }
      if (this.ready) send(this.client,message);
    });
    this.upstream.on('error',()=>this.close());this.upstream.on('close',()=>this.close());
  }
  attach(socket: WebSocket): void {
    if (this.closed || this.client?.readyState===WebSocket.OPEN) { socket.close(1013,'Callback lane is already attached');return; }
    this.client=socket;this.ready=false;
    socket.on('message',frame=>{
      if (this.client!==socket || this.closed) return;
      void this.receive(socket,String(frame)).catch(()=>socket.close(1011,'Callback lane unavailable'));
    });
    const detach=()=>{
      if (this.client!==socket) return;
      this.client=null;this.ready=false;
      for (const key of this.callbacks.keys()) this.armCallback(key);
      for (const mutation of this.mutations.values()) mutation.clients=mutation.clients.filter(value=>value.socket!==socket);
    };
    socket.on('close',detach);socket.on('error',detach);
  }
  private async receive(socket: WebSocket, frame: string): Promise<void> {
    const message=object(JSON.parse(frame));await this.opened;
    if (this.closed || this.client!==socket) return;
    const method=message.method,params=object(message.params);
    if (method==='initialize' && this.initializeReply) { send(socket,{id:message.id,...this.initializeReply});return; }
    if (method==='initialized') {
      if (!this.initialized) {this.initialized=true;send(this.upstream,message);}
      this.ready=true;
      for (const callback of this.callbacks.values()) if (!callback.answered) {
        clearTimeout(callback.timer);callback.timer=undefined;send(socket,callback.message);
      }
      return;
    }
    if (method==='opencraft/orchestration/ack') {
      const operation=typeof params.operationId==='string'?params.operationId:'';
      const mutation=this.mutations.get(operation);
      if (mutation?.reply) this.mutations.delete(operation);
      send(socket,{id:message.id,result:{acknowledged:!mutation||!!mutation.reply}});return;
    }
    if (message.id!==undefined && typeof method!=='string') {
      const key=idKey(message.id),callback=this.callbacks.get(key);
      if(message.__opencraftCallbackIncarnation && !callback)return;
      if (callback) {
        if (callback.answered || message.__opencraftCallbackIncarnation!==this.incarnation || message.__opencraftToolCallKey!==callback.message.__opencraftToolCallKey) return;
        callback.answered=true;clearTimeout(callback.timer);
      }
      const {__opencraftCallbackIncarnation:_incarnation,__opencraftToolCallKey:_call,...native}=message;
      send(this.upstream,native);return;
    }
    if (message.id===undefined) {send(this.upstream,message);return;}
    const operation=typeof params.__opencraftOrchestrationOperation==='string'?params.__opencraftOrchestrationOperation:undefined;
    const {__opencraftOrchestrationOperation:_operation,__opencraftOrchestrationFingerprint:identity,__opencraftOrchestrationIncarnation:expectedIncarnation,__opencraftOrchestrationSourceThreadId:_source,__opencraftDelegationId:delegationId,...nativeParams}=params;
    if (operation) {
      if (!this.replay) throw new Error('Orchestration callback lane is required');
      if(expectedIncarnation!==undefined&&expectedIncarnation!==this.incarnation){send(socket,{id:message.id,error:{code:-32000,message:'Orchestration creation outcome is unconfirmed after Engine Host replacement'}});return;}
      if (!['thread/start','thread/name/set'].includes(String(method)) || !operation || operation.length>256) throw new Error('Invalid orchestration mutation');
      const fingerprint=typeof identity==='string'?JSON.stringify([method,identity]):JSON.stringify([method,nativeParams]),prior=this.mutations.get(operation);
      if (prior) {
        if (prior.fingerprint!==fingerprint) {send(socket,{id:message.id,error:{code:-32600,message:'Orchestration operation reused'}});return;}
        if (prior.reply) send(socket,{id:message.id,...prior.reply});
        else prior.clients.push({socket,id:message.id});
        return;
      }
      if (this.mutations.size>=1024) throw new Error('Unacknowledged orchestration receipt limit');
      this.mutations.set(operation,{fingerprint,clients:[{socket,id:message.id}]});
    }
    const id=`callback-lane:${this.incarnation}:${++this.sequence}`;
    this.pending.set(id,{socket,id:message.id,initialize:method==='initialize',operation,method:typeof method==='string'?method:undefined,threadId:typeof params.threadId==='string'?params.threadId:undefined,delegationId:typeof delegationId==='string'?delegationId:null});
    send(this.upstream,{...message,id,params:nativeParams});
  }
  private bindDelegation(threadId:string,turnId:string,delegationId:string|null):void {
    if(!turnId)return;const key=JSON.stringify([threadId,turnId]);
    if(delegationId){this.turnDelegations.set(key,delegationId);this.threadDelegations.set(threadId,delegationId);}
    else{this.turnDelegations.delete(key);this.threadDelegations.delete(threadId);}
  }
  private armCallback(key: string): void {
    const callback=this.callbacks.get(key);
    if (!callback || callback.answered || callback.timer) return;
    callback.timer=setTimeout(()=>{
      if (this.callbacks.get(key)!==callback || callback.answered) return;
      callback.answered=true;
      send(this.upstream,{id:callback.message.id,result:{success:false,contentItems:[{type:'inputText',text:'Orchestration gateway reconnect window exhausted; inspect the original operation before retrying.'}]}});
    },this.disconnectWindowMs);callback.timer.unref();
  }
  private resolveCallback(key: string): void { const callback=this.callbacks.get(key);clearTimeout(callback?.timer);this.callbacks.delete(key); }
  get pendingMutations(): number { return this.mutations.size; }
  get pendingCallbacks(): number { return [...this.callbacks.values()].filter(value=>!value.answered).length; }
  close(): void {
    if (this.closed) return;this.closed=true;
    this.upstream.terminate();this.client?.terminate();
    for (const key of this.callbacks.keys()) this.resolveCallback(key);
    this.pending.clear();this.mutations.clear();this.turnDelegations.clear();this.threadDelegations.clear();this.retired();
  }
}

/** Private UDS facade. A stable lane query opts a gateway into reconnect/replay;
 * unmarked native clients keep the previous connection-scoped lifetime. */
export async function startOrchestrationCallbackRelay(endpoint: string,target: string,options: {disconnectWindowMs?:number}={}) {
  await removeStaleSocket(endpoint);
  const incarnation=randomUUID(),lanes=new Map<string,CallbackLane>(),server=createServer(),websockets=new WebSocketServer({server,maxPayload:32*1024*1024});
  websockets.on('connection',(socket,request)=>{
    const laneId=new URL(request.url??'/','http://local.invalid').searchParams.get('opencraftLane');
    if (laneId!==null && !/^[a-zA-Z0-9:_-]{1,256}$/u.test(laneId)) {socket.close(1008);return;}
    const key=laneId??randomUUID();let lane=lanes.get(key);
    if (!lane) {
      if (lanes.size>=32) {socket.close(1013);return;}
      lane=new CallbackLane(target,incarnation,options.disconnectWindowMs??15_000,laneId!==null,()=>lanes.delete(key));lanes.set(key,lane);
    }
    lane.attach(socket);
    if (laneId===null) socket.once('close',()=>lane?.close());
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.off('error',reject);resolve();});});
  await chmod(endpoint,0o600);
  return {incarnation,get pendingMutations(){return [...lanes.values()].reduce((count,lane)=>count+lane.pendingMutations,0);},get pendingCallbacks(){return [...lanes.values()].reduce((count,lane)=>count+lane.pendingCallbacks,0);},async close(){for(const lane of lanes.values())lane.close();websockets.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(endpoint).catch(()=>{});}};
}
