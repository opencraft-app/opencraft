import { frame } from "@opencraft/design-system/tokens";

/** Swipe right to reveal the left sidebar; swipe left to dismiss. */
export const MOBILE_SIDEBAR_REVEAL_DIRECTION = 1;
export const MOBILE_SIDEBAR_EDGE_RESERVE = 24;
export const MOBILE_GESTURE_DEADZONE = 8;
// A visible front-page strip remains large enough to dismiss by touch.
export const MOBILE_SIDEBAR_PAGE_PEEK = 64;

/** Narrow only the mobile projection; saved desktop width and hit targets stay intact. */
export function mobileSidebarWidth(viewportWidth: number, savedWidth: number): number {
  const fittedWidth = Math.min(Math.max(0, viewportWidth - MOBILE_SIDEBAR_PAGE_PEEK), Math.max(0, savedWidth));
  return Math.floor(fittedWidth * frame.sidebarMobileWidthRatio);
}

export function sidebarGestureAxis(dx: number, dy: number): "pending" | "horizontal" | "vertical" {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < MOBILE_GESTURE_DEADZONE) return "pending";
  if (Math.abs(dx) > Math.abs(dy) * 1.25) return "horizontal";
  if (Math.abs(dy) > Math.abs(dx) * 1.25) return "vertical";
  return "pending";
}

export type MobileGestureOwner = "pending" | "sidebar" | "content" | "native";
export interface GestureSample { x: number; time: number }

/** CSS pixels and monotonic event timestamps; shared by recognition and release. */
export const MOBILE_GESTURE_COMPETITION = {
  distance: 28, velocity: 0.65, directionRatio: 1.8, sampleWindow: 80, decisionWindow: 100,
} as const;

export function mobileGestureVelocity(samples: readonly GestureSample[], x: number, time: number): number {
  const cutoff = time - MOBILE_GESTURE_COMPETITION.sampleWindow;
  let first = samples[0];
  if (!first || first.time >= time) return 0;
  for (const sample of samples.slice(1)) {
    if (sample.time > cutoff) break;
    first = sample;
  }
  const next = samples.find(sample => sample.time > first!.time) ?? { x, time };
  if (first.time < cutoff && next.time > cutoff) {
    first = { x: first.x + (next.x - first.x) * (cutoff - first.time) / (next.time - first.time), time: cutoff };
  }
  return (x - first.x) / Math.max(1, time - first.time);
}

/** Admission measures motion segments; contact latency cannot dilute later speed. */
export function mobileGestureAdmissionVelocity(samples: readonly GestureSample[], x: number, time: number, motionStartedAt: number | null): number | null {
  if (motionStartedAt === null) return null;
  const moving = samples.filter(sample => sample.time >= motionStartedAt);
  if (moving.length) return mobileGestureVelocity(moving, x, time);
  // A prompt first sample can prove a flick, but a low estimate cannot prove
  // reading intent: the browser may have delayed/coalesced the initial move.
  const first = samples[0];
  return first && time - first.time <= MOBILE_GESTURE_COMPETITION.sampleWindow
    ? mobileGestureVelocity(samples, x, time) : null;
}

/** Preserve the sidebar's existing 100ms release sampling independently of admission. */
export function sidebarReleaseVelocity(samples: readonly GestureSample[], x: number, time: number): number {
  const last = samples[samples.length - 1];
  const first = last && samples.find(sample => sample.time >= last.time - 100);
  return first && time > first.time ? (x - first.x) / (time - first.time) : 0;
}

/** Only pending contacts compete. A committed owner keeps the contact on reversal. */
export function arbitrateMobileGesture(input: {
  owner: MobileGestureOwner; dx: number; dy: number; elapsed: number; velocity: number | null;
  sidebarAllowed: boolean; initiallyOpen: boolean; horizontalContent: boolean; contentCanScroll: boolean; ended?: boolean;
}): MobileGestureOwner {
  if (input.owner !== "pending") return input.owner;
  const { dx, dy } = input;
  const axis = sidebarGestureAxis(dx, dy);
  if (axis === "vertical") return "native";
  if (axis === "pending") return "pending";
  if (!input.sidebarAllowed || (!input.initiallyOpen && dx * MOBILE_SIDEBAR_REVEAL_DIRECTION <= 0)) {
    return input.horizontalContent ? "content" : "native";
  }
  if (!input.horizontalContent || !input.contentCanScroll) return "sidebar";
  if (input.ended) return "content";
  // A rested contact can deliver its first movement as a coalesced sample.
  // Wait for a timed motion segment instead of treating missing speed as slow.
  const policy = MOBILE_GESTURE_COMPETITION;
  if (input.velocity !== null && Math.abs(dx) >= policy.distance && input.elapsed <= policy.decisionWindow
    && Math.abs(dx) >= Math.abs(dy) * policy.directionRatio
    && Math.sign(dx) * input.velocity >= policy.velocity) return "sidebar";
  // Distance proves sufficient travel, not slow intent. Keep observing until
  // the bounded motion window expires; content has not moved while pending.
  if (input.elapsed >= policy.decisionWindow) return "content";
  return "pending";
}

export function sidebarGestureProgress(start: number, dx: number, width: number): number {
  return Math.max(0, Math.min(1, start + MOBILE_SIDEBAR_REVEAL_DIRECTION * dx / Math.max(1, width)));
}

/** Velocity is measured in reveal-direction px/ms over the last touch samples. */
export function sidebarGestureTarget(progress: number, velocity: number, travel: number, initiallyOpen: boolean): boolean {
  if (Math.abs(travel) >= 24 && Math.abs(velocity) >= 0.45) return velocity > 0;
  return progress >= (initiallyOpen ? 0.58 : 0.42);
}
