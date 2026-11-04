import { isCatalogSnapshotHead, CATALOG_MERKLE_CURSOR } from "@opencraft/appserver-protocol";
import {THREAD_COUNT_METHOD,THREAD_COUNT_CAPABILITY,COLLABORATION_METHOD} from '@opencraft/appserver-protocol/collaboration';
import {PUBLIC_TEXT_SEARCH_CAPABILITY,PUBLIC_TEXT_SEARCH_METHOD,PUBLIC_TEXT_SEARCH_MODE,type PublicTextRead} from '@opencraft/appserver-protocol/collaboration';
import {THREAD_SEARCH_METHOD} from '@opencraft/appserver-protocol/collaboration';
import {rpcIngressObservation} from "./rpc-ingress-observation.js";
import {compactRequestTrace, threadCatalogEntry, type ThreadCatalogFact} from "@opencraft/appserver-protocol";
import { SNAPSHOT_CURSOR, SNAPSHOT_START } from "./thread-directory/snapshots.js";
import { createNotificationObservation, notificationTraceFields, type NotificationObservation, createRequestTrace, parseRequestTrace } from "@opencraft/appserver-protocol";
import { THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ, CONVERSATION_STOP_METHOD, CONVERSATION_STOP_OBSERVE_METHOD } from '@opencraft/appserver-protocol/collaboration';
import { randomUUID } from "node:crypto";
import { historyReadTiming, beginHistoryReadTiming, addHistoryReadTiming, measureHistoryRead, type HistoryReadTiming, roundedHistoryDiagnostic } from "./history-read-timing.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { captureTransportMessageScope, type DuplexTransport, type TransportStatus, type TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import { HistoryNotStored, InvalidHistoryCursor, type DirectoryObservation } from "./conversation-history.js";
import type { ConversationHistoryPort } from "./conversation-history-port.js";
import { ConversationExecutionStatus } from "./conversation-execution-status.js";
import { DIRECTORY_FULL_RECONCILE_MS, DIRECTORY_MAX_SOURCE_PAGES } from "./thread-directory/policy.js";

// Preserve deadline identity separately from admission/storage HistoryNotStored.
class HistoryRequestDeadline extends HistoryNotStored {}

type Value = Record<string, any>;
const object = (value: unknown): Value => value && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const catalogControlMethods = new Set(["project/list", "model/list", "permissionProfile/list", "configRequirements/read", "collaborationMode/list", "opencraft/interactions/read", "opencraft/interactions/respond"]);
const exactControlMethods = new Set([THREAD_COUNT_METHOD,PUBLIC_TEXT_SEARCH_METHOD,THREAD_SEARCH_METHOD,THREAD_DEFAULTS_WRITE,THREAD_DEFAULTS_READ,CONVERSATION_STOP_METHOD, CONVERSATION_STOP_OBSERVE_METHOD, 'thread/queue/collaborationReceipt', 'thread/queue/delete']);
const exactCollaborationControls = new Set(['context','commands','servers','messageAttachments','threadDefaults','threadDefaultsObserve','stop','stopObserve','queueCancel','queueRequests','threadSearch','publicTextSearch']);
const exactControl = (method: string, params: Value) => exactControlMethods.has(method)
  || method === 'opencraft/collaboration' && exactCollaborationControls.has(params.action);
const readMethods = new Set(["thread/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/search", "thread/searchOccurrences"]);
interface NativeReadObservation { parent: HistoryReadTiming; started: number; nativeCallId: string; values: Record<string, number>; finished: boolean }
interface Pending { observation?: NativeReadObservation; context: TransportSubmissionContext; executionFence: ReturnType<ConversationExecutionStatus["fence"]>; method: string; params: Value; fence: number; directoryObservation?:DirectoryObservation; directoryFence?: ReadonlyMap<string,string>; allowLiveItemProgress?:boolean; strict?:boolean; sourceRead?:boolean; authorized?:()=>boolean | Promise<boolean>; resolve?(value: Value): void; reject?(error: Error): void; timer?: ReturnType<typeof setTimeout> }
interface Client { watchRevisions: Map<string, number>; catalogReader?: string; catalogSnapshots?: boolean; statusDiscovery?: boolean; discoveryFailed?: boolean; initialize: Value; context: TransportSubmissionContext; ready?: Promise<void> }
interface Repair { lane: string; client: Client; threadId: string; turns: Set<string>; generation: number; attempts: number; cursor: string | null; guard: ()=>boolean; abort: AbortController; timer?: ReturnType<typeof setTimeout>; running?: Promise<void> }

/** Display persistence is below ingress authorization and above every execution adapter.
 * Connection discovery grants protocol information only. Every native command
 * still crosses a fresh native initialization and the original authority checks.
 */
