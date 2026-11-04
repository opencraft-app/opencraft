import {publicTextQuery,type PublicTextRead,type PublicTextWindow,type PublicTextControl,type PublicTextFence} from '@opencraft/appserver-protocol/collaboration';
import {searchTokens,searchSnippet} from './conversation-search.js';
import { parseThreadCatalogChange, THREAD_CATALOG_CHANGED, CATALOG_MERKLE_CURSOR } from "@opencraft/appserver-protocol";
import { historyReadTiming,addHistoryReadTiming,recordDirectoryDetail } from "./history-read-timing.js";
import type { ThreadHistoryUpdate, ThreadHistoryVersion } from "@opencraft/appserver-protocol";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ConversationSearch } from "./conversation-search.js";
import { emptyHistory, reduceHistory, importCoverage, orderKey, unknownCoverage, type HistoryState, type HistoryChange, type HistoryRecord } from "./conversation-model.js";
import { DirectorySnapshotIndex, DirectorySnapshotPages, SNAPSHOT_CURSOR } from "./thread-directory/snapshots.js";

type Value = Record<string, any>;
export type HistoryAdmission = ((id: string) => boolean) & {
  catalogPolicy?: (id: string) => "shared" | "private" | undefined;
  catalogRevision?: number;
  catalogProjected?: boolean;
  catalogReader?: string;
};
export interface DirectoryObservation { epoch: string; fromHead: boolean }
interface CommittedChange { threadId: string; change: HistoryChange; completed: boolean }
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
function sourceItem(entry: Value, groupId: string): Value {
  if(entry.turnId!==undefined && entry.turnId!==groupId)throw new Error("History Item belongs to an unexpected group");
  const item={...object(entry.item ?? entry)};
  for(const key of ["startedAtMs","completedAtMs"])if(typeof entry[key]==="number" && Number.isFinite(entry[key]))item[key]=entry[key];
  return item;
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096;
const terminal = (value: unknown) => ["completed", "failed", "interrupted"].includes(String(value));
const json = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export function historyDirectoryQuery(params: Value): string {
  const { cursor: _cursor, limit: _limit, ...query } = params;
  return json({ archived: false, sortKey: "updated_at", sortDirection: "desc", ...query });
}
export class HistoryNotStored extends Error { readonly code = -32074; }
export class InvalidHistoryCursor extends Error {
  readonly code = -32602;
  constructor(message: string, readonly data?: { code: "HISTORY_CURSOR_EXPIRED"; retryable: true; replacementCursor: string }) { super(message); }
}

/** Immutable versioned baseline + semantic changes own content. Indexed columns
 * are a disposable projection; legacy ambiguous removals are never replayed. */
export class ConversationHistory {
  private readonly catalogPages = new DirectorySnapshotPages();
  private catalogIndex?: { revision: number; index: DirectorySnapshotIndex };
  private discovery: Value | null = null;
  private preparing = new Set<string>();
  private transactionDepth = 0;
  private changedThreads = new Set<string>();
  private committedChanges: CommittedChange[] = [];
  private directoryChanged = false;
  private readonly commits = new Set<(threadIds: readonly string[], catalogRevision: number, updates: ReadonlyMap<string, ThreadHistoryUpdate>, catalogChanged: boolean, deletedThreadIds: readonly string[]) => void>();
  private transactionVersions = new Map<string, ThreadHistoryVersion | null>();
  private readonly directoryRows: ReturnType<DatabaseSync["prepare"]>;
  private readonly directoryDataVersion: ReturnType<DatabaseSync["prepare"]>;
  private readonly directorySchemaVersion: ReturnType<DatabaseSync["prepare"]>;
  private readonly directoryChanges: ReturnType<DatabaseSync["prepare"]>;
  private directorySnapshot?: { dataVersion: number; schemaVersion: number; changes: number; fence: ReadonlyMap<string, string> };
  readonly searchIndex: ConversationSearch;
  constructor(readonly database: DatabaseSync, readonly scope: string, private readonly readOnly = false) {
    this.searchIndex=new ConversationSearch(database,scope);
    if (!readOnly) database.prepare("INSERT OR IGNORE INTO conversation_catalogs(scope,revision,sync_state) VALUES(?,0,'{}')").run(scope);
    this.directoryRows = database.prepare("SELECT id,metadata,archived,deleted FROM conversation_threads WHERE scope=? ORDER BY id");
    this.directoryDataVersion = database.prepare("PRAGMA data_version");
    this.directorySchemaVersion = database.prepare("PRAGMA schema_version");
    this.directoryChanges = database.prepare("SELECT total_changes() AS changes");
  }
  private transaction<T>(run: () => T): T {
    const outer = this.transactionDepth === 0;
    const before = outer ? this.catalogRevision() : 0;
    const saved = new Set(this.changedThreads), savedChanges = this.committedChanges.length, savedDirectory = this.directoryChanged;
    const savedVersions = new Map(this.transactionVersions);
    this.database.exec("SAVEPOINT conversation_history");
    this.transactionDepth++;
    let result: T;
    try { result = run(); this.database.exec("RELEASE conversation_history"); }
    catch (error) {
      this.changedThreads = saved; this.committedChanges.length = savedChanges; this.directoryChanged = savedDirectory;
      this.transactionVersions = savedVersions;
      this.database.exec("ROLLBACK TO conversation_history; RELEASE conversation_history"); throw error;
    } finally { this.transactionDepth--; }
    if (outer) {
      const ids = [...this.changedThreads]; this.changedThreads.clear();
      const changes = this.committedChanges; this.committedChanges = [];
      const updates = new Map(ids.map(threadId => [threadId, {
        ...this.committedUpdate(threadId, changes),
        baseVersion: this.transactionVersions.get(threadId) ?? null,
        version: this.version(threadId)!,
      }]));
      this.transactionVersions.clear();
      const deletedThreadIds = ids.filter(threadId => !this.thread(threadId));
      const catalogChanged = this.directoryChanged || changes.some(({change}) => change.type === "metadata" || change.type === "archive")
        || deletedThreadIds.length > 0;
      this.directoryChanged = false;
      const revision = this.catalogRevision();
      if (revision !== before) for (const listener of this.commits) {
        // A consumer failure cannot roll back a transaction that already committed.
        try { listener(ids, revision, updates, catalogChanged, deletedThreadIds); } catch { /* Consumers reconcile on their next read. */ }
      }
    }
    return result;
  }
  subscribeCommitted(listener: (threadIds: readonly string[], catalogRevision: number, updates: ReadonlyMap<string, ThreadHistoryUpdate>, catalogChanged: boolean, deletedThreadIds: readonly string[]) => void): () => void {
    this.commits.add(listener); return () => { this.commits.delete(listener); };
  }
  private version(threadId: string): ThreadHistoryVersion | null {
    const row = this.database.prepare("SELECT epoch,revision FROM conversation_threads WHERE scope=? AND id=?").get(this.scope, threadId);
    return row ? { epoch: String(row.epoch), revision: Number(row.revision) } : null;
  }
  private rememberVersion(threadId: string): void {
    if (!this.transactionVersions.has(threadId)) this.transactionVersions.set(threadId, this.version(threadId));
  }
  private committedUpdate(threadId: string, changes: readonly CommittedChange[]): ThreadHistoryUpdate {
    const update: ThreadHistoryUpdate = {turns: [], removedTurnIds: [], removedItems: []};
    if (!this.thread(threadId)) return update;
    const groups = new Map<string, {items: Map<string, {value: Value; completed: boolean}>; itemOrder?: string[]}>();
    const group = (id: string) => { let value=groups.get(id); if(!value) groups.set(id,value={items:new Map()}); return value; };
    for (const entry of changes) {
      if(entry.threadId !== threadId) continue;
      const change=entry.change;
      if(change.type === "metadata") {
        const {turns:_turns,status:_status,historyMode:_mode,extra:_extra,...metadata}=change.value;
        update.metadata=metadata;
      } else if(change.type === "put") {
        const row=change.record;
        if(row.kind === "group") group(row.value.id);
        if(row.kind === "item" && row.groupId) group(row.groupId).items.set(row.value.id,{value:row.value,completed:entry.completed});
      } else if(change.type === "remove") {
        if(change.id.startsWith("group:")) update.removedTurnIds.push(change.id.slice(6));
        if(change.id.startsWith("item:")) { const [turnId,itemId]=JSON.parse(change.id.slice(5)); update.removedItems.push({turnId,itemId}); }
      } else if(change.type === "order") {
        if(change.kind === "item" && change.groupId) group(change.groupId).itemOrder=change.ids.map(id=>JSON.parse(id.slice(5))[1]);
        if(change.kind === "group") update.turnOrder=change.ids.map(id=>id.slice(6));
      }
    }
    const latest=this.database.prepare("SELECT record_id FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind='group' ORDER BY position DESC,record_id DESC LIMIT 1").get(this.scope,threadId)?.record_id;
    for(const [id,delta] of groups) {
      const row=this.current(threadId,`group:${id}`); if(!row) continue;
      const header=this.body(row.hash), items: Value[]=[], completedItemIds: string[]=[];
      for(const [itemId,entry] of delta.items) {
        if(!this.current(threadId,`item:${json([id,itemId])}`)) continue;
        const preview=this.preview(entry.value), item=preview.__message ? {...entry.value}:preview;
        if(item.__deferred) { delete item.__deferred; item.historyDetail={cursor:this.cursor(threadId,{kind:"groups",groupId:id})}; }
        items.push(item);
        if(entry.completed || terminal(header.status)) completedItemIds.push(itemId);
      }
      update.turns.push({turn:{...header,id,items:items as unknown as ThreadHistoryUpdate["turns"][number]["turn"]["items"]},completedItemIds,latest:latest===`group:${id}`,...(delta.itemOrder ? {itemOrder:delta.itemOrder}:{})});
    }
    update.removedTurnIds = update.removedTurnIds.filter(id => !this.current(threadId, `group:${id}`));
    update.removedItems = update.removedItems.filter(({turnId,itemId}) => !this.current(threadId, `item:${json([turnId,itemId])}`));
    return update;
  }
  /** Replay only committed display changes. Native checkpoints and source
   * reads are not involved; unchanged loaded bodies remain client-owned. */
  private changesSince(threadId: string, base: unknown): ThreadHistoryUpdate | undefined {
    const value = object(base), version = this.version(threadId);
    if (!version || value.epoch !== version.epoch || !Number.isSafeInteger(value.revision)
      || value.revision < 0 || value.revision > version.revision) return;
    const changes: CommittedChange[] = [];
    for (const row of this.database.prepare("SELECT hash FROM conversation_events WHERE scope=? AND thread_id=? AND revision>? ORDER BY revision").all(this.scope,threadId,value.revision)) {
      const event = this.envelope(row.hash);
      if (event.format !== "opencraft-history-v2" || event.change.type === "baseline") return;
      changes.push({threadId,change:event.change,completed:event.completed === true || event.change.type === "put"
        && (event.change.record.value.completed === true || terminal(event.change.record.value.status))});
    }
    return {...this.committedUpdate(threadId, changes), baseVersion: {epoch: value.epoch,revision: value.revision}, version};
  }
  revision(threadId: string): number { this.ensureModel(threadId); return Number(this.database.prepare("SELECT revision FROM conversation_threads WHERE scope=? AND id=?").get(this.scope, threadId)?.revision ?? 0); }
  catalogRevision(): number { return Number(this.database.prepare("SELECT revision FROM conversation_catalogs WHERE scope=?").get(this.scope)?.revision ?? 0); }
  /** Directory RPCs carry no Item bodies. Their optimistic fence covers only
   * directory facts, including writes from older still-connected readers. */
  private directoryRecordFence(row?: Value): string | undefined {
    // Both directory queries select exactly these scalar columns. Preserve the
    // canonical bytes without sorting object entries for every captured row.
    return row ? createHash("sha256").update(JSON.stringify({archived:row.archived,deleted:row.deleted,id:row.id,metadata:row.metadata})).digest("hex"):undefined;
  }
  directoryFence(): ReadonlyMap<string,string> {
    const observation=historyReadTiming.getStore();
    addHistoryReadTiming(observation,"directoryFenceCalls",1);
    // data_version detects commits from older/other connections; total_changes
    // also detects writes through this borrowed connection. Never retain a
    // transaction-local snapshot: total_changes does not undo rolled-back work.
    const cacheable = !this.database.isTransaction;
    const dataVersion = Number(this.directoryDataVersion.get()!.data_version);
    const schemaVersion = Number(this.directorySchemaVersion.get()!.schema_version);
    const changes = Number(this.directoryChanges.get()!.changes);
    if (cacheable && this.directorySnapshot?.dataVersion === dataVersion && this.directorySnapshot.changes === changes && this.directorySnapshot.schemaVersion === schemaVersion)
      {addHistoryReadTiming(observation,"directoryFenceCacheHits",1);return this.directorySnapshot.fence;}
    let bytes=0,rows=0;
    const fence = new Map(this.directoryRows.all(this.scope).map(row=>{rows++;if(observation?.active)bytes+=Buffer.byteLength(String(row.metadata));return [String(row.id),this.directoryRecordFence(row)!] as const;}));
    addHistoryReadTiming(observation,"directoryFenceRebuilds",1);addHistoryReadTiming(observation,"directoryFenceRows",rows);addHistoryReadTiming(observation,"directoryFenceBytes",bytes);
    // Capture the markers before reading rows. A concurrent writer arriving
    // during/after this SELECT must invalidate the next capture too.
    if (cacheable) this.directorySnapshot = {dataVersion, schemaVersion, changes, fence};
    return fence;
  }
  private directoryKey(params: Value): string {
    return historyDirectoryQuery(params);
  }
  directoryState(params: Value): Value {
    const state = JSON.parse(String(this.database.prepare("SELECT sync_state FROM conversation_catalogs WHERE scope=?").get(this.scope)!.sync_state));
    const {next,epoch,...coverage}=state[this.directoryKey(params)] ?? {state:"unknown",hasMore:state._epoch != null};
    return {...coverage,epoch:json([state._epoch ?? null,epoch ?? null]),hasMore:coverage.hasMore ?? next != null};
  }
  /** Cache observation epoch, not a claim about a native snapshot generation. */
  directoryEpoch(params: Value): string {
    return this.directoryState(params).epoch;
  }
  invalidateDirectory(params?: Value, event?: {source:string;revision:number}, reconciling=false): void {
    this.transaction(() => {
      const state = JSON.parse(String(this.database.prepare("SELECT sync_state FROM conversation_catalogs WHERE scope=?").get(this.scope)!.sync_state));
      if(event) {
        const sources=state._sources ?? {};
        if((sources[event.source] ?? 0)>=event.revision)return;
        state._sources={...sources,[event.source]:event.revision};
      }
      if(params) {
        const key=this.directoryKey(params);
        const {next,...prior}=state[key] ?? {};
        state[key]={...prior,epoch:randomUUID(),observed:false,state:"unknown",hasMore:true,reconciling:reconciling || prior.reconciling === true};
      } else {
        state._epoch=randomUUID();
        for(const key of Object.keys(state))if(!key.startsWith("_")) {
          const {next,...prior}=state[key];
          state[key]={...prior,observed:false,state:"unknown",hasMore:true,reconciling:prior.reconciling === true};
        }
      }
      this.database.prepare("UPDATE conversation_catalogs SET revision=revision+1,sync_state=? WHERE scope=?").run(json(state),this.scope);
      this.directoryChanged=true;
    });
  }
  private commitDirectory(params: Value, result: Value, observation?: DirectoryObservation): void {
    const state = JSON.parse(String(this.database.prepare("SELECT sync_state FROM conversation_catalogs WHERE scope=?").get(this.scope)!.sync_state));
    const prior=state[this.directoryKey(params)];
    const unavailable=result.unavailableEngines?.length || result.catalog?.coverage === "partial" || result.catalog?.coverage === "unknown" || result.catalog?.state === "warming" || result.catalog?.state === "error";
    // Coverage is a historical observation within an explicit invalidation
    // epoch. A head revalidation is not a new traversal of the unseen tail.
    const availabilityChanged=json(prior?.unavailableEngines ?? []) !== json(result.unavailableEngines ?? []);
    const coverageChanged=prior?.catalog && json([prior.catalog.coverage,prior.catalog.state === "warming" || prior.catalog.state === "error"])
      !== json([result.catalog?.coverage,result.catalog?.state === "warming" || result.catalog?.state === "error"]);
    const invalidated=!!prior && (availabilityChanged || coverageChanged);
    const endObserved=result.nextCursor == null && !unavailable && observation?.fromHead !== false && (!invalidated || params.cursor == null);
    const observed=!invalidated && (prior?.observed === true || prior?.state === "observed") || endObserved;
    state[this.directoryKey(params)] = { ...(prior?.epoch ? {epoch:prior.epoch}:{}), observed,
      observedAt:endObserved ? Date.now() : prior?.observedAt ?? null,
      reconciling:prior?.reconciling === true && !endObserved,
      ...(invalidated ? {epoch:randomUUID()}:{}),
      state: observed && !unavailable ? "observed" : "partial",
      hasMore: !observed && (result.nextCursor != null || observation?.fromHead === false || invalidated && params.cursor != null),
      unavailableEngines: result.unavailableEngines ?? [], ...(result.catalog ? { catalog: result.catalog } : {}) };
    const encoded = json(state);
    recordDirectoryDetail("directoryPriorState",prior?.state ?? "unknown");
    recordDirectoryDetail("directoryState",state[this.directoryKey(params)].state);
    recordDirectoryDetail("directoryImportPage",params.cursor == null ? "head" : "continuation");
    // Source progress changes neither searchable facts nor directory membership.
    const changed=this.database.prepare("UPDATE conversation_catalogs SET revision=revision+?,sync_state=? WHERE scope=? AND sync_state<>?").run(availabilityChanged ? 1:0,encoded,this.scope,encoded);
    if(changed.changes && availabilityChanged)this.directoryChanged=true;
  }
  private readonly publicTextLifetime = randomUUID();
  /** Pure read on the original History connection; deliberately bypasses ensureModel. */
  async publicTextRead(request: PublicTextRead, control: PublicTextControl): Promise<PublicTextWindow> {
    const unavailable = () => Object.assign(new Error('Public text read unavailable'), {code:'text_search_unavailable'});
    const changed = () => Object.assign(new Error('Public text source changed'), {code:'text_search_changed'});
    const check = () => { if (!control || !Number.isFinite(control.deadline) || Date.now() >= control.deadline
      || control.cancellation && Atomics.load(control.cancellation,0)) throw unavailable(); };
    check();
    const revision = this.catalogRevision();
    if(revision===0)throw Object.assign(new Error('No imported text source observation'),{code:'text_search_unknown'});
    const prior = request.cursor;
    if (prior && (Object.keys(prior).sort().join(',') !== 'lifetime,position,revision,upper'
      || prior.lifetime !== this.publicTextLifetime || prior.revision !== revision
      || !Number.isSafeInteger(prior.upper) || !Number.isSafeInteger(prior.position) || prior.position < 0 || prior.position > prior.upper)) throw changed();
    const fence:PublicTextFence = prior ? {...prior} : {lifetime:this.publicTextLifetime,revision,
      upper:Number(this.database.prepare('SELECT id FROM conversation_search_documents ORDER BY id DESC LIMIT 1').get()?.id ?? 0),position:0};
    const guard = () => { check(); if(this.catalogRevision() !== revision) throw changed(); };
    const result:PublicTextWindow = {fence,observedAt:Date.now(),candidates:[],entries:[]};
    if(request.kind === 'validate') { guard(); return result; }
    const start=fence.position, end=Math.min(fence.upper,start+128);
    // Numeric PK range bounds candidates before scope, ACL, type or text filtering.
    const rows=this.database.prepare(`SELECT id,scope=? AS in_scope,
      CASE WHEN length(CAST(thread_id AS BLOB))<=4096 THEN thread_id END AS thread_id
      FROM conversation_search_documents WHERE id>? AND id<=? ORDER BY id LIMIT 128`).all(this.scope,start,end);
    if(request.kind === 'window') {
      for(const row of rows) { if(!row.in_scope)continue;if(typeof row.thread_id!=='string'||!row.thread_id)throw unavailable();
        result.candidates.push({position:Number(row.id),threadId:row.thread_id}); }
      fence.position=end; guard(); return result;
    }
    const query=publicTextQuery(request.query),tokens=[...new Set(searchTokens(query).split(' ').filter(Boolean))];
    if(!Array.isArray(request.positions)||request.positions.length>128||new Set(request.positions).size!==request.positions.length
      ||request.positions.some(id=>!Number.isSafeInteger(id)||id<=start||id>end))throw unavailable();
    const allowed=new Set(request.positions);let bytes=0,processed=0;
    const doc=this.database.prepare(`SELECT
      CASE WHEN length(CAST(record_id AS BLOB))<=4096 THEN record_id END AS record_id,
      CASE WHEN length(CAST(group_id AS BLOB))<=4096 THEN group_id END AS group_id,
      CASE WHEN length(CAST(item_id AS BLOB))<=4096 THEN item_id END AS item_id,source_revision
      FROM conversation_search_documents WHERE id=? AND scope=?`);
    const head=this.database.prepare(`SELECT model_version,deleted,archived,
      CASE WHEN length(CAST(history AS BLOB))<=65536 THEN history END AS history
      FROM conversation_threads WHERE scope=? AND id=?`);
    const event=this.database.prepare(`SELECT
      CASE WHEN length(CAST(record_id AS BLOB))<=4096 THEN record_id END AS record_id,
      CASE WHEN length(CAST(group_id AS BLOB))<=4096 THEN group_id END AS group_id,
      CASE WHEN length(type)<=64 THEN type END AS type,CASE WHEN length(kind)<=16 THEN kind END AS kind,
      CASE WHEN length(hash)=64 THEN hash END AS hash,CASE WHEN length(coverage)<=16 THEN coverage END AS coverage,
      source_cursor IS NOT NULL AS continuation,revision
      FROM conversation_events WHERE scope=? AND thread_id=? AND event_key=? AND current=1`);
    const size=this.database.prepare('SELECT length(CAST(body AS BLOB)) AS bytes FROM conversation_payloads WHERE scope=? AND hash=?');
    for(const row of rows) {
      if(++processed%16===0)await new Promise<void>(resolve=>setImmediate(resolve));guard();
      if(!allowed.has(Number(row.id))||!row.in_scope)continue;
      const threadId=String(row.thread_id),d=doc.get(row.id,this.scope),h=head.get(this.scope,threadId);
      if(!d||!h||h.deleted||h.archived)continue;
      if(d.record_id==='thread/metadata')continue;
      if(!d.record_id||!d.group_id||!d.item_id)throw unavailable(); // Metadata is outside public message text.
      if(h.model_version!==2||typeof h.history!=='string')throw unavailable();
      const e=event.get(this.scope,threadId,d.record_id),g=event.get(this.scope,threadId,'group:'+d.group_id);
      if(!e||e.kind!=='item'||e.record_id!==d.record_id||e.group_id!==d.group_id||e.revision!==d.source_revision)continue;
      if(!['userMessage','agentMessage'].includes(String(e.type)))continue;
      if(!g||g.kind!=='group'||g.group_id!==null)throw unavailable();
      const history=JSON.parse(h.history);
      if(!history||typeof history!=='object'||Array.isArray(history)||history.visible!==undefined&&!Array.isArray(history.visible))throw unavailable();
      if(Array.isArray(history.visible)) { if(history.visible.length>4096||history.visible.some((x:unknown)=>typeof x!=='string'||x.length>4102))throw unavailable();
        if(!history.visible.includes('group:'+d.group_id))continue;
      } else if(history.state!=='complete')throw unavailable();
      if(e.coverage!=='complete'||g.coverage!=='complete'||g.continuation)continue;
      const length=Number(size.get(this.scope,e.hash)?.bytes ?? Infinity);if(length>262144||bytes+length>8388608)throw unavailable();
      check();const item=this.body(e.hash);bytes+=length;guard();
      if(item.id!==d.item_id||item.type!==e.type)throw unavailable();
      let text:unknown;
      if(item.type==='agentMessage')text=item.text;
      else { if(!Array.isArray(item.content))throw unavailable();
        const parts=item.content.filter((p:Value)=>p&&p.type==='text');if(parts.some((p:Value)=>typeof p.text!=='string'))throw unavailable();
        text=parts.map((p:Value)=>p.text).join('\n'); }
      if(typeof text!=='string')throw unavailable();
      const have=new Set(searchTokens(text).split(' ').filter(Boolean));guard();
      if(!tokens.every(token=>have.has(token)))continue;
      const term=tokens.find(token=>text.toLowerCase().includes(token))??tokens[0]!;
      result.entries.push({position:Number(row.id),threadId,turnId:String(d.group_id),itemId:String(d.item_id),
        role:item.type==='userMessage'?'user':'assistant',snippet:[...searchSnippet(text,term).snippet].slice(0,240).join('')});
      if(result.entries.length===30){fence.position=Number(row.id);guard();return result;}
    }
    fence.position=end;guard();return result;
  }
  hasThreads(): boolean { return !!this.database.prepare("SELECT 1 FROM conversation_threads WHERE scope=? AND deleted=0 LIMIT 1").get(this.scope); }
  /** Capability discovery belongs to the connection, never the conversation database. */
  initialization(value?: Value): Value | null { if (value) this.discovery = structuredClone(value); return this.discovery; }
  private payload(value: unknown): string {
    const data = json(value), hash = createHash("sha256").update(data).digest("hex");
    this.database.prepare("INSERT OR IGNORE INTO conversation_payloads(scope,hash,body) VALUES(?,?,?)").run(this.scope, hash, data);
    return hash;
  }
  private envelope(hash: unknown): Value {
    const row = this.database.prepare("SELECT body FROM conversation_payloads WHERE scope=? AND hash=?").get(this.scope, String(hash));
    if (!row || createHash("sha256").update(String(row.body)).digest("hex") !== hash) throw new Error("Conversation payload integrity check failed");
    return JSON.parse(String(row.body));
  }
  private body(hash: unknown): Value {
    const value=this.envelope(hash);
    return value.format === "opencraft-record-v1" ? value.value
      : value.format === "opencraft-history-v2" && value.change.type === "put" ? value.change.record.value : value;
  }
  private change(threadId: string, key: string, change: HistoryChange, completed = false): number {
    return this.event(threadId,key,change.type,{format:"opencraft-history-v2",change,...(completed ? {completed:true}:{})},change.type === "order" || change.type === "remove", completed);
  }
  /** One-time lazy migration, inside the same Server owner transaction. */
  private ensureModel(threadId: string): void {
    if (this.preparing.has(threadId)) return;
    const head = this.database.prepare("SELECT * FROM conversation_threads WHERE scope=? AND id=?").get(this.scope,threadId);
    if (!head || head.model_version === 2 || head.deleted) return;
    if (this.readOnly) throw Object.assign(new Error("History model requires writer preparation"), { code: "HISTORY_PREPARATION_REQUIRED" });
    this.preparing.add(threadId);
    try { this.transaction(() => {
      this.rememberVersion(threadId);
      const rows = this.database.prepare("SELECT * FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind IN ('group','item') ORDER BY position,record_id").all(this.scope,threadId);
      const state: HistoryState = {...emptyHistory(),metadata:JSON.parse(String(head.metadata)),archived:!!head.archived};
      const refs: string[] = [], indices: Value = {};
      for (const row of rows) {
        const record: HistoryRecord = {id:String(row.record_id),groupId:row.group_id as string|null,kind:String(row.kind),type:String(row.type),
          coverage:row.coverage as HistoryRecord["coverage"],sourceCursor:row.source_cursor as string|null,value:{$payload:row.hash}};
        state.records[record.id]=record; (state.order[orderKey(record.kind,record.groupId)] ??= []).push(record.id);
        indices[record.id]=Number(row.revision); refs.push(String(row.hash));
      }
      this.database.prepare("UPDATE conversation_threads SET model_version=2,history=?,epoch=? WHERE scope=? AND id=?").run(json(state.history),randomUUID(),this.scope,threadId);
      this.event(threadId,"history/baseline","baseline",{format:"opencraft-history-v2",change:{type:"baseline",state},refs,indices});
      for (const ids of Object.values(state.order)) ids.forEach((key,index) => this.database.prepare("UPDATE conversation_events SET position=? WHERE scope=? AND thread_id=? AND revision=?").run(index+1,this.scope,threadId,indices[key]));
    }); } finally { this.preparing.delete(threadId); }
  }
  /** Explicit recovery tool and test seam: no source engine is consulted. */
  rebuild(threadId: string): void {
    this.ensureModel(threadId);
    this.transaction(() => {
      const head=this.head(threadId), events=this.database.prepare("SELECT revision,hash FROM conversation_events WHERE scope=? AND thread_id=? ORDER BY revision").all(this.scope,threadId);
      let state=emptyHistory(), indices: Value={}, baseline=false;
      for(const event of events) {
        const envelope=this.envelope(event.hash);
        if(envelope.format !== "opencraft-history-v2") continue;
        const change=envelope.change as HistoryChange;
        if(change.type === "baseline") {
          baseline=true; indices={...envelope.indices};
          for(const record of Object.values(change.state.records)) if(record.value.$payload) record.value=this.body(record.value.$payload);
        }
        if(!baseline) continue;
        state=reduceHistory(state,change);
        if(change.type === "put") indices[change.record.id]=Number(event.revision);
        if(change.type === "remove") delete indices[change.id];
      }
      if(!baseline) throw new Error("Conversation baseline is missing");
      this.database.prepare("UPDATE conversation_events SET current=0 WHERE scope=? AND thread_id=? AND kind IN ('group','item')").run(this.scope,threadId);
      for(const [key,ids] of Object.entries(state.order)) {
        const [kind,groupId]=JSON.parse(key);
        ids.forEach((id,index)=> {
          const record=state.records[id]!;
          this.database.prepare("UPDATE conversation_events SET current=1,record_id=?,group_id=?,kind=?,type=?,position=?,preview=?,coverage=?,source_cursor=? WHERE scope=? AND thread_id=? AND revision=?")
            .run(id,groupId,kind,record.type,index+1,json(this.preview(record.value)),record.coverage,record.sourceCursor,this.scope,threadId,indices[id]);
        });
      }
      this.database.prepare("UPDATE conversation_threads SET metadata=?,archived=?,history=?,recency=? WHERE scope=? AND id=?")
        .run(json(state.metadata),state.archived?1:0,json(state.history),Number(state.metadata.recencyAt ?? state.metadata.updatedAt ?? 0),this.scope,threadId);
      this.searchIndex.invalidate(threadId);
      if(this.revision(threadId)!==Number(head.revision)) throw new Error("Recovery cannot allocate history versions");
    });
  }
  private head(threadId: string): Value {
    this.ensureModel(threadId);
    const row = this.database.prepare("SELECT * FROM conversation_threads WHERE scope=? AND id=? AND deleted=0").get(this.scope, threadId);
    if (!row) throw new HistoryNotStored("Conversation history has not been stored");
    return row;
  }
  thread(threadId: string): Value | null {
    this.ensureModel(threadId);
    const row = this.database.prepare("SELECT metadata FROM conversation_threads WHERE scope=? AND id=? AND deleted=0").get(this.scope, threadId);
    return row ? JSON.parse(String(row.metadata)) : null;
  }
  metadata(thread: Value): boolean { return this.transaction(() => this.putMetadata(thread)); }
  private putMetadata(thread: Value): boolean {
    if (!id(thread.id) || thread.ephemeral === true) return false;
    if(this.database.prepare("SELECT deleted FROM conversation_threads WHERE scope=? AND id=?").get(this.scope,thread.id)?.deleted) return false;
    const old = this.thread(thread.id);
    const keys = ["id","sessionId","forkedFromId","parentThreadId","preview","name","cwd","path","createdAt","updatedAt","recencyAt",
      "modelProvider","model","reasoningEffort","projectId","section","sectionEnteredAt","source","threadSource","visibility","agentNickname","agentRole","gitInfo"];
    const metadata: Value = { ...old, ...Object.fromEntries(keys.filter(key => key in thread).map(key => [key, thread[key]])),
      id: thread.id, ephemeral: false, turns: [], extra: null, historyMode: "paginated", status: {type:"notLoaded"} };
    if (old && json(old) === json(metadata)) return true;
    this.rememberVersion(thread.id);
    this.database.prepare(`INSERT INTO conversation_threads(scope,id,epoch,metadata,revision,history,archived,deleted,recency,model_version,search_revision) VALUES(?,?,?,?,0,?,0,0,?,2,0)
      ON CONFLICT(scope,id) DO UPDATE SET metadata=excluded.metadata,recency=excluded.recency`)
      .run(this.scope,thread.id,randomUUID(),json(metadata),json(unknownCoverage()),Number(metadata.recencyAt ?? metadata.updatedAt ?? 0));
    if(!old) this.event(thread.id,"history/baseline","baseline",{format:"opencraft-history-v2",change:{type:"baseline",state:emptyHistory()},indices:{},refs:[]});
    const revision=this.change(thread.id,"thread/metadata",{type:"metadata",value:metadata});
    this.searchIndex.put(thread.id,"thread/metadata",revision,metadata);
    return true;
  }
  private current(threadId: string, key: string): Value | undefined {
    return this.database.prepare("SELECT * FROM conversation_events WHERE scope=? AND thread_id=? AND event_key=? AND current=1").get(this.scope,threadId,key);
  }
  private event(threadId: string, key: string, eventType: string, value: Value, force=false, completed=false): number {
    const hash = this.payload(value), old = this.current(threadId,key);
    if (!force && old?.hash === hash) return Number(old.revision);
    this.rememberVersion(threadId);
    this.changedThreads.add(threadId);
    if (value.format === "opencraft-history-v2") this.committedChanges.push({threadId, change: value.change, completed});
    this.database.prepare("UPDATE conversation_threads SET search_revision=CASE WHEN search_revision=revision THEN revision+1 ELSE search_revision END,revision=revision+1 WHERE scope=? AND id=?").run(this.scope,threadId);
    this.database.prepare("UPDATE conversation_catalogs SET revision=revision+1 WHERE scope=?").run(this.scope);
    const revision = this.revision(threadId);
    this.database.prepare("UPDATE conversation_events SET current=0 WHERE scope=? AND thread_id=? AND event_key=? AND current=1").run(this.scope,threadId,key);
    this.database.prepare(`INSERT INTO conversation_events(scope,thread_id,revision,event_key,event_type,hash,current,record_id,group_id,kind,type,position,preview,coverage,created_at)
      VALUES(?,?,?,?,?,?,1,NULL,NULL,'metadata','metadata',0,'{}','headers',?)`).run(this.scope,threadId,revision,key,eventType,hash,Date.now());
    return revision;
  }
  private preview(value: Value): Value {
    if (["userMessage","agentMessage"].includes(value.type)) return {id:value.id,type:value.type,__message:true};
    // Image bytes are not a text preview. Prefer the durable file identity;
    // inline-only images must stay decodable, including in live updates.
    if (value.type === "imageGeneration") {
      const {__deferred:_deferred,...image}=value;
      return {...image,...(typeof value.savedPath === "string" && value.savedPath.trim() ? {result:""}:{})};
    }
    const preview = {...value};
    for (const field of ["aggregatedOutput","output","stdout","stderr","result","content","diff","changes"]) {
      const data = preview[field];
      if (data !== undefined && Buffer.byteLength(json(data)) > 1024) {
        preview[field] = typeof data === "string" ? data.slice(0,1024) : field === "result" && data && typeof data === "object" && !Array.isArray(data)
          ? {...data,content:[],structuredContent:undefined}:Array.isArray(data) ? [] : null;
        preview.__deferred = true;
      }
    }
    return preview;
  }
  private record(threadId: string, key: string, groupId: string | null, kind: string, position: number, value: Value, coverage: string, eventType: string, sourceCursor?: string | null): void {
    const old=this.current(threadId,key);
    sourceCursor = sourceCursor === undefined ? old?.source_cursor as string | null ?? null : sourceCursor;
    position=Number(old?.position ?? position);
    const incoming: HistoryRecord={id:key,groupId,kind,type:String(value.type ?? kind),value,coverage:coverage as HistoryRecord["coverage"],sourceCursor};
    const state=emptyHistory();
    if(old) state.records[key]={...incoming,value:this.body(old.hash),coverage:old.coverage as HistoryRecord["coverage"]};
    const record=reduceHistory(state,{type:"put",record:incoming}).records[key]!;
    const revision = this.change(threadId,key,{type:"put",record},eventType === "item/completed" || terminal(value.status) || value.completed === true);
    value=record.value; coverage=record.coverage;
    if(kind==="item")this.searchIndex.put(threadId,key,revision,value,groupId);
    this.database.prepare(`UPDATE conversation_events SET record_id=?,group_id=?,kind=?,type=?,position=?,preview=?,coverage=?,source_cursor=?
      WHERE scope=? AND thread_id=? AND revision=?`).run(key,groupId,kind,String(value.type ?? kind),position,json(this.preview(value)),coverage,sourceCursor,this.scope,threadId,revision);
  }
  private ordered(threadId: string, kind: string, groupId: string | null): string[] {
    return this.database.prepare("SELECT record_id FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind=? AND group_id IS ? ORDER BY position,record_id").all(this.scope,threadId,kind,groupId).map(row=>String(row.record_id));
  }
  private order(threadId: string, kind: string, groupId: string | null, ids: string[], prior?: string[]): void {
    const members=this.ordered(threadId,kind,groupId);
    if(new Set(ids).size!==ids.length || members.length!==ids.length || members.some(id=>!ids.includes(id))) throw new Error("History ordering membership is invalid");
    if(json(members)===json(ids)) return;
    this.rememberVersion(threadId);
    const before=prior ?? this.ordered(threadId,kind,groupId);
    if(json(before.filter(id=>ids.includes(id)))!==json(ids.filter(id=>before.includes(id))))
      this.database.prepare("UPDATE conversation_threads SET epoch=? WHERE scope=? AND id=?").run(randomUUID(),this.scope,threadId);
    this.change(threadId,`history/order:${orderKey(kind,groupId)}`,{type:"order",kind,groupId,ids});
    ids.forEach((key,index)=>this.database.prepare("UPDATE conversation_events SET position=? WHERE scope=? AND thread_id=? AND event_key=? AND current=1").run(index+1,this.scope,threadId,key));
  }
  private remove(threadId: string, key: string): void {
    if(!this.current(threadId,key)) return;
    this.change(threadId,`history/remove:${key}`,{type:"remove",id:key});
    this.searchIndex.remove(threadId,key);
    this.database.prepare("UPDATE conversation_events SET current=0 WHERE scope=? AND thread_id=? AND event_key=? AND current=1").run(this.scope,threadId,key);
  }
  private coverage(threadId: string, value: Value): void {
    const old=JSON.parse(String(this.head(threadId).history));
    if(json(old)===json(value)) return;
    this.change(threadId,"history/coverage",{type:"coverage",value:value as any});
    this.database.prepare("UPDATE conversation_threads SET history=? WHERE scope=? AND id=?").run(json(value),this.scope,threadId);
  }
  private edge(threadId: string, kind: string, groupId: string | null, edge: "MIN" | "MAX"): number {
    return Number(this.database.prepare(`SELECT ${edge}(position) AS position FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind=? AND group_id IS ?`)
      .get(this.scope,threadId,kind,groupId)?.position ?? 0);
  }
  observe(method: string, params: Value): void {
    if (method === THREAD_CATALOG_CHANGED) {
      const event = parseThreadCatalogChange(params);
      if (!event) return;
      if(event.change.type === "invalidate") { this.invalidateDirectory(undefined,event); return; }
      this.transaction(() => {
        for (const change of event.change.type === "batch" ? event.change.changes : [event.change]) {
        if (change.type === "upsert") {
          if (this.metadata(change.thread)) this.observe("thread/unarchived", { threadId: change.thread.id });
        } else if (change.type === "remove") {
          // Catalog absence hides a row; it never authorizes deletion of history.
          this.observe("thread/archived", { threadId: change.threadId });
        } else if (change.type === "patch" && change.name !== undefined) this.observe("thread/name/updated", { threadId: change.threadId, name: change.name });
        }
      });
      return;
    }
    const threadId = params.threadId ?? params.thread?.id;
    if (!id(threadId)) return;
    this.transaction(() => {
      if (params.thread) this.metadata(object(params.thread));
      if (!this.thread(threadId)) return;
      if (["thread/deleted","thread/delete"].includes(method)) { this.delete(threadId); return; }
      if (["thread/archived","thread/unarchived"].includes(method)) {
        this.change(threadId,"thread/archive",{type:"archive",value:method === "thread/archived"});
        const archived = method === "thread/archived" ? 1 : 0;
        this.database.prepare("UPDATE conversation_threads SET archived=? WHERE scope=? AND id=? AND archived<>?").run(archived,this.scope,threadId,archived); return;
      }
      if (method === "thread/name/updated") { this.metadata({...this.thread(threadId),name:params.threadName ?? params.name}); return; }
      const turn = object(params.turn), groupId = params.turnId ?? turn.id;
      if (!id(groupId)) return;
      if (["turn/started","turn/completed"].includes(method)) {
        const key = `group:${groupId}`, old = this.current(threadId,key), previous = old ? this.body(old.hash) : {};
        if (terminal(previous.status) && method === "turn/started") return;
        const {items:_items,...header} = turn;
        const full = turn.itemsView === "full" && Array.isArray(turn.items)
          && turn.items.every((entry: Value) => id(entry.id) && !entry.historyDetail);
        const coverage = old?.coverage === "complete" || full ? "complete"
          : old?.coverage === "partial" || method === "turn/started" && !params.__synthetic ? "partial" : "headers";
        const existingItems=this.ordered(threadId,"item",groupId);
        const members = full ? turn.items.map((item: Value) => `item:${json([groupId,item.id])}`) : null;
        if(members)for(const missing of this.ordered(threadId,"item",groupId))if(!members.includes(missing)) {
          this.remove(threadId,missing);
          this.database.prepare("UPDATE conversation_threads SET epoch=? WHERE scope=? AND id=?").run(randomUUID(),this.scope,threadId);
        }
        this.record(threadId,key,null,"group",Number(old?.position ?? this.edge(threadId,"group",null,"MAX")+1),{...previous,...header,id:groupId},coverage,method,full ? null : undefined);
        if(!old) {
          const history=JSON.parse(String(this.head(threadId).history));
          if(history.visible && !history.visible.includes(key)) this.coverage(threadId,{...history,visible:[...history.visible,key]});
        }
        for (const item of Array.isArray(turn.items) ? turn.items : []) this.observe("item/completed",{threadId,turnId:groupId,item});
        if(members)this.order(threadId,"item",groupId,members,existingItems);
      }
      if (["item/started","item/completed"].includes(method)) {
        const item = sourceItem(params,groupId); if (!id(item.id)) return;
        if (!this.current(threadId,`group:${groupId}`)) this.observe("turn/started",{threadId,turn:{id:groupId,status:"inProgress"},__synthetic:true});
        const key = `item:${json([groupId,item.id])}`, old = this.current(threadId,key);
        if (old?.coverage === "complete" && method === "item/started") return;
        this.record(threadId,key,groupId,"item",Number(old?.position ?? this.edge(threadId,"item",groupId,"MAX")+1),item,method === "item/completed" ? "complete" : "partial",method);
      }
    });
  }
  importResult(method: string, params: Value, result: Value, fence: number, directoryFence?: ReadonlyMap<string,string>, allowLiveItemProgress=false, _admitted?:()=>boolean, directoryObservation?:DirectoryObservation): boolean {
    return this.transaction(() => {
      if (method === "initialize") { this.initialization(result); return true; }
      if (method === "thread/list") {
        if(directoryObservation && directoryObservation.epoch !== this.directoryEpoch(params))return false;
        if (!directoryFence && this.catalogRevision() !== fence) return false;
        const lookup=directoryFence ? this.database.prepare("SELECT id,metadata,archived,deleted FROM conversation_threads WHERE scope=? AND id=?"):undefined;
        for (const row of result.data ?? []) {
          if(directoryFence && id(row.id)) {
            const current=lookup!.get(this.scope,row.id);
            // Preserve newer observed metadata, but still import unrelated rows
            // and advance a page whose conflicted records are already retained.
            if(this.directoryRecordFence(current)!==directoryFence.get(row.id))continue;
          }
          if(this.metadata(row))this.observe(params.archived === true ? "thread/archived":"thread/unarchived",{threadId:row.id});
        }
        this.commitDirectory(params,result,directoryObservation); return true;
      }
      const threadId = params.threadId ?? result.thread?.id;
      if (!id(threadId)) return false;
      const preservedGroups=new Set<string>();
      if(this.revision(threadId)!==fence) {
        // Only internal range scans may advance past unrelated live Item puts.
        // Read immutable facts, not disposable indexes; preserve each touched
        // group in its entirety, including newly appended members and coverage.
        if(!allowLiveItemProgress || method!=="thread/turns/list" || result.thread!==undefined || !Array.isArray(result.data))return false;
        const changes=this.database.prepare("SELECT hash FROM conversation_events WHERE scope=? AND thread_id=? AND revision>? ORDER BY revision").all(this.scope,threadId,fence);
        if(!changes.length)return false;
        for(const row of changes) {
          const envelope=this.envelope(row.hash), change=envelope.change;
          if(envelope.format!=="opencraft-history-v2" || change?.type!=="put" || change.record?.kind!=="item" || !id(change.record.groupId))return false;
          preservedGroups.add(change.record.groupId);
        }
      }
      if (result.thread && !this.metadata(result.thread)) return false;
      if (!this.thread(threadId)) return false;
      if (method === "thread/delete") { this.delete(threadId); return true; }
      if (["thread/archive","thread/unarchive"].includes(method)) { this.observe(method === "thread/archive" ? "thread/archived" : "thread/unarchived",{threadId}); return true; }
      if (method === "thread/name/set") { this.observe("thread/name/updated",{threadId,name:params.name}); return true; }
      if (method === "thread/items/list" && id(params.turnId) && Array.isArray(result.data)) {
        const groupId=params.turnId,key=`group:${groupId}`,group=this.current(threadId,key);
        if (!group) return false;
        const direction=params.sortDirection === "desc" ? "desc":"asc";
        const previous=group.source_cursor ? JSON.parse(String(group.source_cursor)):null;
        const contiguous=params.cursor == null || previous?.next === params.cursor && previous?.direction === direction;
        if (!contiguous) return false;
        const sourceItems=result.data.map((entry: Value)=>sourceItem(entry,groupId));
        if(sourceItems.some((item: Value)=>!id(item.id) || item.historyDetail) || new Set(sourceItems.map((item: Value)=>item.id)).size!==sourceItems.length)
          throw new Error("Complete history content identity is missing");
        const existingItems=this.ordered(threadId,"item",groupId), incomingItems: string[]=[];
        let position=this.edge(threadId,"item",groupId,"MAX");
        for (const item of sourceItems) {
          position += 1;
          incomingItems.push(`item:${json([groupId,item.id])}`);
          this.record(threadId,`item:${json([groupId,item.id])}`,groupId,"item",position,item,"complete","history/item");
        }
        const fullMembership=params.cursor == null && result.nextCursor == null;
        if(fullMembership) for(const missing of existingItems) if(!incomingItems.includes(missing)) {
          this.remove(threadId,missing);
          this.database.prepare("UPDATE conversation_threads SET epoch=? WHERE scope=? AND id=?").run(randomUUID(),this.scope,threadId);
        }
        const incoming=direction === "asc" ? incomingItems:[...incomingItems].reverse();
        const ordered=existingItems.filter(id=>!incoming.includes(id));
        // A refreshed prefix/suffix replaces its source window, not the opposite
        // edge. Continuations insert at the last scanned stable Item identity,
        // ahead of observations that may have arrived before the missing page.
        const anchor=previous?.anchor,at=ordered.indexOf(anchor);
        const shared=existingItems.findIndex(id=>incoming.includes(id));
        const offset=params.cursor == null ? direction === "asc" ? 0:ordered.length
          : at>=0 ? at+(direction === "asc" ? 1:0)
          : shared>=0 ? existingItems.slice(0,shared).filter(id=>!incoming.includes(id)).length
          : direction === "asc" ? ordered.length:0;
        ordered.splice(offset,0,...incoming);
        this.order(threadId,"item",groupId,fullMembership ? incoming:ordered,existingItems);
        const visible=params.cursor==null ? incomingItems:[...(previous?.visible ?? []),...incomingItems.filter((key:string)=>!previous?.visible?.includes(key))];
        this.record(threadId,key,null,"group",Number(group.position),this.body(group.hash),group.coverage === "complete" || result.nextCursor == null ? "complete":"partial","history/group",
          result.nextCursor == null ? null:json({next:result.nextCursor,direction,anchor:incomingItems.at(-1) ?? previous?.anchor,visible}));
        return true;
      }
      let page: Value | undefined;
      if (method === "thread/turns/list") page = result;
      else if (result.initialTurnsPage) page = result.initialTurnsPage;
      else if (Array.isArray(result.thread?.turns) && params.includeTurns !== false && params.excludeTurns !== true) page = {data:[...result.thread.turns].reverse(),nextCursor:null};
      if (!page || !Array.isArray(page.data)) return true;
      const history=JSON.parse(String(this.head(threadId).history));
      const rows: Value[]=params.sortDirection === "asc" ? page.data : [...page.data].reverse();
      if(params.sortDirection === "asc" || object(params.initialTurnsPage).sortDirection === "asc") return false;
      const source=json([this.scope,threadId,this.thread(threadId)?.sessionId ?? threadId,this.thread(threadId)?.path ?? null]);
      const cursor=params.cursor ?? null;
      const next=page.nextCursor ?? null;
      const coverage=importCoverage(history,{ids:rows.map(row=>`group:${row.id}`),cursor,next,source,generation:null,query:"all/desc",stable:false});
      let existingGroups=this.ordered(threadId,"group",null);
      const incomingGroups=rows.map(row=>`group:${row.id}`);
      if(cursor===null && next===null) {
        const absent=existingGroups.filter(id=>!incomingGroups.includes(id));
        if(absent.some(key=>preservedGroups.has(this.body(this.current(threadId,key)!.hash).id)))return false;
        for(const group of absent) {
          const groupId=this.body(this.current(threadId,group)!.hash).id;
          for(const item of this.ordered(threadId,"item",groupId)) this.remove(threadId,item);
          this.remove(threadId,group);
        }
        if(absent.length) this.database.prepare("UPDATE conversation_threads SET epoch=? WHERE scope=? AND id=?").run(randomUUID(),this.scope,threadId);
        existingGroups=existingGroups.filter(id=>incomingGroups.includes(id));
      }
      const globalOrder=cursor===null ? [...existingGroups.filter(id=>!incomingGroups.includes(id)),...incomingGroups]
        : [...existingGroups.filter(id=>!coverage.visible!.includes(id)),...coverage.visible!];
            for (const turn of rows) {
        if (!id(turn.id)) throw new Error("History group identity is missing");
        if(preservedGroups.has(turn.id))continue;
        const key = `group:${turn.id}`, old = this.current(threadId,key), {items=[],...header} = turn;
        const requestedView=object(params.initialTurnsPage).itemsView ?? params.itemsView;
        const full = (turn.itemsView === "full" || turn.itemsView === undefined && !["summary","notLoaded","presentation"].includes(requestedView)) && Array.isArray(turn.items)
          && items.every((entry: Value) => id(object(entry.item ?? entry).id) && !object(entry.item ?? entry).historyDetail);
        const groupPosition = Number(old?.position ?? this.edge(threadId,"group",null,"MAX")+1);
        const existingItems=this.ordered(threadId,"item",turn.id);
        if (full) {
          const incoming = items.map((entry: Value) => `item:${json([turn.id,object(entry.item ?? entry).id])}`);
          const missing=existingItems.filter(id=>!incoming.includes(id));
          if(missing.length)this.database.prepare("UPDATE conversation_threads SET epoch=? WHERE scope=? AND id=?").run(randomUUID(),this.scope,threadId);
          for (const id of missing) this.remove(threadId,id);
        }
        this.record(threadId,key,null,"group",groupPosition,{...(old ? this.body(old.hash):{}),...header},full ? "complete" : old?.coverage ?? "headers","history/group",full ? null : undefined);
        let itemPosition = this.edge(threadId,"item",turn.id,"MAX");
        const incomingItems: string[]=[];
        for (const entry of items) {
          const item = sourceItem(entry,turn.id); if (!id(item.id) || item.historyDetail) continue;
          const itemKey=`item:${json([turn.id,item.id])}`; incomingItems.push(itemKey);
          this.record(threadId,itemKey,turn.id,"item",Number(this.current(threadId,itemKey)?.position ?? ++itemPosition),item,full ? "complete" : "partial","history/item");
        }
        if(full) this.order(threadId,"item",turn.id,incomingItems,existingItems);
      }
      this.order(threadId,"group",null,globalOrder,existingGroups);
      this.coverage(threadId,coverage);
      return true;
    });
  }
  private limit(value: unknown): number {
    const limit = value ?? 10;
    if (!Number.isSafeInteger(limit) || Number(limit)<1 || Number(limit)>1000) throw new InvalidHistoryCursor("Invalid history page size");
    return Number(limit);
  }
  private cursor(threadId: string, value: Value): string { return "conversation:"+Buffer.from(json({threadId,epoch:this.head(threadId).epoch,...value})).toString("base64url"); }
  private decode(threadId: string, cursor: unknown): Value {
    if (cursor == null) return {};
    if (typeof cursor === "string" && !cursor.startsWith("conversation:")) throw new HistoryNotStored("Source cursor requires its source");
    try {
      if (typeof cursor !== "string" || cursor.length>16384) throw Error();
      const value = JSON.parse(Buffer.from(cursor.slice(13),"base64url").toString());
      if (value.threadId !== threadId || typeof value.epoch !== "string" || !value.epoch || !["groups","items"].includes(value.kind)
        || value.anchor && (!Array.isArray(value.anchor) || value.anchor.length!==2 || !Number.isFinite(value.anchor[0]) || !id(value.anchor[1]))
        || value.groupId !== undefined && !id(value.groupId)) throw Error();
      if (value.epoch !== this.head(threadId).epoch) {
        // The old request remains invalid. An authorized reader may explicitly
        // retry at a surviving group in the current order without losing its
        // loaded window. Details, isolated records and missing anchors cannot
        // borrow a replacement position.
        const anchor = value.kind === "groups" && value.anchor && !value.groupId && !value.inclusiveGroup && !value.isolated
          ? this.current(threadId, value.anchor[1]) : null;
        throw new InvalidHistoryCursor("Conversation cursor is no longer available", anchor?.kind === "group" ? {
          code: "HISTORY_CURSOR_EXPIRED", retryable: true,
          replacementCursor: this.cursor(threadId, { kind: "groups", anchor: [Number(anchor.position), String(anchor.record_id)] }),
        } : undefined);
      }
      if(value.inclusiveGroup) {
        if(!id(value.inclusiveGroup))throw Error();
        const group=this.current(threadId,`group:${value.inclusiveGroup}`);if(!group)throw Error();
        value.anchor=[Number(group.position),String(group.record_id)];
      }
      if(value.anchor && !value.inclusiveGroup) {
        const anchor=this.current(threadId,value.anchor[1]);
        if(!anchor || anchor.kind !== (value.kind === "groups" ? "group":"item")) throw Error();
        value.anchor=[Number(anchor.position),value.anchor[1]];
      }
      return value;
    } catch (error) {
      if (error instanceof InvalidHistoryCursor) throw error;
      throw new InvalidHistoryCursor("Conversation cursor is no longer available");
    }
  }
  sourceCursor(threadId: string, cursor: unknown): string | null {
    const decoded = this.decode(threadId,cursor); if (decoded.kind !== "groups") throw new InvalidHistoryCursor("Wrong cursor kind");
    const history=JSON.parse(String(this.head(threadId).history));
    return decoded.isolated || decoded.inclusiveGroup && history.visible && !history.visible.includes(`group:${decoded.inclusiveGroup}`) ? "__history_gap__" : history.next ?? "__history_gap__";
  }
  itemSourceCursor(threadId: string, params: Value): string {
    const cursor=this.decode(threadId,params.cursor),group=this.current(threadId,`group:${params.turnId}`);
    if(cursor.kind!=="items" || cursor.groupId!==params.turnId || !group?.source_cursor) throw new HistoryNotStored("Item range has no source continuation");
    return JSON.parse(String(group.source_cursor)).next;
  }
  itemSourceDirection(threadId: string, turnId: string): string | null {
    const group=this.current(threadId,`group:${turnId}`);
    return group?.source_cursor ? JSON.parse(String(group.source_cursor)).direction ?? null : null;
  }
  itemRangeFence(threadId: string, groupId: string): string {
    const group=this.current(threadId,`group:${groupId}`),thread=this.thread(threadId);
    if(!group || !thread)throw new HistoryNotStored("Item group is unavailable");
    return json([thread.sessionId??threadId,thread.path??null,group.source_cursor,group.coverage]);
  }
  directoryQuery(params: Value): string { return this.directoryKey(params); }
  private decodeDirectory(params: Value): Value {
    if (params.cursor == null) return {};
    if (typeof params.cursor !== "string" || !params.cursor.startsWith("conversation-directory:")) { recordDirectoryDetail("directoryMissReason","source-cursor"); throw new HistoryNotStored("Directory cursor requires its source"); }
    try {
      const value = JSON.parse(Buffer.from(params.cursor.slice(23),"base64url").toString());
      if (value.scope !== this.scope || value.query !== this.directoryKey(params) || !Array.isArray(value.after) || value.after.length !== 2 || !Number.isFinite(value.after[0]) || !id(value.after[1])) throw Error();
      return value;
    } catch { throw new InvalidHistoryCursor("Invalid directory cursor"); }
  }
  list(params: Value, admission?: HistoryAdmission): Value { return this.transaction(()=>this.listStored(params, admission)); }
  private listStored(params: Value, admission?: HistoryAdmission): Value {
    if (!Object.keys(params).every(key => ["cursor","limit","archived","sortKey","sortDirection","useStateDbOnly"].includes(key))
      || params.sortKey != null && params.sortKey !== "updated_at" || params.sortDirection != null && params.sortDirection !== "desc") { recordDirectoryDetail("directoryMissReason","unsupported-filter"); throw new HistoryNotStored("Directory filter requires its source"); }
    if (typeof params.cursor === "string" && params.cursor.startsWith(SNAPSHOT_CURSOR)) {
      const coverage = this.directoryState(params);
      if (!this.hasThreads() && coverage.state === "unknown") throw new HistoryNotStored("Conversation directory has not been synchronized");
      const merkle = params.cursor.startsWith(CATALOG_MERKLE_CURSOR);
      if (merkle && admission?.catalogRevision !== undefined && admission.catalogRevision !== this.catalogRevision())
        throw Object.assign(new Error("Catalog changed during admission"), { code: -32086 });
      const result = this.catalogPages.list(params.cursor, params.archived === true, this.limit(params.limit), () => {
        const revision = this.catalogRevision();
        if (this.catalogIndex?.revision !== revision) {
          // Runs in the independent read worker under this SQL read transaction.
          // Reconnect captures once; subsequent pages retain the immutable root.
          const index = new DirectorySnapshotIndex();
          index.replace(this.database.prepare("SELECT metadata,archived FROM conversation_threads WHERE scope=? AND deleted=0").all(this.scope)
            .map(row => ({ row: JSON.parse(String(row.metadata)), archived: row.archived === 1 })));
          this.catalogIndex = { revision, index };
        }
        const complete = coverage.observed === true || coverage.state === "observed";
        const catalog = { ...coverage.catalog,
          state: coverage.catalog?.state === "error" ? "error" : !complete ? "warming" : coverage.catalog?.state ?? "ready",
          coverage: coverage.catalog?.state === "error" || !complete ? "partial" : coverage.catalog?.coverage ?? "complete" };
        return { parts: [{ root: this.catalogIndex.index.capture(params.archived === true),
          merkle: merkle && admission ? this.catalogIndex.index.captureProjectedMerkle(params.archived === true, admission) : this.catalogIndex.index.captureMerkle(params.archived === true),
          checkpoint: { source: "history:" + this.scope, revision } }], catalog };
      }, admission?.catalogReader);
      if (merkle && "catalogMerkle" in result && admission?.catalogProjected) Object.assign(result.catalogMerkle!, { projected: true });
      return result;
    }
    if (!this.hasThreads()) { recordDirectoryDetail("directoryMissReason","empty-store"); throw new HistoryNotStored("Conversation directory has not been synchronized"); }
    const decoded = this.decodeDirectory(params), limit = this.limit(params.limit);
    const rows = this.database.prepare(`SELECT id,metadata,recency FROM conversation_threads WHERE scope=? AND archived=? AND deleted=0 ${decoded.after ? "AND (recency,id)<(?,?)" : ""} ORDER BY recency DESC,id DESC LIMIT ?`)
      .all(this.scope,params.archived === true ? 1:0,...(decoded.after ?? []),limit+1);
    const coverage=this.directoryState(params);
    recordDirectoryDetail("directoryState",coverage.state);
    if (!rows.length && coverage.hasMore) { recordDirectoryDetail("directoryMissReason","unsynchronized-tail"); throw new HistoryNotStored("Earlier directory entries have not been synchronized"); }
    const selected = rows.slice(0,limit), last=selected.at(-1);
    return {historyVersion:{revision:this.catalogRevision()},historyCoverage:coverage,...(coverage.catalog ? {catalog:coverage.catalog}:{}),data:selected.map(row => JSON.parse(String(row.metadata))),nextCursor:last && (rows.length>limit || coverage.hasMore)
      ? "conversation-directory:"+Buffer.from(json({scope:this.scope,query:this.directoryKey(params),after:[last.recency,last.id]})).toString("base64url"):null};
  }
  reindex(threadId:string,limit=100):Value {
    return this.transaction(()=>{this.head(threadId);return this.searchIndex.reindex(threadId,hash=>this.body(hash),limit);});
  }
  read(method: string, params: Value, canRead:HistoryAdmission=()=>true): Value {
    return this.transaction(()=>{
      if(method==="thread/search")return this.searchIndex.search(params,canRead);
      if(method==="thread/searchOccurrences") {
        if(!id(params.threadId)||!canRead(params.threadId))throw new HistoryNotStored("Conversation is unavailable");
        this.head(params.threadId);
        return this.searchIndex.occurrences(params,groupId=>this.cursor(params.threadId,{kind:"groups",inclusiveGroup:groupId}));
      }
      return this.readStored(method,params,canRead);
    });
  }
  private readStored(method: string, params: Value, admission?: HistoryAdmission): Value {
    if (method === "thread/list") return this.list(params,admission);
    const threadId=params.threadId;
    if (!id(threadId)) throw new InvalidHistoryCursor("Conversation identity required");
    const thread=this.thread(threadId); if (!thread) throw new HistoryNotStored("Conversation history has not been stored");
    if (method === "thread/read" && params.includeTurns !== true && !params.initialTurnsPage) return {thread:{...thread,turns:[]},historyVersion:{epoch:this.head(threadId).epoch,revision:this.revision(threadId)}};
    if (method === "thread/read") { const page=this.turns(threadId,{...object(params.initialTurnsPage),cursor:null});
      const update=params.historyBaseVersion ? this.changesSince(threadId,params.historyBaseVersion):undefined;
      return {historyVersion:page.historyVersion,historyCoverage:page.historyCoverage,thread:{...thread,turns:params.includeTurns === true ? [...page.data].reverse():[]},initialTurnsPage:page,
        ...(update ? {historyUpdate:update}:{})}; }
    if (method === "thread/turns/list") return this.turns(threadId,params);
    if (method === "thread/items/list") return this.items(threadId,params);
    throw new HistoryNotStored("Unsupported stored history read");
  }
  private turns(threadId: string, params: Value): Value {
    if (params.sortDirection === "asc") throw new HistoryNotStored("Ascending source page is not stored");
    const decoded=this.decode(threadId,params.cursor),history=JSON.parse(String(this.head(threadId).history)),limit=this.limit(params.limit);
    if (decoded.kind && decoded.kind !== "groups") throw new InvalidHistoryCursor("Wrong cursor kind");
    if(decoded.isolated)throw new HistoryNotStored("This isolated history record has no verified continuation");
    const detail = params.detailItemId && decoded.groupId;
    const target=decoded.inclusiveGroup ?? (detail ? decoded.groupId : undefined);
    const isolated=target && history.visible && !history.visible.includes(`group:${target}`);
    if (decoded.anchor && !decoded.inclusiveGroup && history.visible && !history.visible.includes(decoded.anchor[1]))
      throw new HistoryNotStored("The history anchor is outside the observed source segment");
    const visible=isolated ? [`group:${target}`] : history.visible;
    const rows=this.database.prepare(`SELECT * FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind='group'
      ${visible?.length ? `AND record_id IN (${visible.map(()=>"?").join(",")})`:visible ? "AND 0":""} ${detail ? "AND record_id=?" : decoded.anchor ? `AND (position,record_id)${decoded.inclusiveGroup?"<=":"<"}(?,?)`:""} ORDER BY position DESC,record_id DESC LIMIT ?`)
      .all(this.scope,threadId,...(visible ?? []),...(detail ? [`group:${decoded.groupId}`]:decoded.anchor ?? []),limit+1);
    const sourceEnded = history.next === null && ["observed","stable"].includes(history.evidence) && !isolated;
    if (!rows.length && history.state !== "complete" && !sourceEnded) throw new HistoryNotStored("This history range has not been synchronized");
    const selected=rows.slice(0,limit);
    const data=selected.map(row => {
      const header=this.body(row.hash),groupId=header.id,view=params.itemsView ?? "full";
      if (view === "notLoaded") return {...header,items:[],itemsView:"notLoaded"};
      if (!detail && (row.coverage === "headers" || row.source_cursor)) throw new HistoryNotStored("Group details have not been stored");
      const detailFilter=params.detailItemId ? "AND record_id=?":"";
      const summary=view === "summary" ? `AND revision IN (
        SELECT revision FROM (SELECT revision FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND group_id=? AND type='userMessage' ORDER BY position LIMIT 1)
        UNION ALL SELECT revision FROM (SELECT revision FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND group_id=? AND type='agentMessage' ORDER BY position DESC LIMIT 1))`:"";
      const records=this.database.prepare(`SELECT hash,preview FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind='item' AND group_id=? ${detailFilter} ${summary} ORDER BY position,record_id`)
        .all(this.scope,threadId,groupId,...(params.detailItemId ? [`item:${json([groupId,params.detailItemId])}`]:[]),...(view === "summary" ? [this.scope,threadId,groupId,this.scope,threadId,groupId]:[]));
      if(detail && !records.length)throw new HistoryNotStored("Item details have not been stored");
      const items=records.map(record => {
        const preview=JSON.parse(String(record.preview));
        // Old stored image previews may contain only a base64 prefix. Repair
        // the read projection without rewriting retained history or its epoch.
        const item=view === "full" || preview.__message ? this.body(record.hash)
          :preview.type === "imageGeneration" ? this.preview(
            typeof preview.savedPath === "string" && preview.savedPath.trim() ? preview : this.body(record.hash)
          ):preview;
        if (item.__deferred) {delete item.__deferred;item.historyDetail={cursor:this.cursor(threadId,{kind:"groups",groupId})};}
        return item;
      });
      return {...header,items,itemsView:view === "presentation" ? "full":view,historyCoverage:row.coverage};
    });
    const last=selected.at(-1);
    return {historyVersion:{epoch:this.head(threadId).epoch,revision:this.revision(threadId)},historyCoverage:isolated ? {...history,state:"partial",next:null,visible,evidence:"unknown"}:history,data,nextCursor:!detail && last && (rows.length>limit || history.state !== "complete" && !sourceEnded) ? this.cursor(threadId,{kind:"groups",anchor:[last.position,last.record_id],...(isolated ? {isolated:true}:{})}):null};
  }
  private items(threadId: string,params: Value): Value {
    if (!id(params.turnId)) throw new InvalidHistoryCursor("History group identity required");
    const group=this.current(threadId,`group:${params.turnId}`);
    if (!group || group.coverage === "headers") throw new HistoryNotStored("Group details have not been stored");
    const decoded=this.decode(threadId,params.cursor),limit=this.limit(params.limit),direction=params.sortDirection === "desc" ? "DESC":"ASC";
    if (decoded.kind && decoded.kind !== "items" || decoded.groupId && decoded.groupId !== params.turnId || decoded.direction && decoded.direction !== direction) throw new InvalidHistoryCursor("Invalid item cursor");
    const source=group.source_cursor ? JSON.parse(String(group.source_cursor)):null;
    const rows=this.database.prepare(`SELECT * FROM conversation_events WHERE scope=? AND thread_id=? AND current=1 AND kind='item' AND group_id=?
      ${decoded.anchor ? `AND (position,record_id)${direction === "DESC" ? "<":">"}(?,?)`:""} ORDER BY position ${direction},record_id ${direction} LIMIT ?`)
      .all(this.scope,threadId,params.turnId,...(decoded.anchor ?? []),limit+1);
    if(!rows.length && source?.next!=null) throw new HistoryNotStored("Earlier item entries have not been synchronized");
    const selected=rows.slice(0,limit),last=selected.at(-1);
    return {historyVersion:{epoch:this.head(threadId).epoch,revision:this.revision(threadId)},historyCoverage:group.coverage,data:selected.map(row => ({item:this.body(row.hash),turnId:params.turnId})),nextCursor:(rows.length>limit || source?.next!=null) && last ? this.cursor(threadId,{kind:"items",groupId:params.turnId,direction,anchor:[last.position,last.record_id]}):null};
  }
  delete(threadId: string): void { this.transaction(() => this.deleteStored(threadId)); }
  private deleteStored(threadId: string): void {
    this.rememberVersion(threadId);
    const changed=this.database.prepare("UPDATE conversation_threads SET deleted=1,metadata=?,history=?,epoch=?,revision=revision+1 WHERE scope=? AND id=? AND deleted=0").run(json({id:threadId}),json(unknownCoverage()),randomUUID(),this.scope,threadId);
    if(changed.changes) {
      this.changedThreads.add(threadId);
      this.database.prepare("UPDATE conversation_catalogs SET revision=revision+1 WHERE scope=?").run(this.scope);
    }
    this.searchIndex.remove(threadId);
    this.database.prepare("DELETE FROM conversation_events WHERE scope=? AND thread_id=?").run(this.scope,threadId);
    this.database.prepare("DELETE FROM conversation_payloads WHERE scope=? AND hash NOT IN (SELECT hash FROM conversation_events WHERE scope=?)").run(this.scope,this.scope);
  }
}
