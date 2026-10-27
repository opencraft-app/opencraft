import { asHostId, type HostId } from "@opencraft/chat-core";

import type { HostRuntimeLifecycle, HostRuntimeRegistry } from "./host-runtime-registry";
import {
  workbenchLocationHostId,
  type WorkbenchDraftLocation,
  type WorkbenchLocation,
} from "./workbench-location";

export interface WorkbenchActivatableRuntime extends HostRuntimeLifecycle {
  acquireThread(threadId: string): Promise<WorkbenchThreadLease>;
  /** Optional readiness observation for initial-route recovery. */
  getSnapshot?(): { readonly phase: string; readonly connectionGeneration?: number };
  subscribe?(listener: () => void): () => void;
}

export interface WorkbenchThreadLease {
  setRecoveryVisibility?(visible: boolean): void;
  readonly threadId: string;
  release(): void;
}

export type RuntimeThreadLease<TRuntime extends WorkbenchActivatableRuntime> = Awaited<
  ReturnType<TRuntime["acquireThread"]>
>;

export type WorkbenchActivationPhase = "idle" | "resolving" | "ready" | "error";

export interface WorkbenchCoordinatorSnapshot {
  readonly activationEpoch: number;
  readonly failureStage: "connection" | "thread" | null;
  readonly revision: number;
  /** New-chat preference only. It does not redefine an existing View's Host. */
  readonly selectedHostId: HostId;
  /** Last presentable location committed by the workbench. */
  readonly location: WorkbenchLocation;
  /** Navigation intent currently being resolved without replacing the View. */
  readonly pendingLocation: WorkbenchLocation | null;
  readonly phase: WorkbenchActivationPhase;
  readonly error: Error | null;
  /** Presentation/Route identity committed with the Conversation View. */
  readonly viewId: string | null;
}

export interface WorkbenchCoordinator<TRuntime extends WorkbenchActivatableRuntime> {
  getSnapshot(): WorkbenchCoordinatorSnapshot;
  subscribe(listener: () => void): () => void;
  setSelectedHostId(hostId: string): void;
  setViewId(viewId: string): void;
  /**
   * Publishes a locally valid View identity without waiting for a physical
   * Host connection. Only application bootstrap may use this path; ordinary
   * navigation continues to prepare remotely before replacing the visible
   * View.
   */
  presentInitial(location: WorkbenchLocation, viewId: string): void;
  /**
   * Commits a locally owned New-chat Draft as the visible Home route without
   * waiting for its physical Host. Remote readiness continues via prepare().
   */
  presentLocalDraft(location: WorkbenchDraftLocation, viewId: string): void;
  prepare(location: WorkbenchLocation): Promise<PreparedWorkbenchActivation | null>;
  cancelPending(): void;
  activate(location: WorkbenchLocation): Promise<boolean>;
  getRuntime(): TRuntime;
  /** View-owned lease; Host runtime identity remains independent of presentation. */
  getActiveThreadLease(): RuntimeThreadLease<TRuntime> | null;
  dispose(): void;
}

/**
 * A presentable activation that has not changed the Host/Thread yet. Local
 * painted state is sufficient; authoritative Resume continues independently.
 * Commit is synchronous so callers can include their own synchronous domain
 * mutations in the same activation transaction.
 */
export interface PreparedWorkbenchActivation {
  readonly location: WorkbenchLocation;
  /** Runs synchronous domain mutation after generation validation, before View publication. */
  commit(beforePublish?: () => void, viewId?: string): boolean;
  cancel(): void;
}

/**
 * Serializes route intent into committed, presentable workbench state. An old
 * asynchronous preparation is never allowed to commit after a newer intent.
 */
