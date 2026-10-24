import type { DatabaseSync } from "node:sqlite";
/** Whole-team reductions stay inside a single read snapshot and return only
 * grouped rows plus a bounded detail page. usage_sum is a JS BigInt aggregate;
 * neither SQLite's signed-64 SUM nor floating point touches token values. */
export function readTeamUsage(db:Pick<DatabaseSync,"prepare">,input:{serverId:string;start:number;end:number;modelKey?:string;threadId?:string;turnId?:string;view:string;after:string;limit:number}) {
  const args:(string|number)[]=[],model=input.modelKey;
  if(model!==undefined)args.push(model);
  args.push(input.serverId,input.start,input.end);
  let filters="";
  if(input.threadId!==undefined){filters+=" AND t.thread_id=?";args.push(input.threadId);}
  if(input.turnId!==undefined){filters+=" AND t.turn_id=?";args.push(input.turnId);}
  const selected=`WITH selected AS ${input.threadId!==undefined||input.turnId!==undefined?"MATERIALIZED ":""}(SELECT t.*,${model===undefined?"t.observed_tokens":"mb.tokens"} AS raw,${model===undefined?"t.unknown_model":"(mb.provider IS NULL OR mb.model IS NULL)"} AS model_unknown FROM token_usage_turns t ${model===undefined?"":"JOIN token_usage_buckets mb ON mb.server_id=t.server_id AND mb.thread_id=t.thread_id AND mb.turn_id=t.turn_id AND mb.model_key=?"} WHERE t.server_id=? AND t.started_ms>=? AND t.started_ms<?${filters}) `;
  const grouped=(sql:string,extra:(string|number)[]=[])=>db.prepare(selected+sql).all(...args,...extra);
  const totals:Record<string,bigint>={settled:0n,provisional:0n,pending:0n,system:0n,unknown:0n};
  let known=0n,allocated=0n,turnCount=0,settledTurns=0,missingUsage=0,unknownModelTurns=0;
  const ready=input.threadId===undefined&&input.turnId===undefined&&db.prepare("SELECT ready FROM token_usage_projection_state WHERE server_id=?").get(input.serverId)?.ready===1;
  const day=(ms:number)=>new Date(ms+8*3600000).toISOString().slice(0,10);
  const dailyArgs=[input.serverId,day(input.start),day(input.end)];
  const dailyWhere="server_id=? AND day>=? AND day<?";
  const dailyScope=dailyWhere+" AND model_filter=? AND model_key=?";
  const scopeArgs=[...dailyArgs,model===undefined?0:1,model??""];
  const states=ready?db.prepare("SELECT allocation_state,usage_sum(tokens) AS tokens,sum(turns) AS turns,sum(missing_usage) AS missing,sum(unknown_models) AS unknown_count FROM token_usage_daily WHERE "+dailyScope+" GROUP BY allocation_state").all(...scopeArgs)
    :grouped("SELECT allocation_state,usage_sum(raw) AS tokens,count(*) AS turns,sum(raw IS NULL OR frozen=1) AS missing,sum(model_unknown) AS unknown_count FROM selected GROUP BY allocation_state");
  for(const row of states){
    const value=BigInt(String(row.tokens));totals[String(row.allocation_state)]=value;known+=value;turnCount+=Number(row.turns);missingUsage+=Number(row.missing);unknownModelTurns+=Number(row.unknown_count);
    if(row.allocation_state==="settled"||row.allocation_state==="provisional")allocated+=value;
    if(row.allocation_state==="settled")settledTurns+=Number(row.turns);
  }
  const projection=(sql:string,extra:(string|number)[]=[])=>grouped(sql,extra).map(row=>({key:String(row.key),tokens:String(row.tokens),turns:Number(row.turns)}));
  // Join's fixed deployment timezone has no current DST; optimize this explicit
  // scope only. Other deployment timezones use the generic Intl implementation.
  let daily=ready?[]:projection("SELECT date(started_ms/1000,'unixepoch','+8 hours') AS key,usage_sum(raw) AS tokens,count(*) AS turns FROM selected GROUP BY key ORDER BY key");
  const modelWhere=model===undefined?"":" AND b.model_key=?",modelArgs=model===undefined?[]:[model];
  const joinBuckets=" FROM selected s JOIN token_usage_buckets b ON b.server_id=s.server_id AND b.thread_id=s.thread_id AND b.turn_id=s.turn_id";
  let models=ready?[]:projection("SELECT b.model_key AS key,usage_sum(b.tokens) AS tokens,count(*) AS turns"+joinBuckets+" WHERE 1=1"+modelWhere+" GROUP BY b.model_key ORDER BY b.model_key",modelArgs);
  if(ready){
    const map=(rows:ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>)=>rows.map(row=>({key:String(row.key),tokens:String(row.tokens),turns:Number(row.turns)}));
    daily=map(db.prepare("SELECT day AS key,usage_sum(tokens) AS tokens,sum(turns) AS turns FROM token_usage_daily WHERE "+dailyScope+" GROUP BY day ORDER BY day").all(...scopeArgs));
    models=map(db.prepare("SELECT model_key AS key,usage_sum(tokens) AS tokens,sum(turns) AS turns FROM token_usage_daily WHERE "+dailyWhere+" AND model_filter=1"+(model===undefined?"":" AND model_key=?")+" GROUP BY model_key ORDER BY model_key").all(...dailyArgs,...modelArgs));
  }
  let rows: {key:string;[key:string]:unknown}[]=[];
  if(input.view==="threads")rows=projection("SELECT thread_id AS key,usage_sum(raw) AS tokens,count(*) AS turns FROM selected GROUP BY thread_id HAVING thread_id>? ORDER BY thread_id LIMIT ?",[input.after,input.limit+1]);
  else if(input.view==="actors"&&ready){
    rows=db.prepare("SELECT actor_id AS key,usage_sum(tokens) AS tokens,sum(turns) AS turns FROM token_usage_actor_daily WHERE server_id=? AND actor_id>? AND day>=? AND day<? AND model_filter=? AND model_key=? GROUP BY actor_id ORDER BY actor_id LIMIT ?").all(input.serverId,input.after,day(input.start),day(input.end),model===undefined?0:1,model??"",input.limit+1).map(row=>({key:String(row.key),tokens:String(row.tokens),turns:Number(row.turns)}));
  }
  else if(input.view==="actors"){
    // Materialize range membership once, then scan allocations in actor order.
    // Avoid a nested full range scan for every allocation.
    const actorArgs:(string|number)[]=[input.serverId,input.start,input.end];
    let turnFilter="";
    if(input.threadId!==undefined){turnFilter+=" AND thread_id=?";actorArgs.push(input.threadId);}
    if(input.turnId!==undefined){turnFilter+=" AND turn_id=?";actorArgs.push(input.turnId);}
    actorArgs.push(input.serverId,input.after);
    if(model!==undefined)actorArgs.push(model);
    // Materialize the eligible IDs once. Flattening the date condition into
    // the actor join can make SQLite re-scan the date index per allocation.
    const eligible="WITH eligible AS MATERIALIZED (SELECT thread_id,turn_id FROM token_usage_turns WHERE server_id=? AND started_ms>=? AND started_ms<?"+turnFilter+") ";
    rows=db.prepare(eligible+"SELECT a.actor_id AS key,usage_sum(a.tokens) AS tokens,count(DISTINCT json_array(a.thread_id,a.turn_id)) AS turns FROM token_usage_allocations a WHERE a.server_id=? AND a.actor_id>? AND (a.thread_id,a.turn_id) IN (SELECT thread_id,turn_id FROM eligible)"+(model===undefined?"":" AND a.model_key=?")+" GROUP BY a.actor_id ORDER BY a.actor_id LIMIT ?").all(...actorArgs,input.limit+1).map(row=>({key:String(row.key),tokens:String(row.tokens),turns:Number(row.turns)}));
  }
  else {
    const buckets=db.prepare("SELECT model_key,provider,model,tokens FROM token_usage_buckets WHERE server_id=? AND thread_id=? AND turn_id=? ORDER BY model_key");
    const participants=db.prepare("SELECT count(DISTINCT actor_id) AS n FROM token_usage_inputs WHERE server_id=? AND thread_id=? AND turn_id=? AND actor_kind='human' AND actor_id IS NOT NULL AND admission='confirmed'");
    for(const turn of grouped("SELECT *,json_array(started_ms,thread_id,turn_id) AS key FROM selected WHERE json_array(started_ms,thread_id,turn_id)>? ORDER BY key LIMIT ?",[input.after,input.limit+1])){
      const ids=[input.serverId,String(turn.thread_id),String(turn.turn_id)],raw=turn.raw as string|null;
      rows.push({key:String(turn.key),threadId:turn.thread_id,turnId:turn.turn_id,startedAt:turn.started_ms,executionState:turn.execution_state,allocationState:turn.allocation_state,
        rawTokens:raw,allocatedTokens:turn.allocation_state==="settled"||turn.allocation_state==="provisional"?raw??"0":"0",participantCount:Number(participants.get(...ids)!.n),revision:turn.revision,
        models:buckets.all(...ids).filter(b=>model===undefined||b.model_key===model).map(b=>({key:String(b.model_key),provider:b.provider,model:b.model,tokens:String(b.tokens)}))});
    }
  }
  const threadCount=Number(grouped("SELECT count(DISTINCT thread_id) AS n FROM selected")[0]!.n);
  return {totals,known,allocated,turnCount,settledTurns,threadCount,missingUsage,unknownModelTurns,daily,models,rows};
}
