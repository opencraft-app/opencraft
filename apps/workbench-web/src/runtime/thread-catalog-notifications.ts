import type { AppServerClient } from "@opencraft/appserver-client";
import type { ThreadStatus, ThreadStatusChangedNotification, TurnStartedNotification } from "@opencraft/appserver-protocol/generated/v2";
import type { QueryClient } from "@tanstack/react-query";
import { changesThreadCatalog } from "./thread-catalog-query";
import { parseThreadCatalogChange, THREAD_CATALOG_CHANGED } from "@opencraft/appserver-protocol";
import { receiveThreadCatalogChange } from "./thread-catalog-updates";

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
export function bindThreadCatalogNotifications(client: Pick<AppServerClient, "subscribeNotification">,
  hostId: string, queryClient: QueryClient, isCurrent: () => boolean = () => true): () => void {
  const filter = { queryKey: ["appserver", hostId, "threads"] };
  let disposed = false;
  let pending = Promise.resolve();
  const stop = client.subscribeNotification(notification => {
    if (disposed || !isCurrent()) return;
    if (notification.method === THREAD_CATALOG_CHANGED) {
      const change = parseThreadCatalogChange(notification.params);
      if (change && change.change.type !== "invalidate") {
        receiveThreadCatalogChange(queryClient, hostId, change);
        // Other projections (including archive management) still reconcile.
        void queryClient.invalidateQueries({ ...filter, predicate: query => query.queryKey[3] !== "sidebar-pages" });
        return;
      }
    }
    if (!changesThreadCatalog(notification.method)) return;
    pending = pending.then(async () => {
      if (disposed || !isCurrent()) return;
      await queryClient.cancelQueries(filter);
      if (disposed || !isCurrent()) return;
      if (notification.method === "thread/status/changed") {
        const { threadId, status } = notification.params as ThreadStatusChangedNotification;
        queryClient.setQueriesData<unknown>(filter, (data: unknown) => updateStatus(data, threadId, status));
      } else if (notification.method === "turn/started") {
        const { threadId } = notification.params as TurnStartedNotification;
        queryClient.setQueriesData<unknown>(filter, (data: unknown) => updateStatus(data, threadId, { type: "active", activeFlags: [] }));
      }
      // Do not serialize on network latency; the next event must be able to
      // cancel this read too. Query errors remain owned by the catalog UI.
      void queryClient.invalidateQueries(filter);
    });
  });
  return () => { disposed = true; stop(); };
}
