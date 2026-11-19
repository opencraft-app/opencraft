import { REGISTRY_WRITES, RegistryOperationRejected } from "./generation-registry-protocol.js";
import { checkDatabases } from "./generation-home-integrity.js";
import { generationDirectory } from "./generation-files.js";
import { OperatorLease } from "./operator-lease.js";
import { parentPort, workerData } from "node:worker_threads";
import { readRouterMaintenance, verifyRouterController, verifyRouterConsumers } from "./router-maintenance.js";
import { CodexGenerationRegistry, inspectGenerationRegistry } from "./generation-registry.js";
import type { RegistryProjectionMessage } from "./generation-registry-worker.js";
if (workerData.operator) {
  let operator: OperatorLease | undefined;
  parentPort!.on("message",({id,method,args})=>{
    try {
      let result: unknown;
      if(method === "create"){operator=new OperatorLease(args[0],args[1]);result=operator.claim;}
      else if(!operator)throw new Error("Router operator lease is not initialized");
      else if(method === "start"){let sent=false;operator.start(reason=>{if(!sent){sent=true;parentPort!.postMessage({ended:reason});}},()=>parentPort!.postMessage({ended:"operator-exited"}));}
      else if(method === "renew")operator.renew(args[0]);
      else if(method === "assertLive")operator.assertLive();
      else if(method === "ended")result=operator.ended();
      else throw new Error("Unknown operator operation");
      parentPort!.postMessage({id,result,status:operator?.status()});
    }catch(error){parentPort!.postMessage({id,error:{message:(error as Error).message}});}
  });
} else if (workerData.task) {
  try {
    const {method,args} = workerData.task;
    let result: unknown;
    if (method === "check-databases") result = await checkDatabases(args[0]);
    else if (method === "create-directory") result = generationDirectory(args[0], args[1], args[2]);
    else if (method === "inspect") result = inspectGenerationRegistry(args[0]);
    else if (method === "read-maintenance") result = Reflect.apply(readRouterMaintenance, undefined, args);
    else if (method === "verify-maintenance") { verifyRouterController(args[0]); verifyRouterConsumers(args[0].consumers,args[0].systemdScope); }
    else throw new Error("Unknown router storage task");
    parentPort!.postMessage({result});
  } catch (error) { parentPort!.postMessage({error:{message:(error as Error).message}}); }
  parentPort!.close();
} else {
const registry = new CodexGenerationRegistry(workerData.directory);
const operations = new Set<string>(REGISTRY_WRITES);
let failed = false;
let previousMetadata: Record<string, string> = {};
let revision = 0;
function projection(metadataOnly = false): RegistryProjectionMessage {
  const current = registry.projection(metadataOnly), changed: Record<string, string> = {};
  for (const [key, value] of Object.entries(current.metadata)) {
    if (!Object.hasOwn(previousMetadata, key) || previousMetadata[key] !== value) {
      // Validate before ACK. A malformed stored value must fence the writer,
      // even when nobody has requested that particular historical key yet.
      JSON.parse(value);
      Object.defineProperty(changed, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  const removedMetadata = Object.keys(previousMetadata).filter(key => !Object.hasOwn(current.metadata, key));
  const message = { ...current, metadata: changed, removedMetadata, baseRevision: revision, revision: revision + 1 };
  previousMetadata = current.metadata; revision++;
  return message;
}
// Each message is synchronous here: mutation, commit and its projection precede acknowledgement.
parentPort!.on("message", ({id,method,args}: {id:number;method:string;args:unknown[]}) => {
  try {
    if (failed) throw new Error("Generation storage is fenced after an unconfirmed effect");
    if (method === "initialize") { parentPort!.postMessage({id,projection:projection()}); return; }
    if (!operations.has(method)) throw new RegistryOperationRejected("Unknown generation storage operation", "REGISTRY_OPERATION_REJECTED");
    const result = Reflect.apply(Reflect.get(registry,method),registry,args);
    parentPort!.postMessage({id,result,...(method === "close" || method === "coldSnapshot" ? {} : {projection:projection(["setMetadata", "updateMetadata", "markNonpersistent", "compareMetadata", "selectRetention"].includes(method))})});
    if (method === "close") parentPort!.close();
  } catch (error) {
    const value=error as Error & {code?:string};
    // Only an explicitly classified, effect-free rejection (or confirmed rollback)
    // can keep the writer open. SQL, integrity and post-commit projection failures
    // are unknown effects: fence the port, reject all waiters and release both handles.
    if (error instanceof RegistryOperationRejected) {
      parentPort!.postMessage({id,error:{message:value.message,code:value.code}});
      return;
    }
    failed = true;
    // Release storage before the fatal acknowledgement: a consumer may close
    // and terminate this Worker immediately after its pending call rejects.
    try { registry.close(); } catch { /* Retain the original unknown-effect failure. */ }
    try { parentPort!.postMessage({id,fatal:true,error:{message:value.message,code:value.code}}); }
    finally { process.exitCode=1; parentPort!.close(); }
  }
});

}
