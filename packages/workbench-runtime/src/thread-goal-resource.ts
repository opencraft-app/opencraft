import { AppServerClientError, AppServerRpcError } from "@opencraft/appserver-client";
import type { ThreadGoal } from "@opencraft/appserver-protocol/generated/v2";
import type { OpenCraftThreadGoalCapability } from "@opencraft/appserver-protocol";

/** Stable public classification; raw transport diagnostics are not user copy. */
export class GoalMutationError extends Error {
  /** Only typed codes enter UI copy. The unmodified error/data remain in cause. */
  readonly diagnosticCode: string | null;

  constructor(readonly code: "conflict" | "atomicReplacementRequired" | "requestRejected" | "serverError" | "outcomeUnknown" | "versionRequired", options?: ErrorOptions) {
    super(code === "conflict" ? "The Goal changed or an unfinished Goal already exists" : code === "atomicReplacementRequired" ? "Atomic Goal replacement is not supported by this Host" : code === "versionRequired" ? "A fresh Goal version is required" : code === "requestRejected" ? "Goal request was not accepted" : code === "serverError" ? "Goal request returned a server error" : "Goal write outcome unknown", options);
    this.name = "GoalMutationError";
    this.diagnosticCode = options?.cause instanceof AppServerRpcError && Number.isSafeInteger(options.cause.code)
      ? `RPC ${options.cause.code}`
      : options?.cause instanceof AppServerClientError ? options.cause.code : null;
  }
}

export interface ThreadGoalSnapshot {
  readonly goal: ThreadGoal | null;
  readonly version?: string | null;
  /** Last observed completion, for review after a confirmed replacement clears it. */
  readonly completedGoal: ThreadGoal | null;
  readonly phase: "idle" | "loading" | "ready" | "error";
  readonly busy: boolean;
  readonly error: Error | null;
}

