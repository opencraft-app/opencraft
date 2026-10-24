import type { StatementSync } from "node:sqlite";
import { TokenUsageTelemetry } from "./token-usage-telemetry.js";
import { TokenUsageQuery, type TokenUsageAuthority } from "./token-usage-query.js";
import type { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import { allocateTurnTokens, tokenInteger, tokenModelKey, type TokenCount, type TokenModelBucket } from "./token-usage-allocation.js";

export type UsageExecutionState = "running" | "completed" | "failed" | "interrupted";
export type UsageSourceKind = "human" | "system" | "unknown";
export type UsageAllocationState = "settled" | "provisional" | "pending" | "system" | "unknown";
export interface UsageTurnKey { readonly threadId: string; readonly turnId: string }
const countFields = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
export type UsageCounts = Readonly<Record<(typeof countFields)[number], TokenCount | null>>;
export interface UsageSource extends UsageTurnKey {
  readonly observedAt?: number;
  readonly lineage: string;
  readonly sourceId: string;
  readonly kind: "response" | "turn-snapshot";
  readonly version: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly counts: { readonly totalTokens: TokenCount; readonly [key: string]: unknown };
  /** Advance only in the same transaction as the corresponding facts. */
  readonly cursor?: string;
}
export interface UsageTurn extends UsageTurnKey {
  readonly startedAt: number;
  readonly executionState: UsageExecutionState;
  readonly sourceKind: UsageSourceKind;
  readonly participantsComplete: boolean;
  readonly usageComplete: boolean;
  readonly observedTokens: TokenCount | null;
  readonly allocationState: UsageAllocationState;
  readonly revision: number;
  readonly frozen: boolean;
}

export interface UsageSubmission {
  readonly threadId: string;
  readonly inputId: string;
  readonly actorId: string | null;
  readonly actorKind: "human" | "session" | "unknown";
  readonly mode: "start" | "steer";
  readonly sourceKind: UsageSourceKind;
  readonly submittedAt: number;
}
export type UsageGapReason = "storage-write" | "queue-full" | "source-offline" | "source-replaced" | "invalid-source" | "unreplayable" | "oversized-line";
export interface UsageRollout { readonly threadId: string; readonly path: string; readonly cursor: string; readonly lastSuccessAt: number | null; readonly errorKind: string | null }

export function normalizeUsageCounts(value: UsageSource["counts"]): UsageCounts {
  const result = Object.fromEntries(countFields.map(key => [key, value[key] == null ? null : tokenInteger(value[key]).toString()])) as Record<(typeof countFields)[number], TokenCount | null>;
  if (result.totalTokens === null) throw new TypeError("Reported total token count is required");
  for (const [subset, parent] of [["cachedInputTokens", "inputTokens"], ["reasoningOutputTokens", "outputTokens"]] as const) {
    if (result[subset] !== null && result[parent] !== null && BigInt(result[subset]!) > BigInt(result[parent]!)) {
      throw new TypeError("Token subset exceeds its containing category");
    }
  }
  return result;
}

function requiredId(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024) throw new TypeError("Stable usage identity is required");
  return value;
}
function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Usage time must be nonnegative milliseconds");
  return value;
}

/**
 * Internal Host authority. The Host database owns migration/close; this object
 * writes facts and derived allocations through its existing transaction owner.
 * Callers must verify source receipts and query authorization at ingress.
 */
