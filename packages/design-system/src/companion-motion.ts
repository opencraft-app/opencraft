import type { CompanionKind } from "./companion-artwork";

/** Identity, activity and rendering policy are independent. Idle history stays still. */
export type CompanionActivity = "rest" | "working" | "waiting";
export const companionMotionPolicy = Object.freeze({
  workingFps: 24,
  waitingFps: 12,
  maxConcurrent: 4,
  updatesPerSecond: 96,
  frameWorkMs: 2,
});
const gestures: Record<CompanionKind, { period: number; lift: number; tilt: number; stretch: number }> = {
  bean: { period: 2200, lift: 1.8, tilt: 3, stretch: 0.018 },
  sprout: { period: 2600, lift: 0.8, tilt: 5, stretch: 0.012 },
  bun: { period: 1800, lift: 1.3, tilt: 1, stretch: 0.035 },
  lamp: { period: 2800, lift: 0.7, tilt: 2, stretch: 0.012 },
  cloud: { period: 3200, lift: 2.2, tilt: 1.5, stretch: 0.016 },
  star: { period: 2400, lift: 1.2, tilt: 5, stretch: 0.015 },
};
export interface CompanionPose {
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  eyeScale: number;
}
export const restingCompanionPose: CompanionPose = Object.freeze({
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  eyeScale: 1,
});
/** Deterministic phase; no randomness, layout reads, state mutation or platform APIs. */
export function companionPose(
  kind: CompanionKind,
  activity: CompanionActivity,
  elapsedMs: number,
  phase = 0,
): CompanionPose {
  if (activity === "rest" || elapsedMs <= 0) return restingCompanionPose;
  const gesture = gestures[kind],
    calm = activity === "waiting" ? 0.35 : 1;
  const t = Math.max(0, elapsedMs),
    wave = Math.sin((t / gesture.period) * Math.PI * 2 + phase);
  // Enter gently from the resting geometry. Every avatar can retain its own phase.
  const envelope = Math.min(1, t / 240),
    amplitude = calm * envelope;
  const blinkPhase = (t + phase * 317) % 4600;
  const blink = blinkPhase > 4050 && blinkPhase < 4250 ? Math.sin(((blinkPhase - 4050) / 200) * Math.PI) : 0;
  return {
    y: -wave * gesture.lift * amplitude,
    rotation: wave * gesture.tilt * amplitude,
    scaleX: 1 + wave * gesture.stretch * amplitude,
    scaleY: 1 - wave * gesture.stretch * amplitude,
    eyeScale: 1 - blink * 0.88 * envelope,
  };
}
