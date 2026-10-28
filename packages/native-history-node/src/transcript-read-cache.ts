import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { AppServerThread, AppServerTurn, ThreadTurnsListResponse } from "@opencraft/appserver-protocol";
import { canonicalRolloutPath, readRolloutIncrement, type NativeRolloutSource } from "./codex-rollout-reader.js";

export const TRANSCRIPT_PROJECTION_SCHEMA = 1;
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
export type HistoryReadObserver = (phase: HistoryReadPhase, ms: number) => void;
function observe(observer: HistoryReadObserver | undefined, phase: HistoryReadPhase, started: number): void {
  try { observer?.(phase, Math.max(0, performance.now() - started)); } catch { /* Diagnostics never own read settlement. */ }
}

export interface NativeTranscriptPort {
  nativeHome?: string;
  resolveSource?(threadId: string, path: string): Promise<NativeRolloutSource>;
  observeSnapshotSource?(threadId: string): Promise<NativeTranscriptSnapshotSource | null>;
  readThread(threadId: string, signal?: AbortSignal): Promise<AppServerThread>;
  listTurns(threadId: string, cursor: string | null, limit: number, signal?: AbortSignal, sortDirection?: "asc" | "desc"): Promise<NativePage>;
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
  readonly directory: string;
  private readonly databasePath: string;
  private readonly schema: number;
  outcome: DatabaseOutcome | null = null;
  constructor(readonly dataDirectory: string, private readonly port: NativeTranscriptPort,
    options: { projectionSchema?: number; measured?(event: { kind: "hit" | "rebuild" | "increment"; ms: number; nativeBytes: number }): void } = {}) {
    this.directory = join(dataDirectory, "cache", "transcripts");
    this.databasePath = join(dataDirectory, "cache", "transcript-index.sqlite");
    this.schema = options.projectionSchema ?? TRANSCRIPT_PROJECTION_SCHEMA;
    this.measured = options.measured;
  }
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
  private async serialize<T>(id: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const prior = this.jobs.get(id);
    // Cancellation ends a reader's wait, never the serialization barrier of
    // its predecessor. Later writers must still queue behind actual cleanup.
    const operation = (prior ?? Promise.resolve()).catch(() => {}).then(() => { throwIfAborted(signal); return run(); });
    this.jobs.set(id, operation);
    void operation.finally(() => { if (this.jobs.get(id) === operation) this.jobs.delete(id); }).catch(() => {});
    return awaitWithAbort(operation, signal);
  }
  private drop(threadId: string): void {
    const db = this.database(), paths = this.paths(threadId);
    transaction(db, () => {
      for (const table of ["opencraft_cache_meta", "opencraft_turn_offset_index", "opencraft_cache_blobs"])
        db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId);
    });
    rmSync(paths.turns, { force: true }); rmSync(paths.blobs, { recursive: true, force: true });
  }
  invalidate(threadId: string): Promise<void> {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    return this.serialize(threadId, async () => { this.drop(threadId); });
  }
  watermark(threadId: string): { identity: string; position: number } | null {
    const row = this.database().prepare("SELECT source_identity,source_cursor FROM opencraft_cache_meta WHERE thread_id=?").get(threadId) as Row | undefined;
    return row ? { identity: row.source_identity, position: row.source_cursor } : null;
  }

  /** Native metadata stays live; it is never served from this cache. */
  async read(threadId: string, limit = 10, onValidated?: () => void, itemsView: "full" | "notLoaded" = "full", signal?: AbortSignal, observer?: HistoryReadObserver): Promise<{ thread: AppServerThread; initialTurnsPage: ThreadTurnsListResponse }> {
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const metadataStarted = performance.now();
    const thread = await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal);
    observe(observer, "metadata", metadataStarted);
    throwIfAborted(effectiveSignal);
    if (revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated");
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    onValidated?.();
    const initialTurnsPage = await this.page(threadId, null, limit, thread, itemsView, "desc", effectiveSignal, observer);
    return { thread: { ...thread, historyTurnCount: initialTurnsPage.totalTurnCount }, initialTurnsPage };
  }
  async page(threadId: string, cursor: string | null, limit = 10, metadata?: AppServerThread, itemsView: "full" | "notLoaded" = "full", sortDirection: "asc" | "desc" = "desc", signal?: AbortSignal, observer?: HistoryReadObserver): Promise<ThreadTurnsListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return Promise.reject(new Error("Invalid transcript page size"));
    if (sortDirection !== "asc" && sortDirection !== "desc") return Promise.reject(new Error("Invalid transcript sort direction"));
    const effectiveSignal = signal ?? AbortSignal.timeout(DEFAULT_TRANSCRIPT_READ_TIMEOUT_MS);
    const revision = this.revisions.get(threadId) ?? 0;
    const ensureCurrent = () => { throwIfAborted(effectiveSignal); if (revision !== (this.revisions.get(threadId) ?? 0)) throw new Error("Transcript read invalidated"); };
    const metadataStarted = performance.now();
    const thread = metadata ?? await awaitWithAbort(this.port.readThread(threadId, effectiveSignal), effectiveSignal);
    if (!metadata) observe(observer, "metadata", metadataStarted);
    ensureCurrent();
    if (thread.id !== threadId) throw new Error("Native reader returned another Thread");
    const prepareRollout = async () => {
      const started = performance.now();
      const source = this.port.resolveSource ? await awaitWithAbort(this.port.resolveSource(threadId, thread.path!), effectiveSignal)
        : { nativeHome: this.port.nativeHome!, key: JSON.stringify(["single", this.port.nativeHome]), validate: async () => {} };
      const path = await awaitWithAbort(canonicalRolloutPath(thread.path!, source.nativeHome), effectiveSignal);
      ensureCurrent(); observe(observer, "source", started);
      return { source, path };
    };
    // Metadata and rollout path authorization cannot mutate the projection.
    // Snapshot-source observation stays inside the lane: its watermark must
    // describe the snapshot reconciled under the same invalidation boundary.
    const prepared = !this.port.observeSnapshotSource && typeof thread.path === "string" && existsSync(thread.path)
      ? await prepareRollout() : null;
    ensureCurrent();
    const queued = performance.now();
    return this.serialize(threadId, async () => {
      observe(observer, "queue", queued);
      ensureCurrent();
      const sourceStarted = performance.now();
      const snapshotSource = await awaitWithAbort(Promise.resolve(this.port.observeSnapshotSource?.(threadId)), effectiveSignal);
      ensureCurrent();
      if (!snapshotSource && (typeof thread.path !== "string" || !existsSync(thread.path))) {
        if (cursor?.startsWith("transcript:") || cursor?.startsWith("transcript-asc:")) throw new InvalidTranscriptCursor();
        return awaitWithAbort(this.port.listTurns(threadId, cursor, limit, effectiveSignal, sortDirection), effectiveSignal);
      }
      const rollout = snapshotSource ? null : prepared ?? await prepareRollout();
      const source = rollout?.source, path = snapshotSource?.path ?? rollout!.path;
      ensureCurrent();
      // Rollout preparation already reported source time; snapshot observation
      // is measured here, inside its required serialization boundary.
      if (snapshotSource) observe(observer, "source", sourceStarted);
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = performance.now(), observed = await this.reconcile(threadId, path, source, snapshotSource ?? undefined, effectiveSignal, observer);
        observe(observer, "reconcile", started);
        ensureCurrent();
        const pageStarted = performance.now();
        let page: ThreadTurnsListResponse;
        try {
          page = this.readPage(threadId, cursor, limit, itemsView, sortDirection);
        }
        catch (error) {
          if (error instanceof InvalidTranscriptCursor || attempt === 1) throw error;
          this.drop(threadId); continue;
        }
        await awaitWithAbort((snapshotSource ?? source)!.validate(), effectiveSignal); ensureCurrent();
        observe(observer, "page", pageStarted);
        this.measured?.({ ...observed, ms: performance.now() - started });
        return page;
      }
      throw new Error("Transcript rebuild failed");
    }, effectiveSignal);
  }
  private readPage(threadId: string, cursor: string | null, limit: number, itemsView: "full" | "notLoaded", sortDirection: "asc" | "desc"): ThreadTurnsListResponse {
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
    const fd = itemsView === "full" ? openSync(this.paths(threadId).turns, "r") : null;
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
        return { ...turn, items: turn.items.map(item => {
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
    while (!snapshotSource && cursor < native.position) {
      throwIfAborted(signal);
      const scanStarted = performance.now();
      const read = await readRolloutIncrement({ path, nativeHome: source!.nativeHome, source, cursor, identity,
        select: head => /"type"\s*:\s*"(?:event_msg|turn_context|compacted)"/.test(head),
        retain: (row: any) => {
          const p = object(row.payload);
          if (row.type === "compacted" || p.type === "thread_rolled_back") rebuild = true;
          return typeof p.turn_id === "string" ? p.turn_id : null;
        }, oversized: () => false,
      });
      observe(observer, "scan", scanStarted);
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
      const page = await this.nativePage(threadId, nativeCursor, signal, rebuild ? 100 : 10);
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
