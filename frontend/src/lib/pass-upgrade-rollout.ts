import { useEffect, useSyncExternalStore } from "react";
import { isGlobal } from "@/lib/region";

// UI rollout only: server eligibility and payment checks remain authoritative.
// Keep opt-in within this document, including SPA navigation; never persist it.
let revealed = false;
const listeners = new Set<() => void>();
const setVisible = (value: boolean) => {
  if (revealed === value) return;
  revealed = value;
  listeners.forEach(listener => listener());
};

function installConsoleCommands() {
  if (!isGlobal) return;
  const host = window as Window & {
    show?: (...args: unknown[]) => unknown;
    hide?: (...args: unknown[]) => unknown;
  };
  const originalShow = host.show;
  const originalHide = host.hide;
  const show = (...args: unknown[]) => {
    setVisible(true);
    return originalShow?.apply(host, args) ?? true;
  };
  const hide = (...args: unknown[]) => {
    setVisible(false);
    return originalHide?.apply(host, args) ?? true;
  };
  host.show = show;
  host.hide = hide;
  return () => {
    if (host.show === show) {
      if (originalShow === undefined) delete host.show;
      else host.show = originalShow;
    }
    if (host.hide === hide) {
      if (originalHide === undefined) delete host.hide;
      else host.hide = originalHide;
    }
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function usePassUpgradeVisible(): boolean {
  useEffect(installConsoleCommands, []);
  return useSyncExternalStore(subscribe, () => !isGlobal || revealed, () => !isGlobal);
}
