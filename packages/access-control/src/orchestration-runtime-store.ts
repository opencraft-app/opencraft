import { Worker } from 'node:worker_threads';
import type { ThreadOrchestrationSnapshot } from '@opencraft/appserver-protocol/collaboration';
import type { ParentNotification, WaitTicket } from './orchestration-ledger.js';

export interface OrchestrationRuntimeStorage {
  observe(snapshot: ThreadOrchestrationSnapshot, now: number): Promise<void>;
  targets(includeTerminal: boolean, now: number): Promise<string[]>;
  work(now: number): Promise<{ waits: WaitTicket[]; notifications: ParentNotification[] }>;
  pendingAcks(): Promise<string[]>;
  acknowledge(operationId: string): Promise<void>;
}
/** Child of the fenced Server owner. It borrows the existing WAL database, never
 * imports/migrates it, and must drain before that owner releases its fence. */
export class OrchestrationRuntimeWorker implements OrchestrationRuntimeStorage {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private readonly ready: Promise<void>;
  private failure?: Error;
  private closing?: Promise<void>;
  private stopping = false;
  private nextId = 0;
  constructor(path: string) {
    this.worker = new Worker(new URL('./orchestration-runtime-worker.mjs', import.meta.url), {workerData:{path},execArgv:[]});
    this.ready = new Promise<void>((resolve,reject)=>{
      const failed=(error:Error)=>{this.failure??=error;reject(error);for(const request of this.pending.values())request.reject(error);this.pending.clear();};
      this.worker.on('error',failed);
      this.worker.on('exit',code=>{if(!this.stopping||code!==0||this.pending.size)failed(new Error('Orchestration storage worker exited'));});
      this.worker.on('message',packet=>{
        if(packet.type==='ready'){resolve();return;}
        const request=this.pending.get(packet.id);if(!request)return;this.pending.delete(packet.id);
        if(packet.error)request.reject(Object.assign(new Error(packet.error.message),{code:packet.error.code}));
        else request.resolve(packet.result);
      });
    });
    void this.ready.catch(()=>{});
  }
  start(): Promise<void> { return this.ready; }
  private async request<T>(method: string, payload: unknown = {}, closing = false): Promise<T> {
    if(this.stopping&&!closing)throw new Error('Orchestration storage is closing');
    await this.ready;if(this.failure)throw this.failure;
    if(this.pending.size>=128&&!closing)throw new Error('Orchestration storage queue is full');
    const id=++this.nextId;
    return new Promise<T>((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      try{this.worker.postMessage({id,method,payload});}catch(error){this.pending.delete(id);reject(error);}
    });
  }
  observe(snapshot:ThreadOrchestrationSnapshot,now:number):Promise<void>{return this.request('observe',{snapshot,now});}
  targets(includeTerminal:boolean,now:number):Promise<string[]>{return this.request('targets',{includeTerminal,now});}
  work(now:number):Promise<{waits:WaitTicket[];notifications:ParentNotification[]}>{return this.request('work',{now});}
  pendingAcks():Promise<string[]>{return this.request('pendingAcks');}
  acknowledge(operationId:string):Promise<void>{return this.request('acknowledge',{operationId});}
  close():Promise<void>{
    return this.closing??=(async()=>{
      this.stopping=true;
      try{await this.request('close',{},true);}finally{await this.worker.terminate();}
    })();
  }
}
