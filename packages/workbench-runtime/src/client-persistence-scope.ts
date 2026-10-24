/**
 * Client-local cache partition supplied by the application composition owner.
 * It is neither a verified Actor nor permission to read or submit remote data.
 * A namespace survives application teardown/reopen; an actual credential or
 * account boundary change replaces it and notifies subscribers synchronously.
 */
export interface ClientPersistenceScopeSnapshot {
  readonly namespace: string;
  /** Product-defined partition for a fixed Host's remembered conversation. */
  readonly threadMemoryScope: string;
}

/** Borrowed read-only port; the supplying application owns its lifetime. */
export interface ClientPersistenceScope {
  getSnapshot(): ClientPersistenceScopeSnapshot;
  subscribe(listener: () => void): () => void;
}
