import { spring, type MotionValue } from "motion/react";

/** Presentation time, not request age. A stalled frame admits at most one 30Hz
 * step: prefer a slightly longer transition to skipping its spatial explanation.
 * Normal 60/120Hz cadence is unchanged. No catch-up debt survives a stall.
 * This clock owns no navigation/readiness and uses Motion's existing physics. */
export const overviewMaxFrameStep = 1000 / 30;
export interface OverviewFrameSource {
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}
const browserFrames: OverviewFrameSource = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};
export function animateOverviewProgress(
  value: MotionValue<number>,
  target: number,
  options: {
    stiffness: number;
    damping: number;
    mass: number;
    restDelta: number;
    restSpeed: number;
    velocity?: number;
    onUpdate(value: number): void;
    onComplete(): void;
  },
  frames: OverviewFrameSource = browserFrames,
) {
  const from = value.get();
  const generator = spring({ ...options, keyframes: [from, target] });
  let elapsed = 0,
    last: number | undefined,
    frame: number | undefined;
  let state: "pending" | "playing" | "paused" | "stopped" | "finished" = "pending";
  let velocity = options.velocity ?? 0;
  const unschedule = () => {
    if (frame !== undefined) frames.cancel(frame);
    frame = undefined;
    last = undefined;
  };
  const finish = () => {
    if (state === "stopped" || state === "finished") return;
    state = "finished";
    unschedule();
    velocity = 0;
    options.onComplete();
  };
  const paint = () => {
    const { value: current, done } = generator.next(elapsed);
    // Sample the same physical curve, rather than deriving velocity from wall
    // time (which includes layout/preparation and slow-device stalls).
    const dt = Math.min(5, elapsed);
    const previous = dt ? generator.next(elapsed - dt).value : current;
    if (dt) velocity = generator.velocity?.(elapsed) ?? ((current - previous) * 1000) / dt;
    value.setWithVelocity(previous, current, dt || 1);
    options.onUpdate(current);
    // onUpdate can hand back, reverse or cancel this owner synchronously.
    if (done) finish();
  };
  const tick = (timestamp: number) => {
    frame = undefined;
    if (state !== "pending" && state !== "playing") return;
    state = "playing";
    if (last !== undefined) elapsed += Math.min(overviewMaxFrameStep, Math.max(0, timestamp - last));
    last = timestamp;
    paint();
    if (state === "playing") frame = frames.request(tick);
  };
  const playback = {
    get velocity() {
      return velocity;
    },
    get time() {
      return elapsed / 1000;
    },
    set time(seconds: number) {
      if (state === "stopped" || state === "finished" || !Number.isFinite(seconds)) return;
      elapsed = Math.max(0, seconds * 1000);
      last = undefined;
      paint();
    },
    get duration() {
      // Only inspection/seeking needs duration; live playback follows done.
      const probe = spring({ ...options, keyframes: [from, target] });
      let ms = 0;
      while (ms < 20000 && !probe.next(ms).done) ms += 10;
      return ms / 1000;
    },
    stop() {
      if (state === "finished") return;
      state = "stopped";
      unschedule();
    },
    pause() {
      if (state === "stopped" || state === "finished") return;
      state = "paused";
      unschedule();
    },
    play() {
      if (state !== "paused") return;
      state = "pending";
      frame = frames.request(tick);
    },
    complete() {
      if (state === "stopped" || state === "finished") return;
      value.set(target);
      options.onUpdate(target);
      finish();
    },
  };
  frame = frames.request(tick);
  return playback;
}
