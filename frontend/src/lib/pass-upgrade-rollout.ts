import { useEffect, useSyncExternalStore } from "react";
import { isGlobal } from "@/lib/region";
import { registerWindowCommand } from "@/lib/window-command-chain";

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
  const removeShow = registerWindowCommand(window, "show", (next, ...args) => {
    setVisible(true);
    return next(...args) ?? true;
  });
  const removeHide = registerWindowCommand(window, "hide", (next, ...args) => {
    setVisible(false);
    return next(...args) ?? true;
  });
  return () => {
    removeShow();
    removeHide();
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
