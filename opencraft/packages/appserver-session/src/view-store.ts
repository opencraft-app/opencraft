import { Context, Service } from "@deepseek-ai/cordis";

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
}

export class ThreadViewStoreService extends Service {
  private readonly hostId: string;
  private readonly views = new Map<string, ThreadView>();
  private readonly listeners = new Set<() => void>();
  private readonly threadListeners = new Map<string, Set<() => void>>();
  private snapshot: ThreadViewStoreSnapshot = { revision: 0, threadIds: [] };

  constructor(ctx: Context, config: ThreadViewStoreConfig) {
    super(ctx, "threadViews");
    this.hostId = config.hostId;
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
    return this.views.get(threadId) ?? null;
  }

  getOrCreate(threadId: string): ThreadView {
    const existing = this.views.get(threadId);
    if (existing !== undefined) return existing;
    const created = createEmptyThreadView(this.hostId, threadId);
    this.views.set(threadId, created);
    this.publish(threadId);
    return created;
  }

  getAll(): readonly ThreadView[] {
    return [...this.views.values()];
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

  update(threadId: string, updater: (current: ThreadView) => Omit<ThreadView, "revision">): ThreadView {
    const current = this.getOrCreate(threadId);
    const next: ThreadView = { ...updater(current), revision: current.revision + 1 };
    if (next.hostId !== this.hostId || next.threadId !== threadId) {
      throw new Error("Thread View identity cannot change during an update");
    }
    this.views.set(threadId, next);
    this.publish(threadId);
    return next;
  }

  remove(threadId: string): boolean {
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
