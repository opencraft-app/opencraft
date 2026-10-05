const catalogChanges = new Set(["thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed", "turn/started", "turn/completed"]);
export function changesThreadCatalog(method: string): boolean { return catalogChanges.has(method); }

/** A missing source is not an empty per-Host catalog. Quiet status polling of
 * an already-known source must not flash a loading row every five seconds. */
export function managedCatalogDiscoveryPhase(source: {
  readonly available: boolean | null;
  readonly refreshing: boolean;
  readonly error: string | null;
} | null): "loading" | "error" | null {
  if (!source || source.available === false) return null;
  if (source.error !== null) return source.refreshing ? "loading" : "error";
  return source.available === null && source.refreshing ? "loading" : null;
}

export interface HostThreadCatalogState {
  readonly hostId: string;
  readonly label: string;
  readonly phase: "unavailable" | "loading" | "ready" | "error";
}

/** Disabled queries are pending too; only an admitted reader can be loading. */
export function threadCatalogPhase(query: {
  readonly admitted: boolean;
  readonly status: "pending" | "error" | "success";
  readonly isFetching: boolean;
}): HostThreadCatalogState["phase"] {
  if (!query.admitted) return "unavailable";
  if (query.isFetching || query.status === "pending") return "loading";
  return query.status === "error" ? "error" : "ready";
}

export function sidebarThreadCatalogQueryKey(hostId: string, scope: {
  readonly revision: number;
  readonly authorizationEpoch: number | null;
}) {
  // A valid late-read fence alone cannot protect previously cached data from
  // being reused after logout/unlock or a recipe revision change.
  return ["appserver", hostId, "threads", "sidebar", "updated_at", "desc", false, scope.revision, scope.authorizationEpoch] as const;
}
