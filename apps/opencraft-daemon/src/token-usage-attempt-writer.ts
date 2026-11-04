import { Worker } from "node:worker_threads";
import type { UsageRuntimePort, UsageCollectorPort } from "./token-usage-runtime.js";
import type { NativeRolloutSource } from "@opencraft/native-history-node/codex-rollout-reader";
import type { UsageSubmission, UsageTurnKey } from "./token-usage-ledger.js";

export type UsageWrite =
  | { kind:"attempt"; attemptId:string; input:UsageSubmission }
  | { kind:"outcome"; attemptId:string; outcome:"accepted"|"rejected"|"unknown"; turnId:string|null }
  | { kind:"admission"; key:UsageTurnKey; inputId:string; startedAt:number|null; trusted:UsageSubmission|null }
  | { kind:"submission"; input:UsageSubmission }
  | { kind:"configure"; enabled:boolean };

/** Same physical Host and source store, with durable commits off its RPC loop.
 * Only trusted accounting metadata crosses this port, never native input. */
export class TokenUsageAttemptWriter implements UsageCollectorPort {
  private collectorPort: UsageRuntimePort|null=null;
  private gaps=0;
  private initialized:unknown[]|null=null;
  private readonly sources=new Map<string,NativeRolloutSource>();
  private sourceSequence=0;
  private readonly sourceByThread=new Map<string,string>();
  configureCollector(port:UsageRuntimePort):void {this.collectorPort=port;}
  liveGapCount():number{return this.gaps;}
  send(method:Parameters<UsageCollectorPort["send"]>[0],...args:unknown[]):void {
    if(this.closed||this.closing)return;
    if(method==="initialize")this.initialized=args;
    try{this.start().postMessage({control:method,args});}catch{this.collectorPort?.diagnostic("collector-unavailable");}
  }
  async setEnabled(enabled:boolean):Promise<void>{await this.write({kind:"configure",enabled});}
  private async bridge(message:{rpc:number;method:string;args:any[]}):Promise<void>{
    const worker=this.worker,port=this.collectorPort;if(!worker||!port)return;
    try{
      const [a,b]=message.args;let result:unknown;
      if(message.method==="request"){
        if(a!=="thread/read"&&a!=="thread/turns/list")throw new Error("Invalid collector request");
        result=await port.request(a,a==="thread/read"?{threadId:b.threadId,includeTurns:false}:
          {threadId:b.threadId,limit:100,itemsView:"notLoaded",sortDirection:"desc",...(b.cursor?{cursor:b.cursor}:{})});
      }else if(message.method==="submissions"){
        if(!Array.isArray(b)||b.length>32)throw new Error("Invalid receipt batch");
        result=b.map(inputId=>port.submission?.(a,inputId)??null);
      }else if(message.method==="source"){
        const source=await port.source!(a,b),key=String(++this.sourceSequence);
        const old=this.sourceByThread.get(a);if(old)this.sources.delete(old);
        if(this.sources.size>=256){const thread=this.sourceByThread.keys().next().value!;this.sources.delete(this.sourceByThread.get(thread)!);this.sourceByThread.delete(thread);}
        this.sources.set(key,source);this.sourceByThread.set(a,key);result={nativeHome:source.nativeHome,key:source.key,handle:key};
      }else if(message.method==="validate"){const source=this.sources.get(a);if(!source)throw new Error("Expired source");await source.validate();}
      else throw new Error("Invalid collector bridge");
      if(this.worker===worker)worker.postMessage({rpcResult:message.rpc,result});
    }catch{if(this.worker===worker)worker.postMessage({rpcResult:message.rpc,error:true});}
  }
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
      { eval: true, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 8 },
        workerData: { ...this.options, role: "attempt-writer", collector:!!this.collectorPort, derived:!!this.collectorPort?.derived, source:!!this.collectorPort?.source, submissions:!!this.collectorPort?.submission } });
    this.worker = worker;
    if(this.initialized)worker.postMessage({control:"initialize",args:this.initialized});
    worker.on("message", message => {
      if (this.worker !== worker) return;
      if(message.event==="telemetry"){this.collectorPort?.telemetry?.mergeBatch(message.batch);return;}
      if(message.rpc){void this.bridge(message);return;}
      if(message.event==="gap-count"){this.gaps=message.count;return;}
      if(message.event==="diagnostic"){this.collectorPort?.diagnostic(message.category);return;}
      if(message.event==="invalidate"){this.collectorPort?.derived?.invalidate(message.threadId,message.path);return;}
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error("Usage write unavailable")); else request.resolve(message.result??null);
      if (!this.pending.size) worker.unref();
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = null;
      if(this.collectorPort){this.gaps++;this.collectorPort.diagnostic("collector-unavailable");}
      this.sources.clear();this.sourceByThread.clear();
      for (const request of this.pending.values()) request.reject(new Error("Usage writer unavailable"));
      this.pending.clear(); void worker.terminate();
    };
    worker.on("error", fail); worker.on("exit", fail); worker.unref();
    return worker;
  }
  async close(): Promise<void> {
    if(this.worker)this.worker.postMessage({control:"stop",args:[]});
    this.closing = true;
    // Submitted jobs have bounded retries in the owner. Keep their promises
    // live until acknowledged, including during shutdown.
    for(;;){
      while(this.pending.size)await new Promise(resolve=>setTimeout(resolve,5));
      await new Promise(resolve=>setImmediate(resolve));
      if(!this.pending.size)break;
    }
    // Stop aborts replay and then acknowledges only after its in-flight I/O
    // settles. No transaction/cursor is abandoned by terminate().
    if(this.worker)await new Promise<void>(resolve=>{
      const worker=this.worker!;worker.ref();const done=(message:any)=>{if(message.event==="stopped"){worker.off("message",done);resolve();}};
      worker.on("message",done);worker.once("exit",()=>{worker.off("message",done);resolve();});
      worker.postMessage({control:"stop",args:[]});
    });
    this.sources.clear();this.sourceByThread.clear();
    this.closed=true;
    const worker = this.worker; this.worker = null;
    if (worker) await worker.terminate();
  }
}
