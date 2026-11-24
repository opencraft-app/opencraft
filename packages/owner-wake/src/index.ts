/**
 * Runtime-neutral owner wake-up (docs/architecture/platform/workspace-host-split.md §4.3,
 * docs/architecture/platform/gateway-split.md §4.2).
 *
 * The weakest runtime defines the floor: an owner holds at most one pending wake-up, its process memory can be
 * dropped between wake-ups, and the runtime may offer only one wake-up for everything it hosts. Owners therefore
 * re-derive what is due from their own state when woken; a wake-up never decides due-ness itself. Relative
 * timeouts and a single persistent alarm are peer adapters of this contract. This module imports no runtime.
 */

/**
 * The single wake-up an owner holds. The owner arms it for the next due time it computed; the wake-up only
 * prompts the owner to re-read its state.
 */
export interface OwnerWakeTimer {
  /** Replaces any armed wake-up with one at owner-clock time `at`. The callback never runs while the owner clock
   * still reads earlier than `at`; it may run late. */
  arm(at: number): void;
  /** Disarms. Idempotent; no callback runs after it returns. */
  cancel(): void;
}

export type OwnerWakeTimerFactory = (wake: () => void) => OwnerWakeTimer;

/** An owner clock together with the wake-ups armed on it. Every `at` passed to its timers is read on `now`. */
export interface OwnerWake {
  now(): number;
  readonly timer: OwnerWakeTimerFactory;
}

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
  const disarm = () => {
    generation++;
    cancelDelay?.();
    cancelDelay = null;
  };
  const schedule = () => {
    disarm();
    if (target === null) return;
    const current = ++generation;
    cancelDelay = clock.after(Math.min(Math.max(0, target - clock.now()), maxDelayMs), () => {
      if (current !== generation || target === null) return;
      cancelDelay = null;
      if (clock.now() < target) {
        schedule();
        return;
      }
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
    cancel() {
      target = null;
      disarm();
    },
  };
}

interface TimeoutHost {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
}
const host = globalThis as unknown as TimeoutHost;

/** {@link WakeClock} over the runtime's `setTimeout`. A pending delay never keeps a Node process alive. */
export function timeoutWakeClock(now: () => number = Date.now): WakeClock {
  return {
    now,
    after(delayMs, callback) {
      const handle = host.setTimeout(callback, delayMs);
      (handle as { unref?: () => void } | null)?.unref?.();
      return () => host.clearTimeout(handle);
    },
  };
}

/** The runtime's monotonic clock, so wall-clock changes neither delay nor hasten periodic work. */
const monotonicNow = (): number => (host.performance ? host.performance.now() : Date.now());

/** Longest relative timeout the runtime accepts; a later wake-up is reached in steps. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * {@link OwnerWake} on the runtime's own timer clock, for periodic owner work. The owner clock is the monotonic clock
 * relative timeouts are measured on, and an elapsed timeout counts as having reached its time (timer granularity can
 * leave `now()` up to about a millisecond short of it). Wall-clock changes therefore neither delay nor hasten the work,
 * and its timing stays that of `setInterval`. A pending timeout never keeps a Node process alive. Owners whose due
 * times are wall-clock instants (schedules) use {@link boundedWakeTimer} over a wall clock instead.
 */
export function timeoutOwnerWake(): OwnerWake {
  const clock = timeoutWakeClock(monotonicNow);
  return {
    now: monotonicNow,
    timer(wake) {
      let cancelDelay: (() => void) | null = null;
      const cancel = () => {
        cancelDelay?.();
        cancelDelay = null;
      };
      const schedule = (at: number) => {
        cancel();
        const delay = Math.max(0, at - clock.now());
        cancelDelay = clock.after(Math.min(delay, MAX_TIMEOUT_MS), () => {
          cancelDelay = null;
          if (delay > MAX_TIMEOUT_MS) schedule(at);
          else wake();
        });
      };
      return {
        arm(at) {
          if (!Number.isFinite(at)) throw new RangeError("Wake time must be finite");
          schedule(at);
        },
        cancel,
      };
    },
  };
}

/**
 * Many owner wake-ups on one underlying wake-up, armed for the earliest due time among them ("next due time"). A
 * runtime that offers a single wake-up per object (an alarm) hosts several owners through it. When the underlying
 * wake-up fires, every child whose time has come on `source.now()` wakes in due order, the rest stay armed, and an
 * underlying wake-up that arrives before any child is due (the alarm's clock ran ahead) only re-arms. A child's
 * callback may arm or cancel any child; a throwing callback does not keep the others from waking.
 */
export function mergedOwnerWake(source: OwnerWake): OwnerWake {
  interface Entry {
    at: number;
    readonly wake: () => void;
  }
  const armed = new Set<Entry>();
  let armedAt: number | null = null;
  const rearm = () => {
    let next: number | null = null;
    for (const entry of armed) if (next === null || entry.at < next) next = entry.at;
    if (next === armedAt) return;
    armedAt = next;
    if (next === null) underlying.cancel();
    else underlying.arm(next);
  };
  const fire = () => {
    armedAt = null;
    const now = source.now();
    const due = [...armed].filter((entry) => entry.at <= now).sort((x, y) => x.at - y.at);
    for (const entry of due) armed.delete(entry);
    rearm();
    let failure: { error: unknown } | null = null;
    for (const entry of due) {
      try {
        entry.wake();
      } catch (error) {
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
  };
  const underlying = source.timer(fire);
  return {
    now: () => source.now(),
    timer(wake) {
      const entry: Entry = { at: 0, wake };
      return {
        arm(at) {
          if (!Number.isFinite(at)) throw new RangeError("Wake time must be finite");
          entry.at = at;
          armed.add(entry);
          rearm();
        },
        cancel() {
          if (armed.delete(entry)) rearm();
        },
      };
    },
  };
}

/** A handle to {@link periodicOwnerWork}. */
export interface PeriodicOwnerWork {
  /** Stops it. Idempotent; `run` is not called again after it returns. Work already running is the owner's to drain. */
  close(): void;
}

/**
 * Calls `run` every `periodMs` on the owner clock, first `periodMs` after this call, as `setInterval` does: the
 * next wake-up is armed before `run` is called, measured from the wake-up. Periodic owner work re-derives what to
 * do from its own state, so an owner that lost its memory (and with it this period) resumes by running one pass
 * when it is opened again, as the Node composition does at startup.
 */
export function periodicOwnerWork(wake: OwnerWake, periodMs: number, run: () => void): PeriodicOwnerWork {
  if (!(periodMs > 0) || !Number.isFinite(periodMs)) throw new RangeError("Owner work period must be positive");
  let closed = false;
  const timer = wake.timer(() => {
    if (closed) return;
    timer.arm(wake.now() + periodMs);
    run();
  });
  timer.arm(wake.now() + periodMs);
  return {
    close() {
      closed = true;
      timer.cancel();
    },
  };
}
