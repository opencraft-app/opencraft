import { parentPort, workerData } from "node:worker_threads";
import { CLOSE_METHOD, serializeError, type OwnerReply, type OwnerRequest } from "./protocol.js";

/** Marks an error after which the owner cannot continue (lost handle, failed
 * recovery). The WorkerOwner rejects the call and fences every later one. */
export class WorkerOwnerFatal extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerOwnerFatal";
  }
}

export interface ServedOwner {
  /** Methods callers may invoke. Anything else is rejected without running. */
  readonly methods: Record<string, (...args: never[]) => unknown>;
  /** Explicit synchronous, non-mutating reads may overtake queued work while
   * an async operation waits. They see committed state, not pending mutations.
   * Every other method retains FIFO. Close drains both lanes. */
  readonly concurrentReads?: readonly string[];
  /** Value returned to `WorkerOwner.open`, such as a database outcome. */
  readonly ready?: unknown;
  /** Releases handles and locks after the last request. */
  close?(): void | Promise<void>;
}

/**
 * Runs inside the Worker. `open` creates the owner from `workerData`; requests
 * normally run in arrival order. Explicit synchronous read lanes may inspect
 * committed state while async writes await; no store transaction is interleaved.
 */
export function serveWorkerOwner<D>(open: (data: D) => ServedOwner | Promise<ServedOwner>): void {
  const port = parentPort;
  if (!port) throw new Error("serveWorkerOwner must run inside a Worker");
  const post = (reply: OwnerReply) => port.postMessage(reply);
  let owner: ServedOwner;
  let queue = Promise.resolve();
  const start = (async () => {
    try {
      owner = await open(workerData as D);
      post({ ready: true, value: owner.ready });
      return true;
    } catch (error) {
      post({ ready: false, error: serializeError(error) });
      port.close();
      return false;
    }
  })();
  let sealed=false;
  const reads=new Set<Promise<void>>();
  const execute=async(request:OwnerRequest,read=false)=>{
    if(!(await start))return;
    const method=Object.hasOwn(owner.methods,request.method)?owner.methods[request.method]:undefined;
    if(!method){post({id:request.id,error:serializeError(new Error(`Unknown owner method ${request.method}`)),fatal:false});return;}
    try{
      const result=(method as(...args:readonly unknown[])=>unknown)(...request.args);
      if(read&&result&&typeof(result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw new WorkerOwnerFatal('Concurrent owner reads must be synchronous');}
      const value=await result;post({id:request.id,value});
    }catch(error){post({id:request.id,error:serializeError(error),fatal:error instanceof WorkerOwnerFatal});}
  };
  port.on('message',(request:OwnerRequest)=>{
    if(sealed){post({id:request.id,error:serializeError(new Error('Worker owner is closed')),fatal:false});return;}
    if(request.method===CLOSE_METHOD){
      sealed=true;
      queue=queue.then(async()=>{
        if(!(await start))return;
        await Promise.all(reads);
        try{await owner.close?.();post({id:request.id,value:undefined});}
        catch(error){post({id:request.id,error:serializeError(error),fatal:true});}
        port.close();
      });
      return;
    }
    if(owner?.concurrentReads?.includes(request.method)){
      const reading=execute(request,true);reads.add(reading);
      void reading.finally(()=>reads.delete(reading));
    }else queue=queue.then(()=>execute(request));
  });
}
