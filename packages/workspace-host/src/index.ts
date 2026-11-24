/**
 * Host-agnostic lifecycle of one WorkspaceHost (docs/architecture/platform/workspace-host-split.md §3.2, §4.1).
 *
 * This module owns only identity, ordering and failure isolation. It imports no runtime: the Node composition
 * (`apps/opencraft-daemon/src/workspace-host.ts`) opens SQLite owners through it today, and a per-workspace
 * Durable Object can reuse it later with SQL-port stores and an implicit single-instance lock.
 */

/** The only workspace a deployment assembles until multi-workspace placement exists. */
export const DEFAULT_WORKSPACE_ID = "default";

/** Explicit owner identity and data root. The root is never derived from cwd, a Thread or the process. */
export interface WorkspaceIdentity {
  readonly id: string;
  readonly root: string;
}

const WORKSPACE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export function workspaceIdentity(id: string, root: string): WorkspaceIdentity {
  if (!WORKSPACE_ID.test(id)) throw new TypeError("Workspace id must be a lowercase slug");
  if (!root) throw new TypeError("Workspace Host requires an explicit data root");
  return Object.freeze({ id, root });
}

/** Today's single-workspace layout: the caller passes the existing data root unchanged. */
export function defaultWorkspace(root: string): WorkspaceIdentity {
  return workspaceIdentity(DEFAULT_WORKSPACE_ID, root);
}

type Closer = () => void | Promise<void>;

/**
 * - `dispatch`: owners that can start native work (timers, recovery flights). Closed by `drain()`, which waits
 *   for their in-flight work, so the engine can stop dispatch before it tears down its transport.
 * - `state`: passive stores. Closed by `close()` after the engine has settled its Thread operations.
 */
export type WorkspaceStage = "dispatch" | "state";

export interface WorkspaceOwnership {
  readonly identity: WorkspaceIdentity;
  /** Records an already opened resource. A later open failure closes it again, in reverse order. */
  own<T>(name: string, stage: WorkspaceStage, resource: T, close: (resource: T) => void | Promise<void>): T;
}

export interface WorkspaceOpenOptions {
  /** Exclusive writer guard for the root, acquired before any store opens and released last.
   * Omitted where the host already guarantees a single owner (an existing combined writer lock, or a DO). */
  readonly lock?: (identity: WorkspaceIdentity) => Promise<Closer>;
}

export type WorkspacePhase = "open" | "draining" | "drained" | "closing" | "closed";

/** Runs every closer even when one fails; the first failure is reported after all have run. */
async function closeAll(closers: readonly Closer[]): Promise<void> {
  let failure: { error: unknown } | null = null;
  for (const close of closers) {
    try {
      await close();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) throw failure.error;
}

/** Roots owned in this runtime. Cross-process exclusion is the lock's job; this refuses a second owner of the same
 * root inside one process (or isolate) even where the host relies on an outer writer lock instead. */
const ownedRoots = new Set<string>();

export class WorkspaceOwnerConflict extends Error {
  constructor(readonly identity: WorkspaceIdentity) {
    super(`Workspace ${identity.id} data root is already owned in this runtime`);
  }
}

export class WorkspaceOwner<Stores> {
  private phaseValue: WorkspacePhase = "open";
  private draining: Promise<void> | null = null;
  private closing: Promise<void> | null = null;

  private constructor(
    readonly identity: WorkspaceIdentity,
    readonly stores: Stores,
    private readonly dispatch: readonly Closer[],
    private readonly state: readonly Closer[],
  ) {}

  /**
   * Opens the lock, then whatever `build` opens, in `build`'s order. Opening is all-or-nothing: on failure every
   * owned resource closes in reverse and the lock is released, so the root can be opened again.
   */
  static async open<Stores>(
    identity: WorkspaceIdentity,
    options: WorkspaceOpenOptions,
    build: (ownership: WorkspaceOwnership) => Stores | Promise<Stores>,
  ): Promise<WorkspaceOwner<Stores>> {
    identity = workspaceIdentity(identity.id, identity.root);
    if (ownedRoots.has(identity.root)) throw new WorkspaceOwnerConflict(identity);
    ownedRoots.add(identity.root);
    const root = identity.root;
    const opened: { stage: WorkspaceStage | "lock"; close: Closer }[] = [
      {
        stage: "lock",
        close: () => {
          ownedRoots.delete(root);
        },
      },
    ];
    try {
      if (options.lock) opened.push({ stage: "lock", close: await options.lock(identity) });
      const stores = await build({
        identity,
        own(_name, stage, resource, close) {
          opened.push({ stage, close: () => close(resource) });
          return resource;
        },
      });
      const reverse = (stage: WorkspaceStage | "lock") =>
        opened
          .filter((entry) => entry.stage === stage)
          .map((entry) => entry.close)
          .reverse();
      // The lock (and this runtime's claim on the root) is released only after every passive store has closed.
      return new WorkspaceOwner(identity, stores, reverse("dispatch"), [...reverse("state"), ...reverse("lock")]);
    } catch (error) {
      await closeAll(opened.map((entry) => entry.close).reverse()).catch(() => undefined);
      throw error;
    }
  }

  get phase(): WorkspacePhase {
    return this.phaseValue;
  }

  /** Phase 1: stop dispatch owners in reverse open order, waiting for their in-flight work. Idempotent. */
  drain(): Promise<void> {
    return (this.draining ??= (async () => {
      this.phaseValue = "draining";
      try {
        await closeAll(this.dispatch);
      } finally {
        if (this.phaseValue === "draining") this.phaseValue = "drained";
      }
    })());
  }

  /** Phase 2 (implies phase 1): close passive state in reverse open order, then release the lock. A failure in
   * one step does not keep later stores open or the lock held. Idempotent. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      let failure: { error: unknown } | null = null;
      try {
        await this.drain();
      } catch (error) {
        failure = { error };
      }
      this.phaseValue = "closing";
      try {
        await closeAll(this.state);
      } catch (error) {
        failure ??= { error };
      }
      this.phaseValue = "closed";
      if (failure) throw failure.error;
    })());
  }
}

// The wake-up of a dispatch owner (§4.3) is the runtime-neutral port shared with deployment-level owners
// (gateway-split.md §4.2). It lives in `@opencraft/owner-wake` and is re-exported here for existing consumers.
export {
  boundedWakeTimer,
  MAX_WAKE_DELAY_MS,
  timeoutWakeClock,
  type OwnerWakeTimer,
  type OwnerWakeTimerFactory,
  type WakeClock,
} from "@opencraft/owner-wake";
