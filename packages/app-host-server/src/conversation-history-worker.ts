import {observeStorageWork} from "./storage-work-observation.js";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { historyReadTiming, addHistoryReadTiming, type HistoryReadTiming } from "./history-read-timing.js";
import { HistoryNotStored, InvalidHistoryCursor, historyDirectoryQuery } from "./conversation-history.js";
import type { ConversationHistory, HistoryAdmission } from "./conversation-history.js";
import type { ConversationHistoryPort } from "./conversation-history-port.js";

type Value = Record<string, any>;
type Listener = Parameters<ConversationHistory["subscribeCommitted"]>[0];
export interface HistoryWorkTiming {
  method: string; phase: "worker" | "dependency"; readOnly: boolean; durationMs: number;
  queueMs?: number; executeMs?: number; busyWaitMs?: number; busyRetries?: number; authorizationMs?: number;
}
interface Request {
  method: string; readOnly: boolean; started: number; trace?: HistoryReadTiming;
  resolve(value: any): void;
  reject(error: Error): void;
  committed?: Listener;
  canRead?: HistoryAdmission;
  catalogPolicies?: Map<string, number>;
  admittedImport?: () => boolean;
  admitted: Set<string>;
}
/** Child of the managed Server storage owner. One writer and one read-only worker serve all history
 * scopes, and must close before that owner releases the installation lock. */
