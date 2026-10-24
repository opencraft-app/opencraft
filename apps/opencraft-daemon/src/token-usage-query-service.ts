import { TokenUsageTelemetry } from "./token-usage-telemetry.js";
import { Worker } from "node:worker_threads";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { TokenUsageQueryError, type TokenUsageAuthority } from "./token-usage-query.js";
import type { TokenUsageSnapshot } from "@opencraft/appserver-protocol/token-usage";
/** One bounded read worker per physical Host. All SQLite scans and BigInt
 * reductions stay off the execution loop; ingress owns current authorization. */
export class TokenUsageQueryService {
  private worker: Worker|null=null;
  private readonly secret=randomBytes(32);
  private sequence=0;
  private closed=false;
  private waiters=0;
  private readonly inFlight=new Map<string,Promise<TokenUsageSnapshot>>();
  private readonly pending=new Map<number,{resolve:(value:TokenUsageSnapshot)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private readonly options:{entry:string;databasePath:string;serverId:string;telemetry?:TokenUsageTelemetry}) {}
  private start():Worker {
    if(this.worker)return this.worker;
    const worker=new Worker(`const {workerData}=require('node:worker_threads');
      if(workerData.entry.endsWith('.ts')) {require('tsx/cjs');require(workerData.entry);}
      else {import(require('node:url').pathToFileURL(workerData.entry).href).catch(()=>process.exit(1));}`,
      {eval:true,resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:4},workerData:{entry:this.options.entry,databasePath:this.options.databasePath,serverId:this.options.serverId,timezone:"Asia/Shanghai",secret:this.secret}});
    this.worker=worker;
    worker.on("message",message=>{
      if(this.worker!==worker)return;
      const request=this.pending.get(message.id);if(!request)return;
      this.pending.delete(message.id);clearTimeout(request.timer);if(!this.pending.size)worker.unref();
      if(message.error)request.reject(["unauthorized","forbidden","invalid-query","stale-snapshot"].includes(message.error)?new TokenUsageQueryError(message.error):new Error("Usage query unavailable"));
      else request.resolve(message.result);
    });
    worker.on("error",()=>this.fail(worker));worker.on("exit",()=>this.fail(worker));worker.unref();
    return worker;
  }
  private fail(worker:Worker|null){
    if(this.worker!==worker)return;
    this.worker=null;
    for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error("Usage query unavailable"));}this.pending.clear();
    if(worker)void worker.terminate();
  }
  private request(params:unknown,authority:TokenUsageAuthority):Promise<TokenUsageSnapshot>{
    const worker=this.start(),id=++this.sequence;
    return new Promise<TokenUsageSnapshot>((resolve,reject)=>{
      // Timeout terminates the running scan and its queued work, preventing
      // hidden backlog. The next request can lazily open a new read worker.
      const timer=setTimeout(()=>this.fail(worker),1500);timer.unref();
      worker.ref();this.pending.set(id,{resolve,reject,timer});
      try{worker.postMessage({id,params,authority});}catch{this.fail(worker);}
    });
  }
  async read(params:unknown,authorize:()=>TokenUsageAuthority|null):Promise<TokenUsageSnapshot>{
    const before=authorize();if(!before)throw new TokenUsageQueryError("unauthorized");
    if(this.closed||this.waiters>=1024)throw new Error("Usage query busy");
    // Concurrent requests for the same authorized scope and filter may
    // share an immutable read snapshot. Each caller still reauthorizes;
    // no completed result is retained across later revisions or callers.
    const canonical=params&&typeof params==="object"&&!Array.isArray(params)?Object.fromEntries(Object.entries(params).sort(([a],[b])=>a.localeCompare(b))):params;
    const team=params&&typeof params==="object"&&!Array.isArray(params)&&(params as Record<string,unknown>).scope==="team"&&(params as Record<string,unknown>).cursor===undefined&&before.administrator;
    const key=JSON.stringify([team?"instance-team-administrators":before.actorId,before.administrator,canonical]);
    let shared=this.inFlight.get(key);
    if(!shared){
      if(this.pending.size>=16)throw new Error("Usage query busy");
      shared=this.request(params,before);this.inFlight.set(key,shared);
      const retire=()=>{if(this.inFlight.get(key)===shared)this.inFlight.delete(key);};
      void shared.then(retire,retire);
    }
    this.waiters++;
    const started=performance.now();let success=false;
    try{
      const result=await shared;
      const after=authorize();if(!after)throw new TokenUsageQueryError("unauthorized");
      if(after.actorId!==before.actorId||after.administrator!==before.administrator)throw new TokenUsageQueryError("forbidden");
      const response=structuredClone(result);
      if(team&&response.nextCursor){
        // Authorized team readers share facts, but cursors retain each caller's
        // identity. Never coalesce caller-supplied cursors across principals.
        const [payload,signature,...rest]=response.nextCursor.split(".");
        if(!payload||!signature||rest.length)throw new Error("Invalid query cursor");
        const expected=createHmac("sha256",this.secret).update(payload).digest(),actual=Buffer.from(signature,"base64url");
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new Error("Invalid query cursor");
        const decoded=JSON.parse(Buffer.from(payload,"base64url").toString()),binding=JSON.parse(decoded[0]);
        if(binding[0]!==this.options.serverId||binding[2]!==true||binding[3]!=="team")throw new Error("Invalid team cursor");
        binding[1]=before.actorId;decoded[0]=JSON.stringify(binding);
        const rebound=Buffer.from(JSON.stringify(decoded)).toString("base64url");
        response.nextCursor=rebound+"."+createHmac("sha256",this.secret).update(rebound).digest("base64url");
      }
      success=true;
      this.options.telemetry?.latency("query",performance.now()-started,true);
      if(after.administrator&&this.options.telemetry)response.diagnostics=this.options.telemetry.snapshot();
      return response;
    }finally{this.waiters--;if(!success)this.options.telemetry?.latency("query",performance.now()-started,false);}
  }
  close(){this.closed=true;this.fail(this.worker);}
}
