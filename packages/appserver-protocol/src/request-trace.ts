/** Diagnostic correlation only. These self-reported fields never grant authority. */
export const requestCallers = ["sidebar-catalog", "thread-catalog", "history", "client", "server-refresh"] as const;
export const requestTriggers = ["initial-load", "auto-next-page", "connection-ready", "catalog-notification", "explicit-retry", "explicit-next-page", "query-refetch", "cache-refresh", "direct-request", "unknown"] as const;
export interface RequestTrace extends Partial<NotificationObservation> {
  readonly notificationDecision?: "refresh-other-projections" | "cancel-and-refetch";
  readonly notificationToInvalidateMs?: number;
  readonly notificationCount?: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly linkedTraceId?: string;
  readonly linkedSpanId?: string;
  readonly caller: typeof requestCallers[number];
  readonly trigger: typeof requestTriggers[number];
  readonly catalogId?: string;
  readonly pageIndex?: number;
  readonly attempt?: number;
}
const hex = (value: unknown, length: number): value is string => typeof value === "string"
  && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value) && !/^0+$/.test(value);
export function parseRequestTrace(value: unknown): RequestTrace | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (!hex(v.traceId,32) || !hex(v.spanId,16) || !requestCallers.includes(v.caller as RequestTrace["caller"])
    || !requestTriggers.includes(v.trigger as RequestTrace["trigger"])) return;
  for (const key of ["parentSpanId", "linkedSpanId"]) if (v[key] !== undefined && !hex(v[key],16)) return;
  if (v.catalogId !== undefined && !hex(v.catalogId,32)) return;
  if (v.linkedTraceId !== undefined && !hex(v.linkedTraceId,32)) return;
  if ((v.linkedTraceId === undefined) !== (v.linkedSpanId === undefined)) return;
  for (const key of ["pageIndex","attempt"]) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || (v[key] as number) < 0)) return;
  return {traceId:v.traceId,spanId:v.spanId,caller:v.caller as RequestTrace["caller"],trigger:v.trigger as RequestTrace["trigger"],
    ...notificationTraceFields(v),
    ...(v.parentSpanId === undefined ? {} : {parentSpanId:v.parentSpanId as string}),
    ...(v.linkedTraceId === undefined ? {} : {linkedTraceId:v.linkedTraceId as string,linkedSpanId:v.linkedSpanId as string}),
    ...(v.catalogId === undefined ? {} : {catalogId:v.catalogId as string}),
    ...(v.pageIndex === undefined ? {} : {pageIndex:v.pageIndex as number}),...(v.attempt === undefined ? {} : {attempt:v.attempt as number})};
}
const randomHex = () => {
  const bytes=new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for(let i=0;i<bytes.length;i++) bytes[i]=Math.floor(Math.random()*256);
  // Correlation only; the fallback for insecure local previews is never a credential.
  if(bytes.every(value=>value === 0)) bytes[15]=1;
  return Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
};
export function createRequestTrace(caller: RequestTrace["caller"], trigger: RequestTrace["trigger"], parent?: RequestTrace): RequestTrace {
  return {traceId:parent?.traceId ?? randomHex(),spanId:randomHex().slice(0,16),
    ...(parent ? {parentSpanId:parent.spanId} : {}),caller,trigger};
}


