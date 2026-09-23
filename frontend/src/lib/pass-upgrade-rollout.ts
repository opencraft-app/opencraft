import { useEffect, useSyncExternalStore } from "react";
import { installConsoleShowCommand, isConsoleShowEnabled, subscribeConsoleShow } from "@/lib/console-show-event";

const productionHosts = new Set([
  "lightvela.com", "www.lightvela.com",
  "lightvela.tencent.com", "www.lightvela.tencent.com",
  "lightvela.ai", "www.lightvela.ai",
]);

const subscribe = (notify: () => void) => subscribeConsoleShow(notify);

// UI rollout only: test/preview hosts stay visible, while public production
// sites require the shared console show() command. The backend still decides
// which target bundles are eligible.
export function usePassUpgradeVisible(): boolean {
  const isProduction = typeof window !== "undefined" && productionHosts.has(window.location.hostname.toLowerCase());
  useEffect(() => isProduction ? installConsoleShowCommand() : undefined, [isProduction]);
  return useSyncExternalStore(subscribe, () => !isProduction || isConsoleShowEnabled(), () => false);
}
