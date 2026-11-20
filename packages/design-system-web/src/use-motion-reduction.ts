import { useSyncExternalStore } from "react";

export const motionReductionQuery = "(prefers-reduced-motion: reduce)";
const snapshot = () => typeof window !== "undefined" && window.matchMedia(motionReductionQuery).matches;
const serverSnapshot = () => false;
function subscribe(change: () => void) {
  const preference = window.matchMedia(motionReductionQuery);
  preference.addEventListener("change", change);
  return () => preference.removeEventListener("change", change);
}

/** A live system preference; mounted controls stop motion without remounting. */
export function useMotionReduction(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
