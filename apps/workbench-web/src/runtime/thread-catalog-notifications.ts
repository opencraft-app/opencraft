import { noteCatalogCause } from "./catalog-request-observation";
import type { AppServerClient } from "@opencraft/appserver-client";
import type { ThreadStatus, ThreadStatusChangedNotification } from "@opencraft/appserver-protocol/generated/v2";
import type { QueryClient } from "@tanstack/react-query";
import { changesThreadCatalog } from "./thread-catalog-query";
import { createNotificationObservation, parseNotificationObservation, type RequestTrace, parseThreadCatalogChange, threadCatalogStatus, THREAD_CATALOG_CHANGED, THREAD_DIRECTORY_UPDATES } from "@opencraft/appserver-protocol";
import { hasThreadCatalogUpdates, receiveThreadCatalogChange, configureThreadCatalogUpdates } from "./thread-catalog-updates";
import { THREAD_DIRECTORY_SNAPSHOTS } from "@opencraft/appserver-protocol";

/** The threads prefix also contains non-page projections (e.g. the archived
 * settings array). Status facts patch catalog pages only; other projections
 * retain their identity and reconcile through the common invalidation below. */
function updateStatus(data: unknown, threadId: string, status: ThreadStatus): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  if ("pages" in data && Array.isArray(data.pages)) {
    return { ...data, pages: data.pages.map(page => updateStatus(page, threadId, status)) };
  }
  if (!("data" in data) || !Array.isArray(data.data)) return data;
  return { ...data, data: data.data.map(row => row && typeof row === "object" && row.id === threadId ? { ...row, status } : row) };
}

/** Live lifecycle facts supersede catalog reads started before the fact.
 * Cancel even an initial fetch: invalidation alone reuses an in-flight first
 * read, which may still describe the Thread as idle. Never create phantom rows. */
