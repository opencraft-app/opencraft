import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { TokenUsageQuery, TokenUsageQueryError, type TokenUsageAuthority } from "./token-usage-query.js";
// The Host opens/migrates the file first. This projection worker never migrates,
// creates files or writes facts; it owns and closes only its read-only handle.
const database=new DatabaseSync(workerData.databasePath,{readOnly:true});
database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
const query=new TokenUsageQuery({database},workerData.serverId,workerData.timezone,Date.now,workerData.secret);
parentPort!.on("message",(message:{id:number;params:unknown;authority:TokenUsageAuthority})=>{
  try {parentPort!.postMessage({id:message.id,result:query.read(message.params,()=>message.authority)});}
  catch(error){parentPort!.postMessage({id:message.id,error:error instanceof TokenUsageQueryError?error.code:"unavailable"});}
});
parentPort!.on("close",()=>database.close());
