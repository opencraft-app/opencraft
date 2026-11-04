import {readLatestContext} from './context-window.js';
import {unknownContext,type ThreadContextObservation} from '@opencraft/appserver-protocol/collaboration';
import { ExactReadUnavailable, ExactResultConflict, exactTurnResult, targetWatermark } from './exact-turn-result.js';
import { unobservedTurnConfiguration, type TurnConfigurationObservation, type ConversationTurnResult } from '@opencraft/appserver-protocol/collaboration';
import { createHash, randomUUID } from "node:crypto";
import { access, open, stat } from "node:fs/promises";
import { TranscriptCacheWorker } from "./transcript-cache-worker.js";
import { resolveCacheDataDirectory } from "./cache-directory.js";
import { join } from "node:path";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import type { AppServerThread, AppServerTurn, ThreadTurnsListResponse } from "@opencraft/appserver-protocol";
import { canonicalRolloutPath, readRolloutIncrement, type NativeRolloutSource } from "./codex-rollout-reader.js";

export const TRANSCRIPT_PROJECTION_SCHEMA = 2;
export class NativeItemPaginationUnsupported extends Error {}
const DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS = 30_000;
export { TRANSCRIPT_CACHE_MIGRATIONS } from "./transcript-cache-schema.js";
type Row = Record<string, any>;
type NativePage = { data: AppServerTurn[]; nextCursor: string | null };
/** A native store that is not an append-only Codex rollout (for example a
 * SQLite database plus its WAL). Its reader remains the projection authority.
 * A changed watermark reads a consistent native snapshot and compares its
 * ordered Turn prefix. Database bytes are never JSONL append positions.
 */
export interface NativeTranscriptSnapshotSource {
  readonly path: string;
  readonly key: string;
  readonly identity: string;
  readonly watermark: string;
  readonly position: number;
  validate(): Promise<void>;
}
/** Observe native files without opening a writer, Harness or execution owner.
 * The first file is required; optional companions include SQLite's WAL. */
