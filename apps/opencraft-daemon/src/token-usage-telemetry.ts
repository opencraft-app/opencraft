import type { TokenUsageDiagnostics } from "@opencraft/appserver-protocol/token-usage";
type Counter=keyof TokenUsageDiagnostics["counts"];
export interface UsageTelemetryBatch {
  counts:TokenUsageDiagnostics["counts"];
  writes:number[];queries:number[];writeCount:number;queryCount:number;
  lastSourceSuccessAt:number|null;lastReconcileAt:number|null;
}
/** Process-local, fixed-cardinality diagnostics. No source IDs or user labels. */
export class TokenUsageTelemetry {
  private readonly since=Date.now();
  private readonly counts:TokenUsageDiagnostics["counts"]={collected:0,corrected:0,deduplicated:0,excluded:0,missing:0,reconciled:0,writeFailures:0,queryFailures:0};
  private readonly writes:number[]=[];private readonly queries:number[]=[];
  private writeCount=0;private queryCount=0;
  private lastSourceSuccessAt:number|null=null;private lastReconcileAt:number|null=null;
  increment(key:Counter,count=1){this.counts[key]=Math.min(Number.MAX_SAFE_INTEGER,this.counts[key]+count);}
  source(outcome:"inserted"|"corrected"|"duplicate"|"excluded"){
    this.increment(({inserted:"collected",corrected:"corrected",duplicate:"deduplicated",excluded:"excluded"} as const)[outcome]);
    if(outcome!=="excluded")this.lastSourceSuccessAt=Date.now();
  }
  reconcile(){this.increment("reconciled");this.lastReconcileAt=Date.now();}
  latency(kind:"write"|"query",duration:number,success:boolean){
    const values=kind==="write"?this.writes:this.queries;
    values.push(Math.max(0,duration));if(values.length>256)values.shift();
    if(kind==="write")this.writeCount=Math.min(Number.MAX_SAFE_INTEGER,this.writeCount+1);else this.queryCount=Math.min(Number.MAX_SAFE_INTEGER,this.queryCount+1);
    if(!success)this.increment(kind==="write"?"writeFailures":"queryFailures");
  }
  /** Worker transfer is a delta with at most 256 timing samples, no labels. */
  takeBatch():UsageTelemetryBatch|null {
    if(!this.writeCount&&!this.queryCount&&!Object.values(this.counts).some(Boolean))return null;
    const batch={counts:{...this.counts},writes:this.writes.splice(0),queries:this.queries.splice(0),
      writeCount:this.writeCount,queryCount:this.queryCount,lastSourceSuccessAt:this.lastSourceSuccessAt,lastReconcileAt:this.lastReconcileAt};
    for(const key of Object.keys(this.counts) as Counter[])this.counts[key]=0;
    this.writeCount=0;this.queryCount=0;this.lastSourceSuccessAt=null;this.lastReconcileAt=null;
    return batch;
  }
  mergeBatch(batch:UsageTelemetryBatch):void {
    for(const key of Object.keys(this.counts) as Counter[])this.increment(key,batch.counts[key]);
    this.writeCount=Math.min(Number.MAX_SAFE_INTEGER,this.writeCount+batch.writeCount);
    this.queryCount=Math.min(Number.MAX_SAFE_INTEGER,this.queryCount+batch.queryCount);
    this.writes.push(...batch.writes);this.writes.splice(0,Math.max(0,this.writes.length-256));
    this.queries.push(...batch.queries);this.queries.splice(0,Math.max(0,this.queries.length-256));
    if(batch.lastSourceSuccessAt!==null)this.lastSourceSuccessAt=Math.max(this.lastSourceSuccessAt??0,batch.lastSourceSuccessAt);
    if(batch.lastReconcileAt!==null)this.lastReconcileAt=Math.max(this.lastReconcileAt??0,batch.lastReconcileAt);
  }
  snapshot():TokenUsageDiagnostics {
    const summarize=(values:number[],count:number)=>{const sorted=[...values].sort((a,b)=>a-b);return {count,samples:values.length,p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]!:null,maxMs:sorted.at(-1)??null};};
    return {since:this.since,counts:{...this.counts},lastSourceSuccessAt:this.lastSourceSuccessAt,lastReconcileAt:this.lastReconcileAt,writeLatency:summarize(this.writes,this.writeCount),queryLatency:summarize(this.queries,this.queryCount)};
  }
}
