export type HapticStyle = "light" | "medium" | "selection";

type HapticHost = { __ocHaptic?: (style: string) => void };

/** Invokes the host-provided haptic feedback bridge when available (no-op on unsupported hosts). */
export function triggerHaptic(style: HapticStyle = "selection"): void {
  const fn = (globalThis as HapticHost).__ocHaptic;
  if (typeof fn === "function") fn(style);
}

export function registerHapticHandler(handler?: (style: string) => void): void {
  (globalThis as HapticHost).__ocHaptic = handler;
}
