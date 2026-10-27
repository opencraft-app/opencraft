import { Worker } from "node:worker_threads";
import type { UsageSubmission, UsageTurnKey } from "./token-usage-ledger.js";

export type UsageWrite =
  | { kind:"attempt"; attemptId:string; input:UsageSubmission }
  | { kind:"outcome"; attemptId:string; outcome:"accepted"|"rejected"|"unknown"; turnId:string|null }
  | { kind:"admission"; key:UsageTurnKey; inputId:string; startedAt:number|null; trusted:UsageSubmission|null }
  | { kind:"submission"; input:UsageSubmission };

/** Same physical Host and source store, with durable commits off its RPC loop.
 * Only trusted accounting metadata crosses this port, never native input. */
export class TokenUsageAttemptWriter {
  private worker: Worker | null = null;
  private sequence = 0;
  private closed = false;
  private closing = false;
  private readonly pending = new Map<number, { resolve(value:string|null): void; reject(error: Error): void }>();
  constructor(private readonly options: { entry: string; directory: string; serverId: string; projectLegacy?:boolean }) {}
  record(attemptId:string,input:UsageSubmission):Promise<void> {
    return this.write({kind:"attempt",attemptId,input:this.metadata(input)}).then(()=>{});
  }
  outcome(attemptId:string,outcome:"accepted"|"rejected"|"unknown",turnId:string|null):Promise<string|null> {
    return this.write({kind:"outcome",attemptId,outcome,turnId});
  }
  admit(key:UsageTurnKey,inputId:string,startedAt:number|null,trusted:UsageSubmission|null):Promise<void> {
    return this.write({kind:"admission",key:{...key},inputId,startedAt,trusted:trusted?this.metadata(trusted):null}).then(()=>{});
  }
  submission(input:UsageSubmission):Promise<void> {return this.write({kind:"submission",input:this.metadata(input)}).then(()=>{});}
  private metadata(input:UsageSubmission):UsageSubmission {
    return {threadId:input.threadId,inputId:input.inputId,actorId:input.actorId,actorKind:input.actorKind,
      sourceKind:input.sourceKind,mode:input.mode,submittedAt:input.submittedAt};
  }
  private write(operation:UsageWrite):Promise<string|null> {
    if(this.closed||(this.closing&&operation.kind!=="outcome"&&operation.kind!=="admission")||this.pending.size>=10000)return Promise.reject(new Error("Usage writer unavailable"));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      try{const worker=this.start();this.pending.set(id,{resolve,reject});worker.ref();worker.postMessage({id,operation,deadline:Date.now()+1500});}
      catch{this.pending.delete(id);reject(new Error("Usage writer unavailable"));}
    });
  }
  private start(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(`const {workerData}=require('node:worker_threads');
      if(workerData.entry.endsWith('.ts')){require('tsx/cjs');require(workerData.entry);}
      else import(require('node:url').pathToFileURL(workerData.entry).href).catch(()=>process.exit(1));`,
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
        workerData: { ...this.options, role: "attempt-writer" } });
    this.worker = worker;
    worker.on("message", message => {
      if (this.worker !== worker) return;
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error("Usage write unavailable")); else request.resolve(message.result??null);
      if (!this.pending.size) worker.unref();
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(new Error("Usage writer unavailable"));
      this.pending.clear(); void worker.terminate();
    };
    worker.on("error", fail); worker.on("exit", fail); worker.unref();
    return worker;
  }
  async close(): Promise<void> {
    this.closing = true;
    // Submitted jobs have bounded retries in the owner. Keep their promises
    // live until acknowledged, including during shutdown.
    for(;;){
      while(this.pending.size)await new Promise(resolve=>setTimeout(resolve,5));
      await new Promise(resolve=>setImmediate(resolve));
      if(!this.pending.size)break;
    }
    this.closed=true;
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate();
  }
}