export class ConversationHistoryWorker {
  private readonly worker: Worker;
  private readonly reader: Worker;
  private stopping = false;
  private readonly scopes = new Map<string, {handle: string; opened: Promise<void>}>();
  private readonly writes = new Map<string, Set<Promise<unknown>>>();
  private readonly pending = new Map<number, Request>();
  private nextId = 0;
  private readonly active = new Set<Promise<unknown>>();
  private failure?: Error;
  private closing?: Promise<void>;
  private readonly ready: Promise<void>;
  constructor(path: string, private readonly onSlowWork?: (timing: HistoryWorkTiming)=>void) {
    this.worker = new Worker(new URL("./conversation-history-worker.mjs", import.meta.url), { workerData: { path }, execArgv: [] });
    this.reader = new Worker(new URL("./conversation-history-worker.mjs", import.meta.url), { workerData: { path, readOnly: true }, execArgv: [] });
    this.ready = Promise.all([this.attach(this.worker), this.attach(this.reader)]).then(()=>undefined);
    void this.ready.catch(()=>{});
  }
  private attach(worker: Worker): Promise<void> {
    return new Promise<void>((resolve,reject)=>{
      worker.on("message", async packet=>{
        if(packet.type === "ready") { resolve(); return; }
        const request = this.pending.get(packet.id);
        if(packet.type === "admit") {
          const signal = new Int32Array(packet.signal);
          let allowed=false;
          try { allowed=request?.admittedImport?.() ?? false; } catch { /* Fail closed. */ }
          Atomics.store(signal,0,allowed?1:2);Atomics.notify(signal,0);return;
        }
        if(packet.type === "authorize") {
          const signal = new Int32Array(packet.signal);
          let index=0;
          await this.eachIdentity(packet.ids,id=>{
            try {
              if(request?.canRead?.(id)) {
                const mode = packet.catalog ? request.canRead.catalogPolicy?.(id) : undefined;
                signal[index+1] = mode === "shared" ? 1 : mode === "private" ? 2 : 3;
                request.admitted.add(id);
              }
            } catch { /* Fail closed. */ }
            if (packet.catalog && request) {
              request.catalogPolicies ??= new Map(); request.catalogPolicies.set(id, signal[index+1]!);
            }
            index++;
          });
          Atomics.store(signal,0,1); Atomics.notify(signal,0);
          return;
        }
        if(!request)return;
        this.pending.delete(packet.id);
        for (const [source, target] of [["queueMs", "storageQueueMs"], ["executeMs", "storageExecuteMs"], ["busyWaitMs", "storageBusyMs"], ["busyRetries", "storageBusyRetries"], ["authorizationMs", "storageAuthorizeMs"]])
          addHistoryReadTiming(request.trace, target!, packet.timing?.[source!]);
        if(request.trace?.active && packet.timing?.directoryDetails) {
          const firstMiss=request.trace.details.directoryMissReason;
          Object.assign(request.trace.details,packet.timing.directoryDetails);
          if(firstMiss !== undefined)request.trace.details.directoryMissReason=firstMiss;
        }
        observeStorageWork(request.trace,request.method,request.readOnly,packet.timing,!!packet.error);
        this.slowWork({method:request.method,phase:"worker",readOnly:request.readOnly,durationMs:performance.now()-request.started,...packet.timing});
        if(packet.error) {
          const {name,message,code,data} = packet.error;
          const error = name === "HistoryNotStored" || code === -32074 ? new HistoryNotStored(message)
            : name === "InvalidHistoryCursor" || code === -32602 && data?.code === "HISTORY_CURSOR_EXPIRED" ? new InvalidHistoryCursor(message,data)
            : Object.assign(new Error(message),{name,code,data});
          request.reject(error); return;
        }
        // Deliver commits before resolving their operation, just as the local
        // owner does. Listener failures never turn an acknowledged commit into
        // a failed write, or trigger an automatic duplicate write.
        for(const commit of packet.commits ?? []) {
          try {
            const deliver=()=>request.committed?.(commit.threadIds,commit.revision,commit.updates,commit.catalogChanged,commit.deletedThreadIds);
            if(request.trace)historyReadTiming.run(request.trace,deliver);else deliver();
          } catch { /* Reconcile on next read. */ }
        }
        try {
          await this.eachIdentity(request.admitted,id=>{if(!request.canRead?.(id)) throw new HistoryNotStored("Conversation is unavailable");});
          if (request.catalogPolicies) await this.eachIdentity(request.catalogPolicies.keys(), id => {
            const allowed = request.canRead?.(id), mode = allowed ? request.canRead?.catalogPolicy?.(id) : undefined;
            const current = !allowed ? 0 : mode === "shared" ? 1 : mode === "private" ? 2 : 3;
            if (current !== request.catalogPolicies!.get(id)) throw Object.assign(new Error("Catalog admission changed"), { code: -32086 });
          });
          request.resolve(packet.result);
        } catch(error) { request.reject(error as Error); }
      });
      const fail = (error: Error) => {
        reject(error);
        if(this.failure)return;
        this.failure = error;
        void this.worker.terminate();void this.reader.terminate();
        for(const request of this.pending.values())request.reject(error);
        this.pending.clear();
      };
      worker.on("error",fail);
      worker.on("exit",code=>{if (!(this.stopping && code===0)) fail(new Error(`History storage worker exited (${code})`));});
    });
  }
  private async request(method: string, data: Value = {}, committed?: Listener, canRead?: HistoryAdmission, admittedImport?: () => boolean, readOnly = false): Promise<any> {
    await this.ready;
    if(this.failure)throw this.failure;
    if(this.pending.size>=2048)throw new Error("History storage worker is busy");
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject,committed,canRead,admittedImport,admitted:new Set(),method,readOnly,started:performance.now(),trace:historyReadTiming.getStore()});
      try { (readOnly ? this.reader : this.worker).postMessage({id,method,...data,catalogReader:canRead?.catalogReader,captureDiagnostics:!!historyReadTiming.getStore()?.active,enqueuedAt:process.hrtime.bigint()}); }
      catch(error) { this.pending.delete(id); reject(error); }
    });
  }
  start(): Promise<void> { return this.ready; }
  create(scope: string): ConversationHistoryPort {
    if(this.closing)throw new Error("History storage worker is closing");
    let discovery: Value | null = null;
    let owner=this.scopes.get(scope);
    if (!owner) {
      const handle=randomUUID();
      const opened=this.request("create",{handle,scope}).then(()=>this.request("create",{handle,scope},undefined,undefined,undefined,true)).then(()=>undefined);
      owner={handle,opened}; this.scopes.set(scope,owner); this.track(opened);
      void opened.catch(()=>{
        // A transient scope initialization failure must not poison every new
        // logical handle for the remaining lifetime of the Server owner.
        if(this.scopes.get(scope)?.handle===handle)this.scopes.delete(scope);
      });
    }
    const {handle,opened}=owner, listeners=new Set<Listener>(), active=new Set<Promise<unknown>>();
    let closed=false;
    const committed: Listener=(...args)=>{for(const listener of listeners) { try { listener(...args); } catch { /* Other listeners still reconcile this commit. */ } }};
    const key=(threadId: string|null)=>JSON.stringify([scope,threadId]);
    const call = (method: string,...args: any[]): Promise<any> => {
      if(this.closing || closed)return Promise.reject(new Error("History storage handle is closed or closing"));
      const mutation=method === "observe" || method === "importResult" || method === "reindex" || method === "invalidateDirectory";
      const params=method === "read" || method === "observe" || method === "importResult" ? args[1] : undefined;
      const threadId=method === "reindex" || !params ? args[0] : params.threadId ?? params.thread?.id ?? (method === "importResult" ? args[2]?.thread?.id : undefined);
      const wide=typeof threadId !== "string" || !threadId;
      // Admission captures already accepted writes across every handle of this
      // scope. A later unrelated write cannot extend a reader's dependency set.
      const dependencies=mutation ? [] : [...(this.writes.get(key(wide ? null : threadId)) ?? []), ...(wide ? [] : this.writes.get(key("*")) ?? [])];
      const acceptedAt=performance.now(), trace=historyReadTiming.getStore();
      const operation=Promise.allSettled(dependencies).then(()=>opened).then(async()=>{
        addHistoryReadTiming(trace, "storageDependencyMs", performance.now()-acceptedAt);
        this.slowWork({method,phase:"dependency",readOnly:!mutation,durationMs:performance.now()-acceptedAt});
        const canRead=method === "read" ? args[2] ?? (()=>true) : undefined;
        if(method === "read")args=args.slice(0,2);
        const admittedImport = method === "importResult" ? args[6] ?? (()=>true) : undefined;
        if(method === "importResult")args=[...args.slice(0,6),undefined,args[7]];
        try { return await this.request(method,{handle,args},committed,canRead,admittedImport,!mutation); }
        catch(error) {
          // Legacy preparation is a write, never a side effect of a read-only
          // connection. Re-read a fresh snapshot after the writer finishes it.
          if (mutation || (error as {code?:unknown}).code !== "HISTORY_PREPARATION_REQUIRED") throw error;
          const id=method === "read" ? args[1]?.threadId : args[0];
          await this.request("revision",{handle,args:[id]});
          return this.request(method,{handle,args},committed,canRead,undefined,true);
        }
      });
      if(mutation) {
        const ids=method === "importResult" && args[0] === "thread/list" && Array.isArray(args[2]?.data)
          ? args[2].data.map((row:Value)=>row.id).filter((id:unknown)=>typeof id === "string")
          : wide ? ["*"] : [threadId];
        for(const id of new Set<string|null>([null,...ids])) {
          const identity=key(id), pending=this.writes.get(identity) ?? new Set<Promise<unknown>>();
          pending.add(operation);this.writes.set(identity,pending);
          void operation.finally(()=>{pending.delete(operation);if(!pending.size && this.writes.get(identity)===pending)this.writes.delete(identity);}).catch(()=>{});
        }
      }
      active.add(operation);void operation.finally(()=>active.delete(operation)).catch(()=>{});
      return this.track(operation);
    };
    return {
      scope,
      publicTextRead: (...args)=>call("publicTextRead",...args),
      independentReads: true,
      close: async()=>{closed=true;await Promise.allSettled([...active]);listeners.clear();},
      subscribeCommitted(listener) { listeners.add(listener); return ()=>{listeners.delete(listener);}; },
      directoryQuery: historyDirectoryQuery,
      observe: (...args)=>call("observe",...args),
      initialization: value=>{if(value)discovery=structuredClone(value);return discovery;},
      hasThreads: (...args)=>call("hasThreads",...args),
      reindex: (...args)=>call("reindex",...args),
      revision: (...args)=>call("revision",...args),
      read: (...args)=>call("read",...args),
      itemSourceCursor: (...args)=>call("itemSourceCursor",...args),
      sourceCursor: (...args)=>call("sourceCursor",...args),
      catalogRevision: (...args)=>call("catalogRevision",...args),
      itemSourceDirection: (...args)=>call("itemSourceDirection",...args),
      itemRangeFence: (...args)=>call("itemRangeFence",...args),
      directoryFence: (...args)=>call("directoryFence",...args),
      directoryEpoch: (...args)=>call("directoryEpoch",...args),
      directoryState: (...args)=>call("directoryState",...args),
      invalidateDirectory: (...args)=>call("invalidateDirectory",...args),
      importResult: (...args)=>{
        if(args[0] !== "initialize")return call("importResult",...args);
        if(this.closing || closed || args[6] && !args[6]())throw new HistoryNotStored("Conversation source is unavailable");
        discovery=structuredClone(args[2]);return true;
      },
    };
  }
  private slowWork(timing: HistoryWorkTiming): void {
    if(timing.durationMs<1000)return;
    try { this.onSlowWork?.(timing); } catch { /* Diagnostics cannot affect admission or settlement. */ }
  }
  private async eachIdentity(ids: Iterable<string>, visit: (id: string)=>void): Promise<void> {
    let started=performance.now();
    for(const id of ids) {
      visit(id);
      if(performance.now()-started>=4) {
        await new Promise<void>(resolve=>setImmediate(resolve));
        started=performance.now();
      }
    }
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.active.add(operation);
    void operation.finally(()=>this.active.delete(operation)).catch(()=>{});
    return operation;
  }
  close(): Promise<void> {
    return this.closing ??= (async()=>{
      try {
        await this.ready;
        await Promise.allSettled(this.active);
        this.stopping=true;
        await Promise.all([this.request("close"),this.request("close",{},undefined,undefined,undefined,true)]);
      } finally {
        this.stopping=true;
        await Promise.all([this.worker.terminate(),this.reader.terminate()]);
      }
    })();
  }
}
