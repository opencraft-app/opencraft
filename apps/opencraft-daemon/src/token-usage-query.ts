import type { StatementSync } from "node:sqlite";
import { readTeamUsage } from "./token-usage-team-query.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";

export class TokenUsageQueryError extends Error {
  constructor(readonly code: "unauthorized" | "forbidden" | "invalid-query" | "stale-snapshot", message: string = code) { super(message); }
}
/** This function is supplied by trusted ingress and re-evaluates current roles. */
export interface TokenUsageAuthority { readonly actorId: string; readonly administrator: boolean }
type Sum = { tokens: bigint; turns: number };
function add(map: Map<string, Sum>, key: string, tokens: bigint): void {
  const sum = map.get(key) ?? { tokens: 0n, turns: 0 }; sum.tokens += tokens; sum.turns++; map.set(key, sum);
}
function serialized(map: Map<string, Sum>) { return [...map].sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>({key,tokens:value.tokens.toString(),turns:value.turns})); }
function invalid(): never { throw new TokenUsageQueryError("invalid-query"); }
/** Resolve a civil midnight through Intl instead of assuming an offset or the process timezone. */
function midnight(date: string, format: Intl.DateTimeFormat): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid();
  const utc=Date.parse(date+"T00:00:00Z");
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0,10)!==date) return invalid();
  let result=utc;
  for(let i=0;i<4;i++) {
    const parts=Object.fromEntries(format.formatToParts(result).map(p=>[p.type,p.value]));
    const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
    const correction=utc-represented;
    if(!correction) return result;
    result+=correction;
  }
  return invalid();
}

/** Read-only projection of the Host-owned ledger. No body, title, input IDs,
 * source IDs or filesystem paths are returned. SQLite INTEGER SUM is avoided:
 * token counts can exceed both JS safe integers and SQLite signed 64 bits. */
