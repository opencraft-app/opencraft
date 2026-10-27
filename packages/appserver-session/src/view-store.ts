import { Context, Service } from "@deepseek-ai/cordis";
import type { AppServerThread } from "@opencraft/appserver-protocol";

import {
  createEmptyThreadView,
  type ThreadPendingInteraction,
  type ThreadView,
  type ThreadViewStoreSnapshot,
} from "./models";

declare module "@deepseek-ai/cordis" {
  interface Context {
    threadViews: ThreadViewStoreService;
  }
}

export interface ThreadViewStoreConfig {
  hostId: string;
  connectionGeneration?: () => number;
  frameScheduler?: ThreadViewFrameScheduler;
}

/** Platform adapter owns frame/timer scheduling; callbacks must be asynchronous. */
export interface ThreadViewFrameScheduler {
  schedule(flush: () => void): () => void;
}

type ViewUpdater = (current: ThreadView) => Omit<ThreadView, "revision">;
interface PendingProjection {
  readonly generation: number;
  readonly project: ViewUpdater;
  readonly bytes: number;
}

export class ThreadViewStoreService extends Service {
  private readonly hostId: string;
  private readonly views = new Map<string, ThreadView>();
  private readonly listeners = new Set<() => void>();
  private readonly threadListeners = new Map<string, Set<() => void>>();
  private snapshot: ThreadViewStoreSnapshot = { revision: 0, threadIds: [] };
  private readonly pending = new Map<string, PendingProjection[]>();
  private pendingBytes = 0;
  private pendingCount = 0;
  private cancelFlush: (() => void) | null = null;
  private readonly frameScheduler: ThreadViewFrameScheduler;
  private readonly connectionGeneration: (() => number) | undefined;
  private disposed = false;
  private scheduleGeneration = 0;

  constructor(ctx: Context, config: ThreadViewStoreConfig) {
    super(ctx, "threadViews");
    this.hostId = config.hostId;
    this.connectionGeneration = config.connectionGeneration;
    this.frameScheduler = config.frameScheduler ?? {
      schedule: (flush) => {
        const timer = setTimeout(flush, 16);
        return () => clearTimeout(timer);
      },
    };
    ctx.effect(() => () => {
      this.disposed = true;
      this.cancelFlush?.();
      this.cancelFlush = null;
      this.pending.clear();
    });
  }

