import { useSyncExternalStore } from 'react';

/** UI rollout only. Server ownership, eligibility and payment checks remain authoritative. */
let revealed = false;
const listeners = new Set<() => void>();
const setVisible = (value: boolean) => {
  revealed = value;
  listeners.forEach((listener) => listener());
};
if (typeof window !== 'undefined') {
  Object.assign(window, { show: () => setVisible(true), hide: () => setVisible(false) });
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const testingHosts = new Set(['localhost', '127.0.0.1', 'lightclaw.pages.dev']);
const productionHosts = new Set(['lightvela.com', 'www.lightvela.com', 'lightvela.ai', 'www.lightvela.ai']);

export function isPassUpgradeVisible(
  userId: string | null | undefined,
  hostname = typeof location === 'undefined' ? '' : location.hostname,
): boolean {
  if (!userId) return false;
  if (testingHosts.has(hostname)) return true;
  return productionHosts.has(hostname) && revealed;
}

export function usePassUpgradeVisible(userId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isPassUpgradeVisible(userId), () => false);
}
