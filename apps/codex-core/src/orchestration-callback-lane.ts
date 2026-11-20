import { ThreadPublication } from "./thread-publication.js";
import { isHumanInteraction } from "@opencraft/appserver-protocol";
import { OperationReceipts } from './operation-receipts.js';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { removeStaleSocket } from './native-process.js';
import { ExecutionPreparationError, reportExecutionPreparationFailure } from './execution-preparation.js';
import { projectNativeModelCatalog } from './native-model-catalog.js';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tools = new Set(['thread_spawn','thread_tell','thread_inspect','thread_wait','read_thread','send_message_to_thread','get_thread_delivery']);
// Only these native methods are known not to acquire execution ownership.
// Unknown methods retain the lane until authoritative lifecycle evidence exists.
const transientNativeReads = new Set(['initialize','model/list','thread/list','thread/loaded/list','thread/read']);
const idKey = (id: unknown) => JSON.stringify(id);
// Bound transport queues; operation receipts remain with the Agent owner.
const send = (socket: WebSocket | null, value: unknown) => {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const frame = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(frame) > 32 * 1024 * 1024) { socket.terminate(); return; }
  socket.send(frame, error => { if (error) socket.terminate(); });
};
export interface CallbackRelayLimits {
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  idleLaneMs?: number;
}
interface ExecutionPreparation { cancelled: boolean }
export type NativeRequestPolicy = (method: unknown, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
interface Callback { message: Record<string, unknown>; answered: boolean; human?: boolean; timer?: ReturnType<typeof setTimeout> }


/** The native WebSocket belongs to the APP Host, including while a gateway is absent.
 * Only an explicit tool operation can reuse a native mutation receipt. Ordinary
 * start/steer requests are never retried by this relay. */
/** Relay-lifetime identity; neither upstream nor downstream sockets own receipts. */
class OperationOwner {
  readonly receipts = new OperationReceipts();
  // In-flight policy promises continue consuming capacity across connection loss.
  readonly preparations = new Set<string>();
}

class CallbackLane {
  private readonly upstream: WebSocket;
  private readonly opened: Promise<void>;
  private client: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private sequence = 0;
  private readonly connectionId = randomUUID();
  private initialized = false;
  private initializeReply: Record<string, unknown> | null = null;
  private readonly pending = new Map<string,{socket:WebSocket;id:unknown;initialize:boolean;operation?:string;method?:string;threadId?:string;delegationId?:string|null}>();
  private readonly callbacks = new Map<string,Callback>();
  private get mutations() { return this.owner.receipts; }
  private readonly preparingOperations = new Map<string, string>();
  private readonly requests = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly preparing = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  // RPC completion cannot prove that native execution has ended.
  private executionMayExist = false;
  private readonly turnDelegations = new Map<string,string>();
  private readonly threadDelegations = new Map<string,string>();
  private readonly heldStarts = new Map<string,Record<string,unknown>>();
  private readonly releasePublication: () => void;
  constructor(target: string, private readonly incarnation:string, private readonly disconnectWindowMs: number, private readonly replay: boolean, private readonly retired: () => void, private readonly requestPolicy?: NativeRequestPolicy, private readonly preparations = new Map<string, Set<ExecutionPreparation>>(), private readonly publication = new ThreadPublication(), private readonly limits: CallbackRelayLimits = {}, private readonly owner = new OperationOwner()) {
    this.releasePublication = publication.subscribe(() => {
      for (const [id,message] of this.heldStarts) if (this.ready && publication.allowed(id)) { this.heldStarts.delete(id); send(this.client,message); }
    });
    this.upstream = new WebSocket(`ws+unix://${target}:/`,{handshakeTimeout:5000});
    this.opened = new Promise((resolve,reject) => { this.upstream.once('open',resolve);this.upstream.once('error',reject);this.upstream.once('close',()=>reject(new Error('Native callback owner closed'))); });
    void this.opened.catch(()=>this.close());
    this.upstream.on('message',frame=>{
      let message:Record<string,unknown>;
      try { message=object(JSON.parse(String(frame))); } catch { this.close();return; }
      if (message.id!==undefined && typeof message.method!=='string') {
        const key=String(message.id),pending=this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);this.finishRequest(key);
        const mutation=pending.operation?this.mutations.get(pending.operation):undefined;
        const created=object(object(message.result).thread).id;
        if (['thread/start','thread/fork'].includes(pending.method??'') && typeof created==='string' && !message.error) {
          if (mutation?.publication) this.publication.resolve(pending.operation!,this.owner,created);
          else this.publication.created(created);
        } else if (mutation?.publication && message.error && object(object(message.error).data).resultUnknown!==true) this.publication.resolve(pending.operation!,this.owner);
        const forbidden=!mutation?.publication && ([...this.publication.references(message.result),...(pending.threadId?[pending.threadId]:[])].some(id=>!this.publication.allowed(id)));
        if (forbidden) message={id:message.id,error:{code:-32004,message:'Conversation not found or unavailable'}};
        else if (!message.error) message={...message,result:this.publication.project(pending.method,message.result)};
        const reply=message.error ? {error:pending.operation?{...object(message.error),data:{...object(object(message.error).data),orchestrationRejected:object(object(message.error).data).resultUnknown!==true}}:message.error}:{result:pending.method === 'model/list' ? projectNativeModelCatalog(message.result) : message.result};
        if(!message.error && pending.threadId && ['turn/start','turn/steer'].includes(pending.method??'')) {
          const result=object(message.result),turnId=String(object(result.turn).id??result.turnId??'');
          if(turnId)this.bindDelegation(pending.threadId,turnId,pending.delegationId??null);
        }
        if (pending.initialize && !message.error) this.initializeReply=reply;
        if (pending.operation) {
          if (object(object(message.error).data).resultUnknown === true) this.mutations.uncertain(pending.operation,reply);
          else this.mutations.complete(pending.operation, reply);
        } else send(pending.socket,{id:pending.id,...reply});
        return;
      }
      const params=object(message.params);
      const tid=typeof params.threadId==='string'?params.threadId:typeof object(params.thread).id==='string'?String(object(params.thread).id):'';
      if (tid && !this.publication.allowed(tid)) {
        if (message.method==='thread/started') {
          if(this.heldStarts.size>=1024&&!this.heldStarts.has(tid)){this.close();return;}
          this.heldStarts.set(tid,message);
        }
        return;
      }
      if(tid)this.publication.observed(tid);
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
      const isHuman = isHumanInteraction(message.method, params);
      if (isTool || isHuman || message.method === 'turn/started') this.executionMayExist = true;
      if (isHuman && message.id !== undefined) {
        const key = idKey(message.id), previous = this.callbacks.get(key);
        message = { ...message, __opencraftInteractionKey: previous?.message.__opencraftInteractionKey ?? `human:${this.incarnation}:${randomUUID()}`,
          __opencraftInteractionState: previous?.answered ? previous.message.__opencraftInteractionState ?? "responding" : "pending" };
        if (previous) previous.message = message;
        else {
          if ([...this.callbacks.values()].filter(value => value.human).length >= 256) {
            send(this.upstream, { id: message.id, error: { code: -32083, message: "Too many pending human requests" } }); return;
          }
          this.callbacks.set(key, { message, answered: false, human: true });
        }
      }
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
    clearTimeout(this.idleTimer);this.client=socket;this.ready=false;
    socket.on('message',frame=>{
      if (this.client!==socket || this.closed) return;
      void this.receive(socket,String(frame)).catch(()=>socket.close(1011,'Callback lane unavailable'));
    });
    const detach=()=>{
      if (this.client!==socket) return;
      this.client=null;this.ready=false;
      for (const key of this.callbacks.keys()) this.armCallback(key);
      this.mutations.detach(socket);
      this.armIdleRetirement();
    };
    socket.on('close',detach);socket.on('error',detach);
  }
  private async receive(socket: WebSocket, frame: string): Promise<void> {
    const message=object(JSON.parse(frame));await this.opened;
    if (this.closed || this.client!==socket) return;
    const method=message.method,params=object(message.params);
    const executionThread = typeof params.threadId === 'string' ? params.threadId : '';
    if (this.requestPolicy && method === 'turn/interrupt') for (const preparation of this.preparations.get(executionThread) ?? []) preparation.cancelled = true;
    if (method==='initialize' && this.initializeReply) { send(socket,{id:message.id,...this.initializeReply});return; }
    if (method==='initialized') {
      if (!this.initialized) {this.initialized=true;send(this.upstream,message);}
      this.ready=true;
      for(const [id,message] of this.heldStarts)if(this.publication.allowed(id)){this.heldStarts.delete(id);send(this.client,message);}
      // Human waits have no disconnect deadline and survive Gateway lifetime.
      // Submitted human responses replay state only; they never execute again.
      for (const callback of this.callbacks.values()) if (!callback.answered || callback.human) {
        clearTimeout(callback.timer);callback.timer=undefined;send(socket,callback.message);
      }
      return;
    }
    if (method==='opencraft/orchestration/private-capability') { send(socket,{id:message.id,result:{version:1}});return; }
    if (method==='opencraft/orchestration/publish') {
      const operation=typeof params.operationId==='string'?params.operationId:'';
      send(socket,{id:message.id,result:{published:this.publication.publish(operation,this.owner)}});return;
    }
    if (method==='opencraft/orchestration/ack') {
      const operation=typeof params.operationId==='string'?params.operationId:'';
      send(socket,{id:message.id,result:{acknowledged:this.mutations.acknowledge(operation)}});this.armIdleRetirement();return;
    }
    if (message.id!==undefined && typeof method!=='string') {
      const key=idKey(message.id),callback=this.callbacks.get(key);
      if((message.__opencraftCallbackIncarnation || message.__opencraftInteractionKey) && !callback)return;
      if (callback) {
        if (callback.answered) return;
        if (callback.human && message.__opencraftInteractionKey !== undefined && message.__opencraftInteractionKey !== callback.message.__opencraftInteractionKey) return;
        if (!callback.human && (message.__opencraftCallbackIncarnation!==this.incarnation || message.__opencraftToolCallKey!==callback.message.__opencraftToolCallKey)) return;
        if (this.upstream.readyState !== WebSocket.OPEN) throw new Error("Native response channel is unavailable");
        callback.answered=true;clearTimeout(callback.timer);
        if (callback.human) callback.message = { ...callback.message, __opencraftInteractionState: "responding" };
      }
      const {__opencraftCallbackIncarnation:_incarnation,__opencraftToolCallKey:_call,__opencraftInteractionKey:_interaction,...native}=message;
      send(this.upstream,native);return;
    }
    if (message.id===undefined) {send(this.upstream,message);return;}
    const operation=typeof params.__opencraftOrchestrationOperation==='string'?params.__opencraftOrchestrationOperation:undefined;
    const {__opencraftDeferPublication:deferPublication,__opencraftOrchestrationOperation:_operation,__opencraftOrchestrationFingerprint:identity,__opencraftOrchestrationIncarnation:expectedIncarnation,__opencraftOrchestrationSourceThreadId:_source,__opencraftDelegationId:delegationId,...nativeParams}=params;
    if (operation) {
      if (!this.replay) throw new Error('Orchestration callback lane is required');
      if(expectedIncarnation!==undefined&&expectedIncarnation!==this.incarnation){send(socket,{id:message.id,error:{code:-32000,message:'Orchestration creation outcome is unconfirmed after Engine Host replacement'}});return;}
      if (!['thread/start','thread/name/set'].includes(String(method)) || !operation || operation.length>256) throw new Error('Invalid orchestration mutation');
      // Store a bounded digest of the actual intent as well as the caller's identity.
      // Object key order is not an argument change; a reused caller fingerprint cannot hide changed arguments.
      const fingerprint = createHash('sha256').update(JSON.stringify([method, typeof identity === 'string' ? identity : null, nativeParams, deferPublication === true],
        (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
          ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value)).digest('hex');
      if(deferPublication===true && method!=='thread/start') throw Error('Only creation can defer publication');
      let created = false;
      try {
        created = this.mutations.subscribe(operation, fingerprint, {owner:socket,id:message.id,
          deliver:reply=>send(socket,{id:message.id,...reply})},deferPublication===true) === 'created';
        if (!created) return;
        if(deferPublication===true)this.publication.begin(operation,this.owner);
      } catch (error) {
        const failure={error:{code:-32600,message:(error as Error).message}};
        if (created) this.mutations.complete(operation,failure);
        else send(socket,{id:message.id,...failure});
        return;
      }
    }
    if (this.publication.references(nativeParams).some(id=>!this.publication.allowed(id)) && !operation) {
      send(socket,{id:message.id,error:{code:-32004,message:'Conversation not found or unavailable'}});return;
    }
    for(const id of this.publication.references(nativeParams))this.publication.observed(id);
    const reply = (value: {result?:unknown;error?:unknown}) => {
      if (operation) this.mutations.complete(operation,value);
      else send(socket,{id:message.id,...value});
    };
    // Reconnection handshake must remain available even when old policy work fills admission.
    const preparingCount = method === 'initialize' ? this.preparing.size : this.owner.preparations.size;
    if (preparingCount + this.pending.size >= (this.limits.maxPendingRequests ?? 1024)) {
      if(operation && deferPublication===true)this.publication.resolve(operation,this.owner);
      reply({error:{code:-32085,message:'Request capacity exhausted',data:{notSubmitted:true,forwarded:false,orchestrationRejected:true}}});return;
    }
    const id=`callback-lane:${this.incarnation}:${this.connectionId}:${++this.sequence}`;
    let forwarded = false;
    const timer = setTimeout(() => {
      if(!operation)this.pending.delete(id);
      if(!forwarded && operation && deferPublication===true)this.publication.resolve(operation,this.owner);
      this.finishRequest(id);
      // Deadline is not cancellation or permission to repeat a mutation.
      const outcome={error:{code:-32086,message:forwarded?'Request outcome unconfirmed':'Request preparation timed out',data:{notSubmitted:!forwarded,forwarded,resultUnknown:forwarded,orchestrationRejected:!forwarded}}};
      if(operation && forwarded)this.mutations.uncertain(operation,outcome);
      else reply(outcome);
    }, this.limits.requestTimeoutMs ?? 120_000);
    timer.unref();this.requests.set(id,timer);

    let executionParams = nativeParams;
    const preparationStarted = this.requestPolicy && (method === 'thread/start' || method === 'turn/start') ? performance.now() : undefined;
    const preparation = this.requestPolicy && method === 'turn/start' ? {cancelled: false} : undefined;
    if (preparation) {
      if (!this.preparations.has(executionThread)) this.preparations.set(executionThread, new Set());
      this.preparations.get(executionThread)!.add(preparation);
    }
    this.preparing.add(id);this.owner.preparations.add(id);
    if (operation) this.preparingOperations.set(id,operation);
    try { executionParams = await this.requestPolicy?.(method, nativeParams) ?? nativeParams; }
    catch (cause) {
      if (!this.requests.has(id)) return;
      this.finishRequest(id);
      if(operation && deferPublication===true)this.publication.resolve(operation,this.owner);
      if (preparationStarted !== undefined) reportExecutionPreparationFailure(method, nativeParams, this.incarnation,
        cause instanceof ExecutionPreparationError ? cause.reason : 'policy-failed', performance.now() - preparationStarted);
      reply({error: {code: -32084, message: 'Execution environment unavailable', data: {notSubmitted: true, ...(operation ? {orchestrationRejected: true} : {})}}}); return;
    }
    finally {
      this.preparing.delete(id);this.preparingOperations.delete(id);this.owner.preparations.delete(id);this.armIdleRetirement();
      if (preparation) {
        const pending = this.preparations.get(executionThread);pending?.delete(preparation);
        if (!pending?.size) this.preparations.delete(executionThread);
      }
    }
    if (!this.requests.has(id) || this.closed) return;
    if (preparation?.cancelled) {
      this.finishRequest(id);
      reply({error: {code: -32800, message: 'Execution interrupted', data: {notSubmitted: true}}}); return;
    }
    if (!operation && (this.client !== socket || socket.readyState !== WebSocket.OPEN)) {
      this.finishRequest(id);
      if (preparationStarted !== undefined) reportExecutionPreparationFailure(method, nativeParams, this.incarnation,
        'connection-replaced', performance.now() - preparationStarted);
      return;
    }
    forwarded = true;
    if (!transientNativeReads.has(String(method))) this.executionMayExist = true;
    this.pending.set(id,{socket,id:message.id,initialize:method==='initialize',operation,method:typeof method==='string'?method:undefined,threadId:typeof params.threadId==='string'?params.threadId:undefined,delegationId:typeof delegationId==='string'?delegationId:null});
    send(this.upstream,{...message,id,params:executionParams});
  }
  private finishRequest(id: string): void {
    clearTimeout(this.requests.get(id));this.requests.delete(id);this.armIdleRetirement();
  }
  private armIdleRetirement(): void {
    clearTimeout(this.idleTimer);
    if (!this.canRetire()) return;
    this.idleTimer = setTimeout(() => { if (this.canRetire()) this.close(); }, this.limits.idleLaneMs ?? 60_000);
    this.idleTimer.unref();
  }
  private canRetire(): boolean {
    return !this.closed && !this.client && !this.executionMayExist && !this.requests.size && !this.preparing.size && !this.heldStarts.size && !this.callbacks.size && !this.mutations.size;
  }
  private bindDelegation(threadId:string,turnId:string,delegationId:string|null):void {
    if(!turnId)return;const key=JSON.stringify([threadId,turnId]);
    if(delegationId){this.turnDelegations.set(key,delegationId);this.threadDelegations.set(threadId,delegationId);}
    else{this.turnDelegations.delete(key);this.threadDelegations.delete(threadId);}
  }
  private armCallback(key: string): void {
    const callback=this.callbacks.get(key);
    if (!callback || callback.human || callback.answered || callback.timer) return;
    callback.timer=setTimeout(()=>{
      if (this.callbacks.get(key)!==callback || callback.answered) return;
      callback.answered=true;
      send(this.upstream,{id:callback.message.id,result:{success:false,contentItems:[{type:'inputText',text:'Orchestration gateway reconnect window exhausted; inspect the original operation before retrying.'}]}});
    },this.disconnectWindowMs);callback.timer.unref();
  }
  private resolveCallback(key: string): void { const callback=this.callbacks.get(key);clearTimeout(callback?.timer);this.callbacks.delete(key); }
  get pendingMutations(): number { return this.mutations.size; }
  get pendingCallbacks(): number { return [...this.callbacks.values()].filter(value=>value.human || !value.answered).length; }
  close(): void {
    if (this.closed) return;this.closed=true;
    // Settle only requests proven not to have crossed the native boundary.
    for (const operation of this.preparingOperations.values()) {
      const receipt=this.mutations.get(operation);
      if (!receipt || receipt.settled) continue;
      if (receipt.publication) this.publication.resolve(operation,this.owner);
      this.mutations.complete(operation,{error:{code:-32086,message:'Native connection lost before admission',data:{notSubmitted:true,forwarded:false,resultUnknown:false,orchestrationRejected:true}}});
    }
    for (const pending of this.pending.values()) if (pending.operation) {
      this.mutations.uncertain(pending.operation,{error:{code:-32086,message:'Native connection lost; request outcome unconfirmed',data:{forwarded:true,resultUnknown:true,orchestrationRejected:false}}});
    }
    if (this.client) this.mutations.detach(this.client);
    this.upstream.terminate();this.client?.terminate();
    for (const key of this.callbacks.keys()) this.resolveCallback(key);
    this.releasePublication();this.heldStarts.clear();
    clearTimeout(this.idleTimer);
    for (const timer of this.requests.values()) clearTimeout(timer);
    this.requests.clear();this.preparing.clear();this.preparingOperations.clear();this.pending.clear();this.turnDelegations.clear();this.threadDelegations.clear();this.retired();
  }
}

/** Private UDS facade. A stable lane query opts a gateway into reconnect/replay;
 * unmarked native clients keep the previous connection-scoped lifetime. */
export async function startOrchestrationCallbackRelay(endpoint: string,target: string,options: {disconnectWindowMs?:number;requestPolicy?:NativeRequestPolicy} & CallbackRelayLimits={}) {
  await removeStaleSocket(endpoint);
  const publication=new ThreadPublication();
  const incarnation=randomUUID(),lanes=new Map<string,CallbackLane>(),server=createServer(),websockets=new WebSocketServer({server,maxPayload:32*1024*1024});
  const preparations = new Map<string, Set<ExecutionPreparation>>();
  const owners = new Map<string, OperationOwner>();
  websockets.on('connection',(socket,request)=>{
    const laneId=new URL(request.url??'/','http://local.invalid').searchParams.get('opencraftLane');
    if (laneId!==null && !/^[a-zA-Z0-9:_-]{1,256}$/u.test(laneId)) {socket.close(1008);return;}
    const key=laneId??randomUUID();let lane=lanes.get(key);
    if (!lane) {
      if (lanes.size>=32) {socket.close(1013);return;}
      let owner=owners.get(key);
      if (!owner) {
        // Never evict unacknowledged receipts or private allocations to admit work.
        for (const [id,candidate] of owners) if (!lanes.has(id) && !candidate.receipts.size && !candidate.preparations.size && !publication.hasOwner(candidate)) owners.delete(id);
        if (owners.size>=32) {socket.close(1013,'Operation owner capacity exhausted');return;}
        owner=new OperationOwner();owners.set(key,owner);
      }
      lane=new CallbackLane(target,incarnation,options.disconnectWindowMs??15_000,laneId!==null,()=>lanes.delete(key),options.requestPolicy,preparations,publication,options,owner);lanes.set(key,lane);
    }
    lane.attach(socket);
    if (laneId===null) socket.once('close',()=>lane?.close());
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.off('error',reject);resolve();});});
  await chmod(endpoint,0o600);
  return {incarnation,get pendingMutations(){return [...owners.values()].reduce((count,owner)=>count+owner.receipts.size,0);},get pendingCallbacks(){return [...lanes.values()].reduce((count,lane)=>count+lane.pendingCallbacks,0);},async close(){for(const lane of lanes.values())lane.close();websockets.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await unlink(endpoint).catch(()=>{});}};
}
