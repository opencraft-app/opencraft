import { boundedWakeTimer, type OwnerWake } from "@opencraft/owner-wake";
import type { WakeClock } from "@opencraft/workspace-host";

export const MINUTE = 60_000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
/** Lets queued promise continuations and setImmediate callbacks run. */
export const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** Owner wall clock for `boundedWakeTimer` that can jump independently of the monotonic time pending delays run on. */
export function fakeWakeClock(start = 1800000000000) {
  let wall = start,
    monotonic = 0,
    sequence = 0;
  const pending = new Map<number, { due: number; callback: () => void }>();
  const delays: number[] = [];
  const clock: WakeClock = {
    now: () => wall,
    after(delayMs, callback) {
      delays.push(delayMs);
      const id = ++sequence;
      pending.set(id, { due: monotonic + delayMs, callback });
      return () => {
        pending.delete(id);
      };
    },
  };
  return {
    clock,
    delays,
    get now() {
      return wall;
    },
    /** Time elapsed on the monotonic clock pending delays run on. */
    get monotonic() {
      return monotonic;
    },
    get pending() {
      return pending.size;
    },
    /** Lets `ms` pass on both clocks, running delays that come due in order. */
    elapse(ms: number) {
      const end = monotonic + ms;
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, entry]) => entry.due <= end)
          .sort((x, y) => x[1].due - y[1].due)[0];
        if (!next) break;
        pending.delete(next[0]);
        wall += next[1].due - monotonic;
        monotonic = next[1].due;
        next[1].callback();
      }
      wall += end - monotonic;
      monotonic = end;
    },
    /** Sets the wall clock without any monotonic time passing. */
    jump(delta: number) {
      wall += delta;
    },
  };
}

/** The owner wake-up port over a {@link fakeWakeClock}, as `timeoutOwnerWake` builds it over real timeouts. */
export function fakeOwnerWake(fake: ReturnType<typeof fakeWakeClock>): OwnerWake {
  return { now: () => fake.now, timer: (wake) => boundedWakeTimer(fake.clock, wake) };
}

/** As {@link fakeOwnerWake} on the monotonic clock, as the default `timeoutOwnerWake()` is. */
export function fakeMonotonicOwnerWake(fake: ReturnType<typeof fakeWakeClock>): OwnerWake {
  const now = () => fake.monotonic;
  return { now, timer: (wake) => boundedWakeTimer({ now, after: fake.clock.after }, wake) };
}

/**
 * A runtime with one alarm (a Durable Object): `fire` is what the runtime does when the alarm time has come, and
 * owners share it through `mergedOwnerWake`. `armed` is the alarm time, or null.
 */
export function fakeAlarm(fake: ReturnType<typeof fakeWakeClock>) {
  let callback: (() => void) | null = null;
  const state = { armed: null as number | null, sets: 0 };
  const wake: OwnerWake = {
    now: () => fake.now,
    timer(onAlarm) {
      callback = onAlarm;
      return {
        arm(at) {
          state.armed = at;
          state.sets++;
        },
        cancel() {
          state.armed = null;
        },
      };
    },
  };
  return {
    wake,
    state,
    /** Fires the alarm if its time has come on the wall clock, as the runtime does. */
    fire() {
      if (state.armed === null || state.armed > fake.now) return false;
      state.armed = null;
      callback?.();
      return true;
    },
  };
}