export function createWorkbenchCoordinator<TRuntime extends WorkbenchActivatableRuntime>(
  registry: HostRuntimeRegistry<TRuntime>,
  initialLocation: WorkbenchLocation,
  initialSelectedHostId: string = workbenchLocationHostId(initialLocation),
  initialViewId: string | null = null,
): WorkbenchCoordinator<TRuntime> {
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let revision = 0;
  let selectedHostId = asHostId(initialSelectedHostId);
  let location = initialLocation;
  let pendingLocation: WorkbenchLocation | null = null;
  let phase: WorkbenchActivationPhase = "idle";
  let error: Error | null = null;
  let failureStage: WorkbenchCoordinatorSnapshot["failureStage"] = null;
  let viewId = initialViewId;
  let activeRuntime: TRuntime | null = null;
  let activeThreadLease: RuntimeThreadLease<TRuntime> | null = null;
  let snapshot: WorkbenchCoordinatorSnapshot;
  let cancelPreparation: (() => void) | null = null;

  const ensureOpen = () => {
    if (disposed) throw new Error("Workbench coordinator is disposed");
  };
  const derive = (): WorkbenchCoordinatorSnapshot => ({
    activationEpoch: generation,
    failureStage,
    revision,
    selectedHostId,
    location,
    pendingLocation,
    phase,
    error,
    viewId,
  });
  const publish = () => {
    revision += 1;
    snapshot = derive();
    for (const listener of listeners) listener();
  };
  snapshot = derive();

  const prepare = async (
    nextLocation: WorkbenchLocation,
  ): Promise<PreparedWorkbenchActivation | null> => {
    ensureOpen();
    cancelPreparation?.();
    const activation = ++generation;
    let preparedLease: RuntimeThreadLease<TRuntime> | null = null;
    let preparedRuntime: TRuntime | null = null;
    let settled = false;
    pendingLocation = nextLocation;
    phase = "resolving";
    error = null;
    failureStage = null;
    publish();

    const releasePrepared = () => {
      preparedLease?.release();
      preparedLease = null;
    };
    const cancel = () => {
      releasePrepared();
      if (settled) return;
      settled = true;
      if (cancelPreparation === cancel) cancelPreparation = null;
      if (!disposed && activation === generation) {
        pendingLocation = null;
        phase = activeRuntime === null ? "idle" : "ready";
        error = null;
        publish();
      }
    };
    cancelPreparation = cancel;

    let preparationStage: "connection" | "thread" = "connection";
    try {
      const hostId = workbenchLocationHostId(nextLocation);
      preparedRuntime = await registry.ensureConnected(hostId);
      preparationStage = "thread";
      if (disposed || activation !== generation) {
        cancel();
        return null;
      }
      preparedLease = nextLocation.kind === "thread"
        ? await preparedRuntime.acquireThread(nextLocation.key.threadId) as RuntimeThreadLease<TRuntime>
        : null;
      if (disposed || activation !== generation) {
        cancel();
        return null;
      }
      return {
        location: nextLocation,
        commit(beforePublish, nextViewId) {
          if (settled) return false;
          if (disposed || activation !== generation || preparedRuntime === null) {
            cancel();
            return false;
          }
          try {
            beforePublish?.();
          } catch (cause) {
            settled = true;
            if (cancelPreparation === cancel) cancelPreparation = null;
            releasePrepared();
            pendingLocation = null;
            phase = activeRuntime === null ? "error" : "ready";
            error = cause instanceof Error ? cause : new Error(String(cause));
            publish();
            throw cause;
          }
          settled = true;
          if (cancelPreparation === cancel) cancelPreparation = null;
          const previousLease = activeThreadLease;
          activeRuntime = preparedRuntime;
          activeThreadLease = preparedLease;
          activeThreadLease?.setRecoveryVisibility?.(true);
          preparedLease = null;
          previousLease?.release();
          location = nextLocation;
          if (nextViewId !== undefined) viewId = nextViewId;
          pendingLocation = null;
          phase = "ready";
          error = null;
          publish();
          return true;
        },
        cancel,
      };
    } catch (cause) {
      releasePrepared();
      settled = true;
      if (cancelPreparation === cancel) cancelPreparation = null;
      if (disposed || activation !== generation) return null;
      pendingLocation = null;
      phase = "error";
      failureStage = preparationStage;
      error = cause instanceof Error ? cause : new Error(String(cause));
      publish();
      return null;
    }
  };

  return {
    cancelPending() { cancelPreparation?.(); ++generation; publish(); },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      ensureOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSelectedHostId(nextHostId) {
      ensureOpen();
      const normalized = asHostId(nextHostId);
      // Validation belongs to the runtime index, while selection remains a
      // synchronous preference with no network or route side effects.
      registry.getRuntime(normalized);
      if (selectedHostId === normalized) return;
      selectedHostId = normalized;
      publish();
    },
    setViewId(nextViewId) {
      ensureOpen();
      if (nextViewId.trim().length === 0) throw new RangeError("Workbench View ID must not be empty");
      if (viewId === nextViewId) return;
      viewId = nextViewId;
      publish();
    },
    presentInitial(nextLocation, nextViewId) {
      ensureOpen();
      if (nextViewId.trim().length === 0) {
        throw new RangeError("Workbench View ID must not be empty");
      }
      if (activeRuntime !== null || activeThreadLease !== null || phase !== "idle") {
        throw new Error("Initial Workbench View has already been presented");
      }
      const hostId = workbenchLocationHostId(nextLocation);
      activeRuntime = registry.getRuntime(hostId);
      location = nextLocation;
      viewId = nextViewId;
      pendingLocation = nextLocation;
      phase = "resolving";
      error = null;
      publish();
    },
    presentLocalDraft(nextLocation, nextViewId) {
      ensureOpen();
      if (nextViewId.trim().length === 0) {
        throw new RangeError("Workbench View ID must not be empty");
      }
      generation += 1;
      const previousLease = activeThreadLease;
      activeRuntime = registry.getRuntime(nextLocation.hostId);
      activeThreadLease = null;
      previousLease?.release();
      location = nextLocation;
      viewId = nextViewId;
      pendingLocation = nextLocation;
      phase = "resolving";
      error = null;
      publish();
    },
    prepare,
    async activate(nextLocation) {
      const prepared = await prepare(nextLocation);
      return prepared?.commit() ?? false;
    },
    getRuntime() {
      ensureOpen();
      return registry.getRuntime(workbenchLocationHostId(location));
    },
    getActiveThreadLease() {
      ensureOpen();
      return activeThreadLease;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      activeThreadLease?.release();
      activeRuntime = null;
      activeThreadLease = null;
      listeners.clear();
    },
  };
}
