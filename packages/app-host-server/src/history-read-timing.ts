import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/** Request-local, numeric-only observations. Never pass payloads to a sink. */
export interface HistoryReadTiming {
  gatewayPairId: string;
  sql?: import("./sqlite-observation.js").SqlObservation;
  sink?: (event:Record<string,unknown>)=>void;
  requestMethod?: string;
  storageSamples?: number;
  ingress?: import("./rpc-ingress-observation.js").RpcIngressObservation;
  context?: import("@opencraft/appserver-protocol").RequestTrace;
  details: Record<string,string | number>;
  responseId?: string | number;
  active: boolean;
  started: number;
  outcome: "ok" | "failed" | "aborted";
  values: Record<string, number>;
}
export const historyReadTiming = new AsyncLocalStorage<HistoryReadTiming>();
export function beginHistoryReadTiming(): HistoryReadTiming {
  return { gatewayPairId: randomUUID(), active: true, started: performance.now(), outcome: "failed", values: {}, details: {} };
}
/** Fixed-vocabulary directory decisions; never copy params, cursors or errors here. */
export function recordDirectoryDetail(key: string, value: string | number): void {
  const trace=historyReadTiming.getStore();
  if (!trace?.active) return;
  if (key === "directoryMissReason") {
    trace.details.directoryMissReason ??= value;
    trace.details.directoryRangeReason=value;
  } else trace.details[key]=value;
}
export function addHistoryReadTiming(trace: HistoryReadTiming | undefined, key: string, value: unknown): void {
  if (trace?.active && typeof value === "number" && Number.isFinite(value) && value >= 0)
    trace.values[key] = (trace.values[key] ?? 0) + value;
}
export async function measureHistoryRead<T>(key: string, run: () => T | Promise<T>): Promise<T> {
  const trace = historyReadTiming.getStore(), started = performance.now();
  try { return await run(); }
  finally { addHistoryReadTiming(trace, key, performance.now() - started); }
}

export function roundedHistoryDiagnostic(event: Record<string,unknown>): Record<string,unknown> {
  const rounded=Object.fromEntries(Object.entries(event).map(([key,value])=>[key,typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value) ? Math.round(value*1000)/1000 : value]));
  // Leave room for the trusted producer envelope added by the Node adapter.
  // Keep causal identity, ingress totals and native wait; trim overlapping detail only.
  for(const key of ["historyProjectionMs","historyCoreMs","historyQueueMs","historyNativeRpcMs","gatewayDependencyMs","gatewayInitializeMs","storageAuthorizeMs","storageBusyRetries","storageBusyMs","storageDependencyMs","storageExecuteMs","storageQueueMs","gatewaySerializeMs","gatewayDeliverMs"]) {
    if(Buffer.byteLength(JSON.stringify(rounded))<=1536)break;
    if(key in rounded) {delete rounded[key];rounded.diagnosticTrimmed=Number(rounded.diagnosticTrimmed ?? 0)+1;}
  }
  return rounded;
}
