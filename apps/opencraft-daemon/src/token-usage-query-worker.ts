import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { TokenUsageQuery, TokenUsageQueryError, type TokenUsageAuthority } from "./token-usage-query.js";
import { RolloutDerivedTokenUsage } from "./token-usage-derived.js";
// The Host opens/migrates the file first. This projection worker never migrates,
// creates files or writes facts; it owns and closes only its read-only handle.
const derived=workerData.rollout ? new RolloutDerivedTokenUsage({databasePath:workerData.databasePath,serverId:workerData.serverId,...workerData.rollout}) : null;
const database=derived?.database??new DatabaseSync(workerData.databasePath,{readOnly:true});
if(!derived)database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
const query=new TokenUsageQuery({database},workerData.serverId,workerData.timezone,Date.now,workerData.secret);
let closed=false,working=false,timer:ReturnType<typeof setTimeout>|null=null;
parentPort!.postMessage({ready:true});
async function refresh(){
  if(!derived||closed||working)return;
  working=true;
  let more=false;
  try{more=await derived.step();}catch{try{derived.fault();}catch{/* committed evidence stays readable */}}
  finally{working=false;if(!closed)timer=setTimeout(()=>void refresh(),more?0:1000);}
}
if(derived){void derived.discover().then(()=>refresh()).catch(()=>refresh());}
parentPort!.on("message",async(message:{id:number;params:unknown;authority:TokenUsageAuthority;invalidate?:string;path?:string})=>{
  if(message.invalidate){derived?.invalidate(message.invalidate,message.path);if(timer)clearTimeout(timer);void refresh();return;}
  try {
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