export class ConversationHistoryTransport implements DuplexTransport {
  private state: TransportStatus = { state: "idle" };
  private readonly executionStatus = new ConversationExecutionStatus();
  private readonly statusSource = `execution:${randomUUID()}`;
  private statusRevision = 0;
  private readonly messages = new Set<(frame: string) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();
  private readonly pending = new Map<string, Pending>();
  private readonly clients = new Map<string, Client>();
  private readonly watches = new Map<string, Set<string>>();
  private readonly watchSubscriptions = new Map<string, () => void>();
  private watch(threadId: string, lane: string, client: Client, replace = false): void {
    const watchers = this.watches.get(threadId) ?? new Set<string>();
    watchers.add(lane); this.watches.set(threadId, watchers);
    const key = JSON.stringify([threadId, lane]);
    if (!replace && this.watchSubscriptions.has(key)) return;
    this.watchSubscriptions.get(key)?.();
    const remove = this.inner.watchConversation?.(threadId, lane, () => !this.closed && !this.closing
      && this.clients.get(lane) === client && this.watches.get(threadId)?.has(lane) === true
      && this.readable(threadId, client.context));
    if (remove) this.watchSubscriptions.set(key, remove);
  }
  private unwatch(threadId: string, lane: string): void {
    const client = this.clients.get(lane);
    if (client) client.watchRevisions.set(threadId, (client.watchRevisions.get(threadId) ?? 0) + 1);
    const key = JSON.stringify([threadId, lane]);
    this.watchSubscriptions.get(key)?.(); this.watchSubscriptions.delete(key);
    const watchers = this.watches.get(threadId); watchers?.delete(lane);
    if (!watchers?.size) this.watches.delete(threadId);
  }
  private readonly directoryCheckpoints = new Map<string, {cursor:string|null;fence:ReadonlyMap<string,string>;epoch:string;fromHead:boolean}>();
  private readonly observedDirectories = new Map<string,string>();
  private readonly directoryReads = new Map<string, Promise<Value>>();
  private readonly directoryReconciliations = new Map<string, Promise<void>>();
  private readonly turnReads = new Map<string, Promise<Value>>();
  private readonly itemCheckpoints = new Map<string, {cursor:string|null;range:string}>();
  private readonly itemReads = new Map<string, Promise<Value>>();
  private readonly turnCheckpoints = new Map<string, { cursor: string | null; coverage: string }>();
  private readonly refreshes = new Map<string, Promise<void>>();
  private activeRefreshes = 0;
  private readonly refreshWaiters: (() => void)[] = [];
  private readonly repairs = new Map<string, Repair>();
  private readonly removeCommitted: () => void;
  /**
   * SQLite history writes are synchronous.  Keep them off the notification
   * ingress path so a live turn can be painted before durable indexing runs.
   * The tail is still awaited by reads and response imports, preserving the
   * revision fence between live observations and historical snapshots.
   */
  private historyWriteTail: Promise<void> = Promise.resolve();
  private receiveTail: Promise<void> = Promise.resolve();
  private historySliceStarted = performance.now();
  private historyYield?: Promise<void>;
  private nativeOpening?: Promise<void>;
  private replacing?: Promise<void>;
  private closing = false;
  private closed = false;
  private removers: (() => void)[] = [];
  private publishingGuard: (() => boolean) | undefined;
  constructor(private inner: DuplexTransport, readonly history: ConversationHistoryPort,
    private readonly diagnostic: (event: string) => void = () => {}, private readonly timeoutMs = 8000,
    private readonly recreate?: () => DuplexTransport,
    private readonly canRead:(threadId:string,context:TransportSubmissionContext)=>boolean | "shared" | "private"=()=>true,
    private readonly onReadTiming?: (event: Record<string, unknown>) => void) {
    if (onReadTiming) {
      const timed = new Set(["read", "revision", "catalogRevision", "directoryFence", "directoryEpoch", "directoryState", "importResult", "itemSourceCursor", "sourceCursor", "itemRangeFence"]);
      this.history = new Proxy(history, { get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof key !== "string" || !timed.has(key) || typeof value !== "function") return value;
        return (...args: unknown[]) => measureHistoryRead("gatewayStorageMs", () => Reflect.apply(value, target, args));
      } });
    }
    this.attach(inner);
    this.removeCommitted=history.subscribeCommitted((threadIds,revision,updates,catalogChanged,deletedThreadIds=[])=>{
      for(const threadId of threadIds) for(const lane of this.watches.get(threadId)??[]) {
        const client=this.clients.get(lane);
        if(client)this.publish({method:!deletedThreadIds.includes(threadId)?"opencraft/history/changed":"thread/deleted",params:{threadId,historyVersion:updates.get(threadId)?.version,update:updates.get(threadId)},[LOGICAL_CLIENT_FIELD]:lane},
          ()=>this.clients.get(lane)===client && this.readable(threadId,client.context));
      }
      if(catalogChanged) for(const [lane,client] of this.clients) {
        if (!client.catalogSnapshots) {
          this.publish({method:"opencraft/thread-catalog/changed",params:{version:1,source:"history:"+history.scope,revision,change:{type:"invalidate"}},[LOGICAL_CLIENT_FIELD]:lane},
            ()=>this.clients.get(lane)===client,"history-storage");
          continue;
        }
        const changes: ThreadCatalogFact[] = [];
        let complete = threadIds.length > 0 && threadIds.length <= 256;
        for (const threadId of threadIds) {
          if (!this.readable(threadId, client.context)) continue;
          if (deletedThreadIds.includes(threadId)) changes.push({type:"remove",threadId});
          else {
            const metadata = updates.get(threadId)?.metadata;
            const thread = metadata ? threadCatalogEntry({...metadata,status:this.executionStatus.status(threadId)}) : null;
            if (thread) changes.push({type:"upsert",thread}); else complete = false;
          }
        }
        if (!changes.length && complete) continue;
        this.publish({method:"opencraft/thread-catalog/changed",
          params:{version:1,authority:"directory",source:"history:"+history.scope,revision,
            change:complete ? {type:"batch",changes} : {type:"invalidate"}},[LOGICAL_CLIENT_FIELD]:lane},
          ()=>this.clients.get(lane)===client,"history-storage");
      }
    });
  }
  private publishExecutionStatus(threadIds: readonly string[]): number {
    let attempts=0;
    for (const threadId of threadIds) {
      const params = { version: 1, authority: "directory", source: this.statusSource, revision: ++this.statusRevision,
        change: { type: "patch", threadId, status: this.executionStatus.status(threadId) } };
      for (const [lane, client] of this.clients) {
        attempts++;
        this.publish({ method: "opencraft/thread-catalog/changed", params, [LOGICAL_CLIENT_FIELD]: lane },
          () => this.clients.get(lane) === client && this.readable(threadId, client.context),"execution-status");
      }
    }
    return attempts;
  }
  private readable(threadId: string, context: TransportSubmissionContext): boolean {
    try {
      if(context.validUntil !== undefined && context.validUntil <= Date.now())return false;
      context.resourceOwner?.assertCurrent();
      return !!this.canRead(threadId,context);
    }catch{return false;}
  }
  private admission(context: TransportSubmissionContext, lane: string) {
    const client = this.clients.get(lane)!;
    client.catalogReader ??= randomUUID();
    return Object.assign((id: string) => this.readable(id, context), { catalogReader: client.catalogReader, catalogPolicy: (id: string) => {
      if (!this.readable(id, context)) return undefined;
      const policy = this.canRead(id, context);
      return policy === "shared" || policy === "private" ? policy : undefined;
    } });
  }
  private catalogReadParams(params: Value, context: TransportSubmissionContext): Value {
    if (!isCatalogSnapshotHead(params.cursor) || !String(params.cursor).startsWith(CATALOG_MERKLE_CURSOR)) return params;
    try {
      const query = JSON.parse(params.cursor.slice(CATALOG_MERKLE_CURSOR.length));
      if (query.activeIds !== undefined && !Array.isArray(query.activeIds)) return params;
      const activeIds = [...new Set([...(query.activeIds ?? []), ...this.executionStatus.activeThreadIds(id => this.readable(id, context))])].slice(0, 129);
      return { ...params, cursor: CATALOG_MERKLE_CURSOR + JSON.stringify({ ...query, activeIds }) };
    } catch { return params; }
  }
  private readonly textReads = new Map<string,Set<Int32Array>>();
  private cancelTextReads(lane?:string) {for(const [key,reads] of this.textReads)if(lane===undefined||key===lane){for(const c of reads)Atomics.store(c,0,1);this.textReads.delete(key);}}
  private textSourceLifetime = randomUUID();
  private attach(inner: DuplexTransport) {
    this.cancelTextReads();this.textSourceLifetime=randomUUID();
    for (const remove of this.watchSubscriptions.values()) remove();
    this.watchSubscriptions.clear();
    for (const [threadId, lanes] of this.watches) for (const lane of lanes) {
      const client = this.clients.get(lane); if (client) this.watch(threadId, lane, client);
    }
    this.removers = [inner.subscribeMessage(frame => { if (this.inner === inner) this.receive(frame); }), inner.subscribeStatus(status => {
      if (this.inner !== inner) return;
      if (status.state === "failed" || status.state === "closed") {
        this.cancelTextReads();this.textSourceLifetime=randomUUID();
        void this.retireDirectory();
        for (const [key, request] of this.pending) {
          this.pending.delete(key); clearTimeout(request.timer); request.reject?.(new Error("Execution engine is unavailable"));
        }
        this.publishExecutionStatus(this.executionStatus.clear());
        this.directoryCheckpoints.clear(); this.turnCheckpoints.clear(); this.itemCheckpoints.clear()
        this.nativeOpening = undefined;
        for (const client of this.clients.values()) { client.ready = undefined; client.statusDiscovery = false; client.discoveryFailed = false; }
      }
      // Engine failure cannot erase access to stored history or claim a live execution.
    })];
  }
  get status() { return this.state; }
  async connect(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Conversation transport is closed");
    this.publishStatus({ state: "open" });
  }
  captureMessageScope(): () => boolean {
    const guard = this.publishingGuard;
    return () => !this.closed && (guard?.() ?? true);
  }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  private publishStatus(status: TransportStatus) { this.state = status; for (const listener of this.statuses) listener(status); }
  private publish(packet: Value, guard?: () => boolean, notificationSource?: NotificationObservation["notificationSource"]) {
    if (this.closed || guard && !guard()) return;
    const trace = historyReadTiming.getStore();
    if(packet.id === undefined && typeof packet.method === "string") {
      const stamp=createNotificationObservation(packet.method,packet.params,
        notificationSource ?? (packet.method === "opencraft/thread-catalog/changed" ? "upstream-catalog" : "upstream-native"),trace?.context);
      if(stamp)packet={...packet,__opencraftNotification:stamp};
    }
    if (trace?.active && packet.id === trace.responseId && (packet.result !== undefined || packet.error !== undefined)) {
      trace.outcome = packet.error ? "failed" : "ok";
      if(trace.ingress) {
        trace.values.gatewayIngressToReplyMs=Math.max(0,performance.now()-trace.ingress.started);
        trace.values.gatewayReplyAt=Date.now();
      }
      if (packet.result && typeof packet.result === "object") packet = { ...packet, result: { ...packet.result,
        __opencraftGatewayTiming: { gatewayPairId: trace.gatewayPairId, ...trace.values,
          gatewayMs: performance.now() - trace.started } } };
      else if (packet.error) packet = { ...packet, error: { ...packet.error, data: { ...object(packet.error.data),
        __opencraftGatewayTiming: { gatewayPairId: trace.gatewayPairId, ...trace.values,
          gatewayMs: performance.now() - trace.started } } } };
    }
    const serializeStarted = performance.now();
    const frame = JSON.stringify(packet), previous = this.publishingGuard;
    addHistoryReadTiming(trace, "gatewaySerializeMs", performance.now() - serializeStarted);
    if (trace?.active && packet.id === trace.responseId) trace.values.bytes = Buffer.byteLength(frame);
    const deliverStarted = performance.now();
    this.publishingGuard = guard;
    try { for (const listener of this.messages) { if (this.closed || guard && !guard()) break; listener(frame); } }
    finally { this.publishingGuard = previous; addHistoryReadTiming(trace, "gatewayDeliverMs", performance.now() - deliverStarted); }
  }
  private lane(packet: Value): string { return String(packet[LOGICAL_CLIENT_FIELD] ?? ""); }
  private key(packet: Value): string { return JSON.stringify([this.lane(packet), packet.id]); }
  private envelope(request: Value): Value { return { jsonrpc: "2.0", id: request.id,
    ...(request[LOGICAL_CLIENT_FIELD] === undefined ? {} : { [LOGICAL_CLIENT_FIELD]: request[LOGICAL_CLIENT_FIELD] }) }; }
  private capabilities(result: Value): Value {
    const read = { version: 1, contextUsage: result.capabilities?.extensions?.["opencraft/read-history"]?.contextUsage === true, initialTurnsPage: true, itemDetails: true, versionedUpdates: true, turnConfigurationObservation: result.capabilities?.extensions?.["opencraft/read-history"]?.turnConfigurationObservation === true, exactResult: result.capabilities?.extensions?.["opencraft/read-history"]?.exactResult === true, sourceRead: result.capabilities?.extensions?.["opencraft/read-history"]?.sourceRead === true };
    const extensions: Value = { ...object(result.capabilities?.extensions),
      "opencraft/thread-directory-snapshots": {version:1,recovery:"snapshot"},
      "opencraft/thread-directory-merkle": {version:1,buckets:256,admission:"reader"},
      [PUBLIC_TEXT_SEARCH_CAPABILITY]:{version:1,mode:PUBLIC_TEXT_SEARCH_MODE}, "opencraft/read-history": read, "opencraft/request-trace": {version:1},
      "opencraft/persisted-history": { version: 1, search: "fts5-bm25", sync: true } };
    const access=object(extensions["opencraft/method-access"]);
    if(Array.isArray(access.methods))extensions["opencraft/method-access"]={...access,methods:[...new Set([...access.methods,PUBLIC_TEXT_SEARCH_METHOD,"thread/search","thread/searchOccurrences","opencraft/history/sync"])]};
    const engines = object(extensions["opencraft/execution-engines"]);
    if (Array.isArray(engines.providers)) extensions["opencraft/execution-engines"] = { ...engines,
      providers: engines.providers.map((provider: Value) => ({ ...provider, extensions: { ...object(provider.extensions), "opencraft/read-history": read } })) };
    return { ...result, capabilities: { ...object(result.capabilities), extensions } };
  }
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  private waitForHistoryWrites(): Promise<void> { return measureHistoryRead("gatewayDependencyMs", () => this.historyWriteTail); }
  /** Promise tails preserve ordering but do not yield to sockets/timers. Share
   * one bounded slice across this owner's writes, replies and directory work;
   * only pause between complete synchronous operations, never in a transaction. */
  private yieldHistoryWork(): Promise<void> | undefined {
    if (this.historyYield) return this.historyYield;
    if (performance.now() - this.historySliceStarted < 8) return;
    this.historyYield = new Promise<void>(resolve => setImmediate(resolve)).then(() => {
      this.historySliceStarted = performance.now();
      this.historyYield = undefined;
    });
    return this.historyYield;
  }
  private enqueueHistoryObservation(packet: Value, guard: () => boolean) {
    const previous = this.historyWriteTail;
    const observe = async () => {
      const yieldWork = this.history.independentReads ? undefined : this.yieldHistoryWork(); if (yieldWork) await yieldWork;
      // The observation was accepted while the source scope was valid.  Do
      // not re-check that scope here: a source can close while its last frame
      // is draining, and dropping that frame would create a history hole.
      if (this.closed) return;
      // This frame was admitted while `guard` was live.  The source may have
      // closed while SQLite was draining; committed watchers still need the
      // resulting durable update, subject to their own current read checks.
      try { (await this.history.observe(packet.method, object(packet.params))); }
      catch {
        this.diagnostic("history-persistence-failed");
        this.needRepair(packet, object(packet.params), guard);
      }
    };
    // The managed history owner registers cross-handle dependencies immediately.
    // Synchronous ports retain their existing transport-local mutation FIFO.
    const operation = this.history.independentReads ? observe() : previous.then(observe);
    this.historyWriteTail = Promise.all([previous, operation]).then(()=>undefined,()=>undefined);
  }
  private retireDirectory(): Promise<void> {
    const previous=this.historyWriteTail;
    const retire=()=>this.history.invalidateDirectory();
    const operation=this.history.independentReads ? Promise.resolve(retire()) : previous.then(retire);
    this.historyWriteTail=Promise.all([previous,operation]).then(()=>undefined,()=>undefined);
    void operation.catch(()=>this.diagnostic("history-persistence-failed"));
    return operation;
  }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void> {
    const request = JSON.parse(frame), upstream=parseRequestTrace(request.__opencraftTrace);
    // The gateway consumes diagnostic metadata. Never forward it into an engine.
    if (Object.hasOwn(request,"__opencraftTrace")) { delete request.__opencraftTrace; frame=JSON.stringify(request); }
    if (!this.onReadTiming) return this.sendRequest(frame, context, signal);
    if (!readMethods.has(request.method) || request.id === undefined) return this.sendRequest(frame, context, signal);
    const trace = beginHistoryReadTiming();
    trace.sink=this.onReadTiming;trace.requestMethod=request.method;
    trace.context={...notificationTraceFields(upstream),...createRequestTrace(upstream?.caller ?? "client",upstream?.trigger ?? "unknown",upstream),
      ...(upstream?.catalogId === undefined ? {} : {catalogId:upstream.catalogId}),
      ...(upstream?.pageIndex === undefined ? {} : {pageIndex:upstream.pageIndex}),...(upstream?.attempt === undefined ? {} : {attempt:upstream.attempt})};
    trace.ingress=rpcIngressObservation.getStore();
    if(trace.ingress)Object.assign(trace.values,{gatewayIngressAt:trace.ingress.wallAt,
      gatewayIngressQueueMs:Math.max(0,trace.ingress.dequeued-trace.ingress.started),
      gatewayRpcAccessMs:trace.ingress.accessMs,gatewayIngressToReadMs:Math.max(0,performance.now()-trace.ingress.started)});
    trace.values.gatewayTimingVersion = 2;
    trace.responseId = request.id;
    return historyReadTiming.run(trace, async () => {
      try { await this.sendRequest(frame, context, signal); }
      finally {
        if (signal?.aborted) trace.outcome = "aborted";
        const event = { kind: "rpc", method: request.method, gatewayPairId: trace.gatewayPairId,
          outcome: trace.outcome, durationMs: performance.now() - trace.started, ...trace.values, ...trace.details, ...(trace.context ? compactRequestTrace(trace.context) : {}), traceRole:"gateway-rpc",
          measurementScope: "rpc", observedBy: "self", producerMode: "native", identitySource: "self" };
        trace.active = false;
        try { this.onReadTiming?.(roundedHistoryDiagnostic(event)); } catch { /* Diagnostics cannot change a read result. */ }
      }
    });
  }
  private async sendRequest(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closed || this.state.state !== "open") throw new Error("Conversation transport is not open");
    const request = JSON.parse(frame), params = object(request.params), lane = this.lane(request);
    const requestClient = this.clients.get(lane), watchRevision = requestClient?.watchRevisions.get(params.threadId) ?? 0;
    const assertWatchCurrent = () => {
      signal?.throwIfAborted();
      if (params.watch === true && (!requestClient || this.clients.get(lane) !== requestClient
        || (requestClient.watchRevisions.get(params.threadId) ?? 0) !== watchRevision))
        throw Object.assign(new Error("History reader unsubscribed"), { code: -32073 });
    };
    const trace=historyReadTiming.getStore();
    if(trace && request.method === "thread/list") {
      const key=JSON.stringify([lane,this.history.directoryQuery(params)]);
      let directoryId=this.observedDirectories.get(key);
      if(!directoryId) { directoryId=randomUUID(); if(this.observedDirectories.size>=256)this.observedDirectories.delete(this.observedDirectories.keys().next().value!);this.observedDirectories.set(key,directoryId); }
      trace.details.directoryId=directoryId;
    }
    if (request.method === "runtime/client/disconnect") {
      this.cancelTextReads(lane);
      const priorClient=this.clients.get(lane);
      const countOnly=priorClient&&(priorClient.context.collaborationRequestId==='thread-count'
        ||object(object(object(priorClient.initialize.params).capabilities).extensions)[THREAD_COUNT_CAPABILITY]===true);
      const wasReady=!!priorClient?.ready;
      this.clients.delete(lane);
      for(const key of this.observedDirectories.keys())if(JSON.parse(key)[0]===lane)this.observedDirectories.delete(key);
      for(const key of this.directoryCheckpoints.keys())if(JSON.parse(key)[0]===lane)this.directoryCheckpoints.delete(key);
      for (const [key, pending] of this.pending) if (JSON.parse(key)[0] === lane) {
        this.pending.delete(key); clearTimeout(pending.timer); pending.reject?.(new Error("Client disconnected"));
      }
      for (const key of this.turnCheckpoints.keys()) if (JSON.parse(key)[0] === lane) this.turnCheckpoints.delete(key);
      for(const key of this.itemCheckpoints.keys())if(JSON.parse(key)[0]===lane)this.itemCheckpoints.delete(key);
      for (const threadId of this.watches.keys()) this.unwatch(threadId, lane);
      for(const [key,repair] of this.repairs)if(repair.lane===lane)this.cancelRepair(key,repair);
      if(countOnly)await this.forward(frame,{...context,collaborationRequestId:'thread-count'},signal);
      else if (wasReady && this.inner.status.state === "open") await this.forward(frame, context, signal);
      return;
    }
    if (request.method === "initialize") {
      for (const threadId of this.watches.keys()) this.unwatch(threadId, lane);
      for (const key of this.turnCheckpoints.keys()) if (JSON.parse(key)[0] === lane) this.turnCheckpoints.delete(key);
      for(const key of this.itemCheckpoints.keys())if(JSON.parse(key)[0]===lane)this.itemCheckpoints.delete(key);
      const client: Client = { initialize: request, context, watchRevisions: new Map() }; this.clients.set(lane, client);
      // A trusted imported-history query negotiates this owner's read capability
      // without warming a Native source or joining ordinary history hydration.
      if(context.collaborationRequestId==='thread-text-search'&&context.actorContext&&context.resourceOwner) {
        context.resourceOwner.assertCurrent();
        if(context.validUntil===undefined||Date.now()>=context.validUntil)throw Error('Expired text discovery');
        this.publish({...this.envelope(request),result:this.capabilities({capabilities:{extensions:{}}})});return;
      }
      if(context.collaborationRequestId==='thread-count'||object(object(object(request.params).capabilities).extensions)[THREAD_COUNT_CAPABILITY]===true){
        try {
          const result=await this.nativeRequest(request,context,signal);
          client.ready=Promise.resolve();this.publish({...this.envelope(request),result:this.capabilities(result)});
        }catch(error){this.replyError(request,error,'thread-count');}
        return;
      }
      const stored = (await this.history.initialization());
      if (stored) { this.publish({ ...this.envelope(request), result: this.capabilities(stored) }); return; }
      // Recorded-name discovery may use an existing owner snapshot, but a cold
      // query must not bootstrap Native merely to negotiate the directory.
      if(context.collaborationRequestId==='thread-name-search'&&context.actorContext&&context.resourceOwner) {
        context.resourceOwner.assertCurrent();
        if(context.validUntil===undefined||Date.now()>=context.validUntil)throw Error('Expired name discovery');
        this.publish({...this.envelope(request),error:{code:-32073,message:'Recorded-name source unavailable',data:{code:'thread_search_unavailable'}}});return;
      }
      try {
        const result = await this.nativeRequest(request, context, signal);
        if (this.clients.get(lane) !== client) return;
        client.ready = Promise.resolve();
        this.publish({ ...this.envelope(request), result: this.capabilities(result) });
      } catch (error) {
        if (this.clients.get(lane) === client && (await this.history.hasThreads())) {
          client.discoveryFailed = true;
          this.publish({ ...this.envelope(request), result: this.capabilities({ userAgent: "OpenCraft", capabilities: { extensions: {} } }) });
        } else this.replyError(request, error);
      }
      return;
    }
    if(request.method === PUBLIC_TEXT_SEARCH_METHOD && request.id !== undefined) {
      const client=this.clients.get(lane), source=this.inner, lifetime=this.textSourceLifetime;
      const cancellation=new Int32Array(new SharedArrayBuffer(4));
      const reads=this.textReads.get(lane)??new Set<Int32Array>();reads.add(cancellation);this.textReads.set(lane,reads);
      const abort=()=>Atomics.store(cancellation,0,1);
      const deadline=Math.min(context.validUntil ?? 0,Date.now()+9000);
      const timer=setTimeout(abort,Math.max(0,deadline-Date.now()));timer.unref();signal?.addEventListener('abort',abort,{once:true});
      const check=()=>{context.resourceOwner?.assertCurrent();if(!client||this.clients.get(lane)!==client||this.inner!==source
        ||this.textSourceLifetime!==lifetime||this.closing||this.closed||signal?.aborted||Date.now()>=deadline)throw Error('Text source unavailable');};
      try {
        if(!context.actorContext||!context.resourceOwner||context.collaborationRequestId!=='thread-text-search')throw Error('Trusted text read required');
        check();const p=object(request.params),cursor=p.cursor;
        if(!['window','project','validate'].includes(p.kind)||Object.keys(p).some(k=>!['kind','cursor','query','positions'].includes(k))
          ||p.kind!=='window'&&!cursor)throw Error('Invalid text read');
        if(cursor&&(!String(cursor.lifetime).startsWith(lifetime+':')))throw Object.assign(Error('Changed source'),{code:'text_search_changed'});
        const read={...p,cursor:cursor?{...cursor,lifetime:cursor.lifetime.slice(lifetime.length+1)}:null} as PublicTextRead;
        const result=await this.history.publicTextRead(read,{deadline,cancellation});check();
        result.fence.lifetime=lifetime+':'+result.fence.lifetime;
        this.publish({...this.envelope(request),result},()=>{try{check();return true;}catch{return false;}});
      }catch(error){const code=(error as {code?:string}).code;
        this.publish({...this.envelope(request),error:{code:-32073,message:'Public text read unavailable',
          data:{code:['text_search_changed','text_search_unknown'].includes(code??'')?code:'text_search_unavailable'}}});
      }finally{abort();reads.delete(cancellation);if(!reads.size)this.textReads.delete(lane);clearTimeout(timer);signal?.removeEventListener('abort',abort);}
      return;
    }
    if (request.method === "initialized") return; // nativeRequest sends it for the native lane.
    if(request.method==="opencraft/history/sync" && request.id!==undefined) {
      try {
        await this.waitForHistoryWrites();
        const threadId=params.threadId;
        if(typeof threadId!=="string" || !threadId || threadId.length>4096 || !this.readable(threadId,context))throw new HistoryNotStored("Conversation is unavailable");
        if(params.cursor!=null && (typeof params.cursor!=="string"||params.cursor.length>16384))throw Object.assign(new Error("Invalid source cursor"),{code:-32602});
        const limit=params.limit??20;
        if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(new Error("Invalid synchronization page size"),{code:-32602});
        if(!this.clients.has(lane))throw Object.assign(new Error("Client is not initialized"),{code:-32600});
        let result:Value;
        if(params.indexOnly===true)result={index:(await this.history.reindex(threadId,params.indexLimit??100))};
        else {
          await this.ensureClient(lane,signal);
          if(params.cursor==null) await this.nativeRequest({...request,method:"thread/read",params:{threadId,includeTurns:false}},context,signal,true);
          const page=await this.nativeRequest({...request,method:"thread/turns/list",params:{threadId,cursor:params.cursor??null,limit,sortDirection:"desc",itemsView:"full"}},context,signal,true);
          result={imported:page.data?.length??0,nextCursor:page.nextCursor??null,index:(await this.history.reindex(threadId,params.indexLimit??100))};
        }
        signal?.throwIfAborted();
        this.publish({...this.envelope(request),result:{...result,revision:(await this.history.revision(threadId))}});
      }catch(error){this.replyError(request,error);}return;
    }
    if(['opencraft/thread-context/read','opencraft/turn-configuration/read'].includes(request.method)&&request.id!==undefined) {
      const budget=signal?AbortSignal.any([signal,AbortSignal.timeout(9000)]):AbortSignal.timeout(9000);
      try {
        if(!this.clients.has(lane)||typeof params.threadId!=='string'||!params.threadId||request.method==='opencraft/turn-configuration/read'&&(typeof params.turnId!=='string'||!params.turnId)
          ||Object.keys(params).some(k=>!(request.method==='opencraft/thread-context/read'?['threadId']:['threadId','turnId']).includes(k)))throw Object.assign(new Error('Invalid Turn configuration read'),{code:-32602});
        await this.ensureClient(lane,budget);
        if((await this.history.initialization())?.capabilities?.extensions?.['opencraft/read-history']?.[request.method==='opencraft/thread-context/read'?'contextUsage':'turnConfigurationObservation']!==true)
          throw Object.assign(new Error('Unsupported Turn configuration read'),{code:-32601});
        const result=await this.nativeRequest(request,context,budget,false,undefined,undefined,false,true);
        budget.throwIfAborted();this.publish({...this.envelope(request),result});
      }catch(error){
        if(error instanceof HistoryRequestDeadline||budget.aborted)
          this.publish({...this.envelope(request),error:{code:-32073,message:'Turn configuration read unavailable',data:{code:'HISTORY_READ_UNAVAILABLE'}}});
        else this.replyError(request,error);
      }
      return;
    }
    // An explicitly negotiated recent observation reads one native page. It
    // neither replays cached content nor imports an append-fenced snapshot.
    if (request.method === 'opencraft/turn-result/read' && request.id !== undefined) {
      try {
        if (!this.clients.has(lane) || typeof params.threadId !== 'string' || !params.threadId
          || typeof params.turnId !== 'string' || !params.turnId || typeof params.output !== 'boolean'
          || params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 4096)
          || !params.output && params.cursor != null || Object.keys(params).some(k=>!['threadId','turnId','output','cursor'].includes(k)))
          throw Object.assign(new Error('Invalid exact result read'),{code:-32602});
        await this.ensureClient(lane,signal);
        if ((await this.history.initialization())?.capabilities?.extensions?.['opencraft/read-history']?.exactResult !== true)
          throw Object.assign(new Error('Exact result unsupported'),{code:-32601});
        const result = await this.nativeRequest(request,context,signal,false,undefined,undefined,false,true);
        signal?.throwIfAborted(); this.publish({...this.envelope(request),result});
      } catch(error) {
        const failure=object(error), code=error instanceof HistoryRequestDeadline
          ? 'HISTORY_READ_UNAVAILABLE' : object(failure.data).code;
        // Preserve only this read port's public error vocabulary, never Native payloads.
        if (['HISTORY_READ_UNAVAILABLE','history_changed','UNSUPPORTED_CAPABILITY'].includes(code))
          this.publish({...this.envelope(request),error:{code:typeof failure.code==='number'?failure.code:-32073,
            message:'Exact Turn read unavailable',data:{code}}});
        else this.replyError(request,error);
      }
      return;
    }
    if (params.sourceRead === true && request.id !== undefined) {
      try {
        if (!this.clients.has(lane)) throw Object.assign(new Error("Client is not initialized"), {code:-32600});
        const metadata = request.method === "thread/read" && params.includeTurns === false;
        const headers = request.method === "thread/turns/list" && params.itemsView === "notLoaded" && params.sortDirection === "desc" && Number.isInteger(params.limit) && params.limit >= 1 && params.limit <= 5;
        const items = request.method === "thread/items/list" && typeof params.turnId === "string" && params.turnId.length > 0 && params.sortDirection === "desc" && params.limit === 30;
        const allowed = metadata ? ["threadId","includeTurns","sourceRead"] : headers ? ["threadId","limit","cursor","sortDirection","itemsView","sourceRead"] : ["threadId","turnId","limit","cursor","sortDirection","sourceRead"];
        if (!(metadata || headers || items) || params.cursor != null || Object.keys(params).some(key=>!allowed.includes(key)) || typeof params.threadId !== "string" || !params.threadId)
          throw Object.assign(new Error("Invalid bounded source page"), {code:-32602});
        await this.ensureClient(lane,signal);
        if ((await this.history.initialization())?.capabilities?.extensions?.["opencraft/read-history"]?.sourceRead !== true)
          throw Object.assign(new Error("Bounded source reads are unsupported"),{code:-32601});
        const {sourceRead: _sourceRead,...nativeParams}=params;
        const result=await this.nativeRequest({...request,params:headers ? {...nativeParams,sourceRead:true} : nativeParams},context,signal,false,undefined,undefined,false,true);
        signal?.throwIfAborted();
        this.publish({...this.envelope(request),result});
      } catch(error) { this.replyError(request,error); }
      return;
    }
    if (readMethods.has(request.method) && request.id !== undefined) {
      const client = this.clients.get(lane);
      if (!client) { this.replyError(request, Object.assign(new Error("Client is not initialized"), { code: -32600 })); return; }
      if (request.method === "thread/list" && isCatalogSnapshotHead(params.cursor)) client.catalogSnapshots = true;
      try {
        if (!this.history.independentReads) await this.waitForHistoryWrites();
        if(request.method==="thread/items/list" && request.id!==undefined) {
          const result=await this.sourceItems(request,client,context,signal);
          if(this.clients.get(lane)===client)this.publish({...this.envelope(request),result});
          return;
        }
        const result = (await this.history.read(request.method, request.method === "thread/list" ? this.catalogReadParams(params,context) : params,this.admission(context,lane)));
        const readTrace=historyReadTiming.getStore(); if(readTrace && request.method === "thread/list") readTrace.details.directoryCache="hit";
        assertWatchCurrent();
        if (this.clients.get(lane) !== client || params.threadId && !this.readable(params.threadId,context)) throw new HistoryNotStored("Conversation is unavailable");
        if (params.watch === true && typeof params.threadId === "string") this.watch(params.threadId, lane, client);
        this.publish({ ...this.envelope(request), result: this.executionStatus.project(request.method, result) });
        // Native discovery/reconciliation is independent of the cached first paint.
        const catalogHead = params.cursor == null || isCatalogSnapshotHead(params.cursor);
        if (request.method === "thread/list" && catalogHead && !client.statusDiscovery) {
          client.statusDiscovery = true;
          this.scheduleRefresh({...request,params:{...params,cursor:null}}, client,"initial-discovery");
        } else if ((client.ready || params.watch === true) && (request.method === "thread/read" || request.method === "thread/list" && catalogHead)) this.scheduleRefresh(request.method === "thread/list" ? {...request,params:{...params,cursor:null}} : request, client,request.method === "thread/list" ? "cached-head" : "watched-read");
        const repair=this.repairs.get(params.threadId);
        if(repair && this.readable(params.threadId,context)) {
          // A new authorized read starts a fresh bounded recovery window.
          repair.attempts=0;this.scheduleRepair(repair);
        }
      } catch (error) {
        if (!(error instanceof HistoryNotStored)) { this.replyError(request, error); return; }
        const readTrace=historyReadTiming.getStore(); if(readTrace && request.method === "thread/list") readTrace.details.directoryCache="miss";
        try {
          await this.ensureClient(lane, signal);
          let sourceParams = params;
          if (request.method === "thread/list" && typeof params.cursor === "string" && params.cursor.startsWith(SNAPSHOT_CURSOR))
            sourceParams = {...params,cursor:null};
          if(request.method==="thread/items/list" && typeof params.turnId==="string") {
            const saved=await this.sourceItems(request,client,context,signal);
            signal?.throwIfAborted();
            if(this.clients.get(lane)===client)this.publish({...this.envelope(request),result:this.executionStatus.project(request.method,saved)});
            return;
          }
          if (request.method === "thread/list" && typeof params.cursor === "string" && params.cursor.startsWith("conversation-directory:")) {
            const saved=await this.sourceDirectory(request,client,signal,true,context);
            signal?.throwIfAborted();
            if(this.clients.get(lane)===client)this.publish({...this.envelope(request),result:this.executionStatus.project(request.method,saved)});
            return;
          }
          if (request.method === "thread/turns/list" && params.sortDirection !== "asc" && typeof params.cursor === "string" && params.cursor.startsWith("conversation:") && !params.detailItemId) {
            const saved = await this.sourceTurns(request, client, context, signal);
            signal?.throwIfAborted();
            if (this.clients.get(lane) === client) if (this.clients.get(lane) !== client || params.threadId && !this.readable(params.threadId,context)) throw new HistoryNotStored("Conversation is unavailable");
          this.publish({ ...this.envelope(request), result: this.executionStatus.project(request.method, saved) });
            return;
          }
          if (typeof params.cursor === "string" && params.cursor.startsWith("conversation:")) {
            if (!["thread/turns/list","thread/items/list"].includes(request.method)) throw new HistoryNotStored("Item details have not been stored");
            const cursor = request.method === "thread/items/list" ? (await this.history.itemSourceCursor(params.threadId,params)) : (await this.history.sourceCursor(params.threadId, params.cursor));
            if (cursor === "__history_gap__") throw new HistoryNotStored("Earlier history has not been synchronized");
            sourceParams = { ...params, cursor };
          }
          // Import complete source Items once. Presentation is produced locally afterwards.
          sourceParams = { ...sourceParams, ...(request.method === "thread/turns/list" && params.itemsView !== "notLoaded" ? { itemsView: "full" } : {}),
            ...(params.initialTurnsPage ? { initialTurnsPage: { ...params.initialTurnsPage, itemsView: params.initialTurnsPage.itemsView === "notLoaded" ? "notLoaded":"full" } } : {}) };
          const result = request.method === "thread/list"
            ? await this.sourceDirectory({...request,params:sourceParams},client,signal,false,context)
            : await this.nativeRequest({ ...request, params: sourceParams }, context, signal);
          signal?.throwIfAborted();
          if (this.clients.get(lane) !== client) return;
          let saved: Value;
          try { saved = (await this.history.read(request.method, params,threadId=>this.readable(threadId,context))); }
          catch(error) {
            // A supported stored view must never turn a rejected import into
            // unversioned success carrying a native continuation.
            if(request.method==="thread/read" || request.method==="thread/turns/list" && params.sortDirection!=="asc")throw error;
            saved = result; // Unsupported native views retain their lossless contract.
          }
          assertWatchCurrent();
          if (this.clients.get(lane) !== client || params.threadId && !this.readable(params.threadId,context)) throw new HistoryNotStored("Conversation is unavailable");
          if (params.watch === true && typeof params.threadId === "string") this.watch(params.threadId, lane, client);
          this.publish({ ...this.envelope(request), result: this.executionStatus.project(request.method, saved) });
        } catch (failure) { this.replyError(request, failure); }
      }
      return;
    }
    if (request.method === "thread/history/cancel") {
      this.publish({ ...this.envelope(request), result: { cancelled: false } }); return;
    }
    if (request.method === "thread/unsubscribe" && typeof params.threadId === "string") {
      const watched=this.watches.get(params.threadId)?.has(lane);
      this.unwatch(params.threadId, lane);
      this.turnCheckpoints.delete(JSON.stringify([lane,params.threadId]));
      for(const key of this.itemCheckpoints.keys())if(JSON.parse(key)[0]===lane && JSON.parse(key)[1]===params.threadId)this.itemCheckpoints.delete(key);
      const repair=this.repairs.get(params.threadId);
      if(repair?.lane===lane)this.cancelRepair(params.threadId,repair);
      if(!this.clients.get(lane)?.ready) {
        this.publish({...this.envelope(request),result:{status:watched?"unsubscribed":"notSubscribed"}});return;
      }
    }
    if (request.method !== "runtime/machine/read") await this.ensureClient(lane, signal);
    if (request.id !== undefined) this.pending.set(this.key(request), { context, executionFence: this.executionStatus.fence(), method: request.method, params, fence: (catalogControlMethods.has(request.method) || exactControl(request.method,params)) ? 0 : request.method === "thread/list" ? (await this.history.catalogRevision()) : (await this.history.revision(params.threadId ?? "")) });
    try { await this.forward(frame, context, signal); }
    catch (error) { this.pending.delete(this.key(request)); if(context.collaborationRequestId==='thread-count')this.replyError(request,error,'thread-count');else throw error; }
  }
  /** Rebuild the requested platform range through the current source lane.
   * A newer head read may have replaced its segment; a raw native page from
   * that head is not a reply to an older platform anchor. */
  private sourceTurns(request: Value, client: Client, context: TransportSubmissionContext, signal?: AbortSignal): Promise<Value> {
    const lane=this.lane(request),params=object(request.params),key=JSON.stringify([lane,params.threadId]);
    const authorized=()=>!this.closed && this.clients.get(lane)===client && this.readable(params.threadId,context);
    const read=async()=>(await this.history.read("thread/turns/list",params,id=>this.readable(id,context)));
    const coverage=async()=>JSON.stringify((await this.history.read("thread/turns/list",{threadId:params.threadId,limit:1,itemsView:"notLoaded"},id=>this.readable(id,context))).historyCoverage);
    const predecessor=this.turnReads.get(key);
    const operation=Promise.resolve(predecessor).catch(()=>undefined).then(async()=>{
      signal?.throwIfAborted();
      if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
      try{return await read();}catch(error){if(!(error instanceof HistoryNotStored) && !(error instanceof InvalidHistoryCursor))throw error;}
      const checkpoint=this.turnCheckpoints.get(key);
      let cursor=checkpoint && checkpoint.coverage===await coverage() ? checkpoint.cursor:null;
      const seen=new Set<string>();let restarted=false;
      const deadline=performance.now()+this.timeoutMs;
      for(let page=0;page<8 && (page===0 || performance.now()<deadline);page++) {
        signal?.throwIfAborted();await this.ensureClient(lane,signal);
        if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
        const currentSource=async()=>{
          try { const current=this.turnCheckpoints.get(key);return authorized() && (cursor===null || current?.cursor===cursor && current.coverage===await coverage()); }
          catch {return false;}
        };
        if(!await currentSource()){cursor=null;seen.clear();}
        let result:Value;
        try {
          result=await this.nativeRequest({...request,params:{...params,cursor,itemsView:params.itemsView==="notLoaded"?"notLoaded":"full"}},context,signal,false,currentSource,undefined,true);
        }catch(error) {
          if(authorized() && !await currentSource()){cursor=null;seen.clear();continue;}
          const failure=error as {code?:number;data?:{retryable?:boolean}};
          if(!restarted && cursor && (failure.code===-32080 || failure.data?.retryable===true)) {this.turnCheckpoints.delete(key);cursor=null;seen.clear();restarted=true;continue;}
          throw error;
        }
        if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
        if(!Array.isArray(result.data) || result.nextCursor!=null && typeof result.nextCursor!=="string")throw new HistoryNotStored("Source history is unavailable");
        const next=result.nextCursor??null;
        if(next!==null && (next===cursor || seen.has(next)))throw new HistoryNotStored("Source history made no progress");
        if(next!==null)seen.add(next);
        const importedCoverage=await coverage(),observed=JSON.parse(importedCoverage);
        if(observed.next!==next || result.data.some((row:Value)=>!observed.visible?.includes(`group:${row.id}`))) {
          this.turnCheckpoints.delete(key);cursor=null;seen.clear();continue; // A live commit fenced this import.
        }
        this.turnCheckpoints.set(key,{cursor:next,coverage:importedCoverage});
        try {
          const saved=await read();
          if(saved.data.length>=Math.min(100,params.limit??20) || saved.nextCursor===null)return saved;
        }catch(error){if(!(error instanceof HistoryNotStored))throw error;}
        // Some native paginators return headers even for full. Keep the
        // original per-Turn Item hydration contract and the platform range.
        if(result.data.some((row:Value)=>row.itemsView && row.itemsView!=="full" || row.items?.some((item:Value)=>object(item.item??item).historyDetail))) {
          try { return (await this.history.read("thread/turns/list",{...params,itemsView:"notLoaded"},id=>this.readable(id,context))); }
          catch(error){if(!(error instanceof HistoryNotStored))throw error;}
        }
        if(next===null)throw new HistoryNotStored("History changed during synchronization; retry this page");
        cursor=next;
      }
      try { const saved=await read();if(saved.data.length)return saved; }catch(error){if(!(error instanceof HistoryNotStored))throw error;}
      throw new HistoryNotStored("Earlier history is still synchronizing; retry this page");
    });
    this.turnReads.set(key,operation);
    void operation.finally(()=>{if(this.turnReads.get(key)===operation)this.turnReads.delete(key);}).catch(()=>{});
    return operation;
  }
  /** Item cursors identify a platform position. Durable native continuations
   * never authorize replay on a new lane, query direction or source window. */
  private sourceItems(request: Value, client: Client, context: TransportSubmissionContext, signal?: AbortSignal): Promise<Value> {
    const lane=this.lane(request),params=object(request.params),direction=params.sortDirection==="desc"?"desc":"asc";
    const key=JSON.stringify([lane,params.threadId,params.turnId,direction]);
    const authorized=()=>!this.closed && this.clients.get(lane)===client && this.readable(params.threadId,context);
    const range=async()=>(await this.history.itemRangeFence(params.threadId,params.turnId));
    const read=async()=>(await this.history.read("thread/items/list",params,id=>this.readable(id,context)));
    const operation=Promise.resolve(this.itemReads.get(key)).catch(()=>undefined).then(async()=>{
      signal?.throwIfAborted();if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
      const storedDirection=(await this.history.itemSourceDirection(params.threadId,params.turnId));
      if(storedDirection===null || storedDirection===direction)try{return await read();}catch(error){if(!(error instanceof HistoryNotStored) && !(error instanceof InvalidHistoryCursor))throw error;}
      const checkpoint=this.itemCheckpoints.get(key);
      let cursor=checkpoint?.range===await range()?checkpoint.cursor:null,restarted=false;
      const seen=new Set<string>(),deadline=performance.now()+this.timeoutMs;
      for(let page=0;page<8 && (page===0 || performance.now()<deadline);page++) {
        signal?.throwIfAborted();await this.ensureClient(lane,signal);
        if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
        const before=await range();
        if(cursor!==null && this.itemCheckpoints.get(key)?.range!==before){cursor=null;seen.clear();}
        const current=async()=>{try{return authorized() && await range()===before;}catch{return false;}};
        let result:Value;
        try {
          const nativeCursor=cursor!==null && typeof cursor==="string" && cursor.startsWith("conversation:")
            ? (await this.history.itemSourceCursor(params.threadId,{...params,cursor})) : cursor;
          result=await this.nativeRequest({...request,params:{...params,cursor:nativeCursor,sortDirection:direction}},context,signal,true,current);
        }catch(error) {
          const failure=error as {code?:number;data?:{retryable?:boolean}};
          if(!restarted && cursor && authorized() && (failure.code===-32080 || failure.data?.retryable===true)) {
            this.itemCheckpoints.delete(key);cursor=null;seen.clear();restarted=true;continue;
          }
          throw error;
        }
        if(!authorized())throw new HistoryNotStored("Conversation is unavailable");
        const next=result.nextCursor??null;
        if(next!==null && (next===cursor || seen.has(next)))throw new HistoryNotStored("Source Items made no progress");
        if(next!==null)seen.add(next);
        this.itemCheckpoints.set(key,{cursor:next,range:await range()});
        try {const saved=await read();if(saved.data.length>=Math.min(1000,params.limit??10) || saved.nextCursor===null)return saved;}
        catch(error){if(!(error instanceof HistoryNotStored))throw error;}
        if(next===null)throw new HistoryNotStored("Requested Item range is unavailable");
        cursor=next;
      }
      try{const saved=await read();if(saved.data.length)return saved;}catch(error){if(!(error instanceof HistoryNotStored))throw error;}
      throw new HistoryNotStored("Items are still synchronizing; retry this page");
    });
    this.itemReads.set(key,operation);
    void operation.finally(()=>{if(this.itemReads.get(key)===operation)this.itemReads.delete(key);}).catch(()=>{});
    return operation;
  }
  private scheduleRefresh(request: Value, client: Client, refreshReason="repair") {
    const foreground=historyReadTiming.getStore();
    if(foreground) foreground.details.refreshReason=refreshReason;
    if (client.discoveryFailed) { if(foreground) foreground.details.refreshDecision="disabled"; return; }
    const key = JSON.stringify([this.lane(request), request.method, request.params?.threadId ?? ""]);
    if (this.refreshes.has(key)) { if(foreground) foreground.details.refreshDecision="deduplicated"; return; }
    if(foreground) foreground.details.refreshDecision="scheduled";
    const parent=historyReadTiming.getStore()?.context;
    const operation = this.withRefreshSlot(() => historyReadTiming.exit(async () => {
      if (!this.onReadTiming) return this.refresh(request,client);
      const trace=beginHistoryReadTiming(); trace.values.gatewayTimingVersion=2;
      trace.sink=this.onReadTiming;trace.requestMethod=request.method;
      trace.details.refreshReason=refreshReason;
      if(foreground?.details.directoryId)trace.details.directoryId=foreground.details.directoryId;
      trace.context={...notificationTraceFields(parent),...createRequestTrace("server-refresh","cache-refresh"),...(parent ? {linkedTraceId:parent.traceId,linkedSpanId:parent.spanId} : {})};
      return historyReadTiming.run(trace,async()=>{
        try { await this.refresh(request,client); trace.outcome="ok"; }
        finally { trace.active=false;
          try {this.onReadTiming?.(roundedHistoryDiagnostic({kind:"dependency",method:request.method,outcome:trace.outcome,durationMs:performance.now()-trace.started,
            gatewayPairId:trace.gatewayPairId,...(trace.context ? compactRequestTrace(trace.context) : {}),...trace.values,...trace.details,traceRole:"background-refresh",measurementScope:"rpc",observedBy:"self",producerMode:"native",identitySource:"self"}));} catch { /* Diagnostics cannot change refresh. */ }
        }
      });
    })); this.refreshes.set(key, operation);
    void operation.catch(() => this.diagnostic("history-refresh-unavailable")).finally(() => { if (this.refreshes.get(key) === operation) this.refreshes.delete(key); });
  }
  /** Background cache repair must not fill the Native request lane ahead of
   * interactive resume/send work. Keep a small shared budget across clients;
   * per-key deduplication alone still permits one refresh per recovered lane. */
  private async withRefreshSlot(operation: () => Promise<void>): Promise<void> {
    if (this.activeRefreshes >= 2) await new Promise<void>(resolve => this.refreshWaiters.push(resolve));
    this.activeRefreshes++;
    try { if (!this.closed) await operation(); }
    finally { this.activeRefreshes--; this.refreshWaiters.shift()?.(); }
  }
  private async refresh(request: Value, client: Client) {
    const lane=this.lane(request);
    const authorized=()=>!this.closed && this.clients.get(lane)===client
      && (!request.params?.threadId || this.readable(request.params.threadId,client.context))
      && (request.params?.watch!==true || this.watches.get(request.params.threadId)?.has(lane)===true);
    if(!authorized())return;
    await this.ensureClient(lane);
    if(!authorized())return;
    if (request.method === "thread/list") {
      const state = await this.history.directoryState(object(request.params));
      const completingSnapshot = client.catalogSnapshots === true && state.hasMore === true;
      if(this.directoryReconciliationDue(state) || completingSnapshot) {
        await this.reconcileDirectory(request,client,authorized,completingSnapshot);return;
      }
      await this.sourceDirectory(request,client);
      return;
    }
    const threadId = request.params.threadId;
    await this.nativeRequest({ ...request, params: { ...request.params,
      ...(request.params.initialTurnsPage ? {initialTurnsPage: { ...request.params.initialTurnsPage, itemsView: "full" }} : {}) } }, client.context,undefined,false,authorized);
  }
  private directoryReconciliationDue(state: Value): boolean {
    return state.reconciling === true || (state.observed === true || state.state === "observed" || state.observedAt != null)
      && (state.observedAt == null || Date.now()-state.observedAt >= DIRECTORY_FULL_RECONCILE_MS);
  }
  /** One anti-entropy job per query, independent of how many readers refresh
   * its head. Batches retain progress; failures retain readable cached rows. */
  private reconcileDirectory(request: Value, client: Client, authorized:()=>boolean, force = false): Promise<void> {
    const params=object(request.params),key=this.history.directoryQuery(params);
    const existing=this.directoryReconciliations.get(key);if(existing)return existing;
    const operation=(async()=>{
      const state=await this.history.directoryState(params);
      if(!authorized() || !force && !this.directoryReconciliationDue(state))return;
      if(!state.reconciling)await this.history.invalidateDirectory(params,undefined,true);
      const seen=new Set<string>();
      for(let batch=0;batch<Math.ceil(DIRECTORY_MAX_SOURCE_PAGES/8);batch++) {
        if(!authorized())return;
        const checkpoint=this.directoryCheckpoints.get(JSON.stringify([this.lane(request),key]));
        if(checkpoint?.cursor) {
          if(seen.has(checkpoint.cursor))throw new HistoryNotStored("Directory reconciliation made no progress");
          seen.add(checkpoint.cursor);
        }
        const result=await this.sourceDirectory({...request,params:{...params,cursor:null}},client,undefined,false,client.context,true);
        if(result.reconciled) {
          if(!(await this.history.directoryState(params)).observed)throw new HistoryNotStored("Source directory remains incomplete");
          return;
        }
        // Release the per-query read queue between bounded batches so a
        // foreground missing-range request can use the scan's progress.
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      throw new HistoryNotStored("Directory reconciliation remains partial; retry later");
    })();
    this.directoryReconciliations.set(key,operation);
    void operation.finally(()=>{if(this.directoryReconciliations.get(key)===operation)this.directoryReconciliations.delete(key);}).catch(()=>{});
    return operation;
  }
  /** Native directory cursors belong to this logical connection. Durable
   * keyset positions can outlive it, so a missing range starts a bounded source
   * scan and retains only the current connection's continuation. */
  private sourceDirectory(request: Value, client: Client, signal?: AbortSignal, recover=false, context=client.context, reconcile=false): Promise<Value> {
    const lane=this.lane(request),params=object(request.params),key=JSON.stringify([lane,this.history.directoryQuery(params)]);
    const predecessor=this.directoryReads.get(key);
    const authorized=()=>{
      if(this.closed || this.clients.get(lane)!==client || context.validUntil!==undefined && context.validUntil<=Date.now())return false;
      try{context.resourceOwner?.assertCurrent();return true;}catch{return false;}
    };
    const operation=Promise.resolve(predecessor).catch(()=>undefined).then(async()=>{
      const yieldWork = this.yieldHistoryWork(); if (yieldWork) await yieldWork;
      signal?.throwIfAborted();
      if(!authorized())throw new HistoryNotStored("Conversation directory is unavailable");
      if(recover) {
        try{return (await this.history.read("thread/list",params,id=>this.readable(id,context)));}
        catch(error){if(!(error instanceof HistoryNotStored))throw error;}
      }
      let epoch=await this.history.directoryEpoch(params);
      const retained=this.directoryCheckpoints.get(key);
      const checkpoint=retained?.epoch===epoch ? retained:undefined;
      const directoryTrace=historyReadTiming.getStore();
      if(directoryTrace) Object.assign(directoryTrace.details,{directoryMode:recover || reconcile ? "recover" : "source",directoryStart:recover || reconcile ? checkpoint?.cursor ? "checkpoint" : "head" : params.cursor == null ? "head" : "source-cursor",directoryCheckpoint:checkpoint ? "present" : "absent",directoryQueued:predecessor ? 1 : 0});
      let cursor=recover || reconcile ? checkpoint?.cursor ?? null:params.cursor ?? null;
      let fence=cursor && checkpoint && checkpoint.cursor===cursor ? checkpoint.fence
        : cursor ? new Map<string,string>():(await this.history.directoryFence());
      let fromHead=cursor==null || checkpoint?.cursor===cursor && checkpoint?.fromHead===true;
      let restarted=false;
      const priorPages=reconcile ? Number(directoryTrace?.details.directoryPages ?? 0):0;
      for(let page=0;page<8;page++) {
        if(directoryTrace) directoryTrace.details.directoryPages=priorPages+page+1;
        signal?.throwIfAborted();
        await this.ensureClient(lane,signal);
        let result:Value;
        try {
          result=await this.nativeRequest({...request,params:{...params,cursor,
            ...(recover || reconcile ? {limit:Math.max(100,params.limit??100)}:{})}},context,signal,true,authorized,fence,false,false,{epoch,fromHead});
        }catch(error) {
          this.directoryCheckpoints.delete(key);
          const failure=error as {code?:number;data?:{retryable?:boolean}};
          if((recover || reconcile) && !restarted && (failure.code===-32075 || cursor && (failure.code===-32080 || failure.data?.retryable===true))) {
            if(directoryTrace) directoryTrace.details.directoryRestart="source-invalidated";
            if(failure.code!==-32075)await this.history.invalidateDirectory(params);
            epoch=await this.history.directoryEpoch(params);
            cursor=null;fromHead=true;fence=(await this.history.directoryFence());restarted=true;continue;
          }
          throw error;
        }
        if(!authorized())throw new HistoryNotStored("Conversation directory is unavailable");
        if(!Array.isArray(result.data) || result.nextCursor!=null && typeof result.nextCursor!=="string")throw new HistoryNotStored("Source directory is unavailable");
        const next=result.nextCursor??null;
        if(next!==null && next===cursor)throw new HistoryNotStored("Source directory made no progress");
        // Head revalidation merges facts; it cannot rewind another traversal.
        if(recover || reconcile || params.cursor!=null || !checkpoint || restarted)this.directoryCheckpoints.set(key,{cursor:next,fence,epoch,fromHead});
        if(!recover && !reconcile) { if(directoryTrace) directoryTrace.details.directoryStop="source-page"; return result; }
        if(reconcile) {
          if(next===null) {if(directoryTrace)directoryTrace.details.directoryStop="source-ended";return {reconciled:true};}
          cursor=next;continue;
        }
        try{const saved=await this.history.read("thread/list",params,id=>this.readable(id,context)); if(directoryTrace) directoryTrace.details.directoryStop="cache-satisfied"; return saved;}
        catch(error){if(!(error instanceof HistoryNotStored))throw error;}
        if(next===null) { if(directoryTrace) directoryTrace.details.directoryStop="source-ended"; throw new HistoryNotStored("Directory changed during synchronization; retry this page"); }
        cursor=next;
      }
      // Keep the bounded scan's checkpoint so a later read can continue it.
      if(directoryTrace) directoryTrace.details.directoryStop="page-budget";
      if(reconcile)return {reconciled:false};
      throw new HistoryNotStored("Earlier directory entries are still synchronizing; retry this page");
    });
    this.directoryReads.set(key,operation);
    void operation.finally(()=>{if(this.directoryReads.get(key)===operation)this.directoryReads.delete(key);}).catch(()=>{});
    if(!signal)return operation;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason??new Error("Directory read cancelled"));
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
      void operation.then(resolve,reject).finally(()=>signal.removeEventListener("abort",abort));
    });
  }
  private async ensureClient(lane: string, signal?: AbortSignal): Promise<void> {
    return measureHistoryRead("gatewayInitializeMs", () => this.ensureNativeClient(lane, signal));
  }
  private async ensureNativeClient(lane: string, signal?: AbortSignal): Promise<void> {
    const client = this.clients.get(lane);
    if (!client) throw new Error("Client is not initialized");
    if (!client.ready) {
      const operation = this.nativeRequest(client.initialize, client.context, signal).then(() => {
        for (const [threadId, watchers] of this.watches) if (watchers.has(lane)) {
          this.watch(threadId, lane, client, true);
          this.scheduleRefresh({ method: "thread/read", params: { threadId, includeTurns: false, watch: true, initialTurnsPage: { limit: 10, itemsView: "full", sortDirection: "desc" } }, [LOGICAL_CLIENT_FIELD]: lane }, client);
        }
      });
      client.ready = operation;
      void operation.catch(() => { if (client.ready === operation) client.ready = undefined; });
    }
    await client.ready;
    signal?.throwIfAborted();
  }
  private cancelRepair(key: string, repair: Repair) {
    clearTimeout(repair.timer);repair.abort.abort();
    if(this.repairs.get(key)===repair)this.repairs.delete(key);
  }
  private needRepair(packet: Value, params: Value, guard: ()=>boolean) {
    const threadId=params.threadId??params.thread?.id;
    let lane=this.lane(packet),client=this.clients.get(lane);
    if(typeof threadId==="string" && !client)for(const watcher of this.watches.get(threadId)??[]) {
      const candidate=this.clients.get(watcher);
      if(candidate && this.readable(threadId,candidate.context)){lane=watcher;client=candidate;break;}
    }
    if(typeof threadId!=="string" || !client || !guard() || !this.readable(threadId,client.context))return;
    let repair=this.repairs.get(threadId);
    if(repair && (repair.client!==client || !repair.guard())) {this.cancelRepair(threadId,repair);repair=undefined;}
    if(!repair) {
      if(this.repairs.size>=128){this.diagnostic("history-repair-capacity");return;}
      repair={lane,client,threadId,turns:new Set(),generation:0,attempts:0,cursor:null,guard,abort:new AbortController()};
      this.repairs.set(threadId,repair);
    }
    const turnId=params.turnId??params.turn?.id;
    if(typeof turnId==="string" && repair.turns.size<128)repair.turns.add(turnId);
    repair.generation++;repair.cursor=null;
    this.scheduleRepair(repair);
  }
  private scheduleRepair(repair: Repair) {
    return historyReadTiming.exit(() => this.scheduleDetachedRepair(repair));
  }
  private scheduleDetachedRepair(repair: Repair) {
    if(repair.running || repair.timer || this.closed)return;
    repair.timer=setTimeout(()=>{
      repair.timer=undefined;
      const generation=repair.generation;
      const authorized=()=>!this.closed && !repair.abort.signal.aborted && repair.guard()
        && generation===repair.generation && this.clients.get(repair.lane)===repair.client && this.readable(repair.threadId,repair.client.context);
      if(!authorized()){this.cancelRepair(repair.threadId,repair);return;}
      repair.attempts++;
      const request={method:"thread/read",params:{threadId:repair.threadId,includeTurns:false,watch:true},[LOGICAL_CLIENT_FIELD]:repair.lane};
      const run=async()=>{
        await this.ensureClient(repair.lane,repair.abort.signal);
        await this.nativeRequest(request,repair.client.context,repair.abort.signal,true,authorized);
        // Bound each pass. Continue an opaque chain only while its original
        // authorization remains valid; never claim that it proves a snapshot.
        for(let page=0;page<8;page++) {
          const result=await this.nativeRequest({...request,method:"thread/turns/list",params:{threadId:repair.threadId,cursor:repair.cursor,limit:1,sortDirection:"desc",itemsView:"full"}},repair.client.context,repair.abort.signal,true,authorized);
          if(generation!==repair.generation)return false;
          for(const turn of result.data)repair.turns.delete(turn.id);
          repair.cursor=result.nextCursor??null;
          if(repair.turns.size===0)return true;
          if(repair.cursor===null)throw new HistoryNotStored("Affected history is unavailable");
        }
        return false;
      };
      const operation=run().then(complete=>{
        if(complete && generation===repair.generation && authorized()) {
          this.repairs.delete(repair.threadId);this.diagnostic("history-repair-completed");
        }
      }).catch(()=>{this.diagnostic("history-repair-unavailable");}).finally(()=>{
        repair.running=undefined;
        if(this.repairs.get(repair.threadId)===repair)this.scheduleRepair(repair);
      });
      repair.running=operation;
    },[25,250,1000,5000,15000,60000][Math.min(repair.attempts,5)]);
    repair.timer.unref?.();
  }
  private async forward(frame: string, context: TransportSubmissionContext, signal?: AbortSignal, authorized?:()=>boolean | Promise<boolean>, observation?: NativeReadObservation) {
    const countPacket=object(JSON.parse(frame));
    const countRead=context.collaborationRequestId==='thread-count'||countPacket.method===THREAD_COUNT_METHOD
      ||countPacket.method===COLLABORATION_METHOD&&object(countPacket.params).action==='threadCount'
      ||countPacket.method==='initialize'&&object(object(object(countPacket.params).capabilities).extensions)[THREAD_COUNT_CAPABILITY]===true;
    const nameRead=context.collaborationRequestId==='thread-name-search',source=this.inner;
    const currentNameSource=()=>{if(nameRead&&(this.inner!==source||this.inner.status.state!=='open'))
      throw Object.assign(new Error("Recorded-name source unavailable"),{code:'thread_search_unavailable'});};
    currentNameSource();
    if (!countRead && ["closed", "failed"].includes(this.inner.status.state) && this.recreate) {
      this.replacing ??= (async () => {
        for (const remove of this.removers) remove();
        await this.inner.close();
        if (this.closed) throw new Error("Conversation transport closed");
        await this.retireDirectory();
        this.inner = this.recreate!(); this.directoryCheckpoints.clear(); this.turnCheckpoints.clear(); this.itemCheckpoints.clear(); this.attach(this.inner); this.nativeOpening = undefined;
      })();
      try { await this.replacing; } finally { this.replacing = undefined; }
    }
    // Directory reads may consume an already open source, never connect it.
    if(!nameRead&&!countRead){this.nativeOpening ??= this.inner.connect(signal);await this.nativeOpening;}
    currentNameSource();
    signal?.throwIfAborted();
    if(authorized && !await authorized())throw new HistoryNotStored("Conversation is unavailable");
    const dispatchStarted = performance.now();
    if (observation && !observation.finished) observation.values.nativeDispatchAtMs = dispatchStarted - observation.started;
    try {
      if (this.inner.sendWithContext) await this.inner.sendWithContext(frame, context, signal);
      else { if (context.sender) throw new Error("Verified attribution is unsupported"); await this.inner.send(frame, signal); }
    } finally {
      if (observation && !observation.finished) observation.values.nativeSendMs = performance.now() - dispatchStarted;
    }
  }
  private async nativeRequest(request: Value, context: TransportSubmissionContext, signal?: AbortSignal, strict=false, authorized?:()=>boolean | Promise<boolean>, directoryFence?:ReadonlyMap<string,string>, allowLiveItemProgress=false, sourceRead=false, directoryObservation?:DirectoryObservation): Promise<Value> {
    const parent = historyReadTiming.getStore(), started = performance.now();
    const observation: NativeReadObservation | undefined = parent?.active ? {
      parent, started, nativeCallId: randomUUID(), values: {nativeStartOffsetMs: Math.max(0, started - parent.started)}, finished: false,
    } : undefined;
    let outcome = "failed";
    try {
      return await measureHistoryRead("gatewaySourceMs", async () => {
        const result = await this.nativeRead(request, context, signal, strict, authorized, directoryFence, allowLiveItemProgress, sourceRead, observation, directoryObservation);
        outcome = "ok";
        const timing = object(result.__opencraftHistoryTiming);
        const trace = historyReadTiming.getStore();
        for (const [source, target] of [["coreMs", "historyCoreMs"], ["queueMs", "historyQueueMs"], ["nativeRpcMs", "historyNativeRpcMs"], ["projectionMs", "historyProjectionMs"]])
          addHistoryReadTiming(trace, target!, timing[source!]);
        return result;
      });
    } catch (error) {
      outcome = signal?.aborted ? "aborted" : error instanceof HistoryRequestDeadline ? "timeout" : "failed";
      throw error;
    } finally {
      if (observation) {
        observation.finished = true;
        try { this.onReadTiming?.(roundedHistoryDiagnostic({ kind: "dependency", stage: "history", method: request.method,
          gatewayPairId: observation.parent.gatewayPairId, nativeCallId: observation.nativeCallId,
          gatewayTimingVersion: 2, outcome, durationMs: performance.now() - observation.started,
          ...observation.values, ...(observation.parent.context ? {...createRequestTrace(observation.parent.context.caller,observation.parent.context.trigger,observation.parent.context),...(observation.parent.context.catalogId ? {catalogId:observation.parent.context.catalogId} : {})} : {}),
          ...(request.method === "thread/list" ? observation.parent.details : {}), traceRole:"native-rpc", measurementScope: "rpc", observedBy: "self", producerMode: "native", identitySource: "self" })); } catch { /* Diagnostics cannot settle an RPC. */ }
      }
    }
  }
  private async nativeRead(request: Value, context: TransportSubmissionContext, signal?: AbortSignal, strict=false, authorized?:()=>boolean | Promise<boolean>, directoryFence?:ReadonlyMap<string,string>, allowLiveItemProgress=false, sourceRead=false, observation?: NativeReadObservation, directoryObservation?:DirectoryObservation): Promise<Value> {
    signal?.throwIfAborted();
    const client=this.clients.get(this.lane(request));
    authorized ??= ()=>this.clients.get(this.lane(request))===client && (!request.params?.threadId || this.readable(request.params.threadId,context));
    const admission = authorized();
    if (!(typeof admission === "boolean" ? admission : await admission)) throw new HistoryNotStored("Conversation is unavailable");
    const packet: Value = { ...request, id: `conversation-read:${randomUUID()}` };
    if(['opencraft/thread-context/read','opencraft/turn-configuration/read'].includes(packet.method))packet.params={...object(packet.params),historyReadId:String(packet.id)};
    const key = this.key(packet), params = object(packet.params);
    const snapshotFence = packet.method === "thread/list" ? directoryFence ?? await this.history.directoryFence() : undefined;
    if(packet.method === "thread/list")directoryObservation ??= {epoch:await this.history.directoryEpoch(params),fromHead:params.cursor==null};
    const revisionFence = sourceRead || packet.method === "initialize" ? 0 : packet.method === "thread/list" ? await this.history.catalogRevision() : await this.history.revision(params.threadId ?? "");
    signal?.throwIfAborted();
    const stillAdmitted = authorized();
    if (!(typeof stillAdmitted === "boolean" ? stillAdmitted : await stillAdmitted)) throw new HistoryNotStored("Conversation is unavailable");
    return new Promise((resolve, reject) => {
      const clear = () => { clearTimeout(pending.timer); signal?.removeEventListener("abort", abort); this.pending.delete(key); };
      const releaseDiscovery = () => {
        if(['opencraft/thread-context/read','opencraft/turn-configuration/read'].includes(packet.method))void this.forward(JSON.stringify({id:`cancel:${randomUUID()}`,method:'thread/history/cancel',
          params:{threadId:params.threadId,historyReadId:params.historyReadId},[LOGICAL_CLIENT_FIELD]:packet[LOGICAL_CLIENT_FIELD]}),context).catch(()=>{});
        // An unanswered initialize must not strand a native logical lane before a later execution attempt.
        if (packet.method === "initialize") void this.forward(JSON.stringify({ method: "runtime/client/disconnect", params: {},
          ...(packet[LOGICAL_CLIENT_FIELD] === undefined ? {} : { [LOGICAL_CLIENT_FIELD]: packet[LOGICAL_CLIENT_FIELD] }) }), context).catch(() => {});
      };
      const abort = () => { clear(); releaseDiscovery(); reject(signal?.reason ?? new Error("History read cancelled")); };
      const pending: Pending = { observation, context, executionFence: this.executionStatus.fence(), method: packet.method, params, strict, authorized, allowLiveItemProgress, sourceRead,
        ...(packet.method === "thread/list" ? {directoryFence:snapshotFence,directoryObservation} : {}), fence: revisionFence,
        resolve: result => { clear(); resolve(result); }, reject: error => { clear(); reject(error); },
        timer: setTimeout(() => {
          clear(); releaseDiscovery();
          reject(new HistoryRequestDeadline("Execution history is unavailable; stored content is preserved"));
        }, packet.method === "initialize" ? Math.min(this.timeoutMs, 1000) : this.timeoutMs) };
      this.pending.set(key, pending);
      signal?.addEventListener("abort", abort, { once: true });
      void this.forward(JSON.stringify(packet), context, signal, authorized, observation).catch(error => { clear(); reject(error); });
    });
  }
  private receive(frame: string) {
    historyReadTiming.exit(() => this.receiveFrame(frame));
  }
  private receiveFrame(frame: string) {
    const receivedAt = performance.now();
    if (this.closed || this.closing) return;
    let packet: Value;
    try { packet = JSON.parse(frame); } catch { return; }
    const countPending=packet.id!==undefined&&!packet.method?this.pending.get(this.key(packet)):undefined;
    const countReply=countPending&&(countPending.context.collaborationRequestId==='thread-count'
      ||countPending.method==='initialize'&&object(object(countPending.params.capabilities).extensions)[THREAD_COUNT_CAPABILITY]===true
      ||countPending.method===COLLABORATION_METHOD&&countPending.params.action==='threadCount');
    const source=this.inner;
    // Count replies belong to the metadata owner, not to physical Native openness.
    const guard = countReply?()=>this.inner===source&&!this.closed&&!this.closing:captureTransportMessageScope(this.inner);
    if (!guard()) return;
    const decodedAt = performance.now();
    if (typeof packet.method === "string" && packet.id === undefined) {
      // Notification delivery is deliberately synchronous and DB-free.  The
      // UI gets each live frame in the same turn as the native transport.
      this.publishExecutionStatus(this.executionStatus.observe(packet.method, object(packet.params)));
      this.publish(packet, guard);
      this.enqueueHistoryObservation(packet, guard);
      return;
    }
    const pending = packet.id !== undefined && !packet.method ? this.pending.get(this.key(packet)) : undefined;
    const observation = pending?.observation;
    if (observation && !observation.finished && observation.values.nativeReplyAtMs === undefined) {
      observation.values.nativeReplyAtMs = receivedAt - observation.started;
      observation.values.nativeDecodeMs = decodedAt - receivedAt;
      if (observation.values.nativeDispatchAtMs !== undefined)
        observation.values.nativeReplyWaitMs = Math.max(0, observation.values.nativeReplyAtMs - observation.values.nativeDispatchAtMs);
    }
    const processReply = (run: () => Promise<void>) => {
      const started = performance.now();
      if (observation && !observation.finished) observation.values.nativeReceiveQueueMs = started - decodedAt;
      const operation = observation ? historyReadTiming.run(observation.parent, run) : run();
      return operation.finally(() => {
        if (observation && !observation.finished) observation.values.nativeReplyProcessingMs = performance.now() - started;
      });
    };
    if (pending && (pending.method === "initialize" || (catalogControlMethods.has(pending.method) || exactControl(pending.method,pending.params)) || ["opencraft/thread-context/read","opencraft/turn-result/read","opencraft/turn-configuration/read"].includes(pending.method) || pending.method === "opencraft/collaboration"
      && (["context","commands","messageAttachments","threadCount","servers","projects","models","options","metadata","reference","lookup","delivery","queueRequests","send","cancel","orchestration","exactResult","turnConfigurationObservation","interactions","respondInteraction"].includes(pending.params.action)
        || pending.params.action === "discover" && pending.params.metadataOnly === true))) {
      // Discovery and collaboration receipts do not import conversation content.
      // A busy history writer must not consume their independent RPC deadline.
      void processReply(() => this.receiveControl(packet, pending, guard));
      return;
    }
    const operation = this.receiveTail.then(() => processReply(() => this.receiveOne(packet, guard)), () => processReply(() => this.receiveOne(packet, guard)));
    this.receiveTail = operation.catch(() => undefined);
  }
  private async receiveControl(packet: Value, pending: Pending, guard: () => boolean) {
    const lane = this.lane(packet), client = this.clients.get(lane), key = this.key(packet);
    const admitted = async () => {
      if (this.closed || !guard() || !client || this.clients.get(lane) !== client || this.pending.get(key) !== pending) return false;
      if (pending.context.validUntil !== undefined && pending.context.validUntil <= Date.now()) {
        if(pending.context.collaborationRequestId==='thread-count')throw Object.assign(Error('Count budget expired'),{code:'count_unknown'});
        return false;
      }
      pending.context.resourceOwner?.assertCurrent();
      if (pending.params.threadId && !this.readable(pending.params.threadId, pending.context)) return false;
      return !pending.authorized || await pending.authorized();
    };
    try {
      if (!await admitted()) throw new HistoryNotStored("Conversation is unavailable");
      // Both history ports keep initialization discovery in memory, outside SQL.
      if (!packet.error && pending.method === "initialize" && pending.context.collaborationRequestId!=='thread-count'
        &&object(object(pending.params.capabilities).extensions)[THREAD_COUNT_CAPABILITY]!==true) await this.history.initialization(object(packet.result));
      if (!await admitted()) throw new HistoryNotStored("Conversation is unavailable");
      if (pending.resolve) {
        if (packet.error) pending.reject?.(Object.assign(new Error(packet.error.message ?? "History source failed"), {code:packet.error.code,data:packet.error.data}));
        else {
          if (pending.method === "initialize" && pending.context.collaborationRequestId!=='thread-name-search'&&pending.context.collaborationRequestId!=='thread-count'&&object(object(pending.params.capabilities).extensions)[THREAD_COUNT_CAPABILITY]!==true) void this.forward(JSON.stringify({method:"initialized",[LOGICAL_CLIENT_FIELD]:lane}), {sender:null}).catch(()=>{});
          pending.resolve(object(packet.result));
        }
      } else {
        this.pending.delete(key);
        this.publish(packet, guard);
      }
    } catch (error) {
      if (this.pending.get(key) !== pending) return;
      if (pending.reject) pending.reject(error as Error);
      else { this.pending.delete(key); if (guard() && this.clients.get(lane) === client) this.replyError(packet,error,pending.context.collaborationRequestId==='thread-count'?'thread-count':undefined); }
    }
  }
  private async receiveOne(packet: Value, guard: () => boolean) {
    const observation = packet.id !== undefined && !packet.method ? this.pending.get(this.key(packet))?.observation : undefined;
    const yieldStarted = performance.now();
    const yieldWork = this.yieldHistoryWork(); if (yieldWork) await yieldWork;
    if (observation && !observation.finished) observation.values.nativeReplyYieldMs = performance.now() - yieldStarted;
    if (this.closed || !guard()) return;
    const pending = packet.id !== undefined && !packet.method ? this.pending.get(this.key(packet)) : undefined;
    if (pending) {
      if(pending.authorized && !await pending.authorized()){pending.reject?.(new HistoryNotStored("Conversation is unavailable"));return;}
      if (!packet.error && !pending.sourceRead) {
        // A live notification may have been forwarded already, but its
        // durable revision must be visible before importing a source reply.
        const pendingWritesStarted = performance.now();
        await this.waitForHistoryWrites();
        if (pending.observation && !pending.observation.finished) pending.observation.values.nativePendingWritesMs = performance.now() - pendingWritesStarted;
        if (this.closed || !guard() || pending.authorized && !await pending.authorized()) {
          pending.reject?.(new HistoryNotStored("Conversation is unavailable")); return;
        }
        try {
          const result=object(packet.result);
          if(pending.directoryObservation && pending.directoryObservation.epoch !== await this.history.directoryEpoch(pending.params))
            throw Object.assign(new Error("Directory observation expired; retry this page"),{code:-32075});
          const snapshotStarted = performance.now();
          const changedStatus = this.executionStatus.snapshot(pending.method, result, pending.executionFence);
          if (observation && !observation.finished) {
            observation.values.nativeStatusSnapshotMs = performance.now() - snapshotStarted;
            observation.values.nativeStatusChanges = changedStatus.length;
          }
          const publishStarted = performance.now();
          try {
            const attempts = this.publishExecutionStatus(changedStatus);
            if (observation && !observation.finished) observation.values.nativeStatusPublishAttempts = attempts;
          } finally {
            // Includes existing access checks, serialization and local delivery;
            // no extra policy/SQL calls and no acknowledgement from a browser.
            if (observation && !observation.finished) observation.values.nativeStatusPublishMs = performance.now() - publishStarted;
          }
          if(pending.strict && pending.method==="thread/list" && (!Array.isArray(result.data)
            || result.nextCursor!=null && typeof result.nextCursor!=="string"
            || result.data.some((row:Value)=>typeof row?.id!=="string" || !row.id)))
            throw new HistoryNotStored("Source directory content is unavailable");
          if(pending.strict && pending.method==="thread/read" && result.thread?.id!==pending.params.threadId)
            throw new HistoryNotStored("Source metadata identity is unavailable");
          if(pending.strict && pending.method==="thread/turns/list" && (!Array.isArray(result.data)
            || result.nextCursor!=null && typeof result.nextCursor!=="string"
            || result.data.some((turn:Value)=>!Array.isArray(turn.items) || turn.itemsView!=null && turn.itemsView!=="full"
              || turn.items.some((entry:Value)=>!object(entry.item??entry).id || object(entry.item??entry).historyDetail))))
            throw new HistoryNotStored("Complete source history content is unavailable");
          if(pending.strict && pending.method==="thread/items/list" && (!Array.isArray(result.data)
            || result.nextCursor!=null && typeof result.nextCursor!=="string"
            || result.data.some((entry:Value)=>!object(entry.item??entry).id || object(entry.item??entry).historyDetail
              || entry.turnId!==undefined && entry.turnId!==pending.params.turnId)))
            throw new HistoryNotStored("Source Item identity is unavailable");
          // Insert source imports into the same mutation tail, including live
          // observations accepted while earlier worker requests were awaited.
          const admit=()=>!this.closed && guard() && this.pending.get(this.key(packet))===pending
            && (!pending.params.threadId || this.readable(pending.params.threadId,pending.context));
          const importQueuedAt = performance.now();
          const operation=this.historyWriteTail.then(async()=>{
            if(!admit())throw new HistoryNotStored("Conversation source is unavailable");
            const importStarted = performance.now();
            if (pending.observation && !pending.observation.finished) pending.observation.values.nativeImportQueueMs = importStarted - importQueuedAt;
            try { return await this.history.importResult(pending.method,pending.params,result,pending.fence,pending.directoryFence,pending.allowLiveItemProgress,admit,pending.directoryObservation); }
            finally { if (pending.observation && !pending.observation.finished) pending.observation.values.nativeImportMs = performance.now() - importStarted; }
          });
          this.historyWriteTail=operation.then(()=>undefined,()=>undefined);
          const imported=await operation;
          const sourcePage=pending.method==="thread/turns/list"?result:result.initialTurnsPage;
          if(imported && Array.isArray(sourcePage?.data) && typeof pending.params.threadId==="string") {
            const coverage=(await this.history.read("thread/turns/list",{threadId:pending.params.threadId,limit:1,itemsView:"notLoaded"})).historyCoverage;
            if(coverage.next===(sourcePage.nextCursor??null) && sourcePage.data.every((row:Value)=>coverage.visible?.includes(`group:${row.id}`)))
              this.turnCheckpoints.set(JSON.stringify([this.lane(packet),pending.params.threadId]),{cursor:sourcePage.nextCursor??null,coverage:JSON.stringify(coverage)});
          }
          if(!imported && readMethods.has(pending.method))throw Object.assign(new Error("History changed during import; retry this page"),{code:-32075});
        }catch(error) {
          this.diagnostic("history-persistence-failed");
          if(pending.strict){pending.reject?.(error as Error);return;}
          this.needRepair(packet,pending.params,guard);
        }
      }
      if (!guard() || pending.params.threadId && !this.readable(pending.params.threadId,pending.context)) {
        pending.reject?.(new HistoryNotStored("Conversation is unavailable")); return;
      }
      if (pending.resolve) {
        if (packet.error) pending.reject?.(Object.assign(new Error(packet.error.message ?? "History source failed"), { code: packet.error.code, data: packet.error.data }));
        else {
          if (pending.method === "initialize") void this.forward(JSON.stringify({ method: "initialized", [LOGICAL_CLIENT_FIELD]: this.lane(packet) }), { sender: null }).catch(() => {});
          pending.resolve(object(packet.result));
        }
        return;
      }
      this.pending.delete(this.key(packet));
    } else if (!packet.method && typeof packet.id === "string" && packet.id.startsWith("conversation-read:")) return;
    this.publish(packet, guard);
  }
  private replyError(request: Value, error: unknown, readKind?:'thread-count') {
    if (request.id === undefined || this.closed) return;
    if(readKind==='thread-count'){
      const fault=object(error),code=['count_unknown','thread_count_unknown'].includes(fault.code)||error instanceof HistoryRequestDeadline?'thread_count_unknown':fault.code==='unsupported_capability'?'unsupported_capability':'thread_count_unavailable';
      this.publish({...this.envelope(request),error:{code:-32073,message:'Recorded thread count unavailable',data:{code,
        ...([401,403].includes(Number(fault.status))?{status:fault.status}:{})}}});return;
    }
    const failure = error as { code?: number; message?: string };
    this.publish({ ...this.envelope(request), error: { code: typeof failure?.code === "number" ? failure.code : -32074,
      message: failure?.message ?? "Conversation history is unavailable",
      ...(error instanceof InvalidHistoryCursor && error.data ? { data: error.data }
        : request.method === "initialize" && error instanceof HistoryRequestDeadline
          ? { data: { code: "HISTORY_READ_UNAVAILABLE" } } : {}),
    } });
  }
  async close() {
    if (this.closed || this.closing) return;
    this.closing = true;this.cancelTextReads();
    // Drain accepted live observations before tearing down the database
    // owner.  New ingress is rejected while the drain is in progress.
    await this.waitForHistoryWrites();
    await this.receiveTail;
    this.closed = true;
    for (const remove of this.watchSubscriptions.values()) remove();
    this.watchSubscriptions.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject?.(new Error("Conversation transport closed")); }
    this.executionStatus.clear();
    this.pending.clear(); this.clients.clear(); this.watches.clear(); this.observedDirectories.clear(); this.directoryCheckpoints.clear(); this.turnCheckpoints.clear(); this.itemCheckpoints.clear()
    for(const [key,repair] of this.repairs)this.cancelRepair(key,repair);
    this.removeCommitted();
    for (const remove of this.removers) remove();
    await this.inner.close(); await this.history.close?.(); this.publishStatus({ state: "closed" }); this.messages.clear(); this.statuses.clear();
  }
}
