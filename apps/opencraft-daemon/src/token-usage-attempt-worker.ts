import { TokenUsageTelemetry } from "./token-usage-telemetry.js";
import { nativeLiveAcceptedInputFact } from "./token-usage-native-facts.js";
import { CodexTokenUsageRuntime } from "./token-usage-runtime.js";
import { parentPort, workerData } from "node:worker_threads";
import { TokenUsageStateDatabase } from "./token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "./token-usage-ledger.js";

import type { UsageWrite } from "./token-usage-attempt-writer.js";

export function runTokenUsageAttemptWorker(): void {
  // The Host already migrated and recovered this store. Opening another
  // connection must not classify this same owner's in-flight attempts as lost.
  const state = new TokenUsageStateDatabase(workerData.directory);
  const telemetry=new TokenUsageTelemetry();
  const ledger = new OpenCraftTokenUsageLedger(state, workerData.serverId, Date.now, telemetry, { recoverPendingAttempts: false,projectLegacy:workerData.projectLegacy });
  const queue: Array<{ id: number; operation: UsageWrite;deadline:number }> = [];
  let working = false;
  let stopping=false;
  let sequence=0;
  const pending=new Map<number,{resolve(value:any):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  function rpc(method:string,...args:unknown[]):Promise<any>{
    if(stopping)return Promise.reject(new Error("Collector stopped"));
    const id=++sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error("Collector bridge timed out"));},5500);
      pending.set(id,{resolve,reject,timer});parentPort!.postMessage({rpc:id,method,args});
    });
  }
  const beforeBackground=async()=>{
    // Give already-posted foreground commits a turn before every replay batch.
    await new Promise(resolve=>setImmediate(resolve));
    while(working||queue.length)await new Promise(resolve=>setTimeout(resolve,1));
  };
  const runtime=workerData.collector?new CodexTokenUsageRuntime(ledger,{
    request:(method,params)=>rpc("request",method,params),
    submissions:workerData.submissions?(threadId,inputIds)=>rpc("submissions",threadId,inputIds):undefined,
    source:workerData.source?async(threadId,path)=>{
      const source=await rpc("source",threadId,path);
      return {nativeHome:source.nativeHome,key:source.key,validate:()=>rpc("validate",source.handle)};
    }:undefined,
    diagnostic:category=>parentPort!.postMessage({event:"diagnostic",category}),
    derived:workerData.derived?{invalidate:(threadId,path)=>parentPort!.postMessage({event:"invalidate",threadId,path})}:undefined,
    beforeBackground,
  }):null;
  const report=()=>{
    parentPort!.postMessage({event:"gap-count",count:runtime?.liveGapCount()??0});
    const batch=telemetry.takeBatch();if(batch)parentPort!.postMessage({event:"telemetry",batch});
  };
  const status=setInterval(report,1000);status.unref();
  const controls:Array<{control:string;args:unknown[]}>=[];
  let controlling=false;
  async function drainControls(){
    if(controlling)return;controlling=true;
    try{while(controls.length&&!stopping){await beforeBackground();if(stopping)break;const message=controls.shift()!;
      try{
        if(message.control==="notification"&&workerData.submissions){
          const fact=nativeLiveAcceptedInputFact(message.args[0] as string,message.args[1]);
          if(fact){const [trusted]=await rpc("submissions",fact.threadId,[fact.inputId]);if(trusted)ledger.recoverSubmission(trusted);}
        }
        if(!stopping)runtime?.control(message.control,message.args);
      }catch{parentPort!.postMessage({event:"diagnostic",category:"collector-control"});}
      parentPort!.postMessage({event:"gap-count",count:runtime?.liveGapCount()??0});}}
    finally{controlling=false;}
  }
  async function stop(){
    stopping=true;clearInterval(status);controls.length=0;runtime?.close();
    for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error("Collector stopped"));}pending.clear();
    await runtime?.settled();
    report();parentPort!.postMessage({event:"stopped"});
  }
  async function drain() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const message = queue.shift()!, until = message.deadline;
        let error = false,result:string|null=null;
        for (;;) {
          if(Date.now()>=until){error=true;break;}
          try {
            const work=message.operation;
            if(work.kind==="configure")ledger.setEnabled(work.enabled);
            else if(work.kind==="attempt")ledger.recordAttempt(work.attemptId,work.input);
            else if(work.kind==="outcome")result=ledger.recordAttemptOutcome(work.attemptId,work.outcome,work.turnId);
            else if(work.kind==="submission")ledger.recordSubmission(work.input);
            else ledger.commitReplayBatch(()=>{
              if(work.startedAt!==null)ledger.startTurn(work.key,work.startedAt,"unknown");
              if(work.trusted)ledger.recoverSubmission(work.trusted);
              ledger.recordAdmission(work.key,work.inputId);
            });
            break;
          }
          catch (failure) {
            const code = (failure as { errcode?: number }).errcode;
            if ((code !== 5 && code !== 6) || Date.now() >= until) { error = true; break; }
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
        parentPort!.postMessage({ id: message.id, error, result });
        await new Promise(resolve=>setImmediate(resolve));
      }
    } finally { working = false; }
  }
  parentPort!.on("message", message => {
    if(message.rpcResult){const request=pending.get(message.rpcResult);if(!request)return;pending.delete(message.rpcResult);clearTimeout(request.timer);if(message.error)request.reject(new Error("Collector bridge unavailable"));else request.resolve(message.result);return;}
    if(message.control==="stop"){void stop();return;}
    if(message.control){
      if(!stopping){
        if(controls.length<2048){controls.push(message);void drainControls();}
        else{parentPort!.postMessage({event:"diagnostic",category:"queue-full"});
          const value=message.args?.[0];const threadId=typeof value==="string"?value:value?.threadId;
          if(typeof threadId==="string")runtime?.control("missing",[threadId,"queue-full"]);
        }
      }return;
    }
    queue.push(message);void drain();
  });
  parentPort!.on("close", () => state.close());
}