export class TokenUsageQuery {
  private readonly statements = new Map<string, StatementSync>();
  private statement(sql: string): StatementSync {
    const existing = this.statements.get(sql);
    if (existing) return existing;
    const statement = this.state.database.prepare(sql);
    if (this.statements.size === 128) this.statements.delete(this.statements.keys().next().value!);
    this.statements.set(sql, statement);
    return statement;
  }
  private readonly midnightFormat: Intl.DateTimeFormat;
  private readonly dateFormat: Intl.DateTimeFormat;
  constructor(private readonly state: Pick<OpenCraftHostStateDatabase,"database">, readonly serverId: string, readonly timezone="Asia/Shanghai", private readonly now=Date.now, private readonly secret: Uint8Array=randomBytes(32)) {
    // Intl owns native ICU allocations. Reuse the two immutable formatters for
    // this physical query owner rather than allocating four on every read.
    this.midnightFormat=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
    this.dateFormat=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"});
    state.database.aggregate<bigint>("usage_sum",{start:0n,step:(sum,value)=>sum+BigInt(String(value??"0")),result:sum=>sum.toString()});
  }
  read(value: unknown, authorize: ()=>TokenUsageAuthority | null) {
    const authority=authorize(); if(!authority) throw new TokenUsageQueryError("unauthorized");
    if(!value || typeof value!=="object" || Array.isArray(value)) return invalid();
    const p=value as Record<string,unknown>;
    const allowed=["serverId","from","through","scope","actorId","modelKey","threadId","turnId","view","limit","cursor"];
    if(Object.keys(p).some(key=>!allowed.includes(key))) return invalid();
    if(p.serverId!==undefined && p.serverId!==this.serverId) throw new TokenUsageQueryError("forbidden");
    const scope=p.scope??"self";
    if(scope!=="self" && scope!=="team") return invalid();
    if(scope==="team"&&!authority.administrator) throw new TokenUsageQueryError("forbidden");
    if(p.actorId!==undefined&&(typeof p.actorId!=="string"||!p.actorId)) return invalid();
    const actorId=scope==="self" ? authority.actorId : p.actorId as string|undefined;
    if(scope==="self"&&p.actorId!==undefined&&p.actorId!==authority.actorId) throw new TokenUsageQueryError("forbidden");
    const view=p.view??"turns";
    if(!["turns","threads","actors"].includes(String(view))) return invalid();
    if(view==="actors"&&!authority.administrator) throw new TokenUsageQueryError("forbidden");
    if(typeof p.from!=="string"||typeof p.through!=="string") return invalid();
    const start=midnight(p.from,this.midnightFormat);
    midnight(p.through,this.midnightFormat);
    const endDate=new Date(Date.parse(p.through+"T00:00:00Z")+86_400_000).toISOString().slice(0,10);
    const end=midnight(endDate,this.midnightFormat);
    if(end<=start||Date.parse(endDate+"T00:00:00Z")-Date.parse(p.from+"T00:00:00Z")>366*86_400_000) return invalid();
    for(const key of ["modelKey","threadId","turnId"]) if(p[key]!==undefined&&(typeof p[key]!=="string"||!(p[key] as string).length||(p[key] as string).length>2048)) return invalid();
    const limit=p.limit??50;
    if(typeof limit!=="number"||!Number.isSafeInteger(limit)||limit<1||limit>100) return invalid();
    const binding=JSON.stringify([this.serverId,authority.actorId,authority.administrator,scope,actorId??null,start,end,p.modelKey??null,p.threadId??null,p.turnId??null,view,limit]);
    let bulkIterator:Iterator<Record<string,unknown>>|null=null;
    this.state.database.exec("BEGIN");
    try {
      if(this.statement("SELECT 1 FROM token_usage_checkpoints WHERE server_id=? AND lineage IN ('legacy-projection-retired-v1','legacy-projection-stale-v1')").get(this.serverId))throw new Error("Legacy usage projections require restoration");
      const coverage=this.statement("SELECT * FROM token_usage_scopes WHERE server_id=?").get(this.serverId);
      if(!coverage) return invalid();
      const revision=Number(coverage.revision);
      let after="";
      if(p.cursor!==undefined) {
        if(typeof p.cursor!=="string"||p.cursor.length>8192) return invalid();
        const [payload,signature,...rest]=p.cursor.split(".");
        if(!payload||!signature||rest.length) return invalid();
        const expected=createHmac("sha256",this.secret).update(payload).digest();
        const actual=Buffer.from(signature,"base64url");
        if(actual.length!==expected.length||!timingSafeEqual(actual,expected)) throw new TokenUsageQueryError("forbidden");
        let decoded: unknown; try {decoded=JSON.parse(Buffer.from(payload,"base64url").toString());} catch {return invalid();}
        if(!Array.isArray(decoded)||decoded.length!==3||decoded[0]!==binding||typeof decoded[2]!=="string") throw new TokenUsageQueryError("forbidden");
        if(decoded[1]!==revision) throw new TokenUsageQueryError("stale-snapshot");
        after=decoded[2];
      }
      const dateFormat=this.dateFormat;
      const totals: Record<string,bigint>={settled:0n,provisional:0n,pending:0n,system:0n,unknown:0n};
      const daily=new Map<string,Sum>(), models=new Map<string,Sum>(), threads=new Map<string,Sum>(), people=new Map<string,Sum>();
      let rows: {key:string;[key:string]:unknown}[]=[];
      let known=0n,allocated=0n,turnCount=0,settledTurns=0,missingUsage=0,unknownModelTurns=0;
      const parameters: (string|number)[]=[this.serverId,start,end];
      let filter="";
      if(p.threadId!==undefined){filter+=" AND t.thread_id=?";parameters.push(p.threadId as string);}
      if(p.turnId!==undefined){filter+=" AND t.turn_id=?";parameters.push(p.turnId as string);}
      // Start a personal query from its trusted admitted turn set. A date-first
      // IN filter otherwise scans every team turn in the requested period.
      const personal=actorId!==undefined;
      const turnSql=(personal?`WITH owned AS MATERIALIZED (SELECT DISTINCT thread_id,turn_id FROM token_usage_inputs WHERE server_id=? AND actor_id=? AND actor_kind='human' AND admission='confirmed') SELECT t.* FROM owned CROSS JOIN token_usage_turns t ON t.thread_id=owned.thread_id AND t.turn_id=owned.turn_id `:"SELECT t.* FROM token_usage_turns t ")+`WHERE t.server_id=? AND t.started_ms>=? AND t.started_ms<?${filter} ORDER BY t.started_ms,t.thread_id,t.turn_id`;
      const turnParameters=personal?[this.serverId,actorId!,...parameters]:parameters;
      const buckets=this.statement("SELECT model_key,provider,model,tokens FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY model_key");
      const shares=this.statement("SELECT actor_id,model_key,tokens FROM token_usage_allocations WHERE server_id=? AND thread_id=? AND turn_id=?");
      const participants=this.statement("SELECT count(DISTINCT actor_id) AS count FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=? AND admission='confirmed' AND actor_kind='human' AND actor_id IS NOT NULL");
      const team=actorId===undefined&&this.timezone==="Asia/Shanghai"?readTeamUsage({prepare:sql=>this.statement(sql)},{serverId:this.serverId,start,end,view:String(view),after,limit,modelKey:p.modelKey as string|undefined,threadId:p.threadId as string|undefined,turnId:p.turnId as string|undefined}):null;
      if(team){
        known=team.known;allocated=team.allocated;turnCount=team.turnCount;settledTurns=team.settledTurns;missingUsage=team.missingUsage;unknownModelTurns=team.unknownModelTurns;rows=team.rows;
        Object.assign(totals,team.totals);
      }
      let bulkRow:IteratorResult<Record<string,unknown>>|null=null;
      if(personal){
        // Stream one joined range scan rather than issuing two statements for
        // every turn. Only the current turn's buckets and shares are retained.
        const selected=turnSql.slice(0,turnSql.lastIndexOf(" ORDER BY"));
        const bulk="WITH selected AS MATERIALIZED ("+selected+") SELECT t.thread_id,t.turn_id,b.model_key,b.provider,b.model,b.tokens,a.actor_id,a.tokens AS share_tokens FROM selected t CROSS JOIN token_usage_buckets b ON b.server_id=t.server_id AND b.thread_id=t.thread_id AND b.turn_id=t.turn_id LEFT JOIN token_usage_allocations a ON a.server_id=b.server_id AND a.thread_id=b.thread_id AND a.turn_id=b.turn_id AND a.model_key=b.model_key AND a.actor_id=? ORDER BY t.started_ms,t.thread_id,t.turn_id,b.model_key";
        bulkIterator=this.statement(bulk).iterate(...turnParameters,actorId!);bulkRow=bulkIterator.next();
      }
      if(!team)for(const turn of this.statement(turnSql).iterate(...turnParameters)) {
        const ids=[this.serverId,String(turn.thread_id),String(turn.turn_id)];
        const allBuckets:Record<string,unknown>[]=personal?[]:buckets.all(...ids),allShares:Record<string,unknown>[]=personal?[]:shares.all(...ids);
        while(bulkIterator&&bulkRow&&!bulkRow.done&&bulkRow.value.thread_id===turn.thread_id&&bulkRow.value.turn_id===turn.turn_id){
          const row=bulkRow.value;
          allBuckets.push({model_key:row.model_key,provider:row.provider,model:row.model,tokens:row.tokens});
          if(row.actor_id!==null)allShares.push({actor_id:row.actor_id,model_key:row.model_key,tokens:row.share_tokens});
          bulkRow=bulkIterator.next();
        }
        const chosen=allBuckets.filter(b=>p.modelKey===undefined||b.model_key===p.modelKey);
        if(p.modelKey!==undefined&&!chosen.length)continue;
        const raw=chosen.reduce((n,b)=>n+BigInt(String(b.tokens)),0n);
        const allocations=allShares.filter(a=>(actorId===undefined||a.actor_id===actorId)&&(p.modelKey===undefined||a.model_key===p.modelKey));
        const amount=allocations.reduce((n,a)=>n+BigInt(String(a.tokens)),0n);
        const shown=actorId===undefined?raw:amount;
        turnCount++; known+=raw; allocated+=amount;
        if(turn.allocation_state==="settled") settledTurns++;
        if(turn.observed_tokens===null||turn.frozen===1) missingUsage++;
        if(chosen.some(b=>b.provider===null||b.model===null)) unknownModelTurns++;
        totals[String(turn.allocation_state)]!+=shown;
        add(daily,dateFormat.format(Number(turn.started_ms)),shown);
        add(threads,String(turn.thread_id),shown);
        for(const b of chosen) {
          const n=actorId===undefined?BigInt(String(b.tokens)):allocations.filter(a=>a.model_key===b.model_key).reduce((n,a)=>n+BigInt(String(a.tokens)),0n);
          add(models,String(b.model_key),n);
        }
        const actorTurn=new Map<string,bigint>();
        for(const a of allocations) actorTurn.set(String(a.actor_id),(actorTurn.get(String(a.actor_id))??0n)+BigInt(String(a.tokens)));
        for(const [id,n] of actorTurn) add(people,id,n);
        const key=JSON.stringify([turn.started_ms,turn.thread_id,turn.turn_id]);
        if(view!=="turns"||key<=after||(rows.length===limit+1&&key>=rows.at(-1)!.key))continue;
        // Retain only one bounded detail page while reducing the full range.
        rows.push({key,threadId:turn.thread_id,turnId:turn.turn_id,startedAt:turn.started_ms,executionState:turn.execution_state,allocationState:turn.allocation_state,
          rawTokens:turn.observed_tokens===null?null:raw.toString(),allocatedTokens:amount.toString(),participantCount:Number(participants.get(...ids)!.count),revision:turn.revision,
          models:chosen.map(b=>({key:b.model_key,provider:b.provider,model:b.model,tokens:(actorId===undefined?BigInt(String(b.tokens)):allocations.filter(a=>a.model_key===b.model_key).reduce((n,a)=>n+BigInt(String(a.tokens)),0n)).toString()}))});
        rows.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
        if(rows.length>limit+1)rows.pop();
      }
      const collection=team?team.rows:view==="threads"?serialized(threads):view==="actors"?serialized(people):rows;
      collection.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
      const remaining=collection.filter(row=>row.key>after), page=remaining.slice(0,limit);
      let nextCursor: string|null=null;
      if(remaining.length>limit) {
        const payload=Buffer.from(JSON.stringify([binding,revision,page.at(-1)!.key])).toString("base64url");
        nextCursor=payload+"."+createHmac("sha256",this.secret).update(payload).digest("base64url");
      }
      const current=authorize();
      if(!current) throw new TokenUsageQueryError("unauthorized");
      if(current.actorId!==authority.actorId||current.administrator!==authority.administrator) throw new TokenUsageQueryError("forbidden");
      // Resolve an actor's visible threads once, rather than probing their
      // admissions for every turn of every unrelated coverage incident.
      const gapPrefix=actorId===undefined?"":`WITH visible_threads AS MATERIALIZED (
        SELECT DISTINCT i.thread_id FROM token_usage_inputs i INDEXED BY token_usage_inputs_actor_query CROSS JOIN token_usage_turns t
          ON t.server_id=i.server_id AND t.thread_id=i.thread_id AND t.turn_id=i.turn_id
        WHERE i.server_id=? AND i.actor_id=? AND i.admission='confirmed'
          AND t.started_ms>=? AND t.started_ms<?
      ) `;
      const gapScope=actorId===undefined
        ? "EXISTS(SELECT 1 FROM token_usage_turns t WHERE t.server_id=g.server_id AND t.thread_id=g.thread_id AND t.started_ms>=? AND t.started_ms<?)"
        : "g.thread_id IN (SELECT thread_id FROM visible_threads)";
      const gapParams: (string|number)[]=actorId===undefined
        ? [this.serverId,start,end] : [this.serverId,actorId,start,end,this.serverId];
      const gapCounts=this.statement(`${gapPrefix}SELECT coalesce(sum(records),0) AS gaps,count(*) AS incidents FROM (
        SELECT count(*) AS records FROM token_usage_gaps g
        WHERE g.server_id=? AND g.ends_ms IS NULL AND (g.thread_id IS NULL OR ${gapScope})
        GROUP BY coalesce(g.thread_id,g.gap_key),g.reason
      )`).get(...gapParams)!;
      const gaps=Number(gapCounts.gaps),openGapIncidents=Number(gapCounts.incidents);
      const lastSource = this.statement("SELECT max(observed_ms) AS at FROM token_usage_sources WHERE server_id=?").get(this.serverId)?.at;
      const lastSourceSuccessAt = lastSource == null || Number(lastSource) === 0 ? null : Number(lastSource);
      return {serverId:this.serverId,canQueryTeam:authority.administrator,canConfigure:authority.administrator,scope,actorId:actorId??null,asOf:this.now(),snapshotRevision:revision,timezone:this.timezone,policyVersion:"equal-turn-v1",view,
        coverage:{enabled:coverage.enabled===1,enabledAt:coverage.enabled_at_ms,partial:gaps>0||missingUsage>0,openGaps:gaps,openGapIncidents,missingUsage,unknownModelTurns,lastSourceSuccessAt},
        summary:{tokens:(actorId===undefined?known:allocated).toString(),...(actorId===undefined?{rawTokens:known.toString()}:{}),allocatedTokens:allocated.toString(),turns:turnCount,settledTurns,threads:team?team.threadCount:threads.size,categories:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,v.toString()]))},
        daily:team?team.daily:serialized(daily),models:team?team.models:serialized(models),rows:page.map(({key,...row})=>view==="turns"?row:{key,...row}),nextCursor};
    } finally {
      // Manual join iteration must release its active statement even when a
      // malformed fact or authorization check throws before natural exhaustion.
      try { bulkIterator?.return?.(); } finally { this.state.database.exec("ROLLBACK"); }
    }
  }
}