export class OpenCraftTokenUsageLedger {
  readonly serverId: string;
  private readonly state: Pick<OpenCraftHostStateDatabase,"database"|"transaction">;
  private readonly now: () => number;
  private writing = false;
  private committedEffects:(()=>void)[]=[];
  private queryOwner?: TokenUsageQuery;
  // SQLite statements allocate native memory which V8 heap pressure does not
  // reliably bound. Reuse SQL shapes within this physical ledger owner. Values
  // remain bound parameters; neither turn nor participant identities are keys.
  private readonly statements = new Map<string, StatementSync>();
  private statement(sql: string): StatementSync {
    const existing = this.statements.get(sql);
    if (existing) return existing;
    const statement = this.state.database.prepare(sql);
    // Keep variable-shape callers bounded too; an evicted statement can finish
    // an active synchronous iterator and is then owned by the normal driver GC.
    if (this.statements.size === 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }

  query(value: unknown, authorize: () => TokenUsageAuthority | null) {
    return (this.queryOwner ??= new TokenUsageQuery(this.state, this.serverId, "Asia/Shanghai", this.now)).read(value, authorize);
  }
  constructor(state: Pick<OpenCraftHostStateDatabase,"database"|"transaction">, serverId: string, now: () => number = Date.now, readonly telemetry=new TokenUsageTelemetry()) {
    this.state = state;
    this.serverId = requiredId(serverId);
    this.now = now;
    this.write(() => {
      const at = timestamp(now());
      const inserted = this.statement("INSERT OR IGNORE INTO token_usage_scopes VALUES(?,?,1,0)").run(this.serverId, at);
      if (inserted.changes) this.statement("INSERT INTO token_usage_coverage(server_id,starts_ms,ends_ms) VALUES(?,?,NULL)").run(this.serverId, at);
      this.statement("INSERT OR IGNORE INTO token_usage_projection_state SELECT ?,NOT EXISTS(SELECT 1 FROM token_usage_turns WHERE server_id=?),'',''").run(this.serverId,this.serverId);
      const uncertain=this.statement("INSERT OR IGNORE INTO token_usage_gaps SELECT server_id,'attempt-restart:'||attempt_id,thread_id,NULL,'source-offline',?,NULL FROM token_usage_attempts WHERE server_id=? AND outcome='pending'").run(at,this.serverId);
      this.statement("UPDATE token_usage_attempts SET outcome='unknown' WHERE server_id=? AND outcome='pending'").run(this.serverId);
      if(uncertain.changes)this.bump();
    });
  }
  private write<T>(callback: () => T): T {
    if (this.writing) return callback();
    // This shared connection's operations are synchronous: no other Host
    // transaction can interleave with this temporary timeout. Metering must
    // fail immediately under contention instead of blocking execution for the
    // owner's normal five-second queue/migration busy timeout.
    const previous = Number(this.statement("PRAGMA busy_timeout").get()!.timeout);
    this.state.database.exec("PRAGMA busy_timeout=0");
    const started=performance.now();let success=false;
    this.committedEffects=[];
    try {
      const result=this.state.transaction(() => {
        this.writing=true;
        try{return callback();}finally{this.writing=false;}
      });
      success=true;
      for(const effect of this.committedEffects)effect();
      return result;
    } finally {
      this.committedEffects=[];
      this.telemetry.latency("write",performance.now()-started,success);
      this.state.database.exec(`PRAGMA busy_timeout=${previous}`);
    }
  }
  private afterCommit(effect:()=>void):void {this.committedEffects.push(effect);}

  private key(key: UsageTurnKey): [string, string, string] {
    return [this.serverId, requiredId(key.threadId), requiredId(key.turnId)];
  }
  private bump(): void {
    this.statement("UPDATE token_usage_scopes SET revision=revision+1 WHERE server_id=?").run(this.serverId);
  }
  projectionReady():boolean {return this.statement("SELECT ready FROM token_usage_projection_state WHERE server_id=?").get(this.serverId)?.ready===1;}
  backfillProjectionBatch(limit=32):boolean {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError("Invalid projection batch");
    if(this.projectionReady())return true;
    return this.write(()=>{
      const position=this.statement("SELECT cursor_thread,cursor_turn FROM token_usage_projection_state WHERE server_id=?").get(this.serverId)!;
      const turns=this.statement("SELECT * FROM token_usage_turns WHERE server_id=? AND (thread_id,turn_id)>(?,?) ORDER BY thread_id,turn_id LIMIT ?").all(this.serverId,position.cursor_thread!,position.cursor_turn!,limit);
      for(const turn of turns){
        const ids:[string,string,string]=[this.serverId,String(turn.thread_id),String(turn.turn_id)];
        if(this.statement("SELECT 1 FROM token_usage_turn_actor_projections a JOIN token_usage_turn_projections d USING(server_id,thread_id,turn_id) WHERE a.server_id=? AND a.thread_id=? AND a.turn_id=?").get(...ids))continue;
        const buckets=this.statement("SELECT model_key,provider,model,tokens FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=?").all(...ids);
        this.updateDailyProjection(ids,turn,buckets);
      }
      const last=turns.at(-1);
      this.statement("UPDATE token_usage_projection_state SET ready=?,cursor_thread=?,cursor_turn=? WHERE server_id=?").run(turns.length<limit?1:0,last?.thread_id??position.cursor_thread!,last?.turn_id??position.cursor_turn!,this.serverId);
      return turns.length<limit;
    });
  }
  private updateDailyProjection(ids:[string,string,string],turn:Record<string,unknown>,buckets:readonly {model_key?:unknown;provider?:unknown;model?:unknown;tokens?:unknown}[]):void {
    type Contribution={day:string;modelFilter:number;modelKey:string;state:string;tokens:string;turns:number;missing:number;unknown:number};
    const day=new Date(Number(turn.started_ms)+8*3600000).toISOString().slice(0,10);
    const state=String(turn.allocation_state),next:Contribution[]=[{day,modelFilter:0,modelKey:"",state,tokens:String(turn.observed_tokens??"0"),turns:1,missing:turn.observed_tokens===null||turn.frozen===1?1:0,unknown:buckets.some(b=>b.provider===null||b.model===null)?1:0},
      ...buckets.map(b=>({day,modelFilter:1,modelKey:String(b.model_key??tokenModelKey(b.provider as string|null,b.model as string|null)),state,tokens:String(b.tokens),turns:1,missing:turn.frozen===1?1:0,unknown:b.provider===null||b.model===null?1:0}))];
    const previous=this.statement("SELECT value_json FROM token_usage_turn_projections WHERE server_id=? AND thread_id=? AND turn_id=?").get(...ids);
    const old:Contribution[]=previous?JSON.parse(String(previous.value_json)):[];
    const delta=new Map<string,Contribution&{amount:bigint}>();
    for(const [entries,sign] of [[old,-1],[next,1]] as const)for(const entry of entries){
      const key=JSON.stringify([entry.day,entry.modelFilter,entry.modelKey,entry.state]),before=delta.get(key);
      delta.set(key,{...entry,amount:(before?.amount??0n)+BigInt(entry.tokens)*BigInt(sign),turns:(before?.turns??0)+entry.turns*sign,missing:(before?.missing??0)+entry.missing*sign,unknown:(before?.unknown??0)+entry.unknown*sign});
    }
    const get=this.statement("SELECT tokens,turns,missing_usage,unknown_models FROM token_usage_daily WHERE server_id=? AND day=? AND model_filter=? AND model_key=? AND allocation_state=?");
    const put=this.statement("INSERT INTO token_usage_daily VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(server_id,day,model_filter,model_key,allocation_state) DO UPDATE SET tokens=excluded.tokens,turns=excluded.turns,missing_usage=excluded.missing_usage,unknown_models=excluded.unknown_models");
    for(const entry of delta.values()){
      if(entry.amount===0n&&entry.turns===0&&entry.missing===0&&entry.unknown===0)continue;
      const before=get.get(ids[0],entry.day,entry.modelFilter,entry.modelKey,entry.state);
      const tokens=BigInt(String(before?.tokens??"0"))+entry.amount,turns=Number(before?.turns??0)+entry.turns,missing=Number(before?.missing_usage??0)+entry.missing,unknown=Number(before?.unknown_models??0)+entry.unknown;
      if(tokens<0n||turns<0||missing<0||unknown<0)throw new Error("Inconsistent token usage projection");
      if(turns===0)this.statement("DELETE FROM token_usage_daily WHERE server_id=? AND day=? AND model_filter=? AND model_key=? AND allocation_state=?").run(ids[0],entry.day,entry.modelFilter,entry.modelKey,entry.state);
      else put.run(ids[0],entry.day,entry.modelFilter,entry.modelKey,entry.state,tokens.toString(),turns,missing,unknown);
    }
    this.statement("INSERT INTO token_usage_turn_projections VALUES(?,?,?,?) ON CONFLICT(server_id,thread_id,turn_id) DO UPDATE SET value_json=excluded.value_json").run(...ids,JSON.stringify(next));
    this.updateActorProjection(ids,turn,day);
  }
  private updateActorProjection(ids:[string,string,string],turn:Record<string,unknown>,day:string):void {
    type Contribution={actor:string;day:string;filter:number;model:string;tokens:string};
    const next:Contribution[]=[],all=new Map<string,bigint>();
    for(const row of this.statement("SELECT actor_id,model_key,tokens FROM token_usage_allocations WHERE server_id=? AND thread_id=? AND turn_id=?").all(...ids)){
      const actor=String(row.actor_id),tokens=String(row.tokens);
      next.push({actor,day,filter:1,model:String(row.model_key),tokens});
      all.set(actor,(all.get(actor)??0n)+BigInt(tokens));
    }
    for(const [actor,tokens] of all)next.push({actor,day,filter:0,model:"",tokens:tokens.toString()});
    const previous=this.statement("SELECT value_json FROM token_usage_turn_actor_projections WHERE server_id=? AND thread_id=? AND turn_id=?").get(...ids);
    const old:Contribution[]=previous?JSON.parse(String(previous.value_json)):[];
    const delta=new Map<string,Contribution&{amount:bigint;count:number}>();
    for(const [entries,sign] of [[old,-1],[next,1]] as const)for(const entry of entries){
      const key=JSON.stringify([entry.actor,entry.day,entry.filter,entry.model]),before=delta.get(key);
      delta.set(key,{...entry,amount:(before?.amount??0n)+BigInt(entry.tokens)*BigInt(sign),count:(before?.count??0)+sign});
    }
    const get=this.statement("SELECT tokens,turns FROM token_usage_actor_daily WHERE server_id=? AND actor_id=? AND day=? AND model_filter=? AND model_key=?");
    const put=this.statement("INSERT INTO token_usage_actor_daily VALUES(?,?,?,?,?,?,?) ON CONFLICT(server_id,actor_id,day,model_filter,model_key) DO UPDATE SET tokens=excluded.tokens,turns=excluded.turns");
    const remove=this.statement("DELETE FROM token_usage_actor_daily WHERE server_id=? AND actor_id=? AND day=? AND model_filter=? AND model_key=?");
    for(const entry of delta.values()){
      if(entry.amount===0n&&entry.count===0)continue;
      const key=[ids[0],entry.actor,entry.day,entry.filter,entry.model],before=get.get(...key);
      const tokens=BigInt(String(before?.tokens??"0"))+entry.amount,turns=Number(before?.turns??0)+entry.count;
      if(tokens<0n||turns<0||(turns===0&&tokens!==0n))throw new Error("Inconsistent actor usage projection");
      if(turns===0)remove.run(...key);else put.run(...key,tokens.toString(),turns);
    }
    this.statement("INSERT INTO token_usage_turn_actor_projections VALUES(?,?,?,?) ON CONFLICT(server_id,thread_id,turn_id) DO UPDATE SET value_json=excluded.value_json").run(...ids,JSON.stringify(next));
  }
  metadataCursor(threadId:string):string|null {
    const row=this.statement("SELECT cursor FROM token_usage_metadata_scans WHERE server_id=? AND thread_id=?").get(this.serverId,threadId);
    return row?.cursor as string|null??null;
  }
  advanceMetadataCursor(threadId:string,cursor:string|null):void {
    requiredId(threadId);
    if(cursor!==null)requiredId(cursor);
    if(this.metadataCursor(threadId)===cursor)return;
    this.write(()=>{this.statement("INSERT INTO token_usage_metadata_scans VALUES(?,?,?) ON CONFLICT(server_id,thread_id) DO UPDATE SET cursor=excluded.cursor").run(this.serverId,requiredId(threadId),cursor);});
  }
  hasRunningTurnsOutside(threadId:string,known:readonly string[]):boolean {
    if(known.length>100)throw new TypeError("Unbounded metadata page");
    return !!this.statement(`SELECT 1 FROM token_usage_turns WHERE server_id=? AND thread_id=? AND execution_state='running' AND frozen=0${known.length?` AND turn_id NOT IN (${known.map(()=>"?").join(",")})`:""} LIMIT 1`).get(this.serverId,threadId,...known);
  }
  /** Only the physical native thread/start response can prove an empty
   * ephemeral thread. A resumed/forked thread must never invent this baseline. */
  registerNativeCounter(threadId:string,epoch:string):boolean {
    requiredId(threadId);requiredId(epoch);
    const zero=JSON.stringify(Object.fromEntries(countFields.map(field=>[field,"0"])));
    return this.write(()=>!!this.statement("INSERT OR IGNORE INTO token_usage_native_counters VALUES(?,?,?,NULL,?,?,0,0)").run(this.serverId,threadId,epoch,zero,zero).changes);
  }
  private nativeCounter(threadId:string,epoch:string) {
    const row=this.statement("SELECT * FROM token_usage_native_counters WHERE server_id=? AND thread_id=?").get(this.serverId,threadId);
    if(!row||row.epoch!==epoch||row.broken===1)throw new Error("Unverified native counter baseline");
    return row;
  }
  breakNativeCounter(threadId:string):void {
    this.write(()=>{this.statement("UPDATE token_usage_native_counters SET broken=1 WHERE server_id=? AND thread_id=?").run(this.serverId,threadId);});
  }
  startNativeCounterTurn(key:UsageTurnKey,startedAt:number,epoch:string):void {
    this.write(()=>{
      const row=this.nativeCounter(key.threadId,epoch);
      if(row.turn_id===key.turnId)return;
      if(row.turn_id!==null){
        const previous=this.readTurn({threadId:key.threadId,turnId:String(row.turn_id)});
        if(!previous||previous.executionState==="running"||!previous.usageComplete)throw new Error("Previous native counter turn is incomplete");
      }
      if(!this.readTurn(key)&&!this.startTurn(key,startedAt,"unknown"))throw new Error("Native counter turn is outside coverage");
      if(this.readTurn(key)?.frozen)throw new Error("Native counter turn is frozen");
      this.statement("UPDATE token_usage_native_counters SET turn_id=?,baseline_json=cumulative_json WHERE server_id=? AND thread_id=?").run(key.turnId,this.serverId,key.threadId);
    });
  }
  recordNativeCounter(key:UsageTurnKey,epoch:string,counts:UsageSource["counts"]):void {
    const next=normalizeUsageCounts(counts);
    if(countFields.some(field=>next[field]===null))throw new Error("Incomplete native counter fields");
    this.write(()=>{
      const row=this.nativeCounter(key.threadId,epoch);
      if(row.turn_id!==key.turnId)throw new Error("Native counter turn mismatch");
      const previous=JSON.parse(String(row.cumulative_json)) as UsageCounts,base=JSON.parse(String(row.baseline_json)) as UsageCounts;
      const delta:Record<string,string>={};
      for(const field of countFields){
        if(BigInt(next[field]!)<BigInt(previous[field]!))throw new Error("Native counter reset");
        delta[field]=(BigInt(next[field]!)-BigInt(base[field]!)).toString();
      }
      const serialized=JSON.stringify(next);
      const existing=this.statement("SELECT 1 FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND lineage=? AND source_kind='turn-snapshot' AND source_id='native-turn'").get(...this.key(key),"ephemeral:"+epoch);
      if(serialized===row.cumulative_json&&existing)return;
      const version=Number(row.source_version)+1;
      this.recordSource({...key,lineage:"ephemeral:"+epoch,sourceId:"native-turn",kind:"turn-snapshot",version,provider:null,model:null,counts:{...delta,totalTokens:delta.totalTokens!}});
      this.statement("UPDATE token_usage_native_counters SET cumulative_json=?,source_version=? WHERE server_id=? AND thread_id=?").run(serialized,version,this.serverId,key.threadId);
      const turn=this.readTurn(key);
      if(turn&&turn.executionState!=="running")this.reconcile(key,{executionState:turn.executionState,participantsComplete:true,...this.nativeSettlement(key)});
    });
  }
  completeNativeCounterTurn(key:UsageTurnKey,epoch:string,executionState:UsageExecutionState):void {
    this.write(()=>{
      if(this.nativeCounter(key.threadId,epoch).turn_id!==key.turnId)throw new Error("Native counter terminal mismatch");
      this.recordNativeTerminal(key);
      this.reconcile(key,{executionState,participantsComplete:true,...this.nativeSettlement(key)});
    });
  }
  /** Capture only trusted ingress identity, before forwarding native input. */
  storedSubmission(threadId:string,inputId:string):UsageSubmission|null {
    const row=this.statement("SELECT * FROM token_usage_submissions WHERE server_id=? AND thread_id=? AND input_id=?").get(this.serverId,requiredId(threadId),requiredId(inputId));
    return row?{threadId,inputId,actorId:row.actor_id as string|null,actorKind:row.actor_kind as UsageSubmission["actorKind"],mode:row.mode as UsageSubmission["mode"],sourceKind:row.source_kind as UsageSourceKind,submittedAt:Number(row.submitted_ms)}:null;
  }
  /** Historical receipts establish identity; dispatch owns actual start/steer mode. */
  recoverSubmission(input:UsageSubmission):boolean {
    const before=this.storedSubmission(input.threadId,input.inputId);
    // Queue-author/delegation history is a fallback identity source. It must
    // never overwrite the actual verified requester captured at dispatch.
    if(before&&before.actorKind!=="unknown"&&(before.actorKind!=="human"||before.actorId!==null))return false;
    return this.recordSubmission({...input,mode:before?.mode??input.mode});
  }
  recordAttempt(attemptId:string,input:UsageSubmission):void {
    requiredId(attemptId);
    this.write(()=>{
      const prior=this.statement("SELECT * FROM token_usage_attempts WHERE server_id=? AND attempt_id=?").get(this.serverId,attemptId);
      if(prior){
        if(prior.thread_id!==input.threadId||prior.input_id!==input.inputId||prior.mode!==input.mode||prior.actor_id!==input.actorId||prior.actor_kind!==input.actorKind||prior.source_kind!==input.sourceKind)throw new Error("Immutable usage attempt identity changed");
        return;
      }
      const before=this.storedSubmission(input.threadId,input.inputId);
      if(before&&(before.mode!==input.mode||before.actorId!==input.actorId||before.actorKind!==input.actorKind||before.sourceKind!==input.sourceKind)){
        const unresolved=this.statement("SELECT 1 FROM token_usage_attempts WHERE server_id=? AND thread_id=? AND input_id=? AND outcome!='rejected' LIMIT 1").get(this.serverId,input.threadId,input.inputId);
        const admitted=this.statement("SELECT 1 FROM token_usage_admissions WHERE server_id=? AND thread_id=? AND input_id=?").get(this.serverId,input.threadId,input.inputId);
        if(!admitted&&!unresolved)this.statement("UPDATE token_usage_submissions SET mode=?,actor_id=?,actor_kind=?,source_kind=? WHERE server_id=? AND thread_id=? AND input_id=?").run(input.mode,input.actorId,input.actorKind,input.sourceKind,this.serverId,input.threadId,input.inputId);
      }
      this.recordSubmission(input);
      this.statement("INSERT INTO token_usage_attempts VALUES(?,?,?,?,?,?,?,?,?,'pending',NULL)").run(this.serverId,attemptId,input.threadId,input.inputId,input.mode,input.actorId,input.actorKind,input.sourceKind,timestamp(input.submittedAt));
    });
  }
  recordAttemptOutcome(attemptId:string,outcome:"accepted"|"rejected"|"unknown",turnId:string|null=null):string|null {
    requiredId(attemptId);if(turnId!==null)requiredId(turnId);
    if((outcome==="accepted")!==(turnId!==null))throw new TypeError("Accepted attempts require a native turn target");
    return this.write(()=>{
      const row=this.statement("SELECT * FROM token_usage_attempts WHERE server_id=? AND attempt_id=?").get(this.serverId,attemptId);
      if(!row)return null;
      if(row.outcome==="accepted"||row.outcome==="rejected"){
        if(row.outcome!==outcome||row.turn_id!==turnId)throw new Error("Settled attempt outcome cannot change");
        return String(row.thread_id);
      }
      this.statement("UPDATE token_usage_attempts SET outcome=?,turn_id=? WHERE server_id=? AND attempt_id=?").run(outcome,turnId,this.serverId,attemptId);
      return String(row.thread_id);
    });
  }
  recordSubmission(input: UsageSubmission): boolean {
    requiredId(input.threadId); requiredId(input.inputId); timestamp(input.submittedAt);
    if (input.actorId !== null) requiredId(input.actorId);
    return this.write(() => {
      const before = this.statement("SELECT * FROM token_usage_submissions WHERE server_id=? AND thread_id=? AND input_id=?")
        .get(this.serverId, input.threadId, input.inputId);
      if (before) {
        if(before.actor_id===null&&before.actor_kind==="unknown"&&before.mode===input.mode&&input.actorId!==null&&input.actorKind!=="unknown"){
          this.statement("UPDATE token_usage_submissions SET actor_id=?,actor_kind=?,source_kind=? WHERE server_id=? AND thread_id=? AND input_id=?").run(input.actorId,input.actorKind,input.sourceKind,this.serverId,input.threadId,input.inputId);
          const target=this.statement("SELECT turn_id FROM token_usage_admissions WHERE server_id=? AND thread_id=? AND input_id=?").get(this.serverId,input.threadId,input.inputId);
          if(target)this.syncAdmissions({threadId:input.threadId,turnId:String(target.turn_id)});
          this.bump();return true;
        }
        if (before.actor_id !== input.actorId || before.actor_kind !== input.actorKind || before.mode !== input.mode || before.source_kind !== input.sourceKind) {
          // Preserve the first trusted receipt, but never attribute a reused ID
          // to it after another verified Actor claimed the same input. Persist
          // uncertainty even inside a replay transaction, without throwing away
          // the marker through rollback. This is not a recoverable I/O gap.
          this.statement("INSERT OR IGNORE INTO token_usage_input_conflicts VALUES(?,?,?)").run(this.serverId,input.threadId,input.inputId);
          const admitted=this.statement("SELECT turn_id FROM token_usage_admissions WHERE server_id=? AND thread_id=? AND input_id=?").get(this.serverId,input.threadId,input.inputId);
          if(admitted&&this.readTurn({threadId:input.threadId,turnId:String(admitted.turn_id)}))this.rebuild(this.key({threadId:input.threadId,turnId:String(admitted.turn_id)}));
          this.bump();
          return false;
        }
        return false;
      }
      this.statement("INSERT INTO token_usage_submissions VALUES(?,?,?,?,?,?,?,?)")
        .run(this.serverId, input.threadId, input.inputId, input.actorId, input.actorKind, input.mode, input.sourceKind, input.submittedAt);
      const admission = this.statement("SELECT turn_id FROM token_usage_admissions WHERE server_id=? AND thread_id=? AND input_id=?")
        .get(this.serverId, input.threadId, input.inputId);
      if (admission) this.syncAdmissions({ threadId: input.threadId, turnId: String(admission.turn_id) });
      return true;
    });
  }
  /** Accept only verified native ACK/replay target facts, never latest-turn guesses. */
  recordAdmission(key: UsageTurnKey, inputId: string): boolean {
    this.key(key); requiredId(inputId);
    return this.write(() => {
      const before = this.statement("SELECT turn_id FROM token_usage_admissions WHERE server_id=? AND thread_id=? AND input_id=?")
        .get(this.serverId, key.threadId, inputId);
      if (before) {
        if (before.turn_id !== key.turnId) throw new Error("Native usage admission cannot change target");
        return false;
      }
      this.statement("INSERT INTO token_usage_admissions VALUES(?,?,?,?,?)")
        .run(this.serverId, key.threadId, inputId, key.turnId, timestamp(this.now()));
      this.syncAdmissions(key);
      if (this.readTurn(key)) this.rebuild(this.key(key));
      return true;
    });
  }
  private syncAdmissions(key: UsageTurnKey): void {
    if (!this.readTurn(key)) return;
    const rows = this.statement(`SELECT s.* FROM token_usage_submissions s JOIN token_usage_admissions a
      USING(server_id,thread_id,input_id) WHERE a.server_id=? AND a.thread_id=? AND a.turn_id=?`).all(...this.key(key));
    for (const row of rows) {
      if (row.mode === "start" && row.source_kind === "system") this.statement("UPDATE token_usage_turns SET source_kind='system' WHERE server_id=? AND thread_id=? AND turn_id=? AND source_kind='unknown'").run(...this.key(key));
      this.recordInput(key, { inputId: String(row.input_id), actorId: row.actor_id as string | null,
        actorKind: row.actor_kind as "human" | "session" | "unknown", mode: row.mode as "start" | "steer", admission: row.actor_kind==="unknown"||(row.actor_kind==="human"&&row.actor_id===null)?"pending":"confirmed" });
    }
  }
  unresolvedInputIds(threadId:string,after="",limit=32):string[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new TypeError("Invalid receipt recovery page");
    return this.statement(`SELECT a.input_id FROM token_usage_admissions a LEFT JOIN token_usage_submissions s USING(server_id,thread_id,input_id)
      WHERE a.server_id=? AND a.thread_id=? AND a.input_id>? AND (s.input_id IS NULL OR s.actor_kind='unknown' OR (s.actor_kind='human' AND s.actor_id IS NULL)) ORDER BY a.input_id LIMIT ?`).all(this.serverId,threadId,after,limit).map(row=>String(row.input_id));
  }
  private hasUnresolvedAdmissions(ids: readonly [string, string, string]): boolean {
    return !!this.statement(`SELECT 1 FROM token_usage_admissions a LEFT JOIN token_usage_submissions s
      USING(server_id,thread_id,input_id) WHERE a.server_id=? AND a.thread_id=? AND a.turn_id=?
      AND (s.input_id IS NULL OR s.actor_kind='unknown' OR (s.actor_kind='human' AND s.actor_id IS NULL) OR EXISTS(SELECT 1 FROM token_usage_input_conflicts c WHERE c.server_id=a.server_id AND c.thread_id=a.thread_id AND c.input_id=a.input_id)) LIMIT 1`).get(...ids);
  }
  recordSourceBatch(sources: readonly UsageSource[]): void {
    this.write(() => { for (const source of sources) this.recordSource(source); });
  }
  /** Synchronous internal replay only: never hold a transaction over I/O. */
  commitReplayBatch<T>(callback: () => T): T { return this.write(callback); }
  rememberRollout(threadId: string, path: string): void {
    requiredId(threadId);
    if (typeof path !== "string" || !path || path.length > 32768) throw new TypeError("Invalid native rollout reference");
    const known = this.rollout(threadId);
    if (known) {
      if (known.path !== path) throw new Error("Native rollout source changed; reconciliation required");
      return;
    }
    this.write(() => {
      const existing = this.rollout(threadId);
      if (existing && existing.path !== path) throw new Error("Native rollout source changed; reconciliation required");
      this.statement("INSERT OR IGNORE INTO token_usage_rollouts VALUES(?,?,?,'0',NULL,NULL)").run(this.serverId, threadId, path);
    });
  }
  repairRolloutPath(threadId: string, expectedPath: string, path: string): void {
    requiredId(threadId);
    if (typeof expectedPath !== "string" || !expectedPath || typeof path !== "string" || !path) throw new TypeError("Invalid rollout path");
    this.write(() => {
      const result = this.statement("UPDATE token_usage_rollouts SET path=? WHERE server_id=? AND thread_id=? AND path=?")
        .run(path, this.serverId, threadId, expectedPath);
      if (result.changes !== 1) throw new Error("Stale rollout path");
    });
  }
  rollout(threadId: string): UsageRollout | null {
    const row = this.statement("SELECT * FROM token_usage_rollouts WHERE server_id=? AND thread_id=?").get(this.serverId, requiredId(threadId));
    return row ? { threadId, path: String(row.path), cursor: String(row.cursor), lastSuccessAt: row.last_success_ms as number | null, errorKind: row.error_kind as string | null } : null;
  }
  rollouts(after = "", limit = 100): UsageRollout[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid rollout page");
    return this.statement("SELECT * FROM token_usage_rollouts WHERE server_id=? AND thread_id>? ORDER BY thread_id LIMIT ?")
      .all(this.serverId, after, limit).map(row => ({ threadId: String(row.thread_id), path: String(row.path), cursor: String(row.cursor), lastSuccessAt: row.last_success_ms as number | null, errorKind: row.error_kind as string | null }));
  }
  missingRolloutThreads(after = "", limit = 100): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("Invalid recovery page");
    return this.statement(`SELECT DISTINCT t.thread_id FROM (SELECT server_id,thread_id FROM token_usage_turns UNION SELECT server_id,thread_id FROM token_usage_submissions) t
      WHERE t.server_id=? AND t.thread_id>? AND NOT EXISTS(SELECT 1 FROM token_usage_rollouts r WHERE r.server_id=t.server_id AND r.thread_id=t.thread_id)
      ORDER BY t.thread_id LIMIT ?`).all(this.serverId,after,limit).map(row=>String(row.thread_id));
  }
  advanceRollout(threadId: string, expectedPath: string, cursor: string): void {
    const next = tokenInteger(cursor);
    this.write(() => {
      const before = this.rollout(threadId);
      if (!before || before.path !== expectedPath || BigInt(before.cursor) > next) throw new Error("Stale rollout checkpoint");
      this.statement("UPDATE token_usage_rollouts SET cursor=?,last_success_ms=?,error_kind=NULL WHERE server_id=? AND thread_id=?")
        .run(next.toString(), timestamp(this.now()), this.serverId, threadId);
    });
  }
  noteGap(gap: { readonly id: string; readonly reason: UsageGapReason; readonly threadId?: string; readonly turnId?: string }): void {
    requiredId(gap.id);
    if (!["storage-write","queue-full","source-offline","source-replaced","invalid-source","unreplayable","oversized-line"].includes(gap.reason)) throw new TypeError("Unknown usage gap category");
    this.write(() => {
      const inserted=this.statement("INSERT OR IGNORE INTO token_usage_gaps VALUES(?,?,?,?,?,?,NULL)")
        .run(this.serverId, gap.id, gap.threadId ?? null, gap.turnId ?? null, gap.reason, timestamp(this.now()));
      if(inserted.changes)this.afterCommit(()=>this.telemetry.increment("missing"));
      if (gap.threadId) this.statement("UPDATE token_usage_rollouts SET error_kind=? WHERE server_id=? AND thread_id=?").run(gap.reason, this.serverId, gap.threadId);
      if (gap.threadId && gap.turnId && this.readTurn({threadId:gap.threadId,turnId:gap.turnId})) {
        const ids = this.key({threadId:gap.threadId,turnId:gap.turnId});
        this.statement("UPDATE token_usage_turns SET usage_complete=0 WHERE server_id=? AND thread_id=? AND turn_id=?").run(...ids);
        this.rebuild(ids);
      }
      this.bump();
    });
  }
  resolveGap(id: string): void {
    this.write(() => {
      this.statement("UPDATE token_usage_gaps SET ends_ms=? WHERE server_id=? AND gap_key=? AND ends_ms IS NULL").run(timestamp(this.now()), this.serverId, requiredId(id));
      this.bump();
    });
  }
  /** A complete successful replay repairs transient acquisition failures even
   * after a Host restart. Invalid/replaced source evidence needs separate proof. */
  resolveReplayGaps(threadId:string): void {
    this.write(()=>{
      const result=this.statement("UPDATE token_usage_gaps SET ends_ms=? WHERE server_id=? AND thread_id=? AND ends_ms IS NULL AND reason IN ('storage-write','queue-full','source-offline','unreplayable','source-replaced')").run(timestamp(this.now()),this.serverId,requiredId(threadId));
      if(result.changes)this.bump();
    });
  }
  gaps(): {id: string; threadId: string | null; turnId: string | null; reason: string; startsAt: number; endsAt: number | null}[] {
    return this.statement("SELECT * FROM token_usage_gaps WHERE server_id=? ORDER BY starts_ms,gap_key").all(this.serverId)
      .map(row => ({id:String(row.gap_key),threadId:row.thread_id as string|null,turnId:row.turn_id as string|null,reason:String(row.reason),startsAt:Number(row.starts_ms),endsAt:row.ends_ms as number|null}));
  }
  openGapThreads(limit = 256): { threadId: string; id: string }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024) throw new TypeError("Invalid gap page");
    return this.statement(`SELECT thread_id,gap_key FROM token_usage_gaps
      WHERE server_id=? AND ends_ms IS NULL AND thread_id IS NOT NULL
      ORDER BY starts_ms LIMIT ?`).all(this.serverId, limit)
      .map(row => ({ threadId: String(row.thread_id), id: String(row.gap_key) }));
  }
  correctTurnIdentities(key: UsageTurnKey, provider: string | null, model: string | null): boolean {
    const ids = this.key(key);
    return this.write(() => {
      const updated = this.statement(
        "UPDATE token_usage_sources SET provider=?, model=? WHERE server_id=? AND thread_id=? AND turn_id=? AND provider IS NULL AND model IS NULL"
      ).run(provider, model, ...ids);
      if (updated.changes > 0) {
        this.rebuild(ids);
        return true;
      }
      return false;
    });
  }
  /** Called only for native durable terminal markers, independently of UI state. */
  recordNativeTerminal(key: UsageTurnKey): void {
    this.write(() => {
      this.statement("INSERT OR IGNORE INTO token_usage_native_terminals VALUES(?,?,?)").run(...this.key(key));
    });
  }
  nativeSettlement(key: UsageTurnKey): { usageComplete: boolean; responsesComplete: boolean } {
    const ids = this.key(key);
    const gap = this.statement("SELECT 1 FROM token_usage_gaps WHERE server_id=? AND ends_ms IS NULL AND (thread_id IS NULL OR thread_id=?) AND (turn_id IS NULL OR turn_id=?) LIMIT 1").get(...ids);
    if (gap) return { usageComplete: false, responsesComplete: false };
    const terminal = this.statement("SELECT 1 FROM token_usage_native_terminals WHERE server_id=? AND thread_id=? AND turn_id=?").get(...ids);
    const snapshot = this.statement("SELECT counts_json FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND source_kind='turn-snapshot' AND source_id='native-turn' ORDER BY source_version DESC LIMIT 1").get(...ids);
    if (!snapshot || !terminal) return { usageComplete: false, responsesComplete: false };
    const reported = BigInt((JSON.parse(String(snapshot.counts_json)) as UsageCounts).totalTokens!);
    const responses = this.statement("SELECT counts_json FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND source_kind='response'").all(...ids);
    const exact = responses.reduce((n, row) => n + BigInt((JSON.parse(String(row.counts_json)) as UsageCounts).totalTokens!), 0n);
    return { usageComplete: true, responsesComplete: responses.length > 0 && exact === reported };
  }
  coverage(): { enabledAt: number; enabled: boolean; revision: number; intervals: {startsAt: number; endsAt: number | null}[] } {
    const row = this.statement("SELECT * FROM token_usage_scopes WHERE server_id=?").get(this.serverId)!;
    return {
      enabledAt: Number(row.enabled_at_ms), enabled: row.enabled === 1, revision: Number(row.revision),
      intervals: this.statement("SELECT starts_ms,ends_ms FROM token_usage_coverage WHERE server_id=? ORDER BY id").all(this.serverId)
        .map(r => ({ startsAt: Number(r.starts_ms), endsAt: r.ends_ms === null ? null : Number(r.ends_ms) })),
    };
  }
  setEnabled(enabled: boolean): void {
    this.write(() => {
      if (this.coverage().enabled === enabled) return;
      const at = timestamp(this.now());
      this.statement("UPDATE token_usage_scopes SET enabled=?,revision=revision+1 WHERE server_id=?").run(enabled ? 1 : 0, this.serverId);
      if (enabled) this.statement("INSERT INTO token_usage_coverage(server_id,starts_ms,ends_ms) VALUES(?,?,NULL)").run(this.serverId, at);
      else {
        this.statement("UPDATE token_usage_coverage SET ends_ms=? WHERE server_id=? AND ends_ms IS NULL").run(at, this.serverId);
        this.statement("UPDATE token_usage_turns SET frozen=1,usage_complete=0,responses_complete=0,revision=revision+1 WHERE server_id=? AND execution_state='running'").run(this.serverId);
        for(const turn of this.statement("SELECT * FROM token_usage_turns WHERE server_id=? AND frozen=1 AND execution_state='running'").iterate(this.serverId)){
          const ids:[string,string,string]=[this.serverId,String(turn.thread_id),String(turn.turn_id)];
          const buckets=this.statement("SELECT model_key,provider,model,tokens FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=?").all(...ids);
          this.updateDailyProjection(ids,turn,buckets);
        }
      }
    });
  }
  startTurn(key: UsageTurnKey, startedAt: number, sourceKind: UsageSourceKind, participantsComplete = false): boolean {
    const ids = this.key(key);
    timestamp(startedAt);
    return this.write(() => {
      if (this.readTurn(key)) return false;
      const covered = this.statement("SELECT 1 FROM token_usage_coverage WHERE server_id=? AND starts_ms<=? AND (ends_ms IS NULL OR ?<ends_ms) LIMIT 1")
        .get(this.serverId, startedAt, startedAt);
      if (!covered || !this.coverage().enabled) return false;
      this.statement(`INSERT INTO token_usage_turns(server_id,thread_id,turn_id,started_ms,execution_state,source_kind,
        participants_complete,usage_complete,responses_complete,observed_tokens,allocation_state,revision)
        VALUES(?,?,?,?,'running',?,?,0,0,NULL,?,1)`)
        .run(...ids, startedAt, sourceKind, participantsComplete ? 1 : 0, sourceKind === "human" ? "pending" : sourceKind);
      this.bump();
      this.syncAdmissions(key);
      this.rebuild(ids);
      return true;
    });
  }
  recordInput(key: UsageTurnKey, input: {
    readonly inputId: string; readonly actorId: string | null; readonly actorKind: "human" | "session" | "unknown";
    readonly mode: "start" | "steer"; readonly admission: "confirmed" | "pending" | "rejected";
  }): boolean {
    const ids = this.key(key);
    requiredId(input.inputId);
    if (input.actorId !== null) requiredId(input.actorId);
    return this.write(() => {
      const turn = this.readTurn(key);
      if (!turn || turn.frozen) return false;
      const existing = this.statement("SELECT * FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND input_id=?")
        .get(this.serverId, key.threadId, input.inputId);
      if (existing) {
        const resolvesIdentity = existing.admission === "pending" && existing.actor_id === null && existing.actor_kind === "unknown";
        if (existing.turn_id !== key.turnId || existing.mode !== input.mode ||
          (!resolvesIdentity && (existing.actor_id !== input.actorId || existing.actor_kind !== input.actorKind))) {
          throw new Error("Usage input identity cannot be reassigned");
        }
        if (existing.admission === input.admission && existing.actor_id === input.actorId && existing.actor_kind === input.actorKind) return false;
        if (existing.admission !== "pending") throw new Error("A final input receipt cannot be replaced");
      }
      this.statement(`INSERT INTO token_usage_inputs VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(server_id,thread_id,input_id) DO UPDATE SET actor_id=excluded.actor_id,actor_kind=excluded.actor_kind,admission=excluded.admission`)
        .run(this.serverId, key.threadId, input.inputId, key.turnId, input.actorId, input.actorKind, input.mode, input.admission);
      if (input.mode === "start" && input.admission === "confirmed" && input.actorKind === "human" && input.actorId !== null) {
        this.statement("UPDATE token_usage_turns SET source_kind='human' WHERE server_id=? AND thread_id=? AND turn_id=? AND source_kind='unknown'")
          .run(...ids);
      }
      this.rebuild(ids);
      return true;
    });
  }
  recordSource(source: UsageSource): "inserted" | "corrected" | "duplicate" | "excluded" {
    const ids = this.key(source);
    requiredId(source.lineage); requiredId(source.sourceId);
    if (!Number.isSafeInteger(source.version) || source.version < 0) throw new TypeError("Usage source version must be nonnegative");
    const json = JSON.stringify(normalizeUsageCounts(source.counts));
    return this.write(() => {
      const turn = this.readTurn(source);
      if (!turn || turn.frozen || !this.coverage().enabled) {this.afterCommit(()=>this.telemetry.source("excluded"));return "excluded";}
      const params = [...ids, source.lineage, source.kind, source.sourceId];
      const previous = this.statement("SELECT source_version,provider,model,counts_json FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? AND lineage=? AND source_kind=? AND source_id=?").get(...params);
      let result: "inserted" | "corrected" | "duplicate" = "inserted";
      if (previous) {
        if (source.version < Number(previous.source_version)) {this.afterCommit(()=>this.telemetry.source("duplicate"));return "duplicate";}
        if (source.version === Number(previous.source_version)) {
          if (previous.provider !== source.provider || previous.model !== source.model || previous.counts_json !== json) throw new Error("Conflicting immutable usage source");
          result = "duplicate";
        } else result = "corrected";
      }
      if (result !== "duplicate") {
        this.statement(`INSERT INTO token_usage_sources VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(server_id,thread_id,turn_id,lineage,source_kind,source_id)
          DO UPDATE SET source_version=excluded.source_version,provider=excluded.provider,model=excluded.model,counts_json=excluded.counts_json,observed_ms=excluded.observed_ms`)
          .run(...ids, source.lineage, source.sourceId, source.kind, source.version, source.provider, source.model, json, timestamp(source.observedAt ?? this.now()));
        this.rebuild(ids);
      }
      if (source.cursor !== undefined) {
        requiredId(source.cursor);
        this.statement("INSERT INTO token_usage_checkpoints VALUES(?,?,?) ON CONFLICT(server_id,lineage) DO UPDATE SET cursor=excluded.cursor")
          .run(this.serverId, source.lineage, source.cursor);
      }
      this.afterCommit(()=>this.telemetry.source(result));
      return result;
    });
  }
  reconcile(key: UsageTurnKey, evidence: {
    readonly executionState: UsageExecutionState; readonly participantsComplete: boolean;
    readonly usageComplete: boolean; readonly responsesComplete: boolean;
  }): void {
    const ids = this.key(key);
    // Fact and admission mutations rebuild their own projections. Repeated
    // native metadata must not scan all historical sources or revise cursors.
    // Compare stored evidence rather than readTurn's effective completeness:
    // unresolved admissions can legitimately keep effective completeness false.
    const stored = this.statement("SELECT execution_state,participants_complete,usage_complete,responses_complete,frozen FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(...ids);
    if (!stored || stored.frozen === 1) return;
    if (stored.execution_state === evidence.executionState &&
      stored.participants_complete === (evidence.participantsComplete ? 1 : 0) &&
      stored.usage_complete === (evidence.usageComplete ? 1 : 0) &&
      stored.responses_complete === (evidence.responsesComplete ? 1 : 0)) return;
    this.write(() => {
      const turn = this.readTurn(key);
      if (!turn || turn.frozen) return;
      if (turn.executionState !== "running" && evidence.executionState === "running") throw new Error("Usage execution cannot return to running");
      this.statement("UPDATE token_usage_turns SET execution_state=?,participants_complete=?,usage_complete=?,responses_complete=? WHERE server_id=? AND thread_id=? AND turn_id=?")
        .run(evidence.executionState, evidence.participantsComplete ? 1 : 0, evidence.usageComplete ? 1 : 0, evidence.responsesComplete ? 1 : 0, ...ids);
      this.rebuild(ids);
      this.afterCommit(()=>this.telemetry.reconcile());
    });
  }
  readTurn(key: UsageTurnKey): UsageTurn | null {
    const row = this.statement("SELECT * FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(...this.key(key));
    if (!row) return null;
    const incomplete = this.statement(`SELECT 1 FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=?
      AND (admission='pending' OR (admission='confirmed' AND (actor_kind='unknown' OR (actor_kind='human' AND actor_id IS NULL)))) LIMIT 1`).get(...this.key(key));
    return { ...key, startedAt: Number(row.started_ms), executionState: row.execution_state as UsageExecutionState,
      sourceKind: row.source_kind as UsageSourceKind, participantsComplete: row.participants_complete === 1 && !incomplete && !this.hasUnresolvedAdmissions(this.key(key)),
      usageComplete: row.usage_complete === 1 && row.observed_tokens !== null, observedTokens: row.observed_tokens as string | null,
      allocationState: row.allocation_state as UsageAllocationState, revision: Number(row.revision), frozen: row.frozen === 1 };
  }
  readAllocations(key: UsageTurnKey): { actorId: string; provider: string | null; model: string | null; tokens: string }[] {
    return this.statement("SELECT actor_id,provider,model,tokens FROM token_usage_allocations WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY model_key,actor_id")
      .all(...this.key(key)).map(row => ({ actorId: String(row.actor_id), provider: row.provider as string | null, model: row.model as string | null, tokens: String(row.tokens) }));
  }
  checkpoint(lineage: string): string | null {
    const row = this.statement("SELECT cursor FROM token_usage_checkpoints WHERE server_id=? AND lineage=?").get(this.serverId, lineage);
    return row ? String(row.cursor) : null;
  }
  private rebuild(ids: [string, string, string]): void {
    const turn = this.statement("SELECT * FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?").get(...ids)!;
    const sources = this.statement("SELECT source_kind,provider,model,counts_json FROM token_usage_sources WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY source_version DESC,lineage,source_id").all(...ids);
    const responses = sources.filter(row => row.source_kind === "response");
    const snapshot = sources.find(row => row.source_kind === "turn-snapshot");
    // The adapter supplies a validated per-turn snapshot, never the native
    // thread cumulative total. Raw responses and snapshots are alternatives.
    const chosen = turn.responses_complete === 1 && responses.length ? responses : snapshot ? [snapshot] : responses;
    const buckets: TokenModelBucket[] = chosen.map(row => ({ provider: row.provider as string | null, model: row.model as string | null,
      totalTokens: (JSON.parse(String(row.counts_json)) as UsageCounts).totalTokens! }));
    const total = chosen.length ? buckets.reduce((n, b) => n + BigInt(b.totalTokens), 0n).toString() : null;
    this.statement("DELETE FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=?").run(...ids);
    const modelTotals=new Map<string,{provider:string|null;model:string|null;tokens:bigint}>();
    for(const bucket of buckets){
      const key=tokenModelKey(bucket.provider,bucket.model),old=modelTotals.get(key);
      modelTotals.set(key,{provider:bucket.provider,model:bucket.model,tokens:(old?.tokens??0n)+BigInt(bucket.totalTokens)});
    }
    const putBucket=this.statement("INSERT INTO token_usage_buckets VALUES(?,?,?,?,?,?,?)");
    for(const [key,bucket] of modelTotals) putBucket.run(...ids,key,bucket.provider,bucket.model,bucket.tokens.toString());
    const inputs = this.statement("SELECT actor_id,actor_kind,admission FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=? AND admission!='rejected'").all(...ids);
    const participants = [...new Set(inputs.filter(row => row.admission === "confirmed" && row.actor_kind === "human" && row.actor_id !== null).map(row => String(row.actor_id)))];
    const complete = turn.participants_complete === 1 && !this.hasUnresolvedAdmissions(ids) && !inputs.some(row => row.admission === "pending" || row.actor_kind === "unknown" || (row.actor_kind === "human" && row.actor_id === null));
    let allocationState: UsageAllocationState = turn.source_kind === "system" ? "system" : turn.source_kind === "unknown" ? "unknown" : "pending";
    this.statement("DELETE FROM token_usage_allocations WHERE server_id=? AND thread_id=? AND turn_id=?").run(...ids);
    if (turn.source_kind === "human" && complete && participants.length && total !== null) {
      allocationState = turn.execution_state !== "running" && turn.usage_complete === 1 ? "settled" : "provisional";
      const allocation = allocateTurnTokens(buckets, participants);
      const insert = this.statement("INSERT INTO token_usage_allocations VALUES(?,?,?,?,?,?,?,?)");
      for (const model of allocation.models) for (const actor of model.actors) {
        insert.run(...ids, tokenModelKey(model.provider, model.model), model.provider, model.model, actor.actorId, actor.totalTokens);
      }
    }
    this.statement("UPDATE token_usage_turns SET observed_tokens=?,allocation_state=?,unknown_model=?,revision=revision+1 WHERE server_id=? AND thread_id=? AND turn_id=?")
      .run(total, allocationState, [...modelTotals.values()].some(bucket=>bucket.provider===null||bucket.model===null)?1:0, ...ids);
    this.updateDailyProjection(ids,{...turn,observed_tokens:total,allocation_state:allocationState},[...modelTotals].map(([model_key,b])=>({model_key,provider:b.provider,model:b.model,tokens:b.tokens.toString()})));
    this.bump();
  }
}
