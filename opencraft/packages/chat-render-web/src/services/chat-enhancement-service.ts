import { Context, Service } from "@deepseek-ai/cordis";

export type ChatEnhancementLane = "diagram" | "highlight";

export interface ChatEnhancementTask<T> {
  readonly cacheKey?: string;
  readonly lane: ChatEnhancementLane;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly signal?: AbortSignal;
}

interface QueuedTask<T> {
  readonly cacheKey?: string;
  readonly controller: AbortController;
  readonly lane: ChatEnhancementLane;
  readonly run: (signal: AbortSignal) => Promise<T>;
  readonly reject: (reason: unknown) => void;
  readonly resolve: (value: T) => void;
  removeAbortListener(): void;
}

interface InFlightTask<T> {
  readonly controller: AbortController;
  readonly consumers: Set<symbol>;
  readonly promise: Promise<T>;
  settled: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    chatEnhancements: ChatEnhancementService;
  }
}

function abortError(): DOMException {
  return new DOMException("Chat enhancement request was aborted", "AbortError");
}

/**
 * Application-runtime owner for expensive, optional ChatUI work.
 *
 * It owns visibility observation, concurrency budgets, in-flight de-duplication
 * and the bounded immutable-result cache. Renderers only hold cancellable
 * leases and never create competing schedulers or caches.
 */
export class ChatEnhancementService extends Service {
  private readonly active = new Map<ChatEnhancementLane, number>([
    ["diagram", 0],
    ["highlight", 0],
  ]);
  private readonly limits = new Map<ChatEnhancementLane, number>([
    // Mermaid mutates global configuration and must remain serialized.
    ["diagram", 1],
    ["highlight", 4],
  ]);
  private readonly queues = new Map<ChatEnhancementLane, QueuedTask<unknown>[]>([
    ["diagram", []],
    ["highlight", []],
  ]);
  private readonly resultCache = new Map<string, unknown>();
  private readonly inFlight = new Map<string, InFlightTask<unknown>>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly visibilityCallbacks = new Map<Element, () => void>();
  private visibilityObserver: IntersectionObserver | null = null;
  private disposed = false;

  constructor(ctx: Context) {
    super(ctx, "chatEnhancements");
    ctx.effect(() => () => this.disposeResources());
  }

  observeNearViewport(element: Element, grant: () => void): () => void {
    if (this.disposed) return () => undefined;
    if (typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(grant, 0);
      return () => window.clearTimeout(timer);
    }
    this.visibilityCallbacks.set(element, grant);
    this.ensureVisibilityObserver().observe(element);
    return () => {
      if (this.visibilityCallbacks.get(element) !== grant) return;
      this.visibilityCallbacks.delete(element);
      this.visibilityObserver?.unobserve(element);
    };
  }

  run<T>(task: ChatEnhancementTask<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("Chat enhancement service is disposed"));
    if (task.signal?.aborted === true) return Promise.reject(abortError());
    if (task.cacheKey !== undefined) {
      if (this.resultCache.has(task.cacheKey)) {
        return Promise.resolve(this.resultCache.get(task.cacheKey) as T);
      }
      const pending = this.inFlight.get(task.cacheKey);
      if (pending !== undefined) {
        return this.consume(pending as InFlightTask<T>, task.signal);
      }
    }
    const controller = new AbortController();
    const promise = this.schedule(task, controller);
    if (task.cacheKey !== undefined) {
      const record: InFlightTask<T> = {
        controller,
        consumers: new Set(),
        promise,
        settled: false,
      };
      this.inFlight.set(task.cacheKey, record as InFlightTask<unknown>);
      void promise.then(
        (value) => {
          this.inFlight.delete(task.cacheKey!);
          if (this.disposed) return;
          this.resultCache.set(task.cacheKey!, value);
          while (this.resultCache.size > 100) {
            this.resultCache.delete(this.resultCache.keys().next().value!);
          }
        },
        () => this.inFlight.delete(task.cacheKey!),
      ).finally(() => {
        record.settled = true;
      });
      return this.consume(record, task.signal);
    }
    if (task.signal !== undefined) {
      const abort = () => controller.abort(task.signal?.reason);
      task.signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        () => task.signal?.removeEventListener("abort", abort),
        () => task.signal?.removeEventListener("abort", abort),
      );
    }
    return promise;
  }

  private schedule<T>(task: ChatEnhancementTask<T>, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(task.lane)!;
      const queued: QueuedTask<T> = {
        cacheKey: task.cacheKey,
        controller,
        lane: task.lane,
        run: task.run,
        resolve,
        reject,
        removeAbortListener: () => controller.signal.removeEventListener("abort", abortQueued),
      };
      const abortQueued = () => {
        const index = queue.indexOf(queued as QueuedTask<unknown>);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(abortError());
      };
      controller.signal.addEventListener("abort", abortQueued, { once: true });
      queue.push(queued as QueuedTask<unknown>);
      this.drain(task.lane);
    });
  }

  private consume<T>(record: InFlightTask<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted === true) return Promise.reject(abortError());
    const consumer = Symbol("chat-enhancement-consumer");
    record.consumers.add(consumer);
    return new Promise<T>((resolve, reject) => {
      let complete = false;
      const release = () => {
        if (complete) return;
        complete = true;
        signal?.removeEventListener("abort", abort);
        record.consumers.delete(consumer);
      };
      const abort = () => {
        release();
        if (!record.settled && record.consumers.size === 0) {
          record.controller.abort(signal?.reason);
        }
        reject(abortError());
      };
      signal?.addEventListener("abort", abort, { once: true });
      void record.promise.then(
        (value) => {
          if (complete) return;
          release();
          resolve(value);
        },
        (error) => {
          if (complete) return;
          release();
          reject(error);
        },
      );
    });
  }

  private drain(lane: ChatEnhancementLane): void {
    const queue = this.queues.get(lane)!;
    const limit = this.limits.get(lane)!;
    while (!this.disposed && (this.active.get(lane) ?? 0) < limit && queue.length > 0) {
      const task = queue.shift()!;
      task.removeAbortListener();
      if (task.controller.signal.aborted) {
        task.reject(abortError());
        continue;
      }
      this.active.set(lane, (this.active.get(lane) ?? 0) + 1);
      this.activeControllers.add(task.controller);
      void task.run(task.controller.signal).then(task.resolve, task.reject).finally(() => {
        this.activeControllers.delete(task.controller);
        this.active.set(lane, Math.max(0, (this.active.get(lane) ?? 1) - 1));
        this.drain(lane);
      });
    }
  }

  private ensureVisibilityObserver(): IntersectionObserver {
    if (this.visibilityObserver !== null) return this.visibilityObserver;
    this.visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const grant = this.visibilityCallbacks.get(entry.target);
        if (grant === undefined) continue;
        this.visibilityCallbacks.delete(entry.target);
        this.visibilityObserver?.unobserve(entry.target);
        grant();
      }
    }, { rootMargin: "600px 0px" });
    return this.visibilityObserver;
  }

  private disposeResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = null;
    this.visibilityCallbacks.clear();
    this.resultCache.clear();
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
    for (const queue of this.queues.values()) {
      for (const task of queue.splice(0)) {
        task.removeAbortListener();
        task.controller.abort();
        task.reject(new Error("Chat enhancement service was disposed"));
      }
    }
  }
}
