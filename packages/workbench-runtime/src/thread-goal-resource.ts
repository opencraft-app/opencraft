import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
import type { OpenCraftThreadGoalCapability } from "@opencraft/appserver-protocol";

export interface ThreadGoalSnapshot {
  readonly goal: ThreadGoal | null;
  /** Last observed completion, for review after a confirmed replacement clears it. */
  readonly completedGoal: ThreadGoal | null;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly busy: boolean;
  readonly error: Error | null;
}

export interface ThreadGoalClient {
  get(threadId: string): Promise<{ goal: ThreadGoal | null }>;
  set(threadId: string, change: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }): Promise<{ goal: ThreadGoal }>;
  clear(threadId: string): Promise<{ cleared: boolean }>;
  capability(threadId?: string): OpenCraftThreadGoalCapability | null;
}

const INITIAL: ThreadGoalSnapshot = Object.freeze({ goal: null, completedGoal: null, phase: "idle", busy: false, error: null });

/** Cache is a replaceable Server projection, never a second Goal authority. */
export class ThreadGoalResource {
  private readonly snapshots = new Map<string, ThreadGoalSnapshot>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly catalogListeners = new Set<() => void>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  private readonly writes = new Set<string>();
  private readonly pendingCreates = new Map<string, { objective: string }>();
  private generation = 0;

  constructor(private readonly client: ThreadGoalClient) {}

  capability(threadId?: string): OpenCraftThreadGoalCapability | null { return this.client.capability(threadId); }
  getSnapshot(threadId: string): ThreadGoalSnapshot { return this.snapshots.get(threadId) ?? INITIAL; }

  /** Observe cached metadata without making every catalog row an active View. */
  subscribeCatalog(listener: () => void): () => void {
    this.catalogListeners.add(listener);
    return () => { this.catalogListeners.delete(listener); };
  }

  subscribe(threadId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(threadId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(threadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(threadId);
    };
  }

  private publish(threadId: string, snapshot: ThreadGoalSnapshot): void {
    this.snapshots.set(threadId, Object.freeze(snapshot));
    for (const listener of this.listeners.get(threadId) ?? []) listener();
    for (const listener of this.catalogListeners) listener();
  }

  /** Connection replacement invalidates old reads and rehydrates visible Threads. */
  reset(): void {
    this.generation++;
    this.reads.clear();
    this.pendingCreates.clear();
    this.snapshots.clear();
    for (const threadId of this.listeners.keys()) {
      this.publish(threadId, INITIAL);
      if (this.capability(threadId)?.read) void this.refresh(threadId).catch(() => undefined);
    }
    for (const listener of this.catalogListeners) listener();
  }

  observe(threadId: string, goal: ThreadGoal | null): void {
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    this.publish(threadId, { goal, completedGoal: goal?.status === "complete" ? goal : this.getSnapshot(threadId).completedGoal, phase: "ready", busy: this.writes.has(threadId), error: null });
  }

  async refresh(threadId: string, force = false): Promise<void> {
    if (!threadId || !this.capability(threadId)?.read) return;
    const existing = this.reads.get(threadId);
    if (existing && !force) return existing;
    if (force) this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    const generation = this.generation;
    const revision = this.revisions.get(threadId) ?? 0;
    const previous = this.getSnapshot(threadId);
    this.publish(threadId, { ...previous, phase: previous.phase === "idle" ? "loading" : previous.phase, error: null });
    const operation = this.client.get(threadId).then(({ goal }) => {
      if (this.generation === generation && (this.revisions.get(threadId) ?? 0) === revision) this.observe(threadId, goal);
    }).catch((cause: unknown) => {
      if (this.generation === generation && (this.revisions.get(threadId) ?? 0) === revision) {
        this.publish(threadId, { ...this.getSnapshot(threadId), phase: "error", error: cause instanceof Error ? cause : new Error("Goal could not be loaded") });
      }
      throw cause;
    }).finally(() => {
      if (this.reads.get(threadId) === operation) this.reads.delete(threadId);
    });
    this.reads.set(threadId, operation);
    return operation;
  }

  private async mutate(threadId: string, command: () => Promise<unknown>): Promise<void> {
    if (!this.capability(threadId)?.write) throw new Error("This Host cannot change goals");
    if (this.writes.has(threadId)) throw new Error("A goal change is already in progress");
    const generation = this.generation;
    this.writes.add(threadId);
    this.publish(threadId, { ...this.getSnapshot(threadId), busy: true, error: null });
    try {
      await command();
      if (generation !== this.generation) throw new Error("The Goal connection changed");
      await this.refresh(threadId, true);
    } catch (cause) {
      if (generation === this.generation) this.publish(threadId, { ...this.getSnapshot(threadId), error: cause instanceof Error ? cause : new Error("Goal could not be changed") });
      throw cause;
    } finally {
      this.writes.delete(threadId);
      if (generation === this.generation) this.publish(threadId, { ...this.getSnapshot(threadId), busy: false });
    }
  }

  set(threadId: string, change: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null }): Promise<void> {
    return this.mutate(threadId, () => this.client.set(threadId, change));
  }

  /** Explicit new objective: native set edits an existing Goal and retains its usage. */
  create(threadId: string, objective: string): Promise<void> {
    objective = objective.trim();
    if (!objective) return Promise.reject(new Error("A Goal objective is required"));
    const generation = this.generation;
    const assertCurrent = () => {
      if (generation !== this.generation || !this.capability(threadId)?.write) throw new Error("The Goal connection changed");
    };
    return this.mutate(threadId, async () => {
      const { goal } = await this.client.get(threadId);
      assertCurrent();
      this.observe(threadId, goal);
      const pending = this.pendingCreates.get(threadId);
      if (pending && goal?.objective === pending.objective) {
        if (objective !== pending.objective) throw new Error("Confirm the previous Goal creation first");
        return; // A lost write/confirmation already created this Goal, even if complete.
      }
      if (goal !== null) {
        if (goal.status !== "complete") throw new Error("An unfinished Goal already exists");
        await this.client.clear(threadId);
        assertCurrent();
        const confirmed = await this.client.get(threadId);
        assertCurrent();
        this.observe(threadId, confirmed.goal);
        if (confirmed.goal !== null) throw new Error("Goal removal was not confirmed");
      }
      assertCurrent();
      // No background completion handler clears goals: a late completion cannot
      // delete this new objective. The completed summary is presentation only.
      this.pendingCreates.set(threadId, { objective });
      await this.client.set(threadId, { objective, status: "active", tokenBudget: null });
    }).then(() => {
      assertCurrent();
      if (this.getSnapshot(threadId).goal?.objective !== objective) throw new Error("Goal creation was not confirmed");
      this.pendingCreates.delete(threadId);
    });
  }

  async clear(threadId: string): Promise<void> {
    await this.mutate(threadId, async () => { await this.client.clear(threadId); });
    if (this.getSnapshot(threadId).goal !== null) throw new Error("Goal removal was not confirmed");
    this.pendingCreates.delete(threadId);
    this.publish(threadId, { ...this.getSnapshot(threadId), completedGoal: null });
  }
}
