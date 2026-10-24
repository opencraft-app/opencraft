const catalogChanges = new Set(["opencraft/thread-catalog/changed", "thread/started", "thread/name/updated", "thread/archived", "thread/unarchived", "thread/closed", "thread/deleted", "thread/pins/updated", "thread/status/changed", "turn/started", "turn/completed"]);
export function changesThreadCatalog(method: string): boolean { return catalogChanges.has(method); }

/** The first page backfills native pins outside the recent window. Later
 * recent pages may contain those same IDs; retain the authoritative first row. */
export function mergeThreadCatalogPages<T extends { readonly id: string }>(pages: readonly { readonly data: readonly T[] }[]): T[] {
  const seen = new Set<string>();
  return pages.flatMap(page => page.data.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }));
}

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
  readonly cachedAt?: number;
  /** Successful metadata pages exist, but the directory has a continuation cursor. */
  readonly partial?: boolean;
}

/** Optional Hub projection metadata; legacy/native Servers omit it. */
export function catalogCachedAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("catalog" in value)) return undefined;
  const metadata = value.catalog;
  if (!metadata || typeof metadata !== "object" || !("state" in metadata) || metadata.state !== "error"
    || !("lastSuccessAt" in metadata) || typeof metadata.lastSuccessAt !== "number" || !Number.isFinite(metadata.lastSuccessAt)
    || metadata.lastSuccessAt < 0) return undefined;
  return metadata.lastSuccessAt;
}

/** Disabled queries are pending too; only an admitted reader can be loading. */
export function threadCatalogPhase(query: {
  readonly admitted: boolean;
  readonly status: "pending" | "error" | "success";
  readonly isFetching: boolean;
  readonly partial?: boolean;
}): HostThreadCatalogState["phase"] {
  if (!query.admitted) return "unavailable";
  if (query.isFetching || query.status === "pending" || (query.partial && query.status !== "error")) return "loading";
  return query.status === "error" ? "error" : "ready";
}

export function sidebarThreadCatalogQueryKey(hostId: string, scope: {
  readonly revision: number;
  readonly authorizationEpoch: number | null;
}) {
  // A valid late-read fence alone cannot protect previously cached data from
  // being reused after logout/unlock or a recipe revision change.
  return ["appserver", hostId, "threads", "sidebar-pages", "updated_at", "desc", false, scope.revision, scope.authorizationEpoch] as const;
}
