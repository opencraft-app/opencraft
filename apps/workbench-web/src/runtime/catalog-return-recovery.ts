import type { QueryClient } from "@tanstack/react-query";
import { noteCatalogCause } from "./catalog-request-observation";

const owners = new WeakMap<QueryClient, { retain: number; stop(): void }>();

/** Foreground recovery is required even while the ordinary freshness TTL holds.
 * Only mounted/enabled directory readers refetch; idle Hosts are not dialed.
 */
export function startCatalogReturnRecovery(client: QueryClient): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") return () => {};
  let owner = owners.get(client);
  if (!owner) {
    let hidden = document.visibilityState === "hidden", last = -Infinity;
    const recover = () => {
      if (document.visibilityState === "hidden" || performance.now() - last < 500) return;
      last = performance.now();
      const filters = { predicate: (query: { meta?: Record<string, unknown>; queryKey: readonly unknown[] }) =>
        query.meta?.requestCaller === "sidebar-catalog" && query.queryKey[0] === "appserver" && query.queryKey[2] === "threads" };
      noteCatalogCause(client, filters, "query-refetch");
      void client.invalidateQueries({ ...filters, refetchType: "active" }, { cancelRefetch: false });
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") hidden = true;
      else if (hidden) { hidden = false; recover(); }
    };
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) recover(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", recover);
    window.addEventListener("pageshow", pageshow);
    owner = { retain: 0, stop: () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", recover);
      window.removeEventListener("pageshow", pageshow);
    } };
    owners.set(client, owner);
  }
  owner.retain++;
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--owner!.retain === 0) { owner!.stop(); owners.delete(client); }
  };
}