export function bindThreadCatalogNotifications(client: Pick<AppServerClient, "subscribeNotification"> & Partial<Pick<AppServerClient, "initializeResult">>,
  hostId: string, queryClient: QueryClient, isCurrent: () => boolean = () => true): () => void {
  const filter = { queryKey: ["appserver", hostId, "threads"] };
  let disposed = false;
  let pending = Promise.resolve();
  const statusSource = `legacy-status:${crypto.randomUUID()}`;
  let statusRevision = 0;
  let windowStarted=performance.now();
  const notificationCounts=new Map<string,number>();
  const stop = client.subscribeNotification(notification => {
    if (disposed || !isCurrent()) return;
    configureThreadCatalogUpdates(queryClient, hostId,
      (client.initializeResult?.capabilities?.extensions?.[THREAD_DIRECTORY_SNAPSHOTS] as { version?: unknown } | undefined)?.version === 1);
    const received=performance.now();
    const parsedStamp=parseNotificationObservation(notification.__opencraftNotification);
    const stamp=(parsedStamp?.notificationMethod === notification.method ? parsedStamp : undefined)
      ?? createNotificationObservation(notification.method,notification.params,"unknown");
    if(received-windowStarted>=5000) {notificationCounts.clear();windowStarted=received;}
    const counterKey=stamp ? JSON.stringify([stamp.notificationMethod,stamp.notificationSource,stamp.notificationChange]) : "";
    if(counterKey && (notificationCounts.has(counterKey) || notificationCounts.size<32)) notificationCounts.set(counterKey,(notificationCounts.get(counterKey) ?? 0)+1);
    const notificationCount=notificationCounts.get(counterKey) ?? 1;
    const cause=(decision:RequestTrace["notificationDecision"]): Partial<RequestTrace> => stamp ? {...stamp,notificationDecision:decision,
      notificationToInvalidateMs:Math.max(0,performance.now()-received),notificationCount} : {};
    if (notification.method === 'opencraft/thread-access/changed') {
      void queryClient.invalidateQueries({queryKey:['thread-access']});
      void queryClient.invalidateQueries({predicate:query => query.queryKey.some(key => typeof key === 'string' && key.includes('tasks'))});
    }
    if (notification.method === 'opencraft/thread-access/revoked') {
      const contains = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(contains);
        if (!value || typeof value !== 'object') return false;
        const row = value as Record<string,unknown>;
        return row.threadId === (notification.params as {threadId:string}).threadId || Object.values(row).some(contains);
      };
      queryClient.removeQueries({predicate:query => contains(query.state.data)});
    }
    if (notification.method === 'opencraft/thread-access/revoked' && (notification.params as {local?:boolean}).local !== false) {
      const threadId = (notification.params as {threadId:string}).threadId;
      // Remove cached title immediately, including catalog facts not yet acknowledged by a read.
      receiveThreadCatalogChange(queryClient,hostId,{version:1,source:`access:${threadId}`,revision:Date.now(),change:{type:'remove',threadId}});
      const remove = (data: any): any => Array.isArray(data) ? data.filter(row => row?.id !== threadId)
        : data && typeof data === 'object' ? {...data,...(Array.isArray(data.pages) ? {pages:data.pages.map(remove)} : {}),...(Array.isArray(data.data) ? {data:data.data.filter((row:any) => row?.id !== threadId)} : {})} : data;
      queryClient.setQueriesData(filter,remove);
      queryClient.removeQueries({queryKey:['thread-access',hostId,threadId]});
    }
    if (notification.method === THREAD_CATALOG_CHANGED) {
      const change = parseThreadCatalogChange(notification.params);
      if (change && change.change.type !== "invalidate") {
        receiveThreadCatalogChange(queryClient, hostId, change);
        // Other projections (including archive management) still reconcile.
        const targets={ ...filter, predicate: (query: {queryKey: readonly unknown[]}) => !hasThreadCatalogUpdates(queryClient, query.queryKey) };
        noteCatalogCause(queryClient,targets,"catalog-notification",cause("refresh-other-projections"));
        void queryClient.invalidateQueries(targets);
        return;
      }
    }
    const incremental = (client.initializeResult?.capabilities?.extensions?.[THREAD_DIRECTORY_UPDATES] as { version?: unknown } | undefined)?.version === 1;
    if (incremental && ["turn/started", "turn/completed"].includes(notification.method)) return;
    if (!changesThreadCatalog(notification.method)) return;
    const params = notification.params as ThreadStatusChangedNotification;
    const status = notification.method === "thread/status/changed" ? threadCatalogStatus(params?.status) : null;
    if (status && typeof params.threadId === "string" && params.threadId) {
      // The raw execution notification may follow its canonical catalog patch,
      // or come from an older Host. Both feed the same paged-reader overlay;
      // neither invalidates every already cached page.
      receiveThreadCatalogChange(queryClient, hostId, { version: 1, source: statusSource,
        revision: ++statusRevision, change: { type: "patch", threadId: params.threadId, status } });
    }
    const refreshFilter = status ? { ...filter, predicate: (query: { queryKey: readonly unknown[] }) => !hasThreadCatalogUpdates(queryClient, query.queryKey) } : filter;
    pending = pending.then(async () => {
      if (disposed || !isCurrent()) return;
      await queryClient.cancelQueries(refreshFilter);
      if (disposed || !isCurrent()) return;
      if (notification.method === "thread/status/changed") {
        const { threadId, status } = notification.params as ThreadStatusChangedNotification;
        queryClient.setQueriesData<unknown>(refreshFilter, (data: unknown) => updateStatus(data, threadId, status));
      }
      // Do not serialize on network latency; the next event must be able to
      // cancel this read too. Query errors remain owned by the catalog UI.
      noteCatalogCause(queryClient,refreshFilter,"catalog-notification",cause("cancel-and-refetch"));
      void queryClient.invalidateQueries(refreshFilter);
    });
  });
  return () => { disposed = true; stop(); };
}