export const catalogNotificationMethods = ["opencraft/thread-access/changed","opencraft/thread-access/revoked","opencraft/thread-catalog/changed", "thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed", "thread/deleted", "thread/pins/updated", "thread/status/changed", "turn/started", "turn/completed"] as const;
export const notificationSources = ["history-storage","execution-status","upstream-catalog","upstream-native","access-policy","unknown"] as const;
export const notificationChanges = ["upsert","patch","remove","invalidate","none","unknown"] as const;
export interface NotificationObservation {
  readonly notificationId: string;
  readonly notificationMethod: typeof catalogNotificationMethods[number];
  readonly notificationSource: typeof notificationSources[number];
  readonly notificationChange: typeof notificationChanges[number];
  readonly notificationRevision?: number;
  readonly notificationCauseTraceId?: string;
  readonly notificationCauseSpanId?: string;
}
export function parseNotificationObservation(value: unknown): NotificationObservation | undefined {
  if(!value || typeof value !== "object" || Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(!hex(v.notificationId,32) || !catalogNotificationMethods.includes(v.notificationMethod as NotificationObservation["notificationMethod"])
    || !notificationSources.includes(v.notificationSource as NotificationObservation["notificationSource"])
    || !notificationChanges.includes(v.notificationChange as NotificationObservation["notificationChange"]))return;
  if(v.notificationRevision !== undefined && (!Number.isSafeInteger(v.notificationRevision) || (v.notificationRevision as number)<0))return;
  if((v.notificationCauseTraceId === undefined)!==(v.notificationCauseSpanId === undefined))return;
  if(v.notificationCauseTraceId !== undefined && (!hex(v.notificationCauseTraceId,32) || !hex(v.notificationCauseSpanId,16)))return;
  return {notificationId:v.notificationId,notificationMethod:v.notificationMethod as NotificationObservation["notificationMethod"],
    notificationSource:v.notificationSource as NotificationObservation["notificationSource"],notificationChange:v.notificationChange as NotificationObservation["notificationChange"],
    ...(v.notificationRevision === undefined ? {} : {notificationRevision:v.notificationRevision as number}),
    ...(v.notificationCauseTraceId === undefined ? {} : {notificationCauseTraceId:v.notificationCauseTraceId as string,notificationCauseSpanId:v.notificationCauseSpanId as string})};
}
/** No raw source/publisher ID, thread identity or payload is retained. */
export function createNotificationObservation(method: string, params: unknown, source: NotificationObservation["notificationSource"], cause?: RequestTrace): NotificationObservation | undefined {
  if(!catalogNotificationMethods.includes(method as NotificationObservation["notificationMethod"]))return;
  const p=params && typeof params === "object" ? params as Record<string,unknown> : {};
  const rawChange=p.change && typeof p.change === "object" ? (p.change as {type?:unknown}).type : undefined;
  const change=method === "opencraft/thread-catalog/changed" ? notificationChanges.includes(rawChange as NotificationObservation["notificationChange"]) ? rawChange as NotificationObservation["notificationChange"] : "unknown" : "none";
  return {notificationId:randomHex(),notificationMethod:method as NotificationObservation["notificationMethod"],notificationSource:source,notificationChange:change,
    ...(method === "opencraft/thread-catalog/changed" && Number.isSafeInteger(p.revision) && (p.revision as number)>=0 ? {notificationRevision:p.revision as number} : {}),
    ...(cause ? {notificationCauseTraceId:cause.traceId,notificationCauseSpanId:cause.spanId} : {})};
}
export function notificationTraceFields(value: unknown): Partial<RequestTrace> {
  const parsed=parseNotificationObservation(value);if(!parsed)return {};
  const v=value as RequestTrace;
  return {...parsed,
    ...(["refresh-other-projections","cancel-and-refetch"].includes(String(v.notificationDecision)) ? {notificationDecision:v.notificationDecision} : {}),
    ...(typeof v.notificationToInvalidateMs === "number" && Number.isFinite(v.notificationToInvalidateMs) && v.notificationToInvalidateMs>=0 ? {notificationToInvalidateMs:v.notificationToInvalidateMs} : {}),
    ...(Number.isSafeInteger(v.notificationCount) && v.notificationCount!>=0 ? {notificationCount:v.notificationCount} : {})};
}

/** RPC summaries retain the cause identity; detailed producer links and counters live on Query signals. */
export function compactRequestTrace(value: RequestTrace): RequestTrace {
  const parsed=parseRequestTrace(value)!;
  const {notificationRevision:_revision,notificationCauseTraceId:_causeTrace,notificationCauseSpanId:_causeSpan,
    notificationCount:_count,notificationToInvalidateMs:_wait,...summary}=parsed;
  return summary;
}

/** Server-owned control diagnostics. No error text, payload or identity is projected. */
export interface ControlObservation {
  readonly traceId: string;
  readonly control: "create" | "thread-defaults";
}
export const controlPhases = ["prepare", "revalidate", "permission", "connect", "initialize", "dispatch", "response", "settlement", "defaults-prepare", "defaults-write", "defaults-observe"] as const;
export type ControlPhase = typeof controlPhases[number];
export type ControlOutcome = "started" | "succeeded" | "failed" | "timeout" | "disconnected";
export function controlDiagnostic(observation: ControlObservation | undefined, phase: ControlPhase, outcome: ControlOutcome, error?: unknown, method?: string): Record<string, unknown> | undefined {
  if (!observation || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(observation.traceId)
    || !["create", "thread-defaults"].includes(observation.control) || !controlPhases.includes(phase)
    || !["started", "succeeded", "failed", "timeout", "disconnected"].includes(outcome)) return;
  let rpcCode: number | null = null, status: number | null = null;
  let category = "unknown-error";
  try {
    const value = error as { code?: unknown; status?: unknown } | undefined;
    if (Number.isSafeInteger(value?.code) && Number(value?.code) >= -32768 && Number(value?.code) <= 599) {
      rpcCode = Number(value!.code); category = "rpc-error";
    } else if (value?.code === "unsupported_capability") category = "unsupported-capability";
    if (Number.isSafeInteger(value?.status) && Number(value?.status) >= 400 && Number(value?.status) <= 599) status = Number(value!.status);
  } catch { /* A hostile accessor is not a diagnostic payload. */ }
  return { event: "conversation-control", traceId: observation.traceId, control: observation.control, phase, outcome,
    ...(["initialize","project/list","configRequirements/read","permissionProfile/list","model/list","thread/start","thread/settings/update","opencraft/thread-defaults/update","opencraft/thread-defaults/read"].includes(method ?? "") ? {rpcMethod:method} : {}),
    ...(error === undefined ? {} : { category, rpcCode, status }) };
}
