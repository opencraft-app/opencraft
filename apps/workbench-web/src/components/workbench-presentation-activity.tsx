import { useSyncExternalStore } from "react";
import { usePresentationActive } from "@opencraft/react-runtime";
export { PresentationActivity as WorkbenchPresentationActivity,
  PresentationActivityProvider as WorkbenchPresentationActivityProvider } from "@opencraft/react-runtime";
const alwaysActive = () => true;
const visibilityListeners = new Set<() => void>();
const readVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
const notifyVisibility = () => { for (const listener of visibilityListeners) listener(); };
function subscribeVisibility(listener: () => void) {
  if (visibilityListeners.size === 0) document.addEventListener("visibilitychange", notifyVisibility);
  visibilityListeners.add(listener);
  return () => {
    visibilityListeners.delete(listener);
    if (visibilityListeners.size === 0) document.removeEventListener("visibilitychange", notifyVisibility);
  };
}

export function useWorkbenchPresentationActive(): boolean {
  const active = usePresentationActive();
  const visible = useSyncExternalStore(subscribeVisibility, readVisible, alwaysActive);
  return active && visible;
}
