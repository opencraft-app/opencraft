import { createRequestTrace, notificationTraceFields, type RequestTrace } from "@opencraft/appserver-protocol";
import type { Query, QueryClient, QueryFilters, QueryKey } from "@tanstack/react-query";
import { observeEvent } from "./observability";

type Cause = { trace: RequestTrace; started: number };
type State = { catalogId: string; pending: Cause[]; active?: Cause; last?: RequestTrace; overflow: number; pageIndex: number; lastPage?: string | null; attempt: number };
const clients = new WeakSet<QueryClient>();
const states = new WeakMap<Query, State>();
const isCatalogQuery=(query: Query) => ["sidebar-catalog","thread-catalog"].includes(String(query.meta?.requestCaller));
const caller=(query?: Query): RequestTrace["caller"] => query?.meta?.requestCaller === "thread-catalog" ? "thread-catalog" : "sidebar-catalog";
function state(query: Query): State {
  let value = states.get(query);
  if (!value) { value = {catalogId:createRequestTrace(caller(query),"unknown").traceId,pending:[],overflow:0,pageIndex:0,attempt:0}; states.set(query,value); }
  return value;
}
/** Observe the Query owner's fetch boundaries; retries/pages do not replace an active cause. */
export function observeCatalogQueries(client: QueryClient): void {
  if (clients.has(client)) return;
  clients.add(client);
  client.getQueryCache().subscribe(event => {
    if (event.type !== "updated" || event.query.queryKey[0] !== "appserver" || event.query.queryKey[2] !== "threads" || !isCatalogQuery(event.query)) return;
    const query = event.query, value = state(query);
    if (event.action.type === "fetch") {
      const causes = value.pending.splice(0);
      const trace = {...createRequestTrace(caller(query), causes[0]?.trace.trigger ?? (query.state.data === undefined ? "initial-load" : "query-refetch"), causes[0]?.trace),catalogId:value.catalogId,...notificationTraceFields(causes[0]?.trace)};
      value.active = {trace,started:performance.now()}; value.last = trace; value.lastPage=undefined; value.pageIndex=0; value.attempt=0;
      observeEvent({kind:"client_signal",clientSignal:"catalog_query",outcome:"started",traceRole:"query",...trace,causeCount:causes.length,causeOverflow:value.overflow});
      value.overflow=0;
      for (const cause of causes.slice(1)) observeEvent({kind:"client_signal",clientSignal:"catalog_query",outcome:"progress",traceRole:"cause-link",...trace,
        linkedTraceId:cause.trace.traceId,linkedSpanId:cause.trace.spanId,trigger:cause.trace.trigger,...notificationTraceFields(cause.trace)});
    } else if (value.active && query.state.fetchStatus === "idle") {
      const active=value.active; value.active=undefined;
      if(event.action.type === "success") {
        for(const cause of value.pending.splice(0)) observeEvent({kind:"client_signal",clientSignal:"catalog_query",outcome:"progress",traceRole:"cause-link",...active.trace,
          linkedTraceId:cause.trace.traceId,linkedSpanId:cause.trace.spanId,trigger:cause.trace.trigger,...notificationTraceFields(cause.trace)});
      }
      observeEvent({kind:"client_signal",clientSignal:"catalog_query",outcome:query.state.status === "error" ? "failed" : event.action.type === "error" ? "aborted" : "ok",
        traceRole:"query",...active.trace,durationMs:Math.max(0,performance.now()-active.started)});
    }
  });
}
export function noteCatalogCause(client: QueryClient, filters: QueryFilters, trigger: RequestTrace["trigger"], notification?: Partial<RequestTrace>): void {
  observeCatalogQueries(client);
  for (const query of client.getQueryCache().findAll(filters)) {
    if (query.queryKey[0] !== "appserver" || query.queryKey[2] !== "threads" || !isCatalogQuery(query)) continue;
    const value=state(query), trace={...createRequestTrace(caller(query),trigger,trigger === "auto-next-page" ? value.last : undefined),catalogId:value.catalogId,...notificationTraceFields(notification)};
    // Bound diagnosis independently of a hidden/offline Query's lifetime.
    if (value.pending.length < 16) value.pending.push({trace,started:performance.now()}); else value.overflow++;
    observeEvent({kind:"client_signal",clientSignal:"catalog_query",outcome:"progress",traceRole:"trigger",...trace});
  }
}
export function catalogPageTrace(client: QueryClient, key: QueryKey, page: string | null): RequestTrace {
  observeCatalogQueries(client);
  const query=client.getQueryCache().find({queryKey:key,exact:true});
  const value=query ? state(query) : undefined;
  const active=value?.active?.trace;
  const trace=createRequestTrace(caller(query),active?.trigger ?? "unknown",active);
  const pages=(query?.state.data as {pageParams?: (string|null)[]} | undefined)?.pageParams ?? [];
  const existing=pages.indexOf(page);
  const pageIndex=page == null ? 0 : existing >= 0 ? existing : value?.lastPage === undefined ? pages.length : (value?.pageIndex ?? 0)+1;
  if(value) { value.attempt=value.lastPage === page ? value.attempt+1 : 1; value.lastPage=page; value.pageIndex=pageIndex; }
  return {...trace,...notificationTraceFields(active),...(value ? {catalogId:value.catalogId} : {}),pageIndex,attempt:value?.attempt ?? 1};
}
