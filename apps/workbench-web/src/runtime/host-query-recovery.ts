import type { QueryClient } from "@tanstack/react-query";

interface HostQueryRuntime {
  getSnapshot(): { readonly phase: string; readonly connectionGeneration: number };
  subscribe(listener: () => void): () => void;
}

/** Application-owned: every Host read cache follows its logical connection,
 * independently of which menus or Thread views happen to be mounted. */
export function bindHostQueryRecovery(runtime: HostQueryRuntime, hostId: string, queries: QueryClient): () => void {
  const filters = { queryKey: ["appserver", hostId] };
  let disposed = false;
  let revision = 0;
  let readyGeneration: number | null = null;
  let wasReady = false;
  const observe = () => {
    const snapshot = runtime.getSnapshot();
    if (snapshot.phase !== "ready") {
      if (wasReady) {
        wasReady = false;
        revision++;
        // Cancel projection publication, not server-side execution.
        void queries.cancelQueries(filters).catch(() => undefined);
      }
      return;
    }
    const alreadyReady = wasReady;
    wasReady = true;
    if (alreadyReady && readyGeneration === snapshot.connectionGeneration) return;
    readyGeneration = snapshot.connectionGeneration;
    const ticket = ++revision;
    void queries.cancelQueries(filters).then(() => {
      if (disposed || ticket !== revision || runtime.getSnapshot().phase !== "ready") return;
      // Active readers refetch; inactive caches stay visible but stale.
      return queries.invalidateQueries(filters);
    }).catch(() => undefined);
  };
  const unsubscribe = runtime.subscribe(observe);
  observe();
  return () => { disposed = true; revision++; unsubscribe(); };
}
