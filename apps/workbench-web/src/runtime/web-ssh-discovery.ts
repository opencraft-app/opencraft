import type { SshDiscoveryLifecycle } from "@opencraft/plugin-builtin-agents";

/** Browser mechanics only; discovery policy and state belong to the controller. */
export const webSshDiscoveryLifecycle: SshDiscoveryLifecycle = {
  isActive: () => document.visibilityState !== "hidden" && navigator.onLine !== false,
  subscribeWake(listener) {
    window.addEventListener("online", listener);
    window.addEventListener("pageshow", listener);
    document.addEventListener("visibilitychange", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("pageshow", listener);
      document.removeEventListener("visibilitychange", listener);
    };
  },
  schedule(listener, delayMs) {
    const timer = window.setTimeout(listener, delayMs);
    return () => window.clearTimeout(timer);
  },
};
