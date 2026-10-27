/** Optional trusted first-party Host capability; not a public extension-v1 ABI. */
export const TOKEN_USAGE_CONFIGURE = "opencraft/token-usage/configure";
export const TOKEN_USAGE_QUERY = "opencraft/token-usage/query";
export const TOKEN_USAGE_EXTENSION = "opencraft/token-usage";
export interface TokenUsageAggregate { key: string; tokens: string; turns: number; label?: string | null }
export interface TokenUsageTurnDetail {
  threadId: string; turnId: string; startedAt: number; executionState: string;
  allocationState: string; rawTokens: string | null; allocatedTokens: string;
  participantCount: number; revision: number;
  models: {key:string;provider:string|null;model:string|null;tokens:string}[];
}
export interface TokenUsageSnapshot {
  serverId:string;canQueryTeam:boolean;canConfigure?:boolean;scope:"self"|"team";actorId:string|null;
  asOf:number;snapshotRevision:number;timezone:string;policyVersion:string;view:"turns"|"threads"|"actors";
  coverage:{enabled:boolean;enabledAt:number;partial:boolean;openGaps:number;missingUsage:number;unknownModelTurns:number;lastSourceSuccessAt?:number|null;openGapIncidents?:number};
  summary:{tokens:string;rawTokens?:string;allocatedTokens:string;turns:number;threads?:number;categories:Record<string,string>;settledTurns?:number};
  daily:TokenUsageAggregate[];models:TokenUsageAggregate[];
  rows:(TokenUsageTurnDetail|TokenUsageAggregate)[];nextCursor:string|null;diagnostics?:TokenUsageDiagnostics;
}

/** Current physical Host process only; never a persisted usage ledger. */
export interface TokenUsageDiagnostics {
 since:number;
 counts:{collected:number;corrected:number;deduplicated:number;excluded:number;missing:number;reconciled:number;writeFailures:number;queryFailures:number};
 lastSourceSuccessAt:number|null;lastReconcileAt:number|null;
 writeLatency:{count:number;samples:number;p95Ms:number|null;maxMs:number|null};
 queryLatency:{count:number;samples:number;p95Ms:number|null;maxMs:number|null};
}
