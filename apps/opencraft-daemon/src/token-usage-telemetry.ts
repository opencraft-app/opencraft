import type { TokenUsageDiagnostics } from "@opencraft/appserver-protocol/token-usage";
type Counter=keyof TokenUsageDiagnostics["counts"];
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
  snapshot():TokenUsageDiagnostics {
    const summarize=(values:number[],count:number)=>{const sorted=[...values].sort((a,b)=>a-b);return {count,samples:values.length,p95Ms:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]!:null,maxMs:sorted.at(-1)??null};};
    return {since:this.since,counts:{...this.counts},lastSourceSuccessAt:this.lastSourceSuccessAt,lastReconcileAt:this.lastReconcileAt,writeLatency:summarize(this.writes,this.writeCount),queryLatency:summarize(this.queries,this.queryCount)};
  }
}
