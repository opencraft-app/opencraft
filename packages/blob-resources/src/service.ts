import { Service, type Context } from "@deepseek-ai/cordis";
import { blobResourceKey, type BlobResource, type BlobResourceLoader, type BlobCacheStorage,
  type BlobCacheEntry, type BlobLease, type BlobAcquireOptions, type BlobProgress } from "./types";

interface Job {
  key: string; resource: BlobResource; loader: BlobResourceLoader; options: BlobAcquireOptions;
  controller: AbortController; priority: number; order: number; refs: number;
  started: boolean; settled: boolean; state: BlobProgress; listeners: Set<() => void>;
  promise: Promise<Blob>; resolve(blob: Blob): void; reject(error: unknown): void;
}
export interface BlobResourceConfig {
  concurrency?: number;
  memoryBytes?: number;
  memoryEntries?: number;
  storage?: BlobCacheStorage;
}
const cancelled = () => new DOMException("Blob request released", "AbortError");

/** App-scoped IO scheduler and disposable content cache, never a file authority. */
export class BlobResourceService extends Service {
  private jobs = new Map<string, Job>();
  private memory = new Map<string, BlobCacheEntry>();
  private usedBytes = 0;
  private running = 0;
  private sequence = 0;
  private closed = false;
  private concurrency: number;
  private budget: number;
  private maxEntries: number;
  private storage?: BlobCacheStorage;

  constructor(ctx: Context, config: BlobResourceConfig = {}) {
    super(ctx, "blobResources");
    if ([config.concurrency, config.memoryBytes, config.memoryEntries].some(value => value !== undefined && (!Number.isFinite(value) || value < 0))) {
      throw new Error("Blob resource limits must be finite non-negative numbers");
    }
    this.concurrency = Math.max(1, Math.floor(config.concurrency ?? 3));
    this.budget = Math.max(0, config.memoryBytes ?? 64 * 1024 * 1024);
    this.maxEntries = Math.max(1, Math.floor(config.memoryEntries ?? 256));
    this.storage = config.storage;
    ctx.effect(() => () => this.close());
  }