export async function observeNativeTranscriptFiles(nativeHome: string, paths: readonly string[], key: string): Promise<NativeTranscriptSnapshotSource> {
  if (!paths.length) throw new Error("Native transcript source has no files");
  const canonical = await canonicalRolloutPath(paths[0]!, nativeHome);
  const observed: Array<{ path: string; identity: string; watermark: string; position: number } | null> = [];
  for (let index = 0; index < paths.length; index++) {
    try {
      const path = await canonicalRolloutPath(paths[index]!, nativeHome);
      // SQLite can change a WAL's permissions/ctime when another read-only
      // connection opens it. Only content changes belong in this watermark.
      observed.push({ path, ...await stamp(path, false) });
    } catch (error) {
      if (index === 0 || object(error).code !== "ENOENT") throw error;
      observed.push(null);
    }
  }
  const position = observed.reduce((total, file) => total + (file?.position ?? 0), 0);
  if (!Number.isSafeInteger(position)) throw new Error("Native transcript exceeds safe file size");
  return { path: canonical, key, identity: observed[0]!.identity,
    watermark: JSON.stringify(observed), position,
    async validate() {
      if (await canonicalRolloutPath(paths[0]!, nativeHome) !== canonical) throw new Error("Native transcript source replaced");
    },
  };
}
export type HistoryReadPhase = "metadata" | "queue" | "source" | "reconcile" | "page" | "scan";
export type ItemHydrationPath = "cache-page" | "adapter-oversize-fallback";
export type HistoryReadContext = { itemHydrationPath?: ItemHydrationPath; turnCountBucket?: string; lengthBucket?: string; itemQueueMs?: number; activePhase?: HistoryReadPhase | "projection" };
export type HistoryReadObserver = (phase: HistoryReadPhase | "context" | "start", ms: number, context?: HistoryReadContext) => void;
function observeStart(observer: HistoryReadObserver | undefined, phase: HistoryReadPhase): void {
  try { observer?.("start", 0, { activePhase: phase }); } catch { /* Diagnostics never own read settlement. */ }
}
function observe(observer: HistoryReadObserver | undefined, phase: HistoryReadPhase, started: number): void {
  try { observer?.(phase, Math.max(0, performance.now() - started)); } catch { /* Diagnostics never own read settlement. */ }
}
function observeContext(observer: HistoryReadObserver | undefined, context: HistoryReadContext): void {
  try { observer?.("context", 0, context); } catch { /* Diagnostics never own read settlement. */ }
}
export function historyTurnCountBucket(value: number): string {
  return !Number.isSafeInteger(value) || value < 0 ? "unknown" : value === 0 ? "0" : value <= 10 ? "1-10"
    : value <= 50 ? "11-50" : value <= 100 ? "51-100" : value <= 500 ? "101-500"
      : value <= 1000 ? "501-1000" : "1001+";
}
export function historyLengthBucket(bytes: number): string {
  return !Number.isSafeInteger(bytes) || bytes < 0 ? "unknown" : bytes < 1_048_576 ? "<1MiB"
    : bytes < 10_485_760 ? "1-10MiB" : bytes < 52_428_800 ? "10-50MiB"
      : bytes < 104_857_600 ? "50-100MiB" : bytes < 524_288_000 ? "100-500MiB" : "500MiB+";
}
type NativeItemReadWaiter = { signal?: AbortSignal; resolve(): void; reject(error: Error): void; abort?: () => void };
export class NativeItemReadScheduler {
  private active = 0;
  private readonly waiters = new Map<string, NativeItemReadWaiter[]>();
  private readonly readyScopes: string[] = [];
  constructor(readonly concurrency = 4) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid native Item read concurrency");
  }
  async run<T>(scope: string, signal: AbortSignal | undefined, operation: () => Promise<T>, onWait?: (ms: number) => void): Promise<T> {
    const started = performance.now();
    let acquired = false;
    let waitReported = false;
    const reportWait = () => {
      if (waitReported) return;
      waitReported = true;
      try { onWait?.(Math.max(0, performance.now() - started)); } catch { /* Diagnostics never own read settlement. */ }
    };
    try {
      await this.acquire(scope, signal);
      acquired = true;
      reportWait();
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Transcript read cancelled");
      return await operation();
    } catch (error) {
      reportWait();
      throw error;
    } finally { if (acquired) this.release(); }
  }
  private acquire(scope: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Transcript read cancelled"));
    if (this.active < this.concurrency) { this.active++; return Promise.resolve(); }
    return new Promise<void>((resolve, reject) => {
      const waiter: NativeItemReadWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.abort = () => {
          const queue = this.waiters.get(scope);
          const index = queue?.indexOf(waiter) ?? -1;
          if (queue && index >= 0) queue.splice(index, 1);
          if (queue && queue.length === 0) {
            this.waiters.delete(scope);
            const ready = this.readyScopes.indexOf(scope);
            if (ready >= 0) this.readyScopes.splice(ready, 1);
          }
          signal.removeEventListener("abort", waiter.abort!);
          reject(signal.reason instanceof Error ? signal.reason : new Error("Transcript read cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      const queue = this.waiters.get(scope);
      if (queue) queue.push(waiter);
      else { this.waiters.set(scope, [waiter]); this.readyScopes.push(scope); }
      this.dispatch();
    });
  }
  private release(): void {
    this.active--;
    this.dispatch();
  }
  private dispatch(): void {
    while (this.active < this.concurrency && this.readyScopes.length) {
      const scope = this.readyScopes.shift()!, queue = this.waiters.get(scope);
      if (!queue?.length) { this.waiters.delete(scope); continue; }
      const waiter = queue.shift()!;
      if (queue.length) this.readyScopes.push(scope); else this.waiters.delete(scope);
      if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(waiter.signal.reason instanceof Error ? waiter.signal.reason : new Error("Transcript read cancelled"));
        continue;
      }
      this.active++;
      waiter.resolve();
    }
}
}

export interface NativeTranscriptPort {
  nativeHome?: string;
  resolveSource?(threadId: string, path: string, signal?: AbortSignal): Promise<NativeRolloutSource>;
  observeSnapshotSource?(threadId: string): Promise<NativeTranscriptSnapshotSource | null>;
  readThread(threadId: string, signal?: AbortSignal): Promise<AppServerThread>;
  listTurns(threadId: string, cursor: string | null, limit: number, signal?: AbortSignal, sortDirection?: "asc" | "desc"): Promise<NativePage>;
  /** Optional paired native ports: index every Turn without projecting hidden
   * Item bodies, then materialize only the Turns a caller actually requests. */
  /** A single native header page, without full-Turn or index-building fallback. */
  listRecentTurnHeaders?(threadId: string, limit: number, signal?: AbortSignal): Promise<NativePage>;
  listTurnHeaders?(threadId: string, cursor: string | null, limit: number, signal?: AbortSignal): Promise<NativePage>;
  listTurnItems?(threadId: string, turnId: string, signal?: AbortSignal, path?: ItemHydrationPath): Promise<AppServerTurn["items"]>;
}
function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw reason instanceof Error ? reason : new Error("Transcript read cancelled");
}
async function awaitWithAbort<T>(value: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  // Observe a rejected operation even when cancellation won before this call.
  const operation = Promise.resolve(value);
  void operation.catch(() => {});
  throwIfAborted(signal);
  if (!signal) return await operation;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Transcript read cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
async function exists(path: string): Promise<boolean> {try {await access(path);return true;}catch(error){if(object(error).code==="ENOENT")return false;throw error;}}
async function stamp(path: string, withCtime = true): Promise<{identity:string;watermark:string;position:number}> {
  const s=await stat(path,{bigint:true});
  if(!s.isFile()||s.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("Invalid native transcript");
  const identity=`${s.dev}:${s.ino}`;
  return {identity,watermark:`${identity}:${s.size}:${s.mtimeNs}${withCtime?`:${s.ctimeNs}`:""}`,position:Number(s.size)};
}
async function fileLength(path: string): Promise<number> {try{return (await stat(path)).size;}catch{return -1;}}
/** Disposable normalized native history. The native reader owns projection
 * semantics; the Stage 5 rollout cursor identifies the dirty suffix. A cache
 * projection hit uses stat + indexed pread, with no history paging, model RPC
 * or Resume. Native Thread metadata is revalidated separately on every read.
 */
export class TranscriptReadCache {
  private readonly storage: TranscriptCacheWorker;
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private closed = false;
  private closing?: Promise<void>;
  private headerPagesSupported = true;
  readonly directory: string;
  private readonly schema: number;
  get outcome(): DatabaseOutcome | null {return this.storage.outcome;}
  constructor(readonly dataDirectory: string, private readonly port: NativeTranscriptPort,
    options: { projectionSchema?: number; itemReadScheduler?: NativeItemReadScheduler; measured?(event: { kind: "hit" | "rebuild" | "increment"; ms: number; nativeBytes: number }): void } = {}) {
    const cacheData = resolveCacheDataDirectory(dataDirectory);
    this.directory = join(cacheData, "cache", "transcripts");
    this.schema = options.projectionSchema ?? TRANSCRIPT_PROJECTION_SCHEMA;
    this.storage = new TranscriptCacheWorker(cacheData, this.schema);
    this.itemReadScheduler = options.itemReadScheduler ?? new NativeItemReadScheduler();
    this.measured = options.measured;
  }
  private readonly itemReadScheduler: NativeItemReadScheduler;
  private readonly measured?: (event: { kind: "hit" | "rebuild" | "increment"; ms: number; nativeBytes: number }) => void;
  private async serialize<T>(id: string, run: () => Promise<T>, signal?: AbortSignal, onQueued?: (ms: number) => void): Promise<T> {
    if (this.closed) throw new Error("Transcript cache closed");
    const prior = this.jobs.get(id);
    const queued = performance.now(); let reported = false;
    const report = () => { if (reported) return; reported = true; try { onQueued?.(Math.max(0, performance.now() - queued)); } catch { /* Diagnostics never own read settlement. */ } };
    // Cancellation ends a reader's wait, never the serialization barrier of
    // its predecessor. Later writers must still queue behind actual cleanup.
    const operation = (prior ?? Promise.resolve()).catch(() => {}).then(() => { report(); throwIfAborted(signal); return run(); });
    this.jobs.set(id, operation);
    void operation.finally(() => { if (this.jobs.get(id) === operation) this.jobs.delete(id); }).catch(() => {});
    try { return await awaitWithAbort(operation, signal); }
    catch (error) { report(); throw error; }
  }
  /** Admission generation for concurrent readers, independent of cursor epochs. */
  readRevision(threadId: string): number { return this.revisions.get(threadId) ?? 0; }
  invalidate(threadId: string): Promise<void> {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    return this.serialize(threadId, async () => { await this.storage.drop(threadId); });
  }
  async watermark(threadId: string): Promise<{identity:string;position:number}|null> {
    const row = await this.storage.meta(threadId);
    return row ? {identity:row.source_identity,position:row.source_cursor} : null;
  }

  /** Native metadata stays live; it is never served from this cache. */
  async read(threadId: string, limit = 10, onValidated?: () => void, itemsView: "full" | "notLoaded" | "presentation" = "full", signal?: AbortSignal, observer?: HistoryReadObserver): Promise<{ thread: AppServerThread; initialTurnsPage: ThreadTurnsListResponse }> {
    if(this.closed)throw new Error("Transcript cache closed");
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const metadataStarted = performance.now();
    observeStart(observer, "metadata");
    let thread: AppServerThread;
    try { thread = await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal); }
    finally { observe(observer, "metadata", metadataStarted); }
    observeContext(observer, { turnCountBucket: historyTurnCountBucket(Number(thread.historyTurnCount)),
      lengthBucket: typeof thread.path === "string" ? historyLengthBucket(await fileLength(thread.path)) : "unknown" });
    throwIfAborted(effectiveSignal);
    if (this.closed || revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated");
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    onValidated?.();
    const initialTurnsPage = await this.page(threadId, null, limit, thread, itemsView, "desc", effectiveSignal, observer);
    return { thread: { ...thread, historyTurnCount: initialTurnsPage.totalTurnCount }, initialTurnsPage };
  }
  /** A fresh recent observation never opens or rebuilds the disposable index. */
  async recentHeaders(threadId: string, limit: number, signal?: AbortSignal): Promise<ThreadTurnsListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error("Invalid recent Turn limit");
    if (!this.port.listRecentTurnHeaders) throw new NativeItemPaginationUnsupported("Recent native headers are unavailable");
    if(this.closed)throw new Error("Transcript cache closed");
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const current = () => {
      throwIfAborted(effectiveSignal);
      if (this.closed || revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated");
    };
    current();
    const thread = await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal);
    current();
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    const page = await awaitWithAbort(this.port.listRecentTurnHeaders(threadId, limit, effectiveSignal), effectiveSignal);
    current();
    if (!Array.isArray(page.data) || page.data.length > limit || page.data.some(turn => typeof turn.id !== "string"
      || turn.itemsView !== "notLoaded" || !Array.isArray(turn.items) || turn.items.length !== 0)
      || page.nextCursor !== null && typeof page.nextCursor !== "string") throw new NativeItemPaginationUnsupported("Invalid recent native headers");
    return page;
  }
  /** Latest recorded window size/usage; no cold history index or Native execution. */
  async context(threadId:string,signal?:AbortSignal):Promise<ThreadContextObservation> {
    const budget=signal?AbortSignal.any([signal,AbortSignal.timeout(9000)]):AbortSignal.timeout(9000);
    const revision=this.readRevision(threadId);
    const current=()=>{budget.throwIfAborted();if(this.closed||revision!==this.readRevision(threadId))throw Error('Source changed');};
    try {return await this.itemReadScheduler.run(threadId,budget,async()=>{
      current();const thread=await awaitWithAbort(this.port.readThread(threadId,budget),budget);current();
      if(thread.id!==threadId||typeof thread.path!=='string')return unknownContext('source-unavailable');
      if(!this.port.resolveSource&&!this.port.nativeHome)return unknownContext('source-unavailable');
      const source=this.port.resolveSource?await awaitWithAbort(this.port.resolveSource(threadId,thread.path,budget),budget)
        :{nativeHome:this.port.nativeHome!,key:JSON.stringify(['single',this.port.nativeHome]),validate:async()=>{}};
      const result=await readLatestContext(thread.path,source,budget);current();return result;
    });}catch {signal?.throwIfAborted();return unknownContext(budget.aborted?'read-budget':'source-unavailable');}
  }
  /** Opt-in metadata only; shares exact target/source authority and never builds an index. */
  async configuration(threadId: string, turnId: string, signal?: AbortSignal): Promise<TurnConfigurationObservation> {
    signal?.throwIfAborted();
    const budget = signal ? AbortSignal.any([signal,AbortSignal.timeout(9000)]) : AbortSignal.timeout(9000);
    const revision = this.readRevision(threadId), pages = {remaining:20};
    const current = () => { budget.throwIfAborted(); if(this.closed||revision!==this.readRevision(threadId)) throw new Error('Source invalidated'); };
    const unknown = () => unobservedTurnConfiguration(turnId);
    try { return await this.itemReadScheduler.run(threadId,budget,async()=>{
      current();
      const before = await this.result(threadId,turnId,false,null,budget,pages); current();
      if(!before.watermark||pages.remaining<1) return unknown(); // Must remain visible in canonical Native history.
      const thread = await awaitWithAbort(this.port.readThread(threadId,budget),budget); current();
      if(thread.id!==threadId || typeof thread.path!=='string') return unknown();
      const source = this.port.resolveSource ? await awaitWithAbort(this.port.resolveSource(threadId,thread.path,budget),budget)
        : {nativeHome:this.port.nativeHome!,key:JSON.stringify(['single',this.port.nativeHome]),validate:async()=>{}};
      const path = await awaitWithAbort(canonicalRolloutPath(thread.path,source.nativeHome),budget); current();
      const sourceStat = await stat(path,{bigint:true}), identity = `${sourceStat.dev}:${sourceStat.ino}`, birth = sourceStat.birthtimeNs;
      const end = Number(sourceStat.size);
      // Two bounded passes verify a retained prefix without freezing out unrelated appends.
      if(end>8*1024*1024) return unknown();
      let session=false,started=false,bad=false,startAt:number|null=null;
      let first: {model:string|null;reasoningEffort:string|null;recordedAt:string}|null=null;
      const field=(p:Record<string,any>,key:string) => {
        const v=p[key]; if(v==null)return null;
        if(typeof v!=='string'||!v||v.length>256||/[\s\x00-\x1f]/u.test(v))throw Error('Invalid context field');
        return v;
      };
      const fingerprints:string[]=[];
      let offset=0;
      while(offset<end) {
        current();
        const batch=await readRolloutIncrement<never>({path,nativeHome:source.nativeHome,source,cursor:offset,identity,
          end,signal:budget,fingerprint:true,stopOnOversized:true,maxRecords:128,
          // Unknown/bad record tags cannot be skipped as if the prefix were proven complete.
          select:head=>!/^\s*\{[^\n]*?"type"\s*:\s*"(?:response_item|event_msg)"/.test(head)
            || /"type"\s*:\s*"(?:task_started|thread_rolled_back)"/.test(head),
          retain:(row:any)=>{
            const p=object(row.payload);
            if(typeof row.type!=='string') {bad=true;return null;}
            if(row.type==='session_meta') { if(p.id!==threadId||session)bad=true;session=true; }
            if(row.type==='compacted'||p.type==='thread_rolled_back')bad=true;
            if(row.type==='event_msg'&&p.type==='task_started'&&p.turn_id===turnId) { if(started||!session)bad=true;started=true;startAt=Date.parse(row.timestamp);if(!Number.isSafeInteger(startAt)||startAt<0)bad=true; }
            if(row.type==='turn_context') {
              if(typeof p.turn_id!=='string')bad=true;
              if(p.turn_id===turnId) {
                if(!session||!started)bad=true;
                const at=Date.parse(row.timestamp);
                if(typeof row.timestamp!=='string'||!Number.isSafeInteger(at)||at<0||startAt===null||at<startAt) {bad=true;return null;}
                const value={model:field(p,'model'),reasoningEffort:field(p,'effort'),recordedAt:row.timestamp};
                if(first&&(first.model!==value.model||first.reasoningEffort!==value.reasoningEffort))bad=true;
                first??=value; // Equal duplicates retain the first record's time and never fill missing fields.
              }
            }
            return null;
          },oversized:()=>true});
        current(); if(batch.missing||batch.cursor===offset) return unknown();
        fingerprints.push(batch.fingerprint!);offset=batch.cursor;
      }
      if(bad||!session||!started||!first)return unknown();
      // Detect same-inode rewrites as well as epoch/inode replacement. Never return raw bytes.
      const verificationStamp=await stat(path,{bigint:true});
      offset=0;let part=0;
      while(offset<end) {
        current();const batch=await readRolloutIncrement<never>({path,nativeHome:source.nativeHome,source,cursor:offset,identity,
          end,signal:budget,fingerprint:true,stopOnOversized:true,select:()=>false,retain:()=>null});
        if(batch.missing||batch.cursor===offset||batch.fingerprint!==fingerprints[part++])return unknown();offset=batch.cursor;
      }
      await awaitWithAbort(source.validate(budget),budget);current();
      const after=await this.result(threadId,turnId,false,null,budget,pages);current();
      if(before.watermark!==after.watermark)return unknown();
      await awaitWithAbort(source.validate(budget),budget);current();
      const afterStat=await stat(path,{bigint:true});
      if(`${afterStat.dev}:${afterStat.ino}`!==identity||afterStat.birthtimeNs!==birth
        ||afterStat.mtimeNs!==verificationStamp.mtimeNs||afterStat.ctimeNs!==verificationStamp.ctimeNs)return unknown();
      const context=first as {model:string|null;reasoningEffort:string|null;recordedAt:string};
      return {...unknown(),...context,status:'observed',coverage:'complete-retained-prefix',initiality:'start-boundary-observed',
        watermark:targetWatermark(threadId,turnId,source.key,`${identity}:${birth}`,JSON.stringify(context))};
    }); } catch(error) {
      signal?.throwIfAborted();
      return unobservedTurnConfiguration(turnId,error instanceof NativeItemPaginationUnsupported?'unsupported'
        : budget.aborted||error instanceof ExactResultConflict?'unknown':'unavailable');
    }
  }
  /** Bounded source read owned here, without creating/rebuilding a cold history index. */
  async result(threadId: string, turnId: string, output: boolean, cursor: string | null, signal?: AbortSignal, pages = {remaining:20}): Promise<ConversationTurnResult> {
    const budget = signal ?? AbortSignal.timeout(9000);
    const deadline = performance.now() + 9000;
    const revision = this.readRevision(threadId);
    const current = () => { if(performance.now() >= deadline) throw new Error('Exact result budget exhausted'); throwIfAborted(budget); if (this.closed || revision !== this.readRevision(threadId)) throw new Error('Result source invalidated'); };
    const thread = await awaitWithAbort(this.port.readThread(threadId,budget),budget); current();
    if (thread.id !== threadId || typeof thread.path !== 'string' || !await exists(thread.path)) throw new ExactReadUnavailable('Exact result source unavailable');
    const source = this.port.resolveSource ? await awaitWithAbort(this.port.resolveSource(threadId,thread.path,budget),budget)
      : {nativeHome:this.port.nativeHome!,key:JSON.stringify(['single',this.port.nativeHome]),validate:async()=>{}};
    const path = await awaitWithAbort(canonicalRolloutPath(thread.path,source.nativeHome),budget);
    const sourceIdentity = async () => {const value=await stat(path,{bigint:true});return `${value.dev}:${value.ino}:${value.birthtimeNs}`;};
    const identity = await sourceIdentity();
    let position: string | null = null;
    const seen = new Set<string>();
    let exhausted = false;
    while(pages.remaining-- > 0) {
      current();
      let page: NativePage;
      try {
        page = await awaitWithAbort(this.port.listTurnHeaders
          ? this.port.listTurnHeaders(threadId,position,1,budget)
          : this.port.listTurns(threadId,position,1,budget,'desc'),budget);
      } catch (error) {
        if (error instanceof NativeItemPaginationUnsupported || Number(object(error).code) === -32601)
          throw new NativeItemPaginationUnsupported('Native Turn headers unsupported', {cause:error});
        throw new ExactReadUnavailable('Native Turn header read unavailable',{cause:error});
      }
      current();
      if (!Array.isArray(page.data) || page.data.length>1 || page.nextCursor!==null && typeof page.nextCursor!=='string') throw new Error('Invalid target page');
      let turn=page.data.find(value=>value.id===turnId);
      if(turn) {
        if(output && ['completed','failed','interrupted'].includes(String(turn.status))) {
          if(turn.itemsView!=='full') {
            let full: NativePage;
            try { full=await awaitWithAbort(this.port.listTurns(threadId,position,1,budget,'desc'),budget); }
            catch(error) { throw new ExactReadUnavailable('Complete target hydration unavailable',{cause:error}); }
            current();
            if(full.data.length!==1 || full.data[0]?.id!==turnId) { position=null;seen.clear();continue; }
            turn=full.data[0];
          }
          if(turn.itemsView!=='full') {
            if(!this.port.listTurnItems) throw new ExactReadUnavailable('Complete target unavailable');
            try {
              const items=await this.itemReadScheduler.run(threadId,budget,()=>awaitWithAbort(this.port.listTurnItems!(threadId,turnId,budget,'cache-page'),budget));
              turn={...turn,items,itemsView:'full'};
            } catch(error) { throw new ExactReadUnavailable('Complete target hydration unavailable',{cause:error}); }
          }
          if(!Array.isArray(turn.items)) throw new Error('Incomplete target');
        }
        await awaitWithAbort(source.validate(budget),budget);current();
        if(await sourceIdentity()!==identity) throw new ExactResultConflict('Source replaced');
        const hash=createHash('sha256').update(JSON.stringify(turn)).digest('hex');
        const result = exactTurnResult(turnId,turn,targetWatermark(threadId,turnId,source.key,identity,hash),output,cursor);
        current();return result;
      }
      if(page.nextCursor===null){exhausted=true;break;}
      if(seen.has(page.nextCursor))throw new Error('Repeated native cursor');
      seen.add(page.nextCursor);position=page.nextCursor;
    }
    await awaitWithAbort(source.validate(budget),budget);current();
    if (cursor && !exhausted) throw new Error('Target not located within the bounded source window');
    return exactTurnResult(turnId,undefined,null,output,cursor);
  }
  async page(threadId: string, cursor: string | null, limit = 10, metadata?: AppServerThread, itemsView: "full" | "notLoaded" | "presentation" = "full", sortDirection: "asc" | "desc" = "desc", signal?: AbortSignal, observer?: HistoryReadObserver, detailItemId?: string): Promise<ThreadTurnsListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new Error("Invalid transcript page size"));
    if (sortDirection !== "asc" && sortDirection !== "desc") return Promise.reject(new Error("Invalid transcript sort direction"));
    if(this.closed)throw new Error("Transcript cache closed");
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const ensureCurrent = () => { throwIfAborted(effectiveSignal); if (this.closed || revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated"); };
    const metadataStarted = performance.now();
    if (!metadata) observeStart(observer, "metadata");
    let thread: AppServerThread;
    try { thread = metadata ?? await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal); }
    finally { if (!metadata) observe(observer, "metadata", metadataStarted); }
    ensureCurrent();
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    const prepareRollout = async () => {
      const started = performance.now();
      observeStart(observer, "source");
      try {
        const source = this.port.resolveSource ? await awaitWithAbort(this.port.resolveSource(threadId, thread.path!), effectiveSignal)
          : { nativeHome: this.port.nativeHome!, key: JSON.stringify(["single", this.port.nativeHome]), validate: async () => {} };
        const path = await awaitWithAbort(canonicalRolloutPath(thread.path!, source.nativeHome), effectiveSignal);
        ensureCurrent(); return { source, path };
      } finally { observe(observer, "source", started); }
    };
    // Metadata and rollout path authorization cannot mutate the projection.
    // Snapshot-source observation stays inside the lane: its watermark must
    // describe the snapshot reconciled under the same invalidation boundary.
    const prepared = !this.port.observeSnapshotSource && typeof thread.path === "string" && await exists(thread.path)
      ? await prepareRollout() : null;
    ensureCurrent();
    observeStart(observer, "queue");
    return this.serialize(threadId, async () => {
      ensureCurrent();
      const sourceStarted = performance.now();
      if (!prepared) observeStart(observer, "source");
      let snapshotSource: NativeTranscriptSnapshotSource | null;
      try { snapshotSource = (await awaitWithAbort(Promise.resolve(this.port.observeSnapshotSource?.(threadId)), effectiveSignal)) ?? null; }
      finally { if (!prepared) observe(observer, "source", sourceStarted); }
      ensureCurrent();
      if (!snapshotSource && (typeof thread.path !== "string" || !await exists(thread.path))) {
        const pageStarted = performance.now();
        observeStart(observer, "page");
        try {
        if (cursor?.startsWith("transcript:") || cursor?.startsWith("transcript-asc:")) throw new InvalidTranscriptCursor();
        // A header consumer must not hydrate an entire unfinished Turn first.
        let page = await awaitWithAbort(itemsView === "notLoaded" && sortDirection === "desc" && this.port.listTurnHeaders
          ? this.port.listTurnHeaders(threadId, cursor, limit, effectiveSignal)
          : this.port.listTurns(threadId, cursor, limit, effectiveSignal, sortDirection), effectiveSignal);
        if (itemsView !== "notLoaded" && this.port.listTurnItems) {
          const missing = page.data.filter(turn => turn.itemsView === "notLoaded");
          if (missing.length) {
            observeContext(observer, { itemHydrationPath: "cache-page" });
            const hydrated = await Promise.allSettled(missing.map(async turn => {
              const items = await this.itemReadScheduler.run(threadId, effectiveSignal, () => awaitWithAbort(
                this.port.listTurnItems!(threadId, turn.id, effectiveSignal, "cache-page"), effectiveSignal),
                ms => observeContext(observer, { itemQueueMs: ms }));
              ensureCurrent();
              return { turn, items };
            }));
            const rejected = hydrated.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (rejected) {
              if (!(rejected.reason instanceof NativeItemPaginationUnsupported)) throw rejected.reason;
              ensureCurrent();
              this.headerPagesSupported = false;
              // An older native can still return the same page as full Turns;
              // after Item paging is rejected, let the adapter shrink that page
              // to its supported byte budget and return the complete bodies.
              page = await awaitWithAbort(this.port.listTurns(threadId, cursor, limit, effectiveSignal, sortDirection), effectiveSignal);
            } else {
              for (const result of hydrated) if (result.status === "fulfilled") {
                result.value.turn.items = result.value.items;
                result.value.turn.itemsView = "full";
              }
            }
          }
        }
        return page;
        } finally { observe(observer, "page", pageStarted); }
      }
      const rollout = snapshotSource ? null : prepared ?? await prepareRollout();
      const source = rollout?.source, path = snapshotSource?.path ?? rollout!.path;
      ensureCurrent();
      // Rollout preparation already reported source time; snapshot observation
      // is measured here, inside its required serialization boundary.
      readAttempts: for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now();
        observeStart(observer, "reconcile");
        let observed: { kind: "hit" | "rebuild" | "increment"; nativeBytes: number };
        try { observed = await this.reconcile(threadId, path, source, snapshotSource ?? undefined, effectiveSignal, observer); }
        finally { observe(observer, "reconcile", started); }
        ensureCurrent();
        const pageStarted = performance.now();
        observeStart(observer, "page");
        try {
        let page: ThreadTurnsListResponse;
        try {
          page = await this.storage.readPage(threadId, cursor, limit, itemsView, sortDirection, detailItemId);
        }
        catch (error) {
          if (object(error).code === "TRANSCRIPT_CURSOR_EXPIRED" || attempt === 1) throw error;
          await this.storage.drop(threadId); continue;
        }
        if (itemsView !== "notLoaded" && this.port.listTurnItems) {
          const hydrationTurns = page.data.filter(turn => turn.itemsView === "notLoaded");
          if (hydrationTurns.length) observeContext(observer, { itemHydrationPath: "cache-page",
            turnCountBucket: historyTurnCountBucket(typeof page.totalTurnCount === "number" ? page.totalTurnCount : Number.NaN),
            lengthBucket: historyLengthBucket(typeof thread.path === "string" ? await fileLength(thread.path) : -1) });
          const hydrated = await Promise.allSettled(hydrationTurns.map(async turn => {
          const items = await this.itemReadScheduler.run(threadId, effectiveSignal, () => awaitWithAbort(
              this.port.listTurnItems!(threadId, turn.id, effectiveSignal, "cache-page"), effectiveSignal),
              ms => observeContext(observer, { itemQueueMs: ms }));
            ensureCurrent();
            return { turn, items };
          }));
          const rejected = hydrated.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (rejected) {
            const error = rejected.reason;
            if (!(error instanceof NativeItemPaginationUnsupported)) throw error;
            ensureCurrent();
            // Some native protocols have Turn headers but no Item paginator.
            // Reconstruct full native Turns instead of publishing empty bodies.
            this.headerPagesSupported = false; await this.storage.drop(threadId);
            attempt--; continue readAttempts;
          }
          ensureCurrent();
          await this.storage.hydrate(threadId, hydrated.flatMap(result=>result.status==="fulfilled"?[{...result.value.turn,items:result.value.items,itemsView:"full" as const}]:[]));
          ensureCurrent();
          if (hydrationTurns.length) page = await this.storage.readPage(threadId, cursor, limit, itemsView, sortDirection, detailItemId);
        }
        await awaitWithAbort((snapshotSource ?? source)!.validate(), effectiveSignal); ensureCurrent();
        this.measured?.({ ...observed, ms: performance.now() - started });
        return page;
        } finally { observe(observer, "page", pageStarted); }
      }
      throw new Error("Transcript rebuild failed");
    }, effectiveSignal, ms => { try { observer?.("queue", ms); } catch { /* Diagnostics never own read settlement. */ } });
  }
  private async nativePage(threadId: string, cursor: string | null, signal?: AbortSignal, initialLimit = 100): Promise<NativePage> {
    for (let limit = initialLimit; ; limit = Math.max(1, Math.floor(limit / 2))) {
      try {
        const page = await awaitWithAbort(this.port.listTurns(threadId, cursor, limit, signal, "desc"), signal);
        if (!Array.isArray(page.data)) throw new Error("Invalid native transcript page");
        return page;
      } catch (error) {
        const sizeError = (error instanceof Error && error.message.includes("decoded message length too large")) || object(error).code === -32072
          || object(object(error).data).code === "HISTORY_RESPONSE_TOO_LARGE";
        if (!sizeError || limit === 1) throw error;
      }
    }
  }
  private async indexPage(threadId: string, cursor: string | null, signal?: AbortSignal, initialLimit = 100): Promise<NativePage> {
    if (!this.headerPagesSupported || !this.port.listTurnHeaders || !this.port.listTurnItems) return this.nativePage(threadId, cursor, signal, initialLimit);
    const page = await awaitWithAbort(this.port.listTurnHeaders(threadId, cursor, initialLimit, signal), signal);
    if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("Invalid native Turn header page");
    return { ...page, data: page.data.map(turn => turn.itemsView === "notLoaded"
      ? { ...turn, items: [], itemsView: "notLoaded" as const } : turn) };
  }
  /** SQLite and native snapshot readers may need to read their full logical
   * snapshot. Only changed/new projection records are written. A stable prefix
   * keeps its ordinal and epoch across appended Turns and the live tail's
   * updates, so an older-page cursor remains valid while execution continues.
   */
  private async reconcileSnapshot(threadId: string, source: NativeTranscriptSnapshotSource, watermark: string, meta: Row | undefined, rebuild: boolean, signal?: AbortSignal): Promise<{ kind: "rebuild" | "increment"; nativeBytes: number }> {
    const turns: AppServerTurn[] = [], cursors = new Set<string | null>();
    let cursor: string | null = null;
    do {
      throwIfAborted(signal);
      if (cursors.has(cursor)) throw new Error("Native transcript repeated cursor");
      cursors.add(cursor);
      const page = await this.nativePage(threadId, cursor, signal);
      turns.push(...page.data); cursor = page.nextCursor;
    } while (cursor !== null);
    throwIfAborted(signal);
    return this.storage.snapshot(threadId,turns,{position:source.position,identity:source.identity,path:source.path},watermark,meta,rebuild);
  }
  private async reconcile(threadId: string, path: string, source: NativeRolloutSource | undefined, snapshotSource?: NativeTranscriptSnapshotSource, signal?: AbortSignal, observer?: HistoryReadObserver): Promise<{ kind: "hit" | "rebuild" | "increment"; nativeBytes: number }> {
    throwIfAborted(signal);
    const native = snapshotSource ? { ...snapshotSource } : await stamp(path);
    native.watermark = JSON.stringify([(snapshotSource ?? source)!.key, native.watermark]);
    let meta = await this.storage.meta(threadId);
    if (meta?.projection_schema_version === this.schema && meta.source_path === path
      && meta.native_watermark === native.watermark && await this.storage.exists(threadId)) {
      return { kind: "hit", nativeBytes: 0 };
    }
    let sameSource = false;
    try { sameSource = JSON.parse(meta?.native_watermark ?? "null")?.[0] === (snapshotSource ?? source)!.key; } catch { /* legacy watermark */ }
    let rebuild = !meta || meta.projection_schema_version !== this.schema || meta.source_path !== path
      || !sameSource
      || meta.source_identity !== native.identity || !snapshotSource && meta.source_cursor > native.position
      || !await this.storage.exists(threadId);
    if (snapshotSource) return this.reconcileSnapshot(threadId, snapshotSource, native.watermark, meta, rebuild, signal);
    // Same-size edits cannot be explained by an append cursor.
    if (meta && meta.source_cursor === native.position && meta.native_watermark !== native.watermark) rebuild = true;
    let cursor = rebuild ? 0 : Number(meta!.source_cursor), identity: string | null = rebuild ? null : meta!.source_identity;
    const dirty = new Set<string>(); let bytes = 0;
    if (rebuild && this.headerPagesSupported && this.port.listTurnHeaders && this.port.listTurnItems && native.position > 0) {
      // Native headers reconstruct the entire authoritative index. There is no
      // dirty suffix to discover on a rebuild, so do not decode every tool body
      // just to find Turn IDs. A partial last record keeps the conservative scan.
      const fd = await open(path, "r"), last = Buffer.alloc(1);
      try {
        if ((await fd.read(last, 0, 1, native.position - 1)).bytesRead === 1 && last[0] === 10) {
          cursor = native.position; identity = native.identity;
        }
      } finally { await fd.close(); }
    }
    while (!snapshotSource && cursor < native.position) {
      throwIfAborted(signal);
      const scanStarted = performance.now();
      observeStart(observer, "scan");
      let read: Awaited<ReturnType<typeof readRolloutIncrement<string>>>;
      try { read = await readRolloutIncrement<string>({ path, nativeHome: source!.nativeHome, source, cursor, identity,
        select: head => /"type"\s*:\s*"(?:event_msg|turn_context|compacted)"/.test(head),
        retain: (row: any) => {
          const p = object(row.payload);
          if (row.type === "compacted" || p.type === "thread_rolled_back") rebuild = true;
          return typeof p.turn_id === "string" ? p.turn_id : null;
        }, oversized: () => false,
      }); } finally { observe(observer, "scan", scanStarted); }
      bytes += read.bytes; identity = read.identity;
      for (const id of read.events) dirty.add(id);
      if (read.missing) rebuild = true;
      if (cursor === read.cursor) break;
      cursor = read.cursor;
    }
    if (rebuild) {
      await this.storage.drop(threadId); meta = undefined;
    }
    const max = await this.storage.maximum(threadId);
    let oldestDirty = max.seq === null ? Number.NEGATIVE_INFINITY : Number(max.seq);
    for (const id of dirty) {
      const row = await this.storage.turn(threadId,id);
      if (row) oldestDirty = Math.min(oldestDirty, Number(row.turn_seq));
    }
    // Fold through the canonical native read projection rather than maintaining
    // a second implementation of Codex message/tool/compaction semantics.
    let nativeCursor: string | null = null, descendingSeq = 0;
    const fresh: AppServerTurn[] = [], seen = new Set<string | null>();
    let reachedBoundary = false;
    do {
      if (seen.has(nativeCursor)) throw new Error("Native transcript repeated cursor");
      seen.add(nativeCursor);
      // Incremental validation usually needs only the live tail and its boundary.
      // A full hundred-Turn page can rehydrate megabytes of unchanged tool output.
      // Continue paging until the same dirty boundary; rebuilds still read all Turns.
      const page = await this.indexPage(threadId, nativeCursor, signal, rebuild ? 100 : 10);
      if(rebuild) await this.storage.batch(threadId,page.data.map(turn=>({turn,seq:-descendingSeq++})));
      else for(const turn of page.data) {
        fresh.push(turn);
        const row=await this.storage.turn(threadId,turn.id);
        if(row&&row.turn_seq<=oldestDirty){reachedBoundary=true;break;}
      }
      nativeCursor = page.nextCursor;
    } while (nativeCursor !== null && !reachedBoundary);
    if (!rebuild) {
      // A missing boundary implies a native rewrite. Start fresh next read and
      // never publish this suffix against stale older rows.
      if (max.seq !== null && !reachedBoundary) { await this.storage.drop(threadId); return this.reconcile(threadId, path, source, snapshotSource, signal, observer); }
      await this.storage.append(threadId,fresh.reverse(),Number(max.seq??-1)+1);
    }
    await this.storage.finish(threadId,native.watermark,cursor,native.identity,path,meta?.epoch??randomUUID());
    return { kind: rebuild ? "rebuild" : "increment", nativeBytes: bytes };
  }
  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;
    return this.closing=(async()=>{
      await Promise.allSettled([...this.jobs.values()]);
      await this.storage.close();
    })();
  }
}
class InvalidTranscriptCursor extends Error { constructor(){super("Transcript page expired; reload history");} }
