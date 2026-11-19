import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-density"] });
  return () => observer.disconnect();
}
/** Consume the installation preference, rather than guessing from viewport width. */
export function useTouchLayout(): boolean {
  return useSyncExternalStore(subscribe, () => document.documentElement.dataset.uiDensity === "touch", () => false);
}
