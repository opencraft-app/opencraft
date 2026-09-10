export interface HostCatalogObservableRuntime {
  getSnapshot(): { readonly phase: string };
  subscribe(listener: () => void): () => void;
}

export interface HostCatalogRuntimeRegistry {
  peekRuntime(hostId: string): HostCatalogObservableRuntime | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Bridges the Host lifecycle into catalog revalidation.
 *
 * A catalog request may exhaust its own retry budget while its physical Host
 * keeps reconnecting. The Host becoming ready is a new authority epoch, not a
 * user action, so it must make failed catalog projections eligible to reload.
 */
export function subscribeHostCatalogReadiness(
  registry: HostCatalogRuntimeRegistry,
  hostIds: readonly string[],
  onReady: (hostId: string) => void,
): () => void {
  const observed = new Map<string, {
    readonly runtime: HostCatalogObservableRuntime;
    phase: string;
    unsubscribe: () => void;
  }>();
  const expected = new Set(hostIds);

  const bind = () => {
    for (const [hostId, record] of observed) {
      const runtime = expected.has(hostId) ? registry.peekRuntime(hostId) : null;
      if (runtime === record.runtime) continue;
      record.unsubscribe();
      observed.delete(hostId);
    }

    for (const hostId of expected) {
      if (observed.has(hostId)) continue;
      const runtime = registry.peekRuntime(hostId);
      if (runtime === null) continue;
      const record: {
        readonly runtime: HostCatalogObservableRuntime;
        phase: string;
        unsubscribe: () => void;
      } = {
        runtime,
        phase: runtime.getSnapshot().phase,
        unsubscribe: () => undefined,
      };
      record.unsubscribe = runtime.subscribe(() => {
        const phase = runtime.getSnapshot().phase;
        if (phase === "ready" && record.phase !== "ready") onReady(hostId);
        record.phase = phase;
      });
      observed.set(hostId, record);
    }
  };

  const unsubscribeRegistry = registry.subscribe(bind);
  bind();
  return () => {
    unsubscribeRegistry();
    for (const record of observed.values()) record.unsubscribe();
    observed.clear();
  };
}
