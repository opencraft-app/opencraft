export type MobileShellSwipeTarget = "navigation" | "panel" | "none";
export type MobileShellSwipeAdmission = "pending" | "content" | Exclude<MobileShellSwipeTarget, "none">;

/** Logical points, independent of device/window width. Ambiguous motion stays with content. */
export const MOBILE_SHELL_SWIPE_THRESHOLDS = {
  horizontalDistance: 18,
  verticalDistance: 10,
  horizontalDominance: 1.5,
} as const;

/** Admission is sticky until release; a vertical stroke cannot turn into a Shell swipe. */
export function resolveMobileShellSwipeAdmission(input: {
  owner: MobileShellSwipeAdmission; translationX: number; translationY: number;
  touchCount: number; contentOwned: boolean; navigationProgress: number;
  docked: boolean; panelAvailable: boolean; panelOpen: boolean;
}): MobileShellSwipeAdmission {
  "worklet";
  if (input.touchCount !== 1) return "content";
  if (input.owner !== "pending") return input.owner;
  if (input.contentOwned) return "content";
  const x = Math.abs(input.translationX), y = Math.abs(input.translationY);
  const thresholds = MOBILE_SHELL_SWIPE_THRESHOLDS;
  if (y >= thresholds.verticalDistance && x < y * thresholds.horizontalDominance) return "content";
  if (x < thresholds.horizontalDistance || x < y * thresholds.horizontalDominance) return "pending";
  const target = resolveMobileShellSwipeTarget(input);
  return target === "none" ? "content" : target;
}

/** A contact gets one owner; closing the left drawer cannot also open the right. */
export function resolveMobileShellSwipeTarget(input: {
  navigationProgress: number; docked: boolean; panelAvailable: boolean;
  panelOpen: boolean; translationX: number; contentOwned: boolean;
}): MobileShellSwipeTarget {
  "worklet";
  if (input.contentOwned) return "none";
  if (!input.docked && input.navigationProgress > 0.001) {
    return input.navigationProgress >= 0.999 && input.translationX > 0 ? "none" : "navigation";
  }
  if (input.panelAvailable && input.panelOpen) return "panel";
  if (input.translationX < 0) return input.panelAvailable ? "panel" : "none";
  return input.docked ? "none" : "navigation";
}
