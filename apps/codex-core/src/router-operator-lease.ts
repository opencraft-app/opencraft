import {Worker} from "node:worker_threads";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import type {OperatorLeaseClaim,OperatorLeaseEnd} from "./operator-lease.js";

/** Router maintenance checks live process identity in an owned Worker, including renewals. */
export class RouterOperatorLease {
  readonly claim: OperatorLeaseClaim;
  private sequence=0;
  private failure?: Error;
  private endedReason?: OperatorLeaseEnd;
  private remaining=0;
  private observedAt=performance.now();
  private expire?: (reason:OperatorLeaseEnd)=>void|Promise<void>;
  private failed?:()=>void;
  private readonly pending=new Map<number,{resolve(value:any):void;reject(error:Error):void}>();
  private constructor(private readonly worker:Worker,claim:OperatorLeaseClaim){
    this.claim=claim;
    worker.on("error",error=>this.fail(error));worker.on("exit",()=>this.fail(new Error("Router operator Worker exited")));
    worker.on("message",message=>{
      if(message.ended){this.endedReason=message.ended;void Promise.resolve(this.expire?.(message.ended)).catch(()=>this.failed?.());return;}
      const call=this.pending.get(message.id);if(!call)return;this.pending.delete(message.id);
      if(message.error)call.reject(new Error(message.error.message));
      else {if(message.status){this.remaining=message.status.remainingMs;this.observedAt=performance.now();this.endedReason=message.status.ended;}call.resolve(message.result);}
    });
  }
  static async open(claim:OperatorLeaseClaim|undefined,terminated:readonly string[]=[]):Promise<RouterOperatorLease>{
    const ownFile=typeof __filename==="string"?__filename:fileURLToPath(import.meta.url);
    const worker=new Worker(join(dirname(ownFile),"generation-registry-worker.mjs"),{workerData:{operator:true},execArgv:[]});
    const port=new RouterOperatorLease(worker,claim!);
    try{const result=await port.call("create",[claim,terminated]);Object.assign(port,{claim:result});return port;}catch(error){await worker.terminate();throw error;}
  }
  private fail(error:Error){this.failure??=error;for(const call of this.pending.values())call.reject(this.failure);this.pending.clear();this.failed?.();}
  private call(method:string,args:unknown[]=[]):Promise<any>{if(this.failure)return Promise.reject(this.failure);const id=++this.sequence;return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});try{this.worker.postMessage({id,method,args});}catch(error){this.pending.delete(id);reject(error);}});}
  ended():Promise<OperatorLeaseEnd|undefined>{return this.call("ended");}
  async assertLive():Promise<void>{await this.call("assertLive");}
  async renew(input:OperatorLeaseClaim|undefined):Promise<void>{await this.call("renew",[input]);}
  status(){return{id:this.claim.id,remainingMs:Math.max(0,Math.ceil(this.remaining-(performance.now()-this.observedAt))),ended:this.endedReason};}
  async start(expire:(reason:OperatorLeaseEnd)=>void|Promise<void>,failed:()=>void){this.expire=expire;this.failed=failed;await this.call("start");}
  async dispose():Promise<void>{this.failed=undefined;await this.worker.terminate();}
}
