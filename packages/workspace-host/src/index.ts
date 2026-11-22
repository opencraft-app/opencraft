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
export function defaultWorkspace(root: string): WorkspaceIdentity { return workspaceIdentity(DEFAULT_WORKSPACE_ID, root); }

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
    try { await close(); } catch (error) { failure ??= { error }; }
  }
  if (failure) throw failure.error;
}

/** Roots owned in this runtime. Cross-process exclusion is the lock's job; this refuses a second owner of the same
 * root inside one process (or isolate) even where the host relies on an outer writer lock instead. */
const ownedRoots = new Set<string>();

export class WorkspaceOwnerConflict extends Error {
  constructor(readonly identity: WorkspaceIdentity) { super(`Workspace ${identity.id} data root is already owned in this runtime`); }
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
  static async open<Stores>(identity: WorkspaceIdentity, options: WorkspaceOpenOptions,
    build: (ownership: WorkspaceOwnership) => Stores | Promise<Stores>): Promise<WorkspaceOwner<Stores>> {
    identity = workspaceIdentity(identity.id, identity.root);
    if (ownedRoots.has(identity.root)) throw new WorkspaceOwnerConflict(identity);
    ownedRoots.add(identity.root);
    const root = identity.root;
    const opened: { stage: WorkspaceStage | "lock"; close: Closer }[] = [
      { stage: "lock", close: () => { ownedRoots.delete(root); } },
    ];
    try {
      if (options.lock) opened.push({ stage: "lock", close: await options.lock(identity) });
      const stores = await build({
        identity,
        own(_name, stage, resource, close) { opened.push({ stage, close: () => close(resource) }); return resource; },
      });
      const reverse = (stage: WorkspaceStage | "lock") => opened.filter(entry => entry.stage === stage).map(entry => entry.close).reverse();
      // The lock (and this runtime's claim on the root) is released only after every passive store has closed.
      return new WorkspaceOwner(identity, stores, reverse("dispatch"), [...reverse("state"), ...reverse("lock")]);
    } catch (error) {
      await closeAll(opened.map(entry => entry.close).reverse()).catch(() => undefined);
      throw error;
    }
  }

  get phase(): WorkspacePhase { return this.phaseValue; }

  /** Phase 1: stop dispatch owners in reverse open order, waiting for their in-flight work. Idempotent. */
  drain(): Promise<void> {
    return this.draining ??= (async () => {
      this.phaseValue = "draining";
      try { await closeAll(this.dispatch); }
      finally { if (this.phaseValue === "draining") this.phaseValue = "drained"; }
    })();
  }

  /** Phase 2 (implies phase 1): close passive state in reverse open order, then release the lock. A failure in
   * one step does not keep later stores open or the lock held. Idempotent. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      let failure: { error: unknown } | null = null;
      try { await this.drain(); } catch (error) { failure = { error }; }
      this.phaseValue = "closing";
      try { await closeAll(this.state); } catch (error) { failure ??= { error }; }
      this.phaseValue = "closed";
      if (failure) throw failure.error;
    })();
  }
}

/**
 * The single wake-up a WorkspaceHost dispatch owner holds (workspace-host-split.md §4.3). The owner arms it for the
 * next due time it computed from durable state; the wake-up only prompts the owner to re-read that state, so it
 * never decides due-ness itself. Node arms a bounded timeout ({@link boundedWakeTimer}); a Durable Object arms its
 * alarm.
 */
export interface OwnerWakeTimer {
  /** Replaces any armed wake-up with one at owner-clock time `at`. The callback never runs while the owner clock
   * still reads earlier than `at`; it may run late. */
  arm(at: number): void;
  /** Disarms. Idempotent; no callback runs after it returns. */
  cancel(): void;
}

export type OwnerWakeTimerFactory = (wake: () => void) => OwnerWakeTimer;

/** Host primitives for {@link boundedWakeTimer}: the owner's wall clock and a relative one-shot delay. */
export interface WakeClock {
  now(): number;
  /** Runs `callback` once after about `delayMs`; the returned function cancels it. */
  after(delayMs: number, callback: () => void): () => void;
}

/** Longest single delay a bounded timer waits before re-reading the wall clock. Limits how late a forward clock
 * jump is noticed and keeps far-future targets below platform timer limits. */
export const MAX_WAKE_DELAY_MS = 60_000;

/**
 * An owner wake-up built from relative delays. Each delay is at most `maxDelayMs`; when one elapses the wall clock
 * is read again, so a clock set back re-arms for the remainder instead of waking early, and a clock set forward
 * is noticed within one bounded delay.
 */
export function boundedWakeTimer(clock: WakeClock, wake: () => void, maxDelayMs = MAX_WAKE_DELAY_MS): OwnerWakeTimer {
  if (!(maxDelayMs > 0)) throw new RangeError("Wake delay bound must be positive");
  let target: number | null = null;
  let generation = 0;
  let cancelDelay: (() => void) | null = null;
  const disarm = () => { generation++; cancelDelay?.(); cancelDelay = null; };
  const schedule = () => {
    disarm();
    if (target === null) return;
    const current = ++generation;
    cancelDelay = clock.after(Math.min(Math.max(0, target - clock.now()), maxDelayMs), () => {
      if (current !== generation || target === null) return;
      cancelDelay = null;
      if (clock.now() < target) { schedule(); return; }
      target = null;
      wake();
    });
  };
  return {
    arm(at) {
      if (!Number.isFinite(at)) throw new RangeError("Wake time must be finite");
      target = at;
      schedule();
    },
    cancel() { target = null; disarm(); },
  };
}

interface TimeoutHost {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** {@link WakeClock} over the runtime's `setTimeout`. A pending delay never keeps a Node process alive. */
export function timeoutWakeClock(now: () => number = Date.now): WakeClock {
  const host = globalThis as unknown as TimeoutHost;
  return {
    now,
    after(delayMs, callback) {
      const handle = host.setTimeout(callback, delayMs);
      (handle as { unref?: () => void } | null)?.unref?.();
      return () => host.clearTimeout(handle);
    },
  };
}
