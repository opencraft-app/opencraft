import { useEffect, useSyncExternalStore } from "react";
import { installConsoleShowCommand, isConsoleShowEnabled, subscribeConsoleShow } from "@/lib/console-show-event";

const productionHosts = new Set([
  "lightvela.com", "www.lightvela.com",
  "lightvela.tencent.com", "www.lightvela.tencent.com",
  "lightvela.ai", "www.lightvela.ai",
]);

const subscribe = (notify: () => void) => subscribeConsoleShow(notify);

// Restrictive production UI rollout: only existing within-SP tier upgrades are
// public. This does not grant eligibility; CTL still validates source and target.
const productionSameSPTargets: Readonly<Record<string, string>> = {
  bundle_launch_01: "bundle_cruise_01",
  bundle_launch_ai_01: "bundle_cruise_ai_01",
};

export function isPassUpgradeTargetVisible(sourceBundleID: string, targetBundleID: string, revealAll: boolean): boolean {
  return revealAll || productionSameSPTargets[sourceBundleID] === targetBundleID;
}

// Test/preview hosts expose all server-approved targets. Production exposes
// only same-SP tier upgrades until console show() reveals the other targets.
// The backend remains authoritative for all paths.
export function usePassUpgradeVisible(): boolean {
  const isProduction = typeof window !== "undefined" && productionHosts.has(window.location.hostname.toLowerCase());
  useEffect(() => isProduction ? installConsoleShowCommand() : undefined, [isProduction]);
  return useSyncExternalStore(subscribe, () => !isProduction || isConsoleShowEnabled(), () => false);
}
