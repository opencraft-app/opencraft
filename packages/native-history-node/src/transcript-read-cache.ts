import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { AppServerThread, AppServerTurn, ThreadTurnsListResponse } from "@opencraft/appserver-protocol";
import { canonicalRolloutPath, readRolloutIncrement, type NativeRolloutSource } from "./codex-rollout-reader.js";

export const TRANSCRIPT_PROJECTION_SCHEMA = 2;
export class NativeItemPaginationUnsupported extends Error {}
const DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS = 30_000;
const OUTPUT_FIELDS = ["aggregatedOutput", "output", "result", "structuredResult", "contentItems", "results"] as const;
const SQL = `
CREATE TABLE opencraft_cache_meta(thread_id TEXT PRIMARY KEY,projection_schema_version INTEGER NOT NULL,
 native_watermark TEXT NOT NULL,source_cursor INTEGER NOT NULL,source_identity TEXT NOT NULL,
 source_path TEXT NOT NULL,epoch TEXT NOT NULL,total_turns INTEGER NOT NULL,updated_at_ms INTEGER NOT NULL) STRICT;
CREATE TABLE opencraft_turn_offset_index(thread_id TEXT NOT NULL,turn_seq INTEGER NOT NULL,turn_id TEXT NOT NULL,
 byte_offset INTEGER NOT NULL,byte_length INTEGER NOT NULL,content_sha256 TEXT NOT NULL,status TEXT NOT NULL,updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(thread_id,turn_seq),UNIQUE(thread_id,turn_id)) STRICT;
CREATE TABLE opencraft_cache_blobs(thread_id TEXT NOT NULL,turn_seq INTEGER NOT NULL,
 blob_sha256 TEXT NOT NULL,byte_size INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_seq,blob_sha256)) STRICT;
`;
export const TRANSCRIPT_CACHE_MIGRATIONS = [{ version: 1, name: "disposable-transcript-projection", sql: SQL }];
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
      observed.push({ path, ...stamp(path, false) });
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
export type HistoryReadContext = { itemHydrationPath?: ItemHydrationPath; turnCountBucket?: string; lengthBucket?: string; itemQueueMs?: number; activePhase?: HistoryReadPhase };
export type HistoryReadObserver = (phase: HistoryReadPhase | "context" | "start", ms: number, context?: HistoryReadContext & { activePhase?: HistoryReadPhase }) => void;
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
  resolveSource?(threadId: string, path: string): Promise<NativeRolloutSource>;
  observeSnapshotSource?(threadId: string): Promise<NativeTranscriptSnapshotSource | null>;
  readThread(threadId: string, signal?: AbortSignal): Promise<AppServerThread>;
  listTurns(threadId: string, cursor: string | null, limit: number, signal?: AbortSignal, sortDirection?: "asc" | "desc"): Promise<NativePage>;
  /** Optional paired native ports: index every Turn without projecting hidden
   * Item bodies, then materialize only the Turns a caller actually requests. */
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
function stamp(path: string, withCtime = true): { identity: string; watermark: string; position: number } {
  const s = statSync(path, { bigint: true });
  if (!s.isFile() || s.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid native transcript");
  const identity = `${s.dev}:${s.ino}`;
  return { identity, watermark: `${identity}:${s.size}:${s.mtimeNs}${withCtime ? `:${s.ctimeNs}` : ""}`, position: Number(s.size) };
}
function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = run(); db.exec("COMMIT"); return value; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
function encodeTurn(turn: AppServerTurn) {
  if (typeof turn.id !== "string" || !Array.isArray(turn.items)) throw new Error("Invalid native Turn");
  const blobs: { hash: string; size: number; body: Buffer }[] = [];
  const items = turn.items.map(item => {
    const preview = { ...item }, refs: Record<string, unknown> = {};
    for (const key of OUTPUT_FIELDS) {
      const value = preview[key];
      if (value == null) continue;
      const encoded = typeof value === "string" ? value : JSON.stringify(value);
      if (encoded === undefined || Buffer.byteLength(encoded) <= 1024) continue;
      const body = Buffer.from(encoded), hash = createHash("sha256").update(body).digest("hex");
      preview[key] = body.subarray(0, 1024).toString("utf8");
      refs[key] = { sha256: hash, byteSize: body.length, encoding: typeof value === "string" ? "utf8" : "json" };
      blobs.push({ hash, size: body.length, body });
    }
    if (Object.keys(refs).length) preview.outputBlobRef = refs;
    return preview;
  });
  const buffer = Buffer.from(JSON.stringify({ ...turn, items }) + "\n");
  return { buffer, hash: createHash("sha256").update(buffer).digest("hex"), blobs };
}

/** Only collapsed tool details are deferred. Message content and attachment
 * identities retain their existing semantics. Unknown Item types stay lossless. */
function presentationItem(item: import("@opencraft/appserver-protocol").AppServerThreadItem, cursor: string) {
  if (item.status === "inProgress" || !["commandExecution", "fileChange"].includes(item.type ?? "")) {
    // Non-tool blobs must still be restored by the full reader.
    return null;
  }
  const preview = { ...item };
  let deferred = false;
  for (const key of Object.keys(object(item.outputBlobRef))) {
    // JSON blob previews are byte prefixes, not valid protocol objects.
    preview[key] = null;
    deferred = true;
  }
  delete preview.outputBlobRef;
  if (item.type === "commandExecution") {
    if (typeof preview.command === "string" && preview.command.length > 256) { preview.command = preview.command.slice(0, 256); deferred = true; }
    if (Array.isArray(preview.commandActions)) preview.commandActions = preview.commandActions.map(action => {
      const value = object(action);
      if (typeof value.command !== "string" || value.command.length <= 256) return action;
      deferred = true; return { ...value, command: value.command.slice(0, 256) };
    });
  }
  if (item.type === "fileChange" && Array.isArray(preview.changes)) preview.changes = preview.changes.map(change => {
    const value = object(change), diff = value.diff ?? value.unifiedDiff ?? value.unified_diff;
    if (typeof diff !== "string" || diff.length <= 1024) return change;
    deferred = true;
    const { diff: _diff, unifiedDiff: _unifiedDiff, unified_diff: _unified_diff, ...rest } = value;
    const lines = diff.split("\n");
    return { ...rest, additions: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
      deletions: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length };
  });
  return deferred ? { ...preview, historyDetail: { cursor } } : preview;
}

/** Disposable normalized native history. The native reader owns projection
 * semantics; the Stage 5 rollout cursor identifies the dirty suffix. A cache
 * projection hit uses stat + indexed pread, with no history paging, model RPC
 * or Resume. Native Thread metadata is revalidated separately on every read.
 */
export class TranscriptReadCache {
  private db: DatabaseSync | null = null;
  private dbIdentity = "";
  private readonly jobs = new Map<string, Promise<unknown>>();
  private readonly revisions = new Map<string, number>();
  private closed = false;
  private headerPagesSupported = true;
  readonly directory: string;
  private readonly databasePath: string;
  private readonly schema: number;
  outcome: DatabaseOutcome | null = null;
  constructor(readonly dataDirectory: string, private readonly port: NativeTranscriptPort,
    options: { projectionSchema?: number; itemReadScheduler?: NativeItemReadScheduler; measured?(event: { kind: "hit" | "rebuild" | "increment"; ms: number; nativeBytes: number }): void } = {}) {
    this.directory = join(dataDirectory, "cache", "transcripts");
    this.databasePath = join(dataDirectory, "cache", "transcript-index.sqlite");
    this.schema = options.projectionSchema ?? TRANSCRIPT_PROJECTION_SCHEMA;
    this.itemReadScheduler = options.itemReadScheduler ?? new NativeItemReadScheduler();
    this.measured = options.measured;
  }
  private readonly itemReadScheduler: NativeItemReadScheduler;
  private readonly measured?: (event: { kind: "hit" | "rebuild" | "increment"; ms: number; nativeBytes: number }) => void;
  private database(): DatabaseSync {
    if (this.closed) throw new Error("Transcript cache closed");
    const identity = existsSync(this.databasePath) ? stamp(this.databasePath).identity : "";
    if (this.db && identity === this.dbIdentity) return this.db;
    this.db?.close(); this.db = null;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(join(this.dataDirectory, "cache"), 0o700); chmodSync(this.directory, 0o700);
    const openIndex = () => openManagedDatabase({ path: this.databasePath, migrations: TRANSCRIPT_CACHE_MIGRATIONS,
      legacyPolicy: "reject-unknown", validateSchema: createSchemaValidator(SQL) });
    let opened;
    try { opened = openIndex(); }
    catch (error) {
      const cause = object(object(error).cause), code = typeof cause.errcode === "number" ? cause.errcode & 0xff : null;
      // SQLITE_CORRUPT / SQLITE_NOTADB: only this disposable index can be
      // discarded. Busy, permission and migration errors retain their cause.
      if (code !== 11 && code !== 26) throw error;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(this.databasePath + suffix, { force: true });
      opened = openIndex();
    }
    this.db = opened.database; this.outcome = opened.outcome;
    chmodSync(this.databasePath, 0o600);
    this.dbIdentity = stamp(this.databasePath).identity;
    return this.db;
  }
  private fileKey(threadId: string): string {
    return /^[a-zA-Z0-9_-]{1,128}$/.test(threadId) ? threadId : createHash("sha256").update(threadId).digest("hex");
  }
  private paths(threadId: string) {
    const key = this.fileKey(threadId);
    return { turns: join(this.directory, `${key}.turns.jsonl`), blobs: join(this.directory, `${key}.blobs`) };
  }
  private async serialize<T>(id: string, run: () => Promise<T>, signal?: AbortSignal, onQueued?: (ms: number) => void): Promise<T> {
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
  private drop(threadId: string): void {
    const db = this.database(), paths = this.paths(threadId);
    transaction(db, () => {
      for (const table of ["opencraft_cache_meta", "opencraft_turn_offset_index", "opencraft_cache_blobs"])
        db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId);
    });
    rmSync(paths.turns, { force: true }); rmSync(paths.blobs, { recursive: true, force: true });
  }
  /** Admission generation for concurrent readers, independent of cursor epochs. */
  readRevision(threadId: string): number { return this.revisions.get(threadId) ?? 0; }
  invalidate(threadId: string): Promise<void> {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    return this.serialize(threadId, async () => { this.drop(threadId); });
  }
  watermark(threadId: string): { identity: string; position: number } | null {
    const row = this.database().prepare("SELECT source_identity,source_cursor FROM opencraft_cache_meta WHERE thread_id=?").get(threadId) as Row | undefined;
    return row ? { identity: row.source_identity, position: row.source_cursor } : null;
  }

  /** Native metadata stays live; it is never served from this cache. */
  async read(threadId: string, limit = 10, onValidated?: () => void, itemsView: "full" | "notLoaded" | "presentation" = "full", signal?: AbortSignal, observer?: HistoryReadObserver): Promise<{ thread: AppServerThread; initialTurnsPage: ThreadTurnsListResponse }> {
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const metadataStarted = performance.now();
    observeStart(observer, "metadata");
    let thread: AppServerThread;
    try { thread = await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal); }
    finally { observe(observer, "metadata", metadataStarted); }
    observeContext(observer, { turnCountBucket: historyTurnCountBucket(Number(thread.historyTurnCount)),
      lengthBucket: typeof thread.path === "string" ? historyLengthBucket((() => { try { return statSync(thread.path!).size; } catch { return -1; } })()) : "unknown" });
    throwIfAborted(effectiveSignal);
    if (revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated");
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    onValidated?.();
    const initialTurnsPage = await this.page(threadId, null, limit, thread, itemsView, "desc", effectiveSignal, observer);
    return { thread: { ...thread, historyTurnCount: initialTurnsPage.totalTurnCount }, initialTurnsPage };
  }
  async page(threadId: string, cursor: string | null, limit = 10, metadata?: AppServerThread, itemsView: "full" | "notLoaded" | "presentation" = "full", sortDirection: "asc" | "desc" = "desc", signal?: AbortSignal, observer?: HistoryReadObserver, detailItemId?: string): Promise<ThreadTurnsListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new Error("Invalid transcript page size"));
    if (sortDirection !== "asc" && sortDirection !== "desc") return Promise.reject(new Error("Invalid transcript sort direction"));
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const ensureCurrent = () => { throwIfAborted(effectiveSignal); if (revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated"); };
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
    const prepared = !this.port.observeSnapshotSource && typeof thread.path === "string" && existsSync(thread.path)
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
      if (!snapshotSource && (typeof thread.path !== "string" || !existsSync(thread.path))) {
        const pageStarted = performance.now();
        observeStart(observer, "page");
        try {
        if (cursor?.startsWith("transcript:") || cursor?.startsWith("transcript-asc:")) throw new InvalidTranscriptCursor();
        let page = await awaitWithAbort(this.port.listTurns(threadId, cursor, limit, effectiveSignal, sortDirection), effectiveSignal);
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
          page = this.readPage(threadId, cursor, limit, itemsView, sortDirection, detailItemId);
        }
        catch (error) {
          if (error instanceof InvalidTranscriptCursor || attempt === 1) throw error;
          this.drop(threadId); continue;
        }
        if (itemsView !== "notLoaded" && this.port.listTurnItems) {
          const hydrationTurns = page.data.filter(turn => turn.itemsView === "notLoaded");
          if (hydrationTurns.length) observeContext(observer, { itemHydrationPath: "cache-page",
            turnCountBucket: historyTurnCountBucket(typeof page.totalTurnCount === "number" ? page.totalTurnCount : Number.NaN),
            lengthBucket: historyLengthBucket(typeof thread.path === "string" ? (() => { try { const path = thread.path!; return statSync(path).size; } catch { return -1; } })() : -1) });
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
            this.headerPagesSupported = false; this.drop(threadId);
            attempt--; continue readAttempts;
          }
          for (const result of hydrated) if (result.status === "fulfilled") {
            ensureCurrent();
            const { turn, items } = result.value;
            const row = this.database().prepare("SELECT turn_seq FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_id=?").get(threadId, turn.id) as Row | undefined;
            if (!row) throw new Error("Transcript Turn disappeared during hydration");
            transaction(this.database(), () => this.storeTurn(threadId, { ...turn, items, itemsView: "full" }, Number(row.turn_seq)));
          }
          if (hydrationTurns.length) page = this.readPage(threadId, cursor, limit, itemsView, sortDirection, detailItemId);
        }
        await awaitWithAbort((snapshotSource ?? source)!.validate(), effectiveSignal); ensureCurrent();
        this.measured?.({ ...observed, ms: performance.now() - started });
        return page;
        } finally { observe(observer, "page", pageStarted); }
      }
      throw new Error("Transcript rebuild failed");
    }, effectiveSignal, ms => { try { observer?.("queue", ms); } catch { /* Diagnostics never own read settlement. */ } });
  }
  private readPage(threadId: string, cursor: string | null, limit: number, itemsView: "full" | "notLoaded" | "presentation", sortDirection: "asc" | "desc", detailItemId?: string): ThreadTurnsListResponse {
    const db = this.database(), meta = db.prepare("SELECT * FROM opencraft_cache_meta WHERE thread_id=?").get(threadId)! as Row;
    let before = Number.MAX_SAFE_INTEGER;
    let after = -Number.MAX_SAFE_INTEGER;
    if (cursor !== null) {
      const parsed = /^(transcript|transcript-asc):([^:]+):(-?\d+)$/.exec(cursor);
      if (!parsed || parsed[2] !== meta.epoch || !Number.isSafeInteger(Number(parsed[3]))) throw new InvalidTranscriptCursor();
      if ((sortDirection === "asc") !== (parsed[1] === "transcript-asc")) throw new InvalidTranscriptCursor();
      if (sortDirection === "asc") after = Number(parsed[3]);
      else before = Number(parsed[3]);
    }
    const rows = (sortDirection === "asc"
      ? db.prepare("SELECT * FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_seq>? ORDER BY turn_seq ASC LIMIT ?").all(threadId, after, limit + 1)
      : db.prepare("SELECT * FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_seq<? ORDER BY turn_seq DESC LIMIT ?").all(threadId, before, limit + 1)) as Row[];
    const fd = itemsView !== "notLoaded" ? openSync(this.paths(threadId).turns, "r") : null;
    try {
      const fileSize = fd === null ? 0 : fstatSync(fd).size;
      const data = rows.slice(0, limit).map(row => {
        if (fd === null) return { id: row.turn_id, status: row.status, items: [], itemsView: "notLoaded" as const };
        if (!Number.isSafeInteger(row.byte_offset) || !Number.isSafeInteger(row.byte_length)
          || row.byte_offset < 0 || row.byte_length < 1 || row.byte_length > fileSize - row.byte_offset)
          throw new Error("Invalid transcript cache offset");
        const buffer = Buffer.alloc(row.byte_length);
        const size = readSync(fd, buffer, 0, buffer.length, row.byte_offset);
        if (size !== buffer.length) throw new Error("Truncated transcript cache");
        if (createHash("sha256").update(buffer).digest("hex") !== row.content_sha256) throw new Error("Corrupt transcript cache");
        const turn = JSON.parse(buffer.toString("utf8")) as AppServerTurn;
        if (turn.id !== row.turn_id || !Array.isArray(turn.items)) throw new Error("Corrupt transcript projection");
        // The wire's existing full-items contract is lossless. Cold bodies are
        // stored separately, then restored only for the requested ten Turns.
        return { ...turn, items: turn.items.filter(item => detailItemId === undefined || item.id === detailItemId).map(item => {
          if (itemsView === "presentation") {
            const preview = presentationItem(item, `transcript:${meta.epoch}:${row.turn_seq + 1}`);
            if (preview) return preview;
          }
          const restored = { ...item };
          for (const [key, ref] of Object.entries(object(item.outputBlobRef))) {
            if (!(OUTPUT_FIELDS as readonly string[]).includes(key)) throw new Error("Invalid transcript blob field");
            const hash = object(ref).sha256;
            if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid transcript blob");
            const body = readFileSync(join(this.paths(threadId).blobs, `${hash}.blob`));
            if (createHash("sha256").update(body).digest("hex") !== hash) throw new Error("Corrupt transcript blob");
            restored[key] = object(ref).encoding === "json" ? JSON.parse(body.toString("utf8")) : body.toString("utf8");
          }
          delete restored.outputBlobRef;
          if (itemsView === "presentation" && restored.type === "mcpToolCall" && restored.status !== "inProgress"
            && !restored.mcpAppUi && !restored.appContext && !restored.mcpAppResourceUri) {
            const result = object(restored.result);
            if (Array.isArray(result.content) && Buffer.byteLength(JSON.stringify([result.content, result.structuredContent])) > 1024) {
              // Keep the tool envelope and all surface metadata (Apps/browser/
              // computer identity); only the collapsed result body is deferred.
              const { structuredContent: _structured, ...envelope } = result;
              restored.result = { ...envelope, content: [] };
              restored.historyDetail = { cursor: `transcript:${meta.epoch}:${row.turn_seq + 1}` };
            }
          }
          return restored;
        }) };
      });
      return { data, nextCursor: rows.length > limit ? `${sortDirection === "asc" ? "transcript-asc" : "transcript"}:${meta.epoch}:${rows[limit - 1]!.turn_seq}` : null,
        itemsPaginationByTurnId: {}, totalTurnCount: Number(meta.total_turns) };
    } finally { if (fd !== null) closeSync(fd); }
  }
  private storeTurn(threadId: string, turn: AppServerTurn, seq: number, encoded = encodeTurn(turn)): void {
    const db = this.database(), paths = this.paths(threadId);
    const old = db.prepare("SELECT blob_sha256 FROM opencraft_cache_blobs WHERE thread_id=? AND turn_seq=?").all(threadId, seq) as Row[];
    const { buffer, hash, blobs } = encoded;
    for (const blob of blobs) {
      mkdirSync(paths.blobs, { recursive: true, mode: 0o700 });
      if (!existsSync(join(paths.blobs, `${blob.hash}.blob`))) writeFileSync(join(paths.blobs, `${blob.hash}.blob`), blob.body, { mode: 0o600 });
    }
    const existing = db.prepare("SELECT content_sha256 FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_seq=?").get(threadId, seq) as Row | undefined;
    if (existing?.content_sha256 === hash) return;
    const offset = existsSync(paths.turns) ? statSync(paths.turns).size : 0;
    appendFileSync(paths.turns, buffer, { mode: 0o600 });
    {
      db.prepare("INSERT INTO opencraft_turn_offset_index VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,turn_seq) DO UPDATE SET turn_id=excluded.turn_id,byte_offset=excluded.byte_offset,byte_length=excluded.byte_length,content_sha256=excluded.content_sha256,status=excluded.status,updated_at_ms=excluded.updated_at_ms")
        .run(threadId, seq, turn.id, offset, buffer.length, hash, typeof turn.status === "string" ? turn.status : "unknown", Date.now());
      db.prepare("DELETE FROM opencraft_cache_blobs WHERE thread_id=? AND turn_seq=?").run(threadId, seq);
      for (const blob of blobs) db.prepare("INSERT OR IGNORE INTO opencraft_cache_blobs VALUES(?,?,?,?)").run(threadId, seq, blob.hash, blob.size);
    }
    for (const blob of old) if (!db.prepare("SELECT 1 FROM opencraft_cache_blobs WHERE thread_id=? AND blob_sha256=? LIMIT 1").get(threadId, blob.blob_sha256))
      rmSync(join(paths.blobs, `${blob.blob_sha256}.blob`), { force: true });
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
    const db = this.database(), turns: AppServerTurn[] = [], cursors = new Set<string | null>();
    let cursor: string | null = null;
    do {
      throwIfAborted(signal);
      if (cursors.has(cursor)) throw new Error("Native transcript repeated cursor");
      cursors.add(cursor);
      const page = await this.nativePage(threadId, cursor, signal);
      turns.push(...page.data); cursor = page.nextCursor;
    } while (cursor !== null);
    turns.reverse();
    if (new Set(turns.map(turn => turn.id)).size !== turns.length) throw new Error("Native transcript repeated Turn");
    const encoded = turns.map(encodeTurn);
    const prior = db.prepare("SELECT turn_seq,turn_id,content_sha256,status FROM opencraft_turn_offset_index WHERE thread_id=? ORDER BY turn_seq").all(threadId) as Row[];
    if (!rebuild) {
      if (prior.length !== Number(meta!.total_turns) || turns.length < prior.length) rebuild = true;
      else for (let index = 0; index < prior.length; index++) {
        const previous = prior[index]!, next = turns[index]!;
        if (next.id !== previous.turn_id || (encoded[index]!.hash !== previous.content_sha256
          && !(index === prior.length - 1 && previous.status === "inProgress"))) { rebuild = true; break; }
      }
    }
    if (rebuild) {
      this.drop(threadId); meta = undefined;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    let nextSequence = rebuild || !prior.length ? 0 : Number(prior.at(-1)!.turn_seq) + 1;
    transaction(db, () => {
      for (let index = 0; index < turns.length; index++) {
        const previous = !rebuild ? prior[index] : undefined;
        if (previous?.content_sha256 === encoded[index]!.hash) continue;
        this.storeTurn(threadId, turns[index]!, previous ? Number(previous.turn_seq) : nextSequence++, encoded[index]);
      }
      db.prepare("INSERT OR REPLACE INTO opencraft_cache_meta VALUES(?,?,?,?,?,?,?,?,?)").run(threadId, this.schema,
        watermark, source.position, source.identity, source.path, meta?.epoch ?? randomUUID(), turns.length, Date.now());
    });
    if (!existsSync(this.paths(threadId).turns)) writeFileSync(this.paths(threadId).turns, "", { mode: 0o600 });
    return { kind: rebuild ? "rebuild" : "increment", nativeBytes: 0 };
  }
  private async reconcile(threadId: string, path: string, source: NativeRolloutSource | undefined, snapshotSource?: NativeTranscriptSnapshotSource, signal?: AbortSignal, observer?: HistoryReadObserver): Promise<{ kind: "hit" | "rebuild" | "increment"; nativeBytes: number }> {
    throwIfAborted(signal);
    const db = this.database(), native = snapshotSource ? { ...snapshotSource } : stamp(path);
    native.watermark = JSON.stringify([(snapshotSource ?? source)!.key, native.watermark]);
    let meta = db.prepare("SELECT * FROM opencraft_cache_meta WHERE thread_id=?").get(threadId) as Row | undefined;
    if (meta?.projection_schema_version === this.schema && meta.source_path === path
      && meta.native_watermark === native.watermark && existsSync(this.paths(threadId).turns)) {
      return { kind: "hit", nativeBytes: 0 };
    }
    let sameSource = false;
    try { sameSource = JSON.parse(meta?.native_watermark ?? "null")?.[0] === (snapshotSource ?? source)!.key; } catch { /* legacy watermark */ }
    let rebuild = !meta || meta.projection_schema_version !== this.schema || meta.source_path !== path
      || !sameSource
      || meta.source_identity !== native.identity || !snapshotSource && meta.source_cursor > native.position
      || !existsSync(this.paths(threadId).turns);
    if (snapshotSource) return this.reconcileSnapshot(threadId, snapshotSource, native.watermark, meta, rebuild, signal);
    // Same-size edits cannot be explained by an append cursor.
    if (meta && meta.source_cursor === native.position && meta.native_watermark !== native.watermark) rebuild = true;
    let cursor = rebuild ? 0 : Number(meta!.source_cursor), identity: string | null = rebuild ? null : meta!.source_identity;
    const dirty = new Set<string>(); let bytes = 0;
    if (rebuild && this.headerPagesSupported && this.port.listTurnHeaders && this.port.listTurnItems && native.position > 0) {
      // Native headers reconstruct the entire authoritative index. There is no
      // dirty suffix to discover on a rebuild, so do not decode every tool body
      // just to find Turn IDs. A partial last record keeps the conservative scan.
      const fd = openSync(path, "r"), last = Buffer.alloc(1);
      try {
        if (readSync(fd, last, 0, 1, native.position - 1) === 1 && last[0] === 10) {
          cursor = native.position; identity = native.identity;
        }
      } finally { closeSync(fd); }
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
      this.drop(threadId); meta = undefined;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }
    const max = db.prepare("SELECT max(turn_seq) AS seq FROM opencraft_turn_offset_index WHERE thread_id=?").get(threadId) as Row;
    let oldestDirty = max.seq === null ? Number.NEGATIVE_INFINITY : Number(max.seq);
    for (const id of dirty) {
      const row = db.prepare("SELECT turn_seq FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_id=?").get(threadId, id) as Row | undefined;
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
      transaction(db, () => { for (const turn of page.data) {
        if (rebuild) this.storeTurn(threadId, turn, -descendingSeq++);
        else {
          fresh.push(turn);
          const row = db.prepare("SELECT turn_seq FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_id=?").get(threadId, turn.id) as Row | undefined;
          if (row && row.turn_seq <= oldestDirty) { reachedBoundary = true; break; }
        }
      }
      });
      nativeCursor = page.nextCursor;
    } while (nativeCursor !== null && !reachedBoundary);
    if (!rebuild) {
      // A missing boundary implies a native rewrite. Start fresh next read and
      // never publish this suffix against stale older rows.
      if (max.seq !== null && !reachedBoundary) { this.drop(threadId); return this.reconcile(threadId, path, source, snapshotSource, signal, observer); }
      let next = Number(max.seq ?? -1) + 1;
      transaction(db, () => { for (const turn of fresh.reverse()) {
        const row = db.prepare("SELECT turn_seq FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_id=?").get(threadId, turn.id) as Row | undefined;
        this.storeTurn(threadId, turn, row ? Number(row.turn_seq) : next++);
      } });
    }
    if (!existsSync(this.paths(threadId).turns)) writeFileSync(this.paths(threadId).turns, "", { mode: 0o600 });
    const total = db.prepare("SELECT count(*) AS n FROM opencraft_turn_offset_index WHERE thread_id=?").get(threadId) as Row;
    db.prepare("INSERT OR REPLACE INTO opencraft_cache_meta VALUES(?,?,?,?,?,?,?,?,?)").run(threadId, this.schema,
      native.watermark, snapshotSource ? native.position : cursor, native.identity, path, meta?.epoch ?? randomUUID(), total.n, Date.now());
    return { kind: rebuild ? "rebuild" : "increment", nativeBytes: bytes };
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()]);
    this.closed = true; this.db?.close(); this.db = null;
  }
}
class InvalidTranscriptCursor extends Error {
  constructor() { super("Transcript page expired; reload history"); }
}
