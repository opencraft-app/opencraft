import { blobResourceKey, type BlobResource } from "./types";

export interface ResourceSnapshot<T> {
  readonly status: "loading" | "ready" | "unavailable";
  readonly value: T | null;
  readonly isFetching: boolean;
  readonly error: unknown | null;
}
export interface PreparedResource<T> {
  readonly value: T;
  readonly sizeBytes: number;
  readonly expiresAt?: number;
  readonly dispose?: () => void;
}
export interface ResourceStoreOptions {
  readonly maxAgeMs?: number;
  readonly maxEntries?: number;
  readonly memoryBytes?: number;
}
export type ResourcePreparer<T> = (resource: BlobResource, signal: AbortSignal) => Promise<PreparedResource<T> | null>;
const loading = Object.freeze({ status: "loading" as const, value: null, isFetching: false, error: null });
const unavailable = Object.freeze({ status: "unavailable" as const, value: null, isFetching: false, error: null });
interface Entry<T> {
  resource: BlobResource;
  snapshot: ResourceSnapshot<T>;
  listeners: Set<() => void>;
  controller?: AbortController;
  prepared?: PreparedResource<T>;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Application-owned prepared resources. Views subscribe; they do not own cached results. */
export class ResourceStore<T> {
  private entries = new Map<string, Entry<T>>();
  private closed = false;
  private readonly age: number;
  private readonly limit: number;
  private readonly budget: number;
  constructor(private readonly prepare: ResourcePreparer<T>, options: ResourceStoreOptions = {}) {
    this.age = options.maxAgeMs ?? 10_000;
    this.limit = options.maxEntries ?? 256;
    this.budget = options.memoryBytes ?? 64 * 1024 * 1024;
    if (![this.age, this.limit, this.budget].every(value => Number.isFinite(value) && value >= 0)) {
      throw new Error("Resource store limits must be finite and non-negative");
    }
  }
  /** Side-effect-free and referentially stable, including the cold snapshot. */
  getSnapshot(resource: BlobResource): ResourceSnapshot<T> {
    if (this.closed) return unavailable;
    const entry = this.entries.get(blobResourceKey(resource));
    if (!entry || (entry.listeners.size === 0 && entry.expiresAt <= Date.now())) return loading;
    return entry.snapshot;
  }
  subscribe(resource: BlobResource, listener: () => void): () => void {
    if (this.closed) return () => {};
    const key = blobResourceKey(resource);
    let entry = this.entries.get(key);
    if (entry && entry.listeners.size === 0 && entry.expiresAt <= Date.now()) {
      this.remove(key, entry); entry = undefined;
    }
    if (!entry) {
      entry = { resource, snapshot: loading, listeners: new Set(), expiresAt: Infinity };
      this.entries.set(key, entry);
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    // Each subscription has its own identity, even when callback functions coincide.
    const notify = () => listener();
    entry.listeners.add(notify);
    this.entries.delete(key); this.entries.set(key, entry);
    if (entry.snapshot.status === "loading" && !entry.controller) this.start(key, entry);
    const owned = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true; owned.listeners.delete(notify);
      if (owned.listeners.size || this.entries.get(key) !== owned) return;
      if (owned.snapshot.status !== "ready" || owned.expiresAt <= Date.now()) {
        this.remove(key, owned);
      } else {
        // Stop unobserved refresh IO while retaining the last successful result.
        owned.controller?.abort(); owned.controller = undefined;
        if (owned.snapshot.isFetching) owned.snapshot = { ...owned.snapshot, isFetching: false };
        owned.timer = setTimeout(() => this.remove(key, owned), Math.min(2_147_483_647, owned.expiresAt - Date.now()));
        (owned.timer as unknown as { unref?: () => void }).unref?.();
        this.prune();
      }
    };
  }
  /** Revalidate active readers without withdrawing their last successful result. */
  refresh(resource: BlobResource): void {
    const key = blobResourceKey(resource), entry = this.entries.get(key);
    if (!entry) return;
    if (!entry.listeners.size) { this.remove(key, entry); return; }
    entry.controller?.abort(); entry.controller = undefined;
    this.start(key, entry);
  }
  invalidate(resource: BlobResource): void {
    const key = blobResourceKey(resource), entry = this.entries.get(key);
    if (!entry) return;
    if (!entry.listeners.size) { this.remove(key, entry); return; }
    this.dispose(entry);
    entry.snapshot = loading;
    this.publish(entry);
    if (this.entries.get(key) === entry && entry.listeners.size) this.start(key, entry);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [key, entry] of this.entries) {
      this.remove(key, entry);
      entry.snapshot = unavailable;
      this.publish(entry);
      entry.listeners.clear();
    }
  }
  private start(key: string, entry: Entry<T>): void {
    const controller = new AbortController(); entry.controller = controller;
    entry.snapshot = { status: entry.prepared ? "ready" : "loading", value: entry.prepared?.value ?? null,
      isFetching: true, error: null };
    this.publish(entry);
    const fail = (error: unknown) => {
      if (entry.controller !== controller || controller.signal.aborted) return;
      entry.controller = undefined;
      entry.snapshot = { status: entry.prepared ? "ready" : "unavailable", value: entry.prepared?.value ?? null,
        isFetching: false, error };
      this.publish(entry);
    };
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.prepare(entry.resource, controller.signal);
    }).then(prepared => {
      if (controller.signal.aborted || this.closed || this.entries.get(key) !== entry || entry.controller !== controller) {
        prepared?.dispose?.(); return;
      }
      if (!prepared) { fail(new Error("Resource unavailable")); return; }
      entry.controller = undefined;
      const previous = entry.prepared;
      entry.prepared = prepared;
      entry.expiresAt = Math.min(Date.now() + this.age, prepared?.expiresAt ?? Infinity);
      entry.snapshot = { status: "ready", value: prepared.value, isFetching: false, error: null };
      this.publish(entry);
      previous?.dispose?.();
      this.prune();
    }, fail);
  }
  private publish(entry: Entry<T>): void {
    for (const notify of entry.listeners) { try { notify(); } catch { /* observer isolation */ } }
  }
  private dispose(entry: Entry<T>): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const controller = entry.controller; entry.controller = undefined;
    controller?.abort();
    const prepared = entry.prepared; entry.prepared = undefined;
    prepared?.dispose?.();
  }
  private remove(key: string, entry: Entry<T>): void {
    if (this.entries.get(key) !== entry) return;
    this.entries.delete(key); this.dispose(entry);
  }
  private prune(): void {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.prepared?.sizeBytes ?? 0;
    for (const [key, entry] of this.entries) {
      if (entry.listeners.size) continue;
      if (entry.expiresAt <= Date.now() || this.entries.size > this.limit || bytes > this.budget) {
        bytes -= entry.prepared?.sizeBytes ?? 0; this.remove(key, entry);
      }
    }
  }
}
