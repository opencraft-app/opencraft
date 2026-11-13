import {captureSqliteReadGuard} from '@opencraft/sqlite-node';
import type {RecordedThreadCountRead,RecordedThreadCountSet} from '@opencraft/appserver-protocol/collaboration';
import { recordedNameQuery, type RecordedNameRead, type RecordedNameWindow, type RecordedNameFence } from '@opencraft/appserver-protocol/collaboration';
import { randomUUID } from "node:crypto";
import { DIRECTORY_FULL_RECONCILE_MS, DIRECTORY_MAX_SOURCE_PAGES } from "./policy.js";
import { parseThreadCatalogChange, THREAD_CATALOG_CHANGED, threadDirectoryIncomplete, type ThreadCatalogChange, type ThreadCatalogMetadata, type ThreadListResponse } from "@opencraft/appserver-protocol";
import type { DatabaseSync } from "node:sqlite";
import type { Thread, ThreadListParams } from "@opencraft/appserver-protocol/generated/v2";
import { DirectorySnapshotIndex, DirectorySnapshotPages, SNAPSHOT_CURSOR } from "./snapshots.js";
import { DirectorySnapshotReader } from "./snapshot-reader.js";
export { DirectorySnapshotPages, SNAPSHOT_START, SNAPSHOT_CURSOR } from "./snapshots.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const fields = ["id", "environments", "sessionId", "forkedFromId", "parentThreadId", "preview", "ephemeral", "section", "sectionEnteredAt", "projectId", "historyMode", "modelProvider", "model", "reasoningEffort", "createdAt", "updatedAt", "recencyAt", "status", "path", "cwd", "cliVersion", "originator", "source", "canAcceptDirectInput", "threadSource", "agentNickname", "agentRole", "gitInfo", "name", "daybreakEnabled", "visibility", "accessMode"];
/** Native metadata only. In particular, never persist turns or implementation-specific extra payloads. */
function metadata(value: unknown): Thread | null {
  const row = object(value);
  if (typeof row.id !== "string" || !row.id || row.id.length > 4096 || typeof row.updatedAt !== "number" || !Number.isFinite(row.updatedAt)
    || typeof row.cwd !== "string" || row.ephemeral === true) return null;
  return { ...Object.fromEntries(fields.filter(key => key in row).map(key => [key, row[key]])), preview: typeof row.preview === "string" ? row.preview.slice(0, 512) : "", extra: null, turns: [] } as unknown as Thread;
}
const cursorPrefix = "opencraft-catalog-v1:";
export interface DirectoryMeasurement {
  phase: "read" | "sync" | "flush";
  outcome: "ok" | "failed";
  durationMs: number;
  rows: number;
  changed: number;
  noop: number;
  sourceReads: number;
}
type Sync = { last_success_ms: number | null; watermark: number | null; last_full_ms: number | null; state: string };