  getSnapshot = (): ThreadViewStoreSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeThread(threadId: string, listener: () => void): () => void {
    const listeners = this.threadListeners.get(threadId) ?? new Set<() => void>();
    listeners.add(listener);
    this.threadListeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.threadListeners.delete(threadId);
    };
  }

  get(threadId: string): ThreadView | null {
    this.flush(threadId);
    return this.views.get(threadId) ?? null;
  }

  has(threadId: string): boolean {
    return this.views.has(threadId);
  }

  /** Preserve original event order/count while publishing only once per batch. */
  queueProjection(threadId: string, generation: number, project: ViewUpdater, bytes: number): void {
    if (this.disposed || !this.has(threadId)) return;
    const entries = this.pending.get(threadId) ?? [];
    entries.push({ generation, project, bytes });
    this.pending.set(threadId, entries);
    this.pendingBytes += bytes;
    this.pendingCount += 1;
    if (this.pendingBytes >= 512 * 1_024 || this.pendingCount >= 2_048) {
      this.flush();
    } else if (this.cancelFlush === null) {
      const generation = ++this.scheduleGeneration;
      this.cancelFlush = this.frameScheduler.schedule(() => {
        if (this.disposed || generation !== this.scheduleGeneration) return;
        this.cancelFlush = null;
        this.flush();
      });
    }
  }

  flush(threadId?: string): void {
    if (this.disposed) return;
    for (const id of threadId === undefined ? [...this.pending.keys()] : [threadId]) {
      if (this.pending.has(id)) this.update(id, (view) => view);
    }
  }

  getOrCreate(threadId: string): ThreadView {
    this.flush(threadId);
    const existing = this.views.get(threadId);
    if (existing !== undefined) return existing;
    const created = createEmptyThreadView(this.hostId, threadId);
    this.views.set(threadId, created);
    this.publish(threadId);
    return created;
  }

  getAll(): readonly ThreadView[] {
    this.flush();
    return [...this.views.values()];
  }

  /**
   * Seeds catalog metadata without claiming that history has been restored.
   * Resume remains the only authority allowed to publish Turns or execution
   * readiness. Once a View has authoritative Thread metadata, catalog refreshes
   * must not overwrite its newer projection.
   */
  seedMetadata(thread: AppServerThread): ThreadView {
    if (thread.id.trim().length === 0 || !Array.isArray(thread.turns)) {
      throw new TypeError("Thread catalog returned invalid metadata");
    }
    const existing = this.get(thread.id);
    if (existing !== null && existing.historySource !== null) return existing;
    return this.update(thread.id, (current) => ({
      ...current,
      thread: { ...thread, turns: [] },
      historyMode: thread.historyMode ?? current.historyMode,
    }));
  }

  upsertPendingInteraction(interaction: ThreadPendingInteraction): ThreadView {
    return this.update(interaction.threadId, (current) => ({
      ...current,
      pendingInteractions: [
        ...current.pendingInteractions.filter((candidate) => candidate.requestId !== interaction.requestId),
        interaction,
      ],
    }));
  }

  removePendingInteraction(threadId: string, requestId: string): ThreadView | null {
    const current = this.get(threadId);
    if (current === null || !current.pendingInteractions.some((candidate) => candidate.requestId === requestId)) {
      return current;
    }
    return this.update(threadId, (view) => ({
      ...view,
      pendingInteractions: view.pendingInteractions.filter((candidate) => candidate.requestId !== requestId),
    }));
  }

  update(threadId: string, updater: ViewUpdater): ThreadView {
    const entries = this.pending.get(threadId) ?? [];
    this.pending.delete(threadId);
    this.pendingCount -= entries.length;
    this.pendingBytes -= entries.reduce((bytes, entry) => bytes + entry.bytes, 0);
    if (this.pending.size === 0) {
      this.scheduleGeneration += 1;
      this.cancelFlush?.();
      this.cancelFlush = null;
      this.pendingBytes = 0;
      this.pendingCount = 0;
    }
    const current = this.views.get(threadId) ?? this.getOrCreate(threadId);
    const projected = entries.reduce<ThreadView>((view, entry) => {
      if (this.connectionGeneration !== undefined && entry.generation !== this.connectionGeneration()) return view;
      return { ...entry.project(view), revision: view.revision };
    }, current);
    const next: ThreadView = { ...updater(projected), revision: current.revision + 1 };
    if (next.hostId !== this.hostId || next.threadId !== threadId) {
      throw new Error("Thread View identity cannot change during an update");
    }
    this.views.set(threadId, next);
    this.publish(threadId);
    return next;
  }

  remove(threadId: string): boolean {
    const entries = this.pending.get(threadId) ?? [];
    this.pendingCount -= entries.length;
    this.pendingBytes -= entries.reduce((bytes, entry) => bytes + entry.bytes, 0);
    this.pending.delete(threadId);
    if (this.pending.size === 0) {
      this.scheduleGeneration += 1;
      this.cancelFlush?.();
      this.cancelFlush = null;
    }
    if (!this.views.delete(threadId)) return false;
    this.publish(threadId);
    return true;
  }

  private publish(threadId: string): void {
    this.snapshot = {
      revision: this.snapshot.revision + 1,
      threadIds: [...this.views.keys()],
    };
    for (const listener of this.listeners) listener();
    for (const listener of this.threadListeners.get(threadId) ?? []) listener();
  }
}
