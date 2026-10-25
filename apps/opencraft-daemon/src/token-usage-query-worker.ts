import { runTokenUsageAttemptWorker } from "./token-usage-attempt-worker.js";
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { TokenUsageQuery, TokenUsageQueryError, type TokenUsageAuthority } from "./token-usage-query.js";
import { RolloutDerivedTokenUsage } from "./token-usage-derived.js";
import { CodexCoreControlClient } from "@opencraft/account-pool-host";
import { CodexNativeStorage } from "./codex-native-storage.js";
if(workerData.role==="attempt-writer")runTokenUsageAttemptWorker();
else {
// The Host opens/migrates the file first. This projection worker never migrates,
// creates files or writes facts; it owns and closes only its read-only handle.
const storage=workerData.rollout ? new CodexNativeStorage(workerData.rollout.coreEndpoint
  ? new CodexCoreControlClient(workerData.rollout.coreEndpoint,workerData.rollout.coreAuthToken??"") : null,()=>workerData.rollout.nativeHome) : null;
const derived=workerData.rollout ? new RolloutDerivedTokenUsage({databasePath:workerData.databasePath,serverId:workerData.serverId,...workerData.rollout,
  nativeHomes:()=>storage!.homes(),resolveSource:(threadId,path)=>storage!.resolve(threadId,path,true)}) : null;
const database=derived?.database??new DatabaseSync(workerData.databasePath,{readOnly:true});
if(!derived)database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
const query=new TokenUsageQuery({database},workerData.serverId,workerData.timezone,Date.now,workerData.secret);
let closed=false,working=false,discovered=false,timer:ReturnType<typeof setTimeout>|null=null;
parentPort!.postMessage({ready:true});
async function refresh(){
  if(!derived||closed||working)return;
  working=true;
  let more=false;
  try{if(!discovered){await derived.discover();discovered=true;}more=await derived.step();}catch{try{derived.fault();}catch{/* committed evidence stays readable */}}
  finally{working=false;if(!closed)timer=setTimeout(()=>void refresh(),more?0:1000);}
}
if(derived)void refresh();
parentPort!.on("message",async(message:{id:number;params:unknown;authority:TokenUsageAuthority;invalidate?:string;path?:string})=>{
  if(message.invalidate){derived?.invalidate(message.invalidate,message.path);if(timer)clearTimeout(timer);void refresh();return;}
  try {
    // An unavailable directory must not turn a missing HOME into a complete zero.
    if(workerData.rollout?.coreEndpoint)await storage!.homes();
    if(derived&&!derived.queryReady()){
      const until=performance.now()+1000;
      while(!derived.queryReady()&&performance.now()<until&&!closed)await new Promise(resolve=>setTimeout(resolve,10));
      if(!derived.queryReady()||closed)throw new Error("Usage cache warming");
    }
    parentPort!.postMessage({id:message.id,result:query.read(message.params,()=>message.authority)});
  }
  catch(error){parentPort!.postMessage({id:message.id,error:error instanceof TokenUsageQueryError?error.code:"unavailable"});}
});
parentPort!.on("close",()=>{closed=true;if(timer)clearTimeout(timer);if(derived)derived.close();else database.close();});

}