/** Owner-bound metadata projection. The storage owner lends the connection and retains its lifecycle. */
export class ThreadDirectory {
  readonly #snapshotIndex = new DirectorySnapshotIndex();
  readonly #snapshots: DirectorySnapshotPages;
  readonly #snapshotReader?: DirectorySnapshotReader;
  readonly #snapshotBase: number;
  #indexEdits: Array<() => void> | null = null;
  readonly #coverage = new Map<number, ReturnType<ThreadDirectory["coverage"]>>();
  #closed = false;
  readonly #countReads = new Map<string,{scope:string;expires:number;validate:()=>boolean}>();
  readonly #source = `directory:${randomUUID()}`;
  #dirty = new Set<string>();
  #dirtyTimer?: ReturnType<typeof setTimeout>;
  #dirtyJob: Promise<void> | null = null;
  #observation = 0;
  readonly #fences = new Map<string, number>();
  #events: ThreadCatalogChange[] | null = null;
  #eventRevision = 0;
  readonly #sourceRevisions = new Map<string, number>();
  readonly #temporary = new Set<string>();
  readonly #liveStatus = new Map<string, Thread["status"]>();
  #revision: number;
  #timer?: ReturnType<typeof setTimeout>;
  #job: Promise<void> | null = null;
  #lastAttempt = -Infinity;
  #abort = new AbortController();
  constructor(readonly database: DatabaseSync, readonly port: {
    list(params: ThreadListParams, signal: AbortSignal): Promise<unknown>;
    changed(event?: ThreadCatalogChange): void;
    measured?(measurement: DirectoryMeasurement): void;
    readMetadata?(threadId: string, signal: AbortSignal): Promise<unknown>;
    readMetadataBatch?(threadIds: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, unknown>>;
    project?(thread: Thread): Thread;
    archived?(threadId: string): boolean;
    retain?(threadId: string): boolean;
    archivePartitioned?: boolean;
    incrementalScan?: boolean;
    /** Commit metadata per source page and reconcile in bounded rowid windows. */
    streamingSync?: boolean;
    nonblockingCold?: boolean;
    observed?(threadIds: readonly string[]): void;
  }, readonly now = Date.now, readonly intervalMs = 60_000) {
    this.#snapshots = new DirectorySnapshotPages(now);
    this.#revision = Number(database.prepare("SELECT MAX(revision) AS revision FROM opencraft_thread_catalog").get()?.revision ?? 0);
    this.#snapshotBase = this.#revision;
    const path = database.location();
    if (path) this.#snapshotReader = new DirectorySnapshotReader(path);
  }
  /** Preserve native semantics for advanced filters and native cursors. */
  supports(params: Record<string, unknown>): boolean {
    return Object.keys(params).every(key => ["cursor", "limit", "archived", "sortKey", "sortDirection", "useStateDbOnly"].includes(key))
      && params.sortKey === "updated_at" && (params.sortDirection == null || params.sortDirection === "desc")
      && (params.archived == null || typeof params.archived === "boolean")
      && (params.cursor == null || typeof params.cursor === "string" && (params.cursor.startsWith(cursorPrefix) || params.cursor.startsWith(SNAPSHOT_CURSOR)))
      && (params.limit == null || Number.isSafeInteger(params.limit) && Number(params.limit) > 0 && Number(params.limit) <= 1000)
      && params.useStateDbOnly !== false;
  }
  /** Pure read on the owner's existing connection. Never schedules source refresh. */
  searchNames(request: RecordedNameRead, assertCurrent: () => void = () => {}): RecordedNameWindow {
    const fail = (code = 'thread_search_unavailable'): never => { throw Object.assign(new Error(code), {code}); };
    const started = performance.now();
    const check = () => { assertCurrent(); if (this.#closed || performance.now() - started > 100) fail(); };
    check();
    const state = this.#state(0);
    if (!state || state.last_success_ms == null || !Number.isFinite(state.last_success_ms)) fail();
    const sync = JSON.stringify(state);
    const prior = request.cursor;
    const validate = (f: RecordedNameFence) => {
      if (f.lifetime !== this.#source || f.revision !== this.#revision || f.sync !== sync
        || !Number.isSafeInteger(f.upper) || f.upper < 0 || !Number.isSafeInteger(f.position) || f.position < 0 || f.position > f.upper) fail('thread_search_changed');
    };
    if (prior) validate(prior);
    const upper = prior?.upper ?? Number(this.database.prepare('SELECT rowid AS n FROM opencraft_thread_catalog ORDER BY rowid DESC LIMIT 1').get()?.n ?? 0);
    if (!Number.isSafeInteger(upper) || upper < 0) fail();
    const fence = prior ? {...prior} : {lifetime:this.#source,revision:this.#revision,sync,upper,position:0};
    const entries: RecordedNameWindow['entries'] = [];
    if (request.kind === 'window') {
      const query = recordedNameQuery(request.query), end = Math.min(upper, fence.position + 1024);
      // The primary-key range bounds visited rows, including denied/nonmatching rows.
      // CASE avoids materializing an oversized JSON value into JavaScript.
      const rows = this.database.prepare(`SELECT rowid AS position,thread_id,
        CASE WHEN length(CAST(metadata_json AS BLOB))<=65536 THEN metadata_json ELSE NULL END AS metadata
        FROM opencraft_thread_catalog NOT INDEXED WHERE rowid>? AND rowid<=? AND archived=0 AND deleted=0
        ORDER BY rowid LIMIT 1024`).iterate(fence.position,end);
      for (const row of rows) {
        check();
        if (typeof row.metadata !== 'string') fail();
        const meta = object(JSON.parse(row.metadata as string)), name = meta.name;
        if (typeof name !== 'string') continue;
        if (name.length > 8192 || [...name].length > 4096) fail();
        if (name.normalize('NFC').includes(query)) entries.push({position:Number(row.position),threadId:String(row.thread_id),name});
      }
      fence.position = end;
    }
    check(); validate(fence);
    // Sync state may change without changing individual metadata rows.
    if (JSON.stringify(this.#state(0)) !== sync) fail('thread_search_changed');
    return {entries,fence,observedAt:state!.last_success_ms!};
  }
  /** Count's complete ID-only set; no refresh, metadata projection or source IO.
   * Tickets live only on this original owner for at most nine seconds (32 concurrent reads).
   */
  countRead(request:RecordedThreadCountRead, scope:string, check:()=>void):RecordedThreadCountSet {
    check();
    const now=Date.now();
    for(const [key,value] of this.#countReads)if(now>=value.expires)this.#countReads.delete(key);
    if(request.kind==='validate') {
      const saved=this.#countReads.get(request.ticket);this.#countReads.delete(request.ticket);
      return saved&&saved.scope===scope&&saved.validate()?{status:'validated'}:{status:'unknown'};
    }
    const readState=()=>this.database.prepare(`SELECT
      CASE WHEN length(CAST(state AS BLOB))=5 THEN state='ready' ELSE 0 END AS ready,
      CASE WHEN typeof(last_success_ms) IN ('integer','real') THEN last_success_ms END AS observed
      FROM opencraft_catalog_sync WHERE archived=0`).get();
    const state=readState();
    if(this.#closed||!state||state.ready!==1||typeof state.observed!=='number'||!Number.isFinite(state.observed)||this.#countReads.size>=32)return {status:'unknown'};
    const revision=this.#revision,sync=JSON.stringify(state),expires=now+9000;
    const validate=captureSqliteReadGuard(this.database,()=>!this.#closed&&Date.now()<expires
      &&this.#revision===revision&&JSON.stringify(readState())===sync);
    if(!validate)return {status:'unknown'};
    const ids:string[]=[];let bytes=0;
    // Recency is a covering index over these scope predicates. No metadata/body is read.
    const rows=this.database.prepare(`SELECT CASE WHEN length(CAST(thread_id AS BLOB))<=4096 THEN thread_id END AS id
      FROM opencraft_thread_catalog WHERE archived=0 AND deleted=0 ORDER BY updated_at DESC,thread_id LIMIT 16385`).iterate();
    const readStarted=performance.now();
    for(const row of rows){
      if(performance.now()-readStarted>100||Date.now()>=expires)return {status:'unknown'};
      if(typeof row.id!=='string'||!row.id||ids.length>=16384)return {status:'unknown'};
      bytes+=Buffer.byteLength(row.id);if(bytes>4*1024*1024)return {status:'unknown'};
      ids.push(row.id);
    }
    check();if(!validate())return {status:'unknown'};
    const ticket=randomUUID();this.#countReads.set(ticket,{scope,expires,validate});
    return {status:'complete',ids,ticket,observedAt:state.observed};
  }
  start(): void { if (!this.#closed && this.now() - this.#lastAttempt >= this.intervalMs) void this.refresh().catch(() => {}); }
  /** Observe the owner-scheduled scan without starting another source read. */
  settled(): Promise<void> { return this.#job ?? Promise.resolve(); }
  async list(params: Record<string, unknown>): Promise<ThreadListResponse & { readonly catalog: ThreadCatalogMetadata }> {
    if (!this.supports(params) || this.#closed) throw new Error("Unsupported catalog query");
    if (this.#snapshotReader && typeof params.cursor === "string" && params.cursor.startsWith(SNAPSHOT_CURSOR)) {
      this.start();
      const page = await this.#snapshotReader.list({ cursor: params.cursor, archived: params.archived === true,
        limit: Number(params.limit ?? 30), source: this.#source, base: this.#snapshotBase, expectedRevision: this.#revision });
      if (this.#closed) throw new Error("Directory reader closed");
      return page;
    }
    const readStarted = performance.now();
    const archived = params.archived === true ? 1 : 0;
    let sync = this.#state(archived);
    if (sync?.last_success_ms == null && this.port.nonblockingCold) {
      this.start();
    } else if (sync?.last_success_ms == null) {
      try { await this.refresh(); } catch (error) { if (this.#state(archived)?.last_success_ms == null) throw error; }
      sync = this.#state(archived);
    }
    else if (sync.state === "error" && this.now() - this.#lastAttempt >= 5_000) void this.refresh().catch(() => {});
    else this.start();
    const limit = Number(params.limit ?? 30);
    if (typeof params.cursor === "string" && params.cursor.startsWith(SNAPSHOT_CURSOR)) {
      return this.#snapshots.list(params.cursor, archived === 1, limit, () => ({
        parts: [this.snapshot(archived === 1)], catalog: this.coverage(archived === 1),
      })) as Awaited<ReturnType<ThreadDirectory["list"]>>;
    }
    let anchor: { updatedAt: number; id: string } | null = null;
    if (params.cursor) {
      try {
        const parsed = JSON.parse((params.cursor as string).slice(cursorPrefix.length));
        if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== archived || parsed[1] !== this.#source || !Number.isFinite(parsed[2]) || typeof parsed[3] !== "string") throw Error();
        anchor = { updatedAt: parsed[2], id: parsed[3] };
      } catch { throw new Error("Invalid catalog cursor"); }
    }
    const rows = this.database.prepare(`SELECT metadata_json,updated_at,thread_id FROM opencraft_thread_catalog
      WHERE archived=? AND deleted=0 ${anchor ? "AND (updated_at < ? OR (updated_at = ? AND thread_id > ?))" : ""}
      ORDER BY updated_at DESC,thread_id ASC LIMIT ?`).all(archived, ...(anchor ? [anchor.updatedAt, anchor.updatedAt, anchor.id] : []), limit + 1);
    const more = rows.length > limit; rows.length = Math.min(rows.length, limit);
    const last = rows.at(-1);
    this.#measure({ phase: "read", outcome: "ok", durationMs: performance.now() - readStarted, rows: rows.length, changed: 0, noop: 0, sourceReads: 0 });
    return { data: rows.map(row => JSON.parse(String(row.metadata_json)) as Thread),
      nextCursor: more && last ? this.cursor(archived === 1, { updatedAt: Number(last.updated_at), id: String(last.thread_id) }) : null,
      backwardsCursor: null, catalog: { lastSuccessAt: sync?.last_success_ms ?? null, state: sync?.state === "error" ? "error" : sync?.last_success_ms == null ? "warming" : sync?.state ?? "syncing",
        coverage: sync?.last_success_ms == null ? "unknown" : sync?.state === "error" ? "partial" : "complete" } };
  }
  /** Owner-bound keyset position. Revision changes do not invalidate pagination. */
  cursor(archived: boolean, anchor: { updatedAt: number; id: string }): string {
    return cursorPrefix + JSON.stringify([archived ? 1 : 0, this.#source, anchor.updatedAt, anchor.id]);
  }
  snapshot(archived: boolean) {
    if (this.#snapshotReader) throw new Error("File-backed snapshots belong to the directory reader worker");
    return { root: this.#snapshotIndex.capture(archived), merkle: this.#snapshotIndex.captureMerkle(archived), checkpoint: { source: this.#source, revision: this.#eventRevision } };
  }
  coverage(archived: boolean): { lastSuccessAt: number | null; state: string; coverage: "unknown" | "partial" | "complete" } {
    return this.#coverage.get(Number(archived)) ?? { lastSuccessAt: null, state: "warming", coverage: "unknown" };
  }
  #state(archived: number): Sync | undefined { return this.database.prepare("SELECT * FROM opencraft_catalog_sync WHERE archived=?").get(archived) as Sync | undefined; }
  refresh(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Catalog closed"));
    if (this.#job) return this.#job;
    clearTimeout(this.#timer);
    this.#lastAttempt = this.now();
    const started = performance.now();
    const metric: DirectoryMeasurement = { phase: "sync", outcome: "ok", durationMs: 0, rows: 0, changed: 0, noop: 0, sourceReads: 0 };
    const job = this.#refresh(metric); this.#job = job;
    const report = (outcome: "ok" | "failed") => this.#measure({ ...metric, outcome, durationMs: performance.now() - started });
    void job.then(() => report("ok"), () => report("failed"));
    void job.finally(() => {
      if (this.#job === job) this.#job = null;
      if (!this.#closed) { this.#timer = setTimeout(() => this.start(), this.intervalMs); this.#timer.unref?.(); }
    }).catch(() => {});
    return job;
  }
  async #refresh(metric: DirectoryMeasurement): Promise<void> {
    let failed = false;
    for (const archived of this.port.archivePartitioned === false ? [0] : [0, 1]) {
      if (this.#closed) return;
      const previous = this.#state(archived), startedRevision = this.#revision, startedObservation = this.#observation;
      const full = !this.port.incrementalScan || !previous?.last_full_ms || this.now() - previous.last_full_ms > DIRECTORY_FULL_RECONCILE_MS;
      this.database.prepare(`INSERT INTO opencraft_catalog_sync(archived,state) VALUES(?,'syncing')
        ON CONFLICT(archived) DO UPDATE SET state='syncing'`).run(archived);
      try {
        const seen = new Set<string>(), cursors = new Set<string>();
        const staged: Thread[] = [];
        let cursor: string | null = null, watermark = previous?.watermark ?? 0, complete = false, partial = false;
        for (let page = 0; page < DIRECTORY_MAX_SOURCE_PAGES; page++) {
          metric.sourceReads++;
          const response = object(await this.port.list({ archived: archived === 1, limit: 200,
            sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true, cursor }, this.#abort.signal));
          if (this.#closed) return;
          partial ||= threadDirectoryIncomplete(response);
          if (!Array.isArray(response.data) || !(response.nextCursor == null || typeof response.nextCursor === "string")) throw new Error("Invalid catalog page");
          if(this.port.streamingSync && response.data.length>200)throw new Error("Oversized metadata page");
          let oldest = Infinity;
          for (const value of response.data) {
            const row = metadata(value);
            if (!row) { if (object(value).ephemeral === true) continue; throw new Error("Invalid catalog metadata"); }
            watermark = Math.max(watermark, row.updatedAt); oldest = Math.min(oldest, row.updatedAt);
            if (!seen.has(row.id)) { staged.push(row); seen.add(row.id); }
          }
          if(this.port.streamingSync){
            if(!await this.#chunks(staged.splice(0),row=>{if((this.#fences.get(row.id)??0)<=startedObservation)this.#put(row,archived,startedRevision,true,metric);},metric))return;
            await new Promise<void>(resolve=>setImmediate(resolve));
            if(this.#closed)return;
          }
          if (response.nextCursor == null || !full && oldest < (previous?.watermark ?? 0)) { complete = true; break; }
          if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error("Catalog cursor did not advance");
          cursor = response.nextCursor; cursors.add(cursor);
        }
        if (!complete) throw new Error("Catalog synchronization limit exceeded");
        if (!await this.#chunks(staged, row => {
          if ((this.#fences.get(row.id) ?? 0) <= startedObservation)
            this.#put(row, this.port.archived ? Number(this.port.archived(row.id)) : archived, startedRevision, true, metric);
        }, metric)) return;
        if (full && !partial) {
          if(this.port.streamingSync){
            const upper=Number(this.database.prepare('SELECT rowid AS n FROM opencraft_thread_catalog ORDER BY rowid DESC LIMIT 1').get()?.n??0);
            for(let position=0;position<upper;position+=1024){
              if(this.#closed)return;
              const rows=this.database.prepare('SELECT thread_id FROM opencraft_thread_catalog NOT INDEXED WHERE rowid>? AND rowid<=? AND archived=? AND revision<=? AND deleted=0 ORDER BY rowid').all(position,Math.min(upper,position+1024),archived,startedRevision);
              if(!await this.#chunks(rows,row=>{const id=String(row.thread_id);if(!seen.has(id)&&!this.port.retain?.(id)&&(this.#fences.get(id)??0)<=startedObservation)this.#remove(id,metric);},metric))return;
              await new Promise<void>(resolve=>setImmediate(resolve));
            }
          }else{
          const rows = this.database.prepare("SELECT thread_id FROM opencraft_thread_catalog WHERE (?=1 OR archived=?) AND revision<=? AND deleted=0").all(Number(this.port.archivePartitioned === false), archived, startedRevision);
          if (!await this.#chunks(rows, row => {
            const id = String(row.thread_id);
            if (!seen.has(id) && !this.port.retain?.(id) && (this.#fences.get(id) ?? 0) <= startedObservation) this.#remove(id, metric);
          }, metric)) return;
          }
        }
        this.#commit(() => {
          this.database.prepare("UPDATE opencraft_catalog_sync SET last_success_ms=?,watermark=?,last_full_ms=?,state=? WHERE archived=?")
            .run(partial ? previous?.last_success_ms ?? (seen.size ? this.now() : null) : this.now(),
              partial ? previous?.watermark ?? 0 : watermark,
              full && !partial ? this.now() : previous?.last_full_ms ?? null, partial ? "error" : "ready", archived);
          if (this.port.archivePartitioned === false) this.database.prepare(`INSERT INTO opencraft_catalog_sync(archived,last_success_ms,watermark,last_full_ms,state)
            SELECT 1,last_success_ms,watermark,last_full_ms,state FROM opencraft_catalog_sync WHERE archived=0
            ON CONFLICT(archived) DO UPDATE SET last_success_ms=excluded.last_success_ms,watermark=excluded.watermark,last_full_ms=excluded.last_full_ms,state=excluded.state`).run();
        }, metric);
        failed ||= partial;
        const ready = { lastSuccessAt: partial ? previous?.last_success_ms ?? (seen.size ? this.now() : null) : this.now(),
          state: partial ? "error" : "ready", coverage: partial ? "partial" as const : "complete" as const };
        this.#coverage.set(archived, ready);
        if (this.port.archivePartitioned === false) this.#coverage.set(1, ready);
        // Coverage becomes ready only after all committed chunks and absence reconciliation.
        if (previous?.last_success_ms == null) this.#publish();
        if(this.port.streamingSync){
          const upper=Number(this.database.prepare('SELECT rowid AS n FROM opencraft_thread_catalog ORDER BY rowid DESC LIMIT 1').get()?.n??0);
          for(let position=0;position<upper;position+=1024){
            if(this.#closed)return;
            this.port.observed?.(this.database.prepare('SELECT thread_id FROM opencraft_thread_catalog NOT INDEXED WHERE rowid>? AND rowid<=? AND deleted=0 ORDER BY rowid').all(position,Math.min(upper,position+1024)).map(row=>String(row.thread_id)));
            await new Promise<void>(resolve=>setImmediate(resolve));
          }
        }else this.port.observed?.(this.database.prepare("SELECT thread_id FROM opencraft_thread_catalog WHERE deleted=0").all().map(row => String(row.thread_id)));
      } catch {
        if (this.#closed) return;
        const error = { lastSuccessAt: previous?.last_success_ms ?? null, state: "error", coverage: "partial" as const };
        this.#coverage.set(archived, error);
        if (this.port.archivePartitioned === false) this.#coverage.set(1, error);
        this.database.prepare("UPDATE opencraft_catalog_sync SET state='error' WHERE archived=? OR ?=1")
          .run(archived, Number(this.port.archivePartitioned === false)); failed = true;
      }
    }
    if (failed) throw new Error("Remote catalog refresh failed");
  }
  async #chunks<T>(rows: readonly T[], apply: (row: T) => void, metric: DirectoryMeasurement): Promise<boolean> {
    for (let offset = 0; offset < rows.length; offset += 128) {
      if (this.#closed) return false;
      this.#commit(() => { for (const row of rows.slice(offset, offset + 128)) apply(row); }, metric);
      if (offset + 128 < rows.length) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return !this.#closed;
  }
  #commit(apply: () => void, metric: DirectoryMeasurement): void {
    const revision = this.#revision, eventRevision = this.#eventRevision, changed = metric.changed;
    this.database.exec("SAVEPOINT catalog_sync"); this.#events = []; this.#indexEdits = [];
    try { apply(); this.database.exec("RELEASE catalog_sync"); }
    catch (error) {
      this.#events = null; this.#indexEdits = null; this.#revision = revision; this.#eventRevision = eventRevision; metric.changed = changed;
      this.database.exec("ROLLBACK TO catalog_sync; RELEASE catalog_sync"); throw error;
    }
    const events = this.#events; this.#events = null;
    // Publish only after every changed row is reflected in the immutable index.
    const edits = this.#indexEdits!; this.#indexEdits = null;
    for (const edit of edits) edit();
    for (const event of events) this.#publish(event);
  }
  #put(row: Thread, archived: number, fence?: number, preserveStatus = false, metric?: DirectoryMeasurement): void {
    archived = this.port.archived ? Number(this.port.archived(row.id)) : archived;
    const old = this.database.prepare("SELECT revision,metadata_json,archived,deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(row.id);
    if (fence !== undefined && old && (Number(old.revision) > fence || old.deleted)) return;
    if (metric) metric.rows++;
    if (preserveStatus && old && !old.deleted) row = { ...row, status: (JSON.parse(String(old.metadata_json)) as Thread).status };
    if (this.#liveStatus.has(row.id)) row = { ...row, status: this.#liveStatus.get(row.id)! };
    row = metadata(this.port.project?.(row) ?? row)!;
    if (!row) throw new Error("Invalid projected metadata");
    if (old && !old.deleted && Number(old.archived) === archived && String(old.metadata_json) === JSON.stringify(row)) { if (metric) metric.noop++; return; }
    this.database.prepare(`INSERT INTO opencraft_thread_catalog VALUES(?,?,?,?,?,?,0) ON CONFLICT(thread_id) DO UPDATE SET
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at,archived=excluded.archived,
      observed_at_ms=excluded.observed_at_ms,revision=excluded.revision,deleted=0`)
      .run(row.id, JSON.stringify(row), row.recencyAt ?? row.updatedAt, archived, this.now(), ++this.#revision);
    if (metric) metric.changed++;
    this.#editIndex(() => this.#snapshotIndex.set(row, archived === 1));
    this.#change(archived ? { type: "remove", threadId: row.id } : { type: "upsert", thread: row });
  }
  #change(change: ThreadCatalogChange["change"]): void {
    const event: ThreadCatalogChange = { version: 1, authority: "directory", source: this.#source, revision: ++this.#eventRevision, change };
    if (this.#events) this.#events.push(event); else this.#publish(event);
  }
  #measure(measurement: DirectoryMeasurement): void {
    try { this.port.measured?.(measurement); } catch { /* Diagnostics never change data settlement. */ }
  }
  #editIndex(edit: () => void): void {
    if (this.#snapshotReader) return;
    if (this.#indexEdits) this.#indexEdits.push(edit); else edit();
  }
  #publish(event?: ThreadCatalogChange): void {
    if (!this.#closed) try { this.port.changed(event); } catch { /* Subscribers cannot undo committed metadata. */ }
  }
  #remove(id: string, metric?: DirectoryMeasurement): void {
    const previous = this.database.prepare("SELECT deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(id);
    if (previous?.deleted) return;
    this.database.prepare(`INSERT INTO opencraft_thread_catalog VALUES(?,'{}',0,0,?,?,1)
      ON CONFLICT(thread_id) DO UPDATE SET deleted=1,revision=excluded.revision`).run(id, this.now(), ++this.#revision);
    if (metric) { metric.rows++; metric.changed++; }
    this.#editIndex(() => this.#snapshotIndex.delete(id));
    this.#change({ type: "remove", threadId: id });
  }
  /** Notifications mark metadata dirty; they never read history or infer execution state. */
  markDirty(id: string): void {
    if (this.#closed || !(this.port.readMetadata || this.port.readMetadataBatch) || !id || this.#temporary.has(id)) return;
    this.#fences.set(id, ++this.#observation);
    this.#dirty.add(id);
    if (!this.#dirtyTimer && !this.#dirtyJob) {
      this.#dirtyTimer = setTimeout(() => { this.#dirtyTimer = undefined; void this.flush().catch(() => {}); }, 25);
      this.#dirtyTimer.unref?.();
    }
  }
  flush(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#dirtyJob) return this.#dirtyJob;
    clearTimeout(this.#dirtyTimer); this.#dirtyTimer = undefined;
    const started = performance.now();
    const metric: DirectoryMeasurement = { phase: "flush", outcome: "ok", durationMs: 0, rows: 0, changed: 0, noop: 0, sourceReads: 0 };
    const job = this.#flush(metric); this.#dirtyJob = job;
    void job.then(() => this.#measure({ ...metric, durationMs: performance.now() - started }), () => {});
    void job.finally(() => {
      if (this.#dirtyJob === job) this.#dirtyJob = null;
      if (!this.#closed && this.#dirty.size) {
        this.#dirtyTimer = setTimeout(() => { this.#dirtyTimer = undefined; void this.flush().catch(() => {}); }, 1000);
        this.#dirtyTimer.unref?.();
      }
    }).catch(() => {});
    return job;
  }
  async #flush(metric: DirectoryMeasurement): Promise<void> {
    // Bounded batches, sequential native reads; notification bursts share one latest read.
    const ids = [...this.#dirty].slice(0, 64);
    const fences = new Map(ids.map(id => [id, this.#fences.get(id)]));
    // Full-summary-only engines read once for this dirty batch, never once per UI page or ID.
    let batch: ReadonlyMap<string, unknown> | undefined;
    let batchFailed = false;
    if (ids.length && this.port.readMetadataBatch) {
      try { metric.sourceReads++; batch = await this.port.readMetadataBatch(ids, this.#abort.signal); }
      catch { batchFailed = true; }
      if (this.#closed) return;
    }
    for (const id of ids) {
      this.#dirty.delete(id);
      if (this.#temporary.has(id) || this.database.prepare("SELECT deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(id)?.deleted) continue;
      const fence = fences.get(id);
      try {
        if (batchFailed) throw new Error("Metadata batch unavailable");
        if (!batch) metric.sourceReads++;
        const result = object(batch ? batch.get(id) : await this.port.readMetadata!(id, this.#abort.signal));
        if (this.#closed) return;
        if (this.#fences.get(id) !== fence) { this.#dirty.add(id); continue; }
        if (object(result.thread).ephemeral === true) { this.#temporary.add(id); continue; }
        const row = metadata(result.thread);
        if (!row || row.id !== id) throw new Error("Metadata unavailable");
        const stored = this.database.prepare("SELECT archived,deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(id);
        if (stored && !stored.deleted) {
          const current = this.database.prepare("SELECT metadata_json FROM opencraft_thread_catalog WHERE thread_id=?").get(id);
          if (current) row.status = (JSON.parse(String(current.metadata_json)) as Thread).status;
        }
        if (!stored?.deleted) this.#put(row, this.port.archived ? Number(this.port.archived(id)) : Number(stored?.archived ?? 0), undefined, true, metric);
      } catch {
        metric.outcome = "failed";
        if (!this.#closed && !this.#temporary.has(id) && this.#fences.get(id) === fence
          && !this.database.prepare("SELECT deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(id)?.deleted) this.#dirty.add(id);
      }
    }
  }
  observe(method: string, params: unknown, result?: unknown): void {
    if (this.#closed) return;
    if (method === THREAD_CATALOG_CHANGED) {
      const event = parseThreadCatalogChange(params);
      if (!event || event.revision <= (this.#sourceRevisions.get(event.source) ?? 0)) return;
      this.#sourceRevisions.set(event.source, event.revision);
      if (this.#sourceRevisions.size > 32) this.#sourceRevisions.delete(this.#sourceRevisions.keys().next().value!);
      for (const change of event.change.type === "batch" ? event.change.changes : [event.change]) {
      if (change.type === "upsert") this.observe("thread/started", { thread: change.thread });
      else if (change.type === "remove") this.observe("thread/deleted", { threadId: change.threadId });
      else if (change.type === "patch") {
        if (change.name !== undefined) this.observe("thread/name/updated", { threadId: change.threadId, name: change.name });
        if (change.status !== undefined) this.observe("thread/status/changed", { threadId: change.threadId, status: change.status });
      }
      }
      return;
    }
    if (["turn/start", "turn/started", "turn/completed"].includes(method)) {
      const id = object(params).threadId;
      if (typeof id === "string") this.markDirty(id);
      return;
    }
    const raw = object(object(result).thread ?? object(params).thread);
    if (typeof raw.id === "string" && raw.ephemeral === true) {
      this.#temporary.add(raw.id); this.#dirty.delete(raw.id); return;
    }
    // Read/resume results have no event revision. An old read must not overwrite
    // a newer title/status; only the fenced synchronizer imports read metadata.
    if (!["thread/start", "thread/started", "thread/fork", "thread/archive", "thread/archived", "thread/unarchive", "thread/unarchived", "thread/delete", "thread/deleted", "thread/name/set", "thread/name/updated", "thread/status/changed"].includes(method)) return;
    const input = object(params), output = object(result);
    const row = metadata(output.thread ?? input.thread);
    const observedId = row?.id ?? input.threadId;
    if (typeof observedId === "string") {
      this.#fences.set(observedId, ++this.#observation);
      if (method === "thread/status/changed" && typeof object(input.status).type === "string") this.#liveStatus.set(observedId, input.status as Thread["status"]);
    }
    if ((method === "thread/delete" || method === "thread/deleted") && typeof observedId === "string") {
      this.#dirty.delete(observedId); this.#liveStatus.delete(observedId);
      this.#remove(observedId); return;
    }
    if (row) {
      const old = this.database.prepare("SELECT archived FROM opencraft_thread_catalog WHERE thread_id=?").get(row.id);
      this.#put(row, Number(old?.archived ?? 0));
    }
    const id = row?.id ?? input.threadId;
    if (typeof id !== "string" || !id) return;
    const stored = this.database.prepare("SELECT metadata_json,archived,deleted FROM opencraft_thread_catalog WHERE thread_id=?").get(id);
    if (!stored) { this.markDirty(id); return; }
    if (stored.deleted) return;
    const current = JSON.parse(String(stored.metadata_json)) as Thread;
    let archived = Number(stored.archived);
    if (["thread/archive", "thread/archived"].includes(method)) archived = 1;
    else if (["thread/unarchive", "thread/unarchived"].includes(method)) archived = 0;
    else if (["thread/name/set", "thread/name/updated"].includes(method) && typeof (input.name ?? input.threadName) === "string") current.name = String(input.name ?? input.threadName);
    else if (method === "thread/status/changed" && typeof object(input.status).type === "string") current.status = input.status as Thread["status"];
    else if (!row) return;
    this.#put(current, archived);

  }
  close(): void {
    this.#snapshots.clear();
    this.#snapshotReader?.close();
    this.#closed = true; this.#countReads.clear(); clearTimeout(this.#timer); clearTimeout(this.#dirtyTimer);
    this.#dirty.clear(); this.#liveStatus.clear(); this.#temporary.clear(); this.#sourceRevisions.clear(); this.#abort.abort();
    // Every continuation checks closed before accessing the borrowed connection.
    // The storage owner can close it immediately, even if a source ignores abort.
  }
}
