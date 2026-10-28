export const MAX_FILE_PREVIEW_BYTES = 25 * 1024 * 1024;
export type PreviewErrorCode = "too-large" | "encrypted" | "invalid" | "timeout" | "busy";
export class FilePreviewError extends Error {
  constructor(readonly code: PreviewErrorCode) { super({ "too-large": "File exceeds preview limit", encrypted: "Password-protected document", invalid: "Invalid document", timeout: "Preview opening timed out", busy: "Preview capacity is in use" }[code]); this.name = "FilePreviewError"; }
}

export interface PreviewDocument {
  dispose(): void;
  subscribeFailure?(listener: (error: unknown) => void): () => void;
}
export interface PreviewIdentity {
  readonly ownerId: string;
  readonly tabId: string;
  readonly resource: string;
  readonly revision: string;
  readonly adapter: string;
}
export type PreviewSnapshot<T> =
  | { readonly phase: "opening" }
  | { readonly phase: "ready"; readonly document: T }
  | { readonly phase: "failed"; readonly error: unknown }
  | { readonly phase: "released" };
interface Entry<T> {
  identity: PreviewIdentity;
  key: string;
  bytes: number;
  consumers: number;
  accessed: number;
  controller: AbortController;
  snapshot: PreviewSnapshot<T>;
  listeners: Set<() => void>;
  timeout?: ReturnType<typeof setTimeout>;
  unsubscribeFailure?: () => void;
}
export interface PreviewLease<T> {
  getSnapshot(): PreviewSnapshot<T>;
  subscribe(listener: () => void): () => void;
  release(): void;
}
export const previewKey = (id: PreviewIdentity): string => JSON.stringify([
  id.ownerId, id.tabId, id.resource, id.revision, id.adapter,
]);

/** Presentation-neutral ownership. Idle retention never grants late work authority. */
export class PreviewSessionPool<T extends PreviewDocument> {
  private entries = new Map<string, Entry<T>>();
  private clock = 0;
  private closed = false;
  constructor(private readonly capacity = 3, private readonly sourceBudget = 64 * 1024 * 1024, private readonly openTimeoutMs = 45_000) {
    if (!Number.isInteger(capacity) || capacity < 1 || !Number.isFinite(sourceBudget) || sourceBudget < 1) throw new Error("Invalid preview limits");
  }

  acquire(identity: PreviewIdentity, bytes: number, open: (signal: AbortSignal) => Promise<T>): PreviewLease<T> {
    if (this.closed) throw new Error("Preview owner was released");
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.sourceBudget) throw new Error("Preview exceeds resource limit");
    const key = previewKey(identity);
    let entry = this.entries.get(key);
    if (!entry) {
      // A tab's old content is no longer the current viewer. Other tabs keep
      // their own mutable viewers, even when they share the same source bytes.
      this.releaseWhere(e => e.identity.ownerId === identity.ownerId && e.identity.tabId === identity.tabId && e.identity.resource === identity.resource);
      this.makeRoom(bytes);
      entry = { identity, key, bytes, consumers: 0, accessed: ++this.clock,
        controller: new AbortController(), snapshot: { phase: "opening" }, listeners: new Set() };
      this.entries.set(key, entry);
      const owned = entry;
      owned.timeout = setTimeout(() => {
        if (this.entries.get(key) !== owned || owned.snapshot.phase !== "opening") return;
        owned.snapshot = { phase: "failed", error: new FilePreviewError("timeout") };
        owned.controller.abort();
        this.emit(owned);
      }, this.openTimeoutMs);
      void Promise.resolve().then(() => {
        owned.controller.signal.throwIfAborted();
        return open(owned.controller.signal);
      }).then(viewer => {
        clearTimeout(owned.timeout);
        if (this.entries.get(key) !== owned || owned.controller.signal.aborted) { viewer.dispose(); return; }
        owned.snapshot = { phase: "ready", document: viewer };
        const unsubscribe = viewer.subscribeFailure?.(error => {
          if (this.entries.get(key) !== owned || owned.snapshot.phase !== "ready") return;
          owned.snapshot = { phase: "failed", error };
          owned.unsubscribeFailure?.();
          owned.unsubscribeFailure = undefined;
          try { viewer.dispose(); } finally { this.emit(owned); }
        });
        // A subscription may synchronously report a previously observed failure.
        if (owned.snapshot.phase === "ready") owned.unsubscribeFailure = unsubscribe;
        else unsubscribe?.();
        this.emit(owned);
      }, error => {
        clearTimeout(owned.timeout);
        if (this.entries.get(key) !== owned || owned.controller.signal.aborted) return;
        owned.snapshot = { phase: "failed", error };
        this.emit(owned);
      });
    }
    const owned = entry;
    owned.consumers++;
    owned.accessed = ++this.clock;
    let released = false;
    return {
      getSnapshot: () => owned.snapshot,
      subscribe: listener => { owned.listeners.add(listener); return () => owned.listeners.delete(listener); },
      release: () => {
        if (released) return;
        released = true;
        owned.consumers--;
        owned.accessed = ++this.clock;
        // Do not retain abandoned computations or failed attempts. A completed
        // idle viewer may survive a route/DOM detach until LRU eviction.
        if (owned.consumers === 0 && owned.snapshot.phase !== "ready") this.remove(owned);
      },
    };
  }

  releaseTab(ownerId: string, tabId: string): void {
    this.releaseWhere(e => e.identity.ownerId === ownerId && e.identity.tabId === tabId);
  }
  releaseAdapter(adapter: string): void { this.releaseWhere(e => e.identity.adapter === adapter); }
  dispose(): void { this.closed = true; this.releaseWhere(() => true); }
  get size(): number { return this.entries.size; }

  private makeRoom(bytes: number): void {
    const total = () => [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size >= this.capacity || total() + bytes > this.sourceBudget) {
      const victim = [...this.entries.values()].filter(e => e.consumers === 0).sort((a, b) => a.accessed - b.accessed)[0];
      if (!victim) throw new FilePreviewError("busy");
      this.remove(victim);
    }
  }
  private releaseWhere(predicate: (entry: Entry<T>) => boolean): void {
    for (const entry of this.entries.values()) if (predicate(entry)) this.remove(entry);
  }
  private remove(entry: Entry<T>): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    clearTimeout(entry.timeout);
    entry.unsubscribeFailure?.();
    entry.unsubscribeFailure = undefined;
    entry.controller.abort();
    const viewer = entry.snapshot.phase === "ready" ? entry.snapshot.document : null;
    entry.snapshot = { phase: "released" };
    try { viewer?.dispose(); } finally { this.emit(entry); entry.listeners.clear(); }
  }
  private emit(entry: Entry<T>): void { for (const listener of entry.listeners) listener(); }
}
