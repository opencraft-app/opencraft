import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const snapshot = () => typeof window !== "undefined" && window.matchMedia(query).matches;
const serverSnapshot = () => false;
function subscribe(change: () => void) {
  const preference = window.matchMedia(query);
  preference.addEventListener("change", change);
  return () => preference.removeEventListener("change", change);
}

/** A live system preference; mounted controls stop motion without remounting. */
export function useMotionReduction(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
