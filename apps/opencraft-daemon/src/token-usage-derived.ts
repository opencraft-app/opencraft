import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openManagedDatabase, createSchemaValidator, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { TOKEN_USAGE_STATE_MIGRATIONS } from "./token-usage-state-database.js";
import { OpenCraftTokenUsageLedger, type UsageCounts } from "./token-usage-ledger.js";
import { tokenModelKey } from "./token-usage-allocation.js";
import { emptyUsageParserState, parseUsageEvent, readUsageIncrement, type RetainedUsageEvent, type UsageParserState } from "./token-usage-derived-source.js";

// Retained source evidence has its own immutable migration history. Only the
// derived file may be discarded; neither receipts nor retained events are caches.
const RETAINED_SQL = `
CREATE TABLE usage_files(thread_id TEXT PRIMARY KEY,path TEXT NOT NULL,cursor INTEGER NOT NULL,identity TEXT,error TEXT,complete INTEGER NOT NULL) STRICT;
CREATE TABLE usage_events(seq INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,event_key TEXT NOT NULL UNIQUE,at_ms INTEGER NOT NULL,kind TEXT NOT NULL,data_json TEXT NOT NULL) STRICT;
CREATE TABLE usage_legacy(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(thread_id,turn_id)) STRICT;
`;
const CACHE_SQL = `
CREATE TABLE usage_cache_version(version TEXT NOT NULL) STRICT;
INSERT INTO usage_cache_version VALUES('rollout-counts-3/equal-turn-v1');
CREATE TABLE usage_parser(thread_id TEXT PRIMARY KEY,value_json TEXT NOT NULL) STRICT;
CREATE TABLE usage_totals(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,model_key TEXT NOT NULL,evidence TEXT NOT NULL,provider TEXT,model TEXT,counts_json TEXT NOT NULL,version INTEGER NOT NULL,at_ms INTEGER NOT NULL,PRIMARY KEY(thread_id,turn_id,model_key,evidence)) STRICT;
CREATE TABLE usage_receipts(thread_id TEXT NOT NULL,turn_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(thread_id,turn_id)) STRICT;
CREATE TABLE usage_position(singleton INTEGER PRIMARY KEY,seq INTEGER NOT NULL) STRICT;
INSERT INTO usage_position VALUES(1,0);
CREATE TABLE usage_reproject(thread_id TEXT PRIMARY KEY,after_turn TEXT NOT NULL) STRICT;
`;
export const DERIVED_CACHE_VERSION = "rollout-counts-3/equal-turn-v1";
const CACHE_MIGRATIONS = [...TOKEN_USAGE_STATE_MIGRATIONS,
  { version: TOKEN_USAGE_STATE_MIGRATIONS.at(-1)!.version+1, name: "rollout-derived-cache-v1", sql: CACHE_SQL },
  { version: TOKEN_USAGE_STATE_MIGRATIONS.at(-1)!.version+2, name: "rollout-derived-gap-index", sql: "CREATE INDEX derived_usage_gaps_thread ON token_usage_gaps(server_id,thread_id,ends_ms);" },
];
type Row = Record<string, any>;
type LegacyTurn = { tokens: string | null; buckets: { provider: string | null; model: string | null; tokens: string }[] };
function transaction<T>(db: DatabaseSync, body: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = body(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
function openCache(path: string): DatabaseSync {
  const options = { path, legacyPolicy: "reject-unknown" as const, migrations: CACHE_MIGRATIONS,
    validateSchema: createSchemaValidator(CACHE_MIGRATIONS.map(m => m.sql).join("\n")) };
  try {
    const db = openManagedDatabase(options).database;
    if (db.prepare("SELECT version FROM usage_cache_version").get()?.version === DERIVED_CACHE_VERSION) return db;
    db.close();
  } catch (error) {
    if (!(error instanceof SqliteLifecycleError) || !["history-mismatch", "newer-schema", "unsupported-legacy"].includes(error.kind)) throw error;
  }
  // This exact path is an explicitly disposable projection owned by this worker.
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  return openManagedDatabase(options).database;
}

/** One worker owns retained evidence and the rebuildable query projection.
 * All native file I/O is asynchronous and all reductions use bounded batches. */
export class RolloutDerivedTokenUsage {
  readonly database: DatabaseSync;
  readonly ledger: OpenCraftTokenUsageLedger;
  private readonly source: DatabaseSync;
  private readonly retained: DatabaseSync;
  private receiptAfter: [string, string] = ["", ""];
  private receiptsReady = false;
  private readonly dirty = new Set<string>();
  private readonly dirtyAfter = new Map<string,string>();
  private readonly dirtyAgain = new Set<string>();
  private fileAfter = "";
  private roundProgress = false;
  private readonly hadCache: boolean;
  private closed = false;
  private actualEnabled = true;
  private activeRead = false;
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  private statement(db: DatabaseSync, sql: string) {
    const key = (db === this.database ? "c" : db === this.retained ? "r" : "s") + sql;
    const old = this.statements.get(key); if (old) return old;
    const stmt = db.prepare(sql); if (this.statements.size >= 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(key, stmt); return stmt;
  }
  constructor(readonly options: { databasePath: string; nativeHome: string; serverId: string; directory?: string }) {
    const directory = options.directory ?? dirname(options.databasePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.source = new DatabaseSync(options.databasePath, { readOnly: true });
    this.source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=0");
    this.retained = openManagedDatabase({ path: join(directory, "token-usage-retained.sqlite"), legacyPolicy: "reject-unknown",
      migrations: [{ version: 1, name: "retained-native-usage-evidence", sql: RETAINED_SQL }], validateSchema: createSchemaValidator(RETAINED_SQL) }).database;
    this.database = openCache(join(directory, "token-usage-derived.sqlite"));
    this.hadCache=!!this.statement(this.database,"SELECT 1 FROM token_usage_turns LIMIT 1").get();
    this.copyCoverage();
    this.ledger = new OpenCraftTokenUsageLedger({ database: this.database, transaction: body => transaction(this.database, body) }, options.serverId);
    for(const file of this.statement(this.retained,"SELECT thread_id,error FROM usage_files WHERE error IS NOT NULL").all())this.gap(`file:${file.thread_id}`,String(file.thread_id),String(file.error));
    this.gap("building", null, "source-offline");
  }
  private copyCoverage() {
    const scope = this.statement(this.source, "SELECT * FROM token_usage_scopes WHERE server_id=?").get(this.options.serverId);
    if (!scope) throw new Error("No trusted usage coverage");
    this.actualEnabled = scope.enabled === 1;
    const before=this.statement(this.database,"SELECT * FROM token_usage_scopes WHERE server_id=?").get(this.options.serverId);
    const intervals=this.statement(this.source,"SELECT starts_ms,ends_ms FROM token_usage_coverage WHERE server_id=? ORDER BY id").all(this.options.serverId);
    const previous=this.statement(this.database,"SELECT starts_ms,ends_ms FROM token_usage_coverage WHERE server_id=? ORDER BY id").all(this.options.serverId);
    if(before?.enabled===scope.enabled&&before?.enabled_at_ms===scope.enabled_at_ms&&JSON.stringify(intervals)===JSON.stringify(previous))return;
    transaction(this.database, () => {
      this.statement(this.database, "INSERT INTO token_usage_scopes VALUES(?,?,?,0) ON CONFLICT(server_id) DO UPDATE SET enabled_at_ms=excluded.enabled_at_ms,enabled=excluded.enabled,revision=revision+1").run(this.options.serverId, scope.enabled_at_ms!,scope.enabled!);
      this.statement(this.database, "DELETE FROM token_usage_coverage WHERE server_id=?").run(this.options.serverId);
      const put = this.statement(this.database, "INSERT INTO token_usage_coverage(server_id,starts_ms,ends_ms) VALUES(?,?,?)");
      for (const interval of intervals) put.run(this.options.serverId, interval.starts_ms!, interval.ends_ms!);
    });
  }
  invalidate(threadId: string, path?: string) {
    if (!threadId || threadId.length > 1024) return;
    if(threadId==="*"){this.copyCoverage();this.receiptsReady=false;this.receiptAfter=["",""];this.gap("building",null,"source-offline");return;}
    if(this.dirty.has(threadId))this.dirtyAgain.add(threadId);
    else if (this.dirty.size < 10000) this.dirty.add(threadId);
    else this.gap("receipt-overflow", null, "queue-full");
    if (path) this.register(threadId, path);
  }
  private register(threadId: string, path: string) {
    const previous = this.statement(this.retained, "SELECT path FROM usage_files WHERE thread_id=?").get(threadId);
    if(previous?.path===path)return;
    if (previous && previous.path !== path && existsSync(String(previous.path))) return;
    this.statement(this.retained, "INSERT INTO usage_files VALUES(?,?,0,NULL,NULL,0) ON CONFLICT(thread_id) DO UPDATE SET path=excluded.path,error=NULL").run(threadId, path);
  }
  /** Bounded filename discovery repairs archived/moved native paths. No content scan. */
  async discover(): Promise<void> {
    const allowed=new Set(this.statement(this.source, "SELECT DISTINCT thread_id FROM token_usage_turns WHERE server_id=?").all(this.options.serverId).map(row=>String(row.thread_id)));
    const visit = async (directory: string, depth: number): Promise<void> => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (this.closed) return;
        const path = join(directory, entry.name);
        if (entry.isDirectory() && depth > 0) await visit(path, depth - 1);
        else if (entry.isFile()) {
          const match = entry.name.match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
          if (match&&allowed.has(match[1]!)) this.register(match[1]!, path);
        }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    for (const folder of ["sessions", "archived_sessions"]) await visit(join(this.options.nativeHome, folder), 3);
  }
  private gap(id: string, thread: string | null, reason: string) {
    this.ledger.commitReplayBatch(()=>{
      const changed=this.statement(this.database, "INSERT INTO token_usage_gaps VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(server_id,gap_key) DO UPDATE SET ends_ms=NULL WHERE ends_ms IS NOT NULL").run(this.options.serverId, id, thread, null, reason, Date.now());
      if(changed.changes){this.statement(this.database, "UPDATE token_usage_scopes SET revision=revision+1 WHERE server_id=?").run(this.options.serverId);if(thread&&!id.startsWith("retained:"))this.enqueueProjection(thread);}
    });
  }
  private clearGap(id: string) {
    this.ledger.commitReplayBatch(()=>{
      const gap=this.statement(this.database,"SELECT thread_id FROM token_usage_gaps WHERE server_id=? AND gap_key=? AND ends_ms IS NULL").get(this.options.serverId,id);
      if(!gap)return;
      this.statement(this.database, "UPDATE token_usage_gaps SET ends_ms=? WHERE server_id=? AND gap_key=?").run(Date.now(),this.options.serverId,id);
      this.statement(this.database, "UPDATE token_usage_scopes SET revision=revision+1 WHERE server_id=?").run(this.options.serverId);
      if(gap.thread_id&&!id.startsWith("retained:"))this.enqueueProjection(String(gap.thread_id));
    });
  }
  private enqueueProjection(threadId:string){this.statement(this.database,"INSERT INTO usage_reproject VALUES(?,'') ON CONFLICT(thread_id) DO UPDATE SET after_turn=''").run(threadId);}
  fault(){this.gap("refresh-failed",null,"source-offline");}
  queryReady(){return this.hadCache||this.receiptsReady;}
  private syncReceipt(turn: Row) {
    const server = this.options.serverId, thread = String(turn.thread_id), turnId = String(turn.turn_id), key = { threadId: thread, turnId };
    const params = [server, thread, turnId];
    const inputs = this.statement(this.source, "SELECT * FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY input_id").all(...params);
    const unresolved = this.statement(this.source, `SELECT count(*) AS n FROM token_usage_admissions a LEFT JOIN token_usage_submissions s USING(server_id,thread_id,input_id)
      WHERE a.server_id=? AND a.thread_id=? AND a.turn_id=? AND (s.input_id IS NULL OR s.actor_kind='unknown' OR (s.actor_kind='human' AND s.actor_id IS NULL) OR EXISTS(SELECT 1 FROM token_usage_input_conflicts c WHERE c.server_id=a.server_id AND c.thread_id=a.thread_id AND c.input_id=a.input_id))`).get(...params)!.n;
    const fingerprint = createHash("sha256").update(JSON.stringify([turn.started_ms, turn.execution_state, turn.source_kind, turn.participants_complete, turn.frozen, unresolved, inputs])).digest("hex");
    const before = this.statement(this.database, "SELECT fingerprint FROM usage_receipts WHERE thread_id=? AND turn_id=?").get(thread, turnId);
    if (before?.fingerprint === fingerprint) return;
    const buckets = this.statement(this.source, "SELECT provider,model,tokens FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY model_key").all(...params);
    this.statement(this.retained, "INSERT OR IGNORE INTO usage_legacy VALUES(?,?,?)").run(thread, turnId, JSON.stringify({ tokens: turn.observed_tokens, buckets }));
    this.ledger.commitReplayBatch(() => {
      this.statement(this.database, "UPDATE token_usage_scopes SET enabled=1 WHERE server_id=?").run(server);
      this.ledger.startTurn(key, Number(turn.started_ms), turn.source_kind, turn.participants_complete === 1);
      // Replace only this disposable copy of trusted participation, including
      // unresolved/ambiguous admissions. Never infer identities from a rollout.
      this.statement(this.database, "DELETE FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=?").run(...params);
      const put = this.statement(this.database, "INSERT INTO token_usage_inputs VALUES(?,?,?,?,?,?,?,?)");
      for (const input of inputs) put.run(...params.slice(0, 2), input.input_id!, turnId, input.actor_id!, input.actor_kind!, input.mode!, input.admission!);
      this.statement(this.database, "UPDATE token_usage_turns SET source_kind=?,participants_complete=? WHERE server_id=? AND thread_id=? AND turn_id=?").run(turn.source_kind, turn.participants_complete === 1 && Number(unresolved) === 0 ? 1 : 0, ...params);
      this.statement(this.database, "INSERT INTO usage_receipts VALUES(?,?,?) ON CONFLICT(thread_id,turn_id) DO UPDATE SET fingerprint=excluded.fingerprint").run(thread, turnId, fingerprint);
      this.project(thread, turnId, String(turn.execution_state),true);
      this.statement(this.database, "UPDATE token_usage_scopes SET enabled=? WHERE server_id=?").run(this.actualEnabled ? 1 : 0, server);
    });
  }
  private project(threadId: string, turnId: string, execution?: string,receiptsChanged=false) {
    const key = { threadId, turnId }, turn = this.ledger.readTurn(key); if (!turn) return;
    const params = [threadId, turnId];
    this.statement(this.database,"UPDATE token_usage_turns SET frozen=0 WHERE server_id=? AND thread_id=? AND turn_id=?").run(this.options.serverId,...params);
    const allTotals = this.statement(this.database, "SELECT * FROM usage_totals WHERE thread_id=? AND turn_id=? ORDER BY model_key").all(...params);
    const exact=allTotals.some(row=>row.evidence==="exact"),totals=allTotals.filter(row=>row.evidence===(exact?"exact":"counter"));
    if(exact&&allTotals.some(row=>row.evidence==="counter"))this.gap(`mixed:${threadId}:${turnId}`,threadId,"invalid-source");
    const file = this.statement(this.retained, "SELECT error,complete FROM usage_files WHERE thread_id=?").get(threadId);
    const old = this.statement(this.retained, "SELECT value_json FROM usage_legacy WHERE thread_id=? AND turn_id=?").get(...params);
    const legacy: LegacyTurn | null = old ? JSON.parse(String(old.value_json)) : null;
    const incomplete=!!this.statement(this.database,"SELECT 1 FROM token_usage_gaps WHERE server_id=? AND thread_id=? AND ends_ms IS NULL AND gap_key NOT LIKE 'retained:%' LIMIT 1").get(this.options.serverId,threadId);
    const derivedTotal=totals.reduce((n,row)=>n+BigInt(JSON.parse(String(row.counts_json)).totalTokens),0n);
    const useRetained = (!totals.length && (!file || file.error !== null || file.complete === 1)) || (!!legacy?.tokens&&(file?.error||incomplete)&&BigInt(legacy.tokens)>derivedTotal);
    let removed=false;
    if (totals.length&&!useRetained) {
      this.clearGap(`retained:${threadId}:${turnId}`);
      removed=!!this.statement(this.database, "DELETE FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND lineage='retained-legacy'").run(this.options.serverId, ...params).changes;
      removed=!!this.statement(this.database,"DELETE FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND lineage='rollout-derived' AND source_id NOT IN (SELECT model_key FROM usage_totals WHERE thread_id=? AND turn_id=? AND evidence=?)").run(this.options.serverId,...params,...params,exact?"exact":"counter").changes||removed;
      for (const row of totals) this.ledger.recordSource({ ...key, lineage: "rollout-derived", sourceId: String(row.model_key), kind: "response", version: Number(row.version), provider: row.provider as string | null, model: row.model as string | null, counts: JSON.parse(String(row.counts_json)), observedAt: Number(row.at_ms) });
    } else if (useRetained) {
      if (legacy?.tokens !== null && legacy) {
        removed=!!this.statement(this.database,"DELETE FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND lineage='rollout-derived'").run(this.options.serverId,...params).changes;
        for (const bucket of legacy.buckets) this.ledger.recordSource({ ...key, lineage: "retained-legacy", sourceId: tokenModelKey(bucket.provider, bucket.model), kind: "response", version: 0, provider: bucket.provider, model: bucket.model, counts: { totalTokens: bucket.tokens } });
        this.gap(`retained:${threadId}:${turnId}`, threadId, "unreplayable");
      }
    }
    const status = execution ?? turn.executionState;
    const nativeTerminal = !!this.statement(this.database, "SELECT 1 FROM token_usage_native_terminals WHERE server_id=? AND thread_id=? AND turn_id=?").get(this.options.serverId, ...params);
    const missing = !!this.statement(this.database, "SELECT 1 FROM token_usage_gaps WHERE server_id=? AND ends_ms IS NULL AND thread_id=? AND gap_key NOT LIKE 'retained:%' LIMIT 1").get(this.options.serverId, threadId);
    const frozen=this.statement(this.source,"SELECT frozen FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(this.options.serverId,...params)?.frozen===1;
    this.ledger.reconcile(key, { executionState: status as "running" | "completed" | "failed" | "interrupted", participantsComplete: this.statement(this.database, "SELECT participants_complete FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(this.options.serverId, ...params)!.participants_complete === 1, usageComplete: status !== "running" && nativeTerminal && !missing&&!frozen, responsesComplete: true });
    if(frozen)this.statement(this.database,"UPDATE token_usage_turns SET frozen=1 WHERE server_id=? AND thread_id=? AND turn_id=?").run(this.options.serverId,...params);
    if(frozen||receiptsChanged||removed)this.ledger.rebuildProjection(key);
  }
  private consume() {
    const seq = Number(this.statement(this.database, "SELECT seq FROM usage_position WHERE singleton=1").get()!.seq);
    const rows = this.statement(this.retained, "SELECT * FROM usage_events WHERE seq>? ORDER BY seq LIMIT 128").all(seq);
    if (!rows.length) return false;
    this.ledger.commitReplayBatch(() => {
      this.statement(this.database, "UPDATE token_usage_scopes SET enabled=1 WHERE server_id=?").run(this.options.serverId);
      const states = new Map<string, UsageParserState>(), touched = new Map<string, string | undefined>();
      for (const row of rows) {
        const thread = String(row.thread_id);
        let state = states.get(thread);
        if (!state) {
          const saved = this.statement(this.database, "SELECT value_json FROM usage_parser WHERE thread_id=?").get(thread);
          state = saved ? JSON.parse(String(saved.value_json)) : emptyUsageParserState(); states.set(thread, state!);
        }
        const event = { kind: row.kind, data: JSON.parse(String(row.data_json)) } as RetainedUsageEvent;
        const result = parseUsageEvent(state!, event, thread);
        if (result.missing) {this.gap(`invalid:${thread}`, thread, "invalid-source");if(state!.turn){const key=JSON.stringify([thread,state!.turn]);if(!touched.has(key))touched.set(key,undefined);}}
        if (result.delta) {
          const d = result.delta, modelKey = tokenModelKey(d.provider, d.model);
          const nativeTime=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(d.turnId)?Number.parseInt(d.turnId.replaceAll("-","").slice(0,12),16):null;
          const known=this.statement(this.source,"SELECT started_ms FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(this.options.serverId,thread,d.turnId);
          const started=known?.started_ms??nativeTime;
          const interval=started===null?null:this.statement(this.source,"SELECT ends_ms FROM token_usage_coverage WHERE server_id=? AND starts_ms<=? AND (ends_ms IS NULL OR ends_ms>?) ORDER BY starts_ms DESC LIMIT 1").get(this.options.serverId,started,started);
          if(!interval||(interval.ends_ms!==null&&Number(row.at_ms)>=Number(interval.ends_ms)))continue;
          const old = this.statement(this.database, "SELECT counts_json FROM usage_totals WHERE thread_id=? AND turn_id=? AND model_key=? AND evidence=?").get(thread, d.turnId, modelKey,d.evidence);
          const counts: UsageCounts = old ? JSON.parse(String(old.counts_json)) : Object.fromEntries(Object.keys(d.counts).map(k => [k, "0"])) as unknown as UsageCounts;
          const next = Object.fromEntries(Object.entries(d.counts).map(([k, n]) => [k, n === null || counts[k as keyof UsageCounts] === null ? null : (BigInt(counts[k as keyof UsageCounts]!) + BigInt(n)).toString()]));
          this.statement(this.database, "INSERT INTO usage_totals VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,turn_id,model_key,evidence) DO UPDATE SET counts_json=excluded.counts_json,version=excluded.version,at_ms=excluded.at_ms").run(thread, d.turnId, modelKey,d.evidence, d.provider, d.model, JSON.stringify(next), row.seq!, row.at_ms!);
          const key=JSON.stringify([thread,d.turnId]);if(!touched.has(key))touched.set(key,undefined);
        }
        if (result.terminal) {
          this.ledger.recordNativeTerminal({ threadId: thread, turnId: result.terminal.turnId });
          touched.set(JSON.stringify([thread, result.terminal.turnId]), result.terminal.state);
        }
      }
      for (const [thread, state] of states) this.statement(this.database, "INSERT INTO usage_parser VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET value_json=excluded.value_json").run(thread, JSON.stringify(state));
      for (const [key, status] of touched) { const [thread, turn] = JSON.parse(key); this.project(thread, turn, status); }
      this.statement(this.database, "UPDATE usage_position SET seq=? WHERE singleton=1").run(rows.at(-1)!.seq!);
      this.statement(this.database, "UPDATE token_usage_scopes SET enabled=? WHERE server_id=?").run(this.actualEnabled ? 1 : 0, this.options.serverId);
    });
    return true;
  }
  /** Returns true when more bounded work can run immediately. */
  async step(): Promise<boolean> {
    if (this.closed || this.activeRead) return false;
    this.activeRead = true;
    try {
      if (!this.receiptsReady) {
        const turns = this.statement(this.source, "SELECT * FROM token_usage_turns WHERE server_id=? AND (thread_id,turn_id)>(?,?) ORDER BY thread_id,turn_id LIMIT 32").all(this.options.serverId, ...this.receiptAfter);
        if(turns.length)this.ledger.commitReplayBatch(()=>transaction(this.retained,()=>{for(const turn of turns)this.syncReceipt(turn);}));
        const last=turns.at(-1);if(last)this.receiptAfter=[String(last.thread_id),String(last.turn_id)];
        if (turns.length === 32) return true;
        for (const row of this.statement(this.source, "SELECT thread_id,path FROM token_usage_rollouts WHERE server_id=?").all(this.options.serverId)) this.register(String(row.thread_id), String(row.path));
        this.receiptsReady = true;
      }
      const dirty = this.dirty.values().next().value;
      if (dirty) {
        this.copyCoverage();
        const turns=this.statement(this.source,"SELECT * FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id>? ORDER BY turn_id LIMIT 32").all(this.options.serverId,dirty,this.dirtyAfter.get(dirty)??"");
        if(turns.length)this.ledger.commitReplayBatch(()=>transaction(this.retained,()=>{for(const turn of turns)this.syncReceipt(turn);}));
        if(turns.length===32)this.dirtyAfter.set(dirty,String(turns.at(-1)!.turn_id));
        else{this.dirtyAfter.delete(dirty);if(this.dirtyAgain.has(dirty))this.dirtyAgain.delete(dirty);else this.dirty.delete(dirty);}
      }
      const projection=this.statement(this.database,"SELECT * FROM usage_reproject ORDER BY thread_id LIMIT 1").get();
      if(projection)this.ledger.commitReplayBatch(()=>{
        const thread=String(projection.thread_id),turns=this.statement(this.database,"SELECT turn_id FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id>? ORDER BY turn_id LIMIT 32").all(this.options.serverId,thread,projection.after_turn!);
        this.statement(this.database,"UPDATE token_usage_scopes SET enabled=1 WHERE server_id=?").run(this.options.serverId);
        for(const turn of turns)this.project(thread,String(turn.turn_id));
        this.statement(this.database,"UPDATE token_usage_scopes SET enabled=? WHERE server_id=?").run(this.actualEnabled?1:0,this.options.serverId);
        if(turns.length===32)this.statement(this.database,"UPDATE usage_reproject SET after_turn=? WHERE thread_id=?").run(turns.at(-1)!.turn_id!,thread);
        else this.statement(this.database,"DELETE FROM usage_reproject WHERE thread_id=?").run(thread);
      });
      if (this.consume()) return true;
      const file = this.statement(this.retained, "SELECT * FROM usage_files WHERE thread_id>? ORDER BY thread_id LIMIT 1").get(this.fileAfter);
      if (!file) { this.fileAfter = "";const more=this.roundProgress||this.dirty.size>0||!!this.statement(this.database,"SELECT 1 FROM usage_reproject LIMIT 1").get();this.roundProgress=false;if(!more){this.clearGap("building");this.clearGap("refresh-failed");}return more; }
      const thread = String(file.thread_id); this.fileAfter = thread;
      try {
        const result = await readUsageIncrement({ path: String(file.path), nativeHome: this.options.nativeHome, threadId: thread, cursor: Number(file.cursor), identity: file.identity as string | null });
        if (this.closed) return false;
        if(result.events.some(row=>row.event.kind==="session"&&row.event.data[0]!==thread))throw new Error("Usage session identity mismatch");
        const changed=result.cursor!==Number(file.cursor)||result.identity!==file.identity||result.missing||file.complete!==(result.more?0:1);
        let sourceMissing=result.missing;
        if(changed)transaction(this.retained, () => {
          const put = this.statement(this.retained, "INSERT OR IGNORE INTO usage_events(thread_id,event_key,at_ms,kind,data_json) VALUES(?,?,?,?,?)");
          for (const row of result.events) {
            const json=JSON.stringify(row.event.data),inserted=put.run(thread,row.key,row.at,row.event.kind,json);
            if(!inserted.changes&&this.statement(this.retained,"SELECT data_json FROM usage_events WHERE event_key=?").get(row.key)?.data_json!==json)sourceMissing=true;
          }
          this.statement(this.retained, "UPDATE usage_files SET cursor=?,identity=?,error=?,complete=? WHERE thread_id=?").run(result.cursor, result.identity, sourceMissing ? "invalid-source" : file.error, result.more ? 0 : 1, thread);
        });
        if (sourceMissing||file.error) this.gap(`file:${thread}`, thread, "invalid-source");
        else if (!file.error) this.clearGap(`file:${thread}`);
        if(!result.more&&file.complete!==1)this.ledger.commitReplayBatch(()=>{
          this.statement(this.database, "UPDATE token_usage_scopes SET enabled=1 WHERE server_id=?").run(this.options.serverId);
          for(const turn of this.statement(this.source, "SELECT turn_id FROM token_usage_turns WHERE server_id=? AND thread_id=?").all(this.options.serverId,thread))this.project(thread,String(turn.turn_id));
          this.statement(this.database, "UPDATE token_usage_scopes SET enabled=? WHERE server_id=?").run(this.actualEnabled?1:0,this.options.serverId);
        });
        if (result.events.length || result.cursor > Number(file.cursor)) { this.roundProgress=true;return true; }
      } catch {
        this.statement(this.retained, "UPDATE usage_files SET error='source-replaced',complete=1 WHERE thread_id=?").run(thread);
        this.gap(`file:${thread}`, thread, "source-replaced");
        this.ledger.commitReplayBatch(() => {
          this.statement(this.database, "UPDATE token_usage_scopes SET enabled=1 WHERE server_id=?").run(this.options.serverId);
          for (const turn of this.statement(this.source, "SELECT turn_id FROM token_usage_turns WHERE server_id=? AND thread_id=?").all(this.options.serverId, thread)) this.project(thread, String(turn.turn_id));
          this.statement(this.database, "UPDATE token_usage_scopes SET enabled=? WHERE server_id=?").run(this.actualEnabled ? 1 : 0, this.options.serverId);
        });
      }
      return true;
    } finally { this.activeRead = false; }
  }
  close() { this.closed = true; this.statements.clear(); this.database.close(); this.retained.close(); this.source.close(); }
}