export interface ThreadGoalClient {
  get(threadId: string): Promise<{ goal: ThreadGoal | null; version?: string }>;
  set(threadId: string, change: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null; expectedVersion?: string }): Promise<{ goal: ThreadGoal }>;
  clear(threadId: string, change?: { expectedVersion?: string }): Promise<{ cleared: boolean }>;
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
  private readonly conditionalThreads = new Set<string>();
  private readonly unavailableVersions = new Set<string>();
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
    this.conditionalThreads.clear();
    this.unavailableVersions.clear();
    this.snapshots.clear();
    for (const threadId of this.listeners.keys()) {
      this.publish(threadId, INITIAL);
      if (this.capability(threadId)?.read) void this.refresh(threadId).catch(() => undefined);
    }
    for (const listener of this.catalogListeners) listener();
  }

  private readVersion(threadId: string, value: unknown): string | undefined {
    if (value === undefined && !this.conditionalThreads.has(threadId)) return undefined;
    this.conditionalThreads.add(threadId);
    if (typeof value !== "string" || value.length > 19 || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) {
      this.unavailableVersions.add(threadId);
      throw new GoalMutationError("versionRequired");
    }
    this.unavailableVersions.delete(threadId);
    return value;
  }

  private hydrateLater(threadId: string): void {
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation || this.writes.has(threadId)) return;
      const pending = this.reads.get(threadId);
      if (pending) {
        void pending.catch(() => undefined).then(() => {
          if (generation === this.generation && !this.writes.has(threadId) && !this.reads.has(threadId)) void this.refresh(threadId, true).catch(() => undefined);
        });
      } else void this.refresh(threadId, true).catch(() => undefined);
    });
  }

  observe(threadId: string, goal: ThreadGoal | null, version?: string): void {
    const previous = this.getSnapshot(threadId);
    const sameSemanticGoal = goal !== null && previous.goal !== null
      && goal.objective === previous.goal.objective && goal.status === previous.goal.status
      && goal.tokenBudget === previous.goal.tokenBudget && goal.createdAt === previous.goal.createdAt;
    const token = version ?? (sameSemanticGoal ? previous.version : null);
    this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    this.publish(threadId, { goal, version: token, completedGoal: goal?.status === "complete" ? goal : previous.completedGoal, phase: "ready", busy: this.writes.has(threadId), error: null });
    if (token == null && this.conditionalThreads.has(threadId)) this.hydrateLater(threadId);
  }

  private precondition(threadId: string, requested?: string | null): { expectedVersion?: string } {
    if (!this.conditionalThreads.has(threadId)) {
      if (requested != null) throw new GoalMutationError("versionRequired");
      return {};
    }
    const version = requested === undefined ? this.getSnapshot(threadId).version : requested;
    if (this.unavailableVersions.has(threadId) || typeof version !== "string" || version.length > 19 || !/^(0|[1-9][0-9]*)$/.test(version) || BigInt(version) > 9223372036854775807n) throw new GoalMutationError("versionRequired");
    return { expectedVersion: version };
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
    const operation = this.client.get(threadId).then(({ goal, version: rawVersion }) => {
      if (this.generation !== generation) return;
      const version = this.readVersion(threadId, rawVersion);
      if ((this.revisions.get(threadId) ?? 0) === revision) this.observe(threadId, goal, version);
      else if (this.conditionalThreads.has(threadId)) this.hydrateLater(threadId);
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

  private async mutate(threadId: string, command: () => Promise<ThreadGoal | null>): Promise<void> {
    if (!this.capability(threadId)?.write) throw new Error("This Host cannot change goals");
    if (this.writes.has(threadId)) throw new Error("A goal change is already in progress");
    const generation = this.generation;
    this.writes.add(threadId);
    this.publish(threadId, { ...this.getSnapshot(threadId), busy: true, error: null });
    let reconciledFailure = false;
    try {
      const revision = this.revisions.get(threadId) ?? 0;
      const goal = await command();
      // The write response is the commit acknowledgement. A subsequent read is
      // not part of that commit; a reconnect must not turn it into a failure.
      // A notification received during the command may be newer than its ACK.
      if (generation === this.generation && (this.revisions.get(threadId) ?? 0) === revision) this.observe(threadId, goal);
    } catch (cause) {
      // Reconcile once while still single-flight; never replay the mutation.
      // A matching state is not a receipt proving this command committed.
      if (generation === this.generation && (!(cause instanceof GoalMutationError) || cause.cause !== undefined)) {
        reconciledFailure = true;
        await this.refresh(threadId, true).catch(() => undefined);
      }
      if (generation === this.generation) this.publish(threadId, { ...this.getSnapshot(threadId), error: cause instanceof Error ? cause : new Error("Goal could not be changed") });
      throw cause;
    } finally {
      this.writes.delete(threadId);
      if (generation === this.generation) {
        this.publish(threadId, { ...this.getSnapshot(threadId), busy: false });
        if (!reconciledFailure && this.conditionalThreads.has(threadId)) this.hydrateLater(threadId);
      }
    }
  }

  private async write(threadId: string, command: () => Promise<ThreadGoal | null>): Promise<ThreadGoal | null> {
    const generation = this.generation;
    try { return await command(); }
    catch (cause) {
      // Without a durable native operation receipt, a transport rejection does
      // not prove non-execution. Never automatically replay this mutation.
      if (cause && typeof cause === "object" && "code" in cause && cause.code === -32010
        && "data" in cause && cause.data && typeof cause.data === "object" && "reason" in cause.data
        && cause.data.reason === "goal_version_required") {
        if (generation === this.generation) {
          this.conditionalThreads.add(threadId);
          this.unavailableVersions.add(threadId);
        }
        throw new GoalMutationError("versionRequired", { cause });
      }
      if (cause && typeof cause === "object" && "code" in cause && cause.code === -32009
        && "data" in cause && cause.data && typeof cause.data === "object" && "reason" in cause.data
        && cause.data.reason === "goal_version_conflict") throw new GoalMutationError("conflict", { cause });
      if (cause instanceof GoalMutationError) throw cause;
      // Only client pre-dispatch failures and standard RPC admission errors
      // prove non-admission. Other server errors may follow a commit.
      const code = cause instanceof AppServerClientError
        && ["CLOSED", "NOT_CONNECTED", "NOT_DISPATCHED", "QUEUE_FULL"].includes(cause.code)
        ? "requestRejected"
        : cause instanceof AppServerRpcError
          ? [-32700, -32600, -32601, -32602].includes(cause.code) ? "requestRejected" : "serverError"
          : "outcomeUnknown";
      throw new GoalMutationError(code, { cause });
    }
  }

  set(threadId: string, change: { objective?: string; status?: ThreadGoal["status"]; tokenBudget?: number | null; expectedVersion?: string | null }): Promise<void> {
    return this.mutate(threadId, () => {
      const { expectedVersion, ...payload } = change;
      const guard = this.precondition(threadId, expectedVersion);
      return this.write(threadId, async () => (await this.client.set(threadId, { ...payload, ...guard })).goal);
    });
  }

  /** Native set is an upsert, NOT an atomic create/replace operation. */
  create(threadId: string, objective: string, expectedVersion?: string | null, canCommit: () => boolean = () => true): Promise<void> {
    objective = objective.trim();
    if (!objective) return Promise.reject(new Error("A Goal objective is required"));
    const generation = this.generation;
    return this.mutate(threadId, async () => {
      const { goal, version: rawVersion } = await this.client.get(threadId);
      if (generation !== this.generation || !this.capability(threadId)?.write) throw new Error("The Goal connection changed");
      if (!canCommit()) throw new Error("The new conversation changed before its Goal was started");
      const version = this.readVersion(threadId, rawVersion);
      const guard = this.precondition(threadId, expectedVersion === undefined ? version : expectedVersion);
      if (goal !== null) {
        this.observe(threadId, goal, version);
        if (goal.status !== "complete") throw new GoalMutationError("conflict");
        // No clear-then-set fallback: it could delete another writer's Goal.
        throw new GoalMutationError("atomicReplacementRequired");
      }
      // Legacy empty creation still has a cross-writer upsert race. Native
      // expected-version + operation receipts are required to close it fully.
      return this.write(threadId, async () => (await this.client.set(threadId, { objective, status: "active", tokenBudget: null, ...guard })).goal);
    });
  }

  async clear(threadId: string, expectedVersion?: string | null): Promise<void> {
    const generation = this.generation;
    await this.mutate(threadId, () => {
      const guard = this.precondition(threadId, expectedVersion);
      return this.write(threadId, async () => { await this.client.clear(threadId, guard); return null; });
    });
    if (generation === this.generation && this.getSnapshot(threadId).goal === null) {
      this.publish(threadId, { ...this.getSnapshot(threadId), completedGoal: null });
    }
  }
}
