import { communicationExtensionModule } from './communication-extension.js';
import type { ChannelSyncCommand, ChannelSyncResult } from "./native-channel-sync.js";
import type { CommunicationCommand, CommunicationResult } from './communication-command.js';
import { AutomationError } from './automation.js';
import { Worker } from 'node:worker_threads';
import type { ThreadAccessPolicy } from './thread-access.js';
import type { ConversationRef, ThreadOrchestrationSnapshot } from '@opencraft/appserver-protocol/collaboration';
import type { ParentNotification, WaitTicket } from './orchestration-ledger.js';
import type { ExecutionRequestState } from './execution-request-state.js';

export interface OrchestrationRuntimeStorage {
  claimTitleWrite(operationId: string): Promise<boolean>;
  finishTitleWrite(toolCallKey: string, result: unknown): Promise<void>;
  observe(snapshot: ThreadOrchestrationSnapshot, now: number): Promise<void>;
  targets(includeTerminal: boolean, now: number): Promise<string[]>;
  work(now: number): Promise<{ waits: WaitTicket[]; notifications: ParentNotification[] }>;
  pendingAcks(): Promise<string[]>;
  acknowledge(operationId: string): Promise<void>;
}
/** The Server core owner's port for the orchestration runtime domain
 * (`orchestrationRuntimeOwnerMethods`), e.g. `openServerCoreOwner(...)`. */
export interface OrchestrationRuntimeOwner {
  readonly call: { orchestrationRuntime(method: string, payload: unknown): Promise<unknown> };
}
/**
 * Async port of the orchestration runtime storage. Given the Server core owner,
 * every command runs on the owner connection in FIFO order with the other
 * owner domains (Headless). Given a file path, a standalone child Worker
 * borrows the existing WAL database, never imports/migrates it, and must drain
 * before that owner releases its fence (tests and file-backed compositions).
 */
export class OrchestrationRuntimeWorker implements OrchestrationRuntimeStorage {
  private readonly worker?: Worker;
  private readonly owner?: OrchestrationRuntimeOwner;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly ready: Promise<void>;
  private failure?: Error;
  private closing?: Promise<void>;
  private stopping = false;
  private nextId = 0;
  constructor(source: string | OrchestrationRuntimeOwner) {
    if (typeof source !== 'string') {
      this.owner = source;
      this.ready = Promise.resolve();
      return;
    }
    const path = source;
    const worker = this.worker = new Worker(new URL('./orchestration-runtime-worker.mjs', import.meta.url), {workerData:{path,extensionModule:communicationExtensionModule()},execArgv:[]});
    this.ready = new Promise<void>((resolve,reject)=>{
      const failed=(error:Error)=>{this.failure??=error;reject(error);for(const request of this.pending.values())request.reject(error);this.pending.clear();};
      worker.on('error',failed);
      worker.on('exit',code=>{if(!this.stopping||code!==0||this.pending.size)failed(new Error('Orchestration storage worker exited'));});
      worker.on('message',packet=>{
        if(packet.type==='ready'){resolve();return;}
        const request=this.pending.get(packet.id);if(!request)return;this.pending.delete(packet.id);
        if(packet.error)request.reject(domainError(packet.error));
        else request.resolve(packet.result);
      });
    });
    void this.ready.catch(()=>{});
  }
  start(): Promise<void> { return this.ready; }
  inheritChildCreator(parent:ConversationRef,child:ConversationRef):Promise<ThreadAccessPolicy>{
    return this.request('inheritChildCreator',{parent,child});
  }
  claimTitleWrite(operationId:string):Promise<boolean>{return this.request('claimTitleWrite',{operationId});}
  finishTitleWrite(toolCallKey:string,result:unknown):Promise<void>{return this.request('finishTitleWrite',{toolCallKey,result});}
  private async request<T>(method: string, payload: unknown = {}, closing = false): Promise<T> {
    if(this.stopping&&!closing)throw new Error('Orchestration storage is closing');
    await this.ready;if(this.failure)throw this.failure;
    if((this.owner?this.inFlight.size:this.pending.size)>=(this.owner?256:128)&&!closing)throw new Error('Orchestration storage queue is full');
    if(this.owner){
      // The owner reply arrives after its transaction committed (or rolled back).
      const call=this.owner.call.orchestrationRuntime(method,payload).catch(error=>{throw domainError(error);});
      this.inFlight.add(call);void call.catch(()=>{}).finally(()=>this.inFlight.delete(call));
      return call as Promise<T>;
    }
    const id=++this.nextId;
    return new Promise<T>((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.worker!.postMessage({id,method,payload});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  automation<T = any>(operation: string, input: unknown, now: number): Promise<T> {return this.request('automation',{operation,input,now});}
  observe(snapshot:ThreadOrchestrationSnapshot,now:number):Promise<void>{return this.request('observe',{snapshot,now});}
  targets(includeTerminal:boolean,now:number):Promise<string[]>{return this.request('targets',{includeTerminal,now});}
  work(now:number):Promise<{waits:WaitTicket[];notifications:ParentNotification[]}>{return this.request('work',{now});}
  pendingAcks():Promise<string[]>{return this.request('pendingAcks');}
  acknowledge(operationId:string):Promise<void>{return this.request('acknowledge',{operationId});}
  recordAssistantThreadAllocation(value:import('./assistant-thread-store.js').AssistantThreadAllocation):Promise<any>{return this.request('assistantAllocation',value);}
  assistantAdmissions():Promise<any[]>{return this.request('assistantAdmissions');}
  admission(threadId:string,inputId:string):Promise<Record<string,unknown>|null>{return this.request('admission',{threadId,inputId});}
  executionAuthority(threadId:string,execution:{inputId?:string;turnId?:string}):Promise<Record<string,unknown>|null>{return this.request('executionAuthority',{threadId,execution});}
  updateExecution(value:ExecutionRequestState):Promise<void>{return this.request('updateExecution',value);}
  personalAssistantAssignments(after:string):Promise<ReturnType<import('./personal-assistants.js').PersonalAssistants['assignments']>>{return this.request('personalAssistantAssignments',{after});}
  synchronizeChannels(command:ChannelSyncCommand):Promise<ChannelSyncResult>{return this.request('channelSync',command);}
  communicate(command: CommunicationCommand): Promise<CommunicationResult> { return this.request('communication',command); }
  close():Promise<void>{
    return this.closing??=(async()=>{
      this.stopping=true;
      // The owner belongs to its composition: drain this port's calls, never close the owner.
      if(this.owner){await Promise.allSettled([...this.inFlight]);return;}
      try{await this.request('close',{},true);}finally{await this.worker!.terminate();}
    })();
  }
}
/** Rebuilds the automation error class callers match; other failures keep message and code. */
function domainError(error: {message?: string; code?: unknown; status?: unknown}): Error {
  if(typeof error.status==='number'&&typeof error.code==='string')return new AutomationError(error.code,error.status);
  if(error instanceof Error)return error;
  return Object.assign(new Error(error.message),{code:error.code});
}
