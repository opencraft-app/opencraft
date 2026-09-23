import { useEffect, useSyncExternalStore } from "react";
import { installConsoleShowCommand, isConsoleShowEnabled, subscribeConsoleShow } from "@/lib/console-show-event";

const productionHosts = new Set([
  "lightvela.com", "www.lightvela.com",
  "lightvela.tencent.com", "www.lightvela.tencent.com",
]);

const subscribe = (notify: () => void) => subscribeConsoleShow(notify);

// UI rollout only: international production and test/preview hosts show backend-approved
// targets; domestic production still requires the shared console show() command.
// The backend remains authoritative for eligibility and checkout.
export function usePassUpgradeVisible(): boolean {
  const isProduction = typeof window !== "undefined" && productionHosts.has(window.location.hostname.toLowerCase());
  useEffect(() => isProduction ? installConsoleShowCommand() : undefined, [isProduction]);
  return useSyncExternalStore(subscribe, () => !isProduction || isConsoleShowEnabled(), () => false);
}