  acquire(resource: BlobResource, loader: BlobResourceLoader, options: BlobAcquireOptions = {}): BlobLease {
    if (this.closed) throw new Error("Blob resources disposed");
    options.signal?.throwIfAborted();
    const key = blobResourceKey(resource);
    let job = this.jobs.get(key);
    if (!job) {
      let resolve!: (blob: Blob) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<Blob>((yes, no) => { resolve = yes; reject = no; });
      void promise.catch(() => {});
      job = { key, resource, loader, options, controller: new AbortController(), priority: options.priority ?? 0,
        order: ++this.sequence, refs: 0, started: false, settled: false, state: { phase: "queued" },
        listeners: new Set(), promise, resolve, reject };
      this.jobs.set(key, job);
      const cached = this.memory.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        this.remember({ ...cached, accessedAt: Date.now() });
        job.settled = true;
        job.state = { phase: "ready", receivedBytes: cached.blob.size, totalBytes: cached.blob.size };
        job.resolve(cached.blob);
        this.jobs.delete(key);
      }
    }
    const shared = job;
    shared.priority = Math.max(shared.priority, options.priority ?? 0);
    shared.refs++;
    let released = false;
    let rejectLease!: (error: unknown) => void;
    const promise = new Promise<Blob>((resolve, reject) => {
      rejectLease = reject;
      shared.promise.then(value => { if (!released) resolve(value); }, error => { if (!released) reject(error); });
    });
    void promise.catch(() => {});
    const ownedListeners = new Set<() => void>();
    const release = () => {
      if (released) return;
      released = true;
      options.signal?.removeEventListener("abort", release);
      for (const listener of ownedListeners) shared.listeners.delete(listener);
      ownedListeners.clear();
      rejectLease(cancelled());
      if (--shared.refs === 0 && !shared.settled) {
        shared.controller.abort();
        shared.reject(cancelled());
        if (this.jobs.get(key) === shared) this.jobs.delete(key);
      }
      this.pump();
    };
    options.signal?.addEventListener("abort", release, { once: true });
    queueMicrotask(() => this.pump());
    return { promise, release, getProgress: () => shared.state,
      subscribe: listener => { if (released) return () => {};
        ownedListeners.add(listener); shared.listeners.add(listener);
        return () => { ownedListeners.delete(listener); shared.listeners.delete(listener); }; } };
  }

  async invalidate(resource: BlobResource): Promise<void> {
    const key = blobResourceKey(resource);
    const job = this.jobs.get(key);
    if (job) { job.controller.abort(); job.reject(cancelled()); this.jobs.delete(key); }
    this.removeMemory(key);
    try { await this.storage?.delete(key); } catch { /* disposable cache */ }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.jobs.values()) { job.controller.abort(); job.reject(cancelled()); }
    this.jobs.clear(); this.memory.clear(); this.usedBytes = 0; this.storage?.close();
  }

  private pump(): void {
    if (this.closed) return;
    const queued = [...this.jobs.values()].filter(job => !job.started && job.refs > 0)
      .sort((a, b) => b.priority - a.priority || a.order - b.order);
    while (this.running < this.concurrency && queued.length) {
      const job = queued.shift()!;
      job.started = true; this.running++;
      void this.run(job).finally(() => { this.running--; this.pump(); });
    }
  }

  private publish(job: Job, state: BlobProgress): void {
    job.state = state;
    for (const listener of job.listeners) { try { listener(); } catch { /* observer isolation */ } }
  }

  private async run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    try {
      this.publish(job, { phase: "cache" });
      let cached = this.memory.get(job.key);
      if (!cached && job.options.persistent) {
        try { cached = await this.storage?.get(job.key); } catch { /* read through */ }
      }
      signal.throwIfAborted();
      if (cached && cached.expiresAt <= Date.now()) { this.removeMemory(job.key); cached = undefined; }
      let blob = cached?.blob;
      if (!blob) {
        this.publish(job, { phase: "loading" });
        blob = await job.loader(job.resource, signal, (receivedBytes, totalBytes) => {
          if (!signal.aborted) this.publish(job, { phase: "loading", receivedBytes, totalBytes });
        });
        signal.throwIfAborted();
      }
      const requestedAge = job.options.maxAgeMs ?? 10_000;
      const maxAge = !Number.isFinite(requestedAge) && !job.resource.version ? 10_000 : requestedAge;
      const entry = { key: job.key, blob, accessedAt: Date.now(),
        expiresAt: cached?.expiresAt ?? Date.now() + Math.max(0, maxAge) };
      this.remember(entry);
      if (job.options.persistent && !cached && blob.size <= this.budget) {
        try { await this.storage?.put(entry); } catch { /* quota/private mode: content is still usable */ }
      }
      signal.throwIfAborted();
      this.publish(job, { phase: "ready", receivedBytes: blob.size, totalBytes: blob.size });
      job.resolve(blob);
    } catch (error) {
      this.publish(job, { phase: "failed" }); job.reject(error);
    } finally {
      job.settled = true;
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    }
  }

  private removeMemory(key: string): void {
    const old = this.memory.get(key);
    if (old) { this.usedBytes -= old.blob.size; this.memory.delete(key); }
  }
  private remember(entry: BlobCacheEntry): void {
    this.removeMemory(entry.key);
    if (entry.blob.size > this.budget || entry.expiresAt <= Date.now()) return;
    this.memory.set(entry.key, entry); this.usedBytes += entry.blob.size;
    while (this.usedBytes > this.budget || this.memory.size > this.maxEntries) this.removeMemory(this.memory.keys().next().value!);
  }
}
declare module "@deepseek-ai/cordis" { interface Context { blobResources: BlobResourceService; } }
