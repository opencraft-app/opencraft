import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openManagedDatabase, createSchemaValidator, type DatabaseOutcome } from "@opencraft/sqlite-node";
import type { AppServerTurn, ThreadTurnsListResponse } from "@opencraft/appserver-protocol";
function object(value: unknown): Record<string, any> {return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,any>:{};}
const OUTPUT_FIELDS = ["aggregatedOutput", "output", "result", "structuredResult", "contentItems", "results"] as const;
import { TRANSCRIPT_CACHE_MIGRATIONS, TRANSCRIPT_CACHE_SQL as SQL } from "./transcript-cache-schema.js";
type Row = Record<string, any>;
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

export class TranscriptCacheStorage {
  private db: DatabaseSync | null = null;
  private dbIdentity = "";
  readonly directory: string;
  private readonly databasePath: string;
  private readonly schema: number;
  outcome: DatabaseOutcome | null = null;
  private closed = false;
  constructor(readonly dataDirectory: string, schema: number) {
    this.directory=join(dataDirectory,"cache","transcripts");
    this.databasePath=join(dataDirectory,"cache","transcript-index.sqlite");
    this.schema=schema;
  }
  private database(): DatabaseSync {
    if (this.closed) throw new Error("Transcript cache closed");
    const identity = existsSync(this.databasePath) ? stamp(this.databasePath).identity : "";
    if (this.db && identity === this.dbIdentity) return this.db;
    this.db?.close(); this.db = null;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(join(this.dataDirectory, "cache"), 0o700); chmodSync(this.directory, 0o700);
    const openIndex = () => openManagedDatabase({ schemaId: "transcript-read-cache", path: this.databasePath, migrations: TRANSCRIPT_CACHE_MIGRATIONS,
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
  drop(threadId: string): void {
    const db = this.database(), paths = this.paths(threadId);
    transaction(db, () => {
      for (const table of ["opencraft_cache_meta", "opencraft_turn_offset_index", "opencraft_cache_blobs"])
        db.prepare(`DELETE FROM ${table} WHERE thread_id=?`).run(threadId);
    });
    rmSync(paths.turns, { force: true }); rmSync(paths.blobs, { recursive: true, force: true });
    mkdirSync(this.directory,{recursive:true,mode:0o700});
  }
  readPage(threadId: string, cursor: string | null, limit: number, itemsView: "full" | "notLoaded" | "presentation", sortDirection: "asc" | "desc", detailItemId?: string): ThreadTurnsListResponse {
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

  meta(threadId: string) { return this.database().prepare("SELECT * FROM opencraft_cache_meta WHERE thread_id=?").get(threadId) as Row | undefined; }
  turn(threadId: string, turnId: string) { return this.database().prepare("SELECT turn_seq FROM opencraft_turn_offset_index WHERE thread_id=? AND turn_id=?").get(threadId,turnId) as Row | undefined; }
  maximum(threadId: string) { return this.database().prepare("SELECT max(turn_seq) AS seq FROM opencraft_turn_offset_index WHERE thread_id=?").get(threadId) as Row; }
  exists(threadId: string) { return existsSync(this.paths(threadId).turns); }
  batch(threadId: string, turns: Array<{turn: AppServerTurn; seq: number}>) { transaction(this.database(),()=>{ for(const value of turns)this.storeTurn(threadId,value.turn,value.seq); }); }
  hydrate(threadId: string, turns: AppServerTurn[]) { transaction(this.database(),()=>{for(const turn of turns){const row=this.turn(threadId,turn.id);if(!row)throw new Error("Transcript Turn disappeared during hydration");this.storeTurn(threadId,turn,Number(row.turn_seq));}}); }
  append(threadId: string, turns: AppServerTurn[], next: number) { transaction(this.database(),()=>{for(const turn of turns){const row=this.turn(threadId,turn.id);this.storeTurn(threadId,turn,row?Number(row.turn_seq):next++);}}); }
  finish(threadId: string, watermark: string, cursor: number, identity: string, path: string, epoch: string) {
    const db=this.database();
    if(!existsSync(this.paths(threadId).turns))writeFileSync(this.paths(threadId).turns,"",{mode:0o600});
    const total=db.prepare("SELECT count(*) AS n FROM opencraft_turn_offset_index WHERE thread_id=?").get(threadId) as Row;
    db.prepare("INSERT OR REPLACE INTO opencraft_cache_meta VALUES(?,?,?,?,?,?,?,?,?)").run(threadId,this.schema,watermark,cursor,identity,path,epoch,total.n,Date.now());
  }
  snapshot(threadId: string, turns: AppServerTurn[], source: {position:number;identity:string;path:string}, watermark: string, meta: Row|undefined, rebuild: boolean): {kind:"rebuild"|"increment";nativeBytes:number} {
    const db = this.database();
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

  close() { this.closed=true;this.db?.close();this.db=null; }
}
class InvalidTranscriptCursor extends Error { readonly code="TRANSCRIPT_CURSOR_EXPIRED"; constructor(){super("Transcript page expired; reload history");} }
