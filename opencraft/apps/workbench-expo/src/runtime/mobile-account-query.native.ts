import { QueryClient, focusManager, onlineManager } from "@tanstack/react-query";
import * as Network from "expo-network";
import { AppState } from "react-native";
import { parseAccountProfile, type AccountProfileSource } from "@opencraft/mobile-account-sdk";
import { LIGHTVELA_REGIONS, type LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";

export const mobileAccountQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 5 * 60 * 1000,
      retry(failures, error) {
        const status = (error as { status?: unknown }).status;
        return failures < 2 && (status === undefined || status === 408 || status === 429 || (typeof status === "number" && status >= 500));
      },
      retryDelay: attempt => Math.min(1000 * 2 ** attempt, 4000),
    },
  },
});

export async function fetchMobileAccountProfile(region: LightVelaRegion, token: string): Promise<AccountProfileSource> {
  const base = LIGHTVELA_REGIONS[region].apiBase;
  const response = await fetch(`${base}/auth/profile`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) throw Object.assign(new Error("Profile unavailable"), { status: response.status });
  const payload = await response.json() as { user?: unknown };
  const profile = parseAccountProfile(payload.user);
  const absoluteUrl = (value: string | null | undefined) => value && !/^(https?:|data:)/i.test(value)
    ? new URL(value, base).href : value;
  return {
    ...profile,
    avatarUrl: absoluteUrl(profile.avatarUrl),
    pendingAvatarUrl: absoluteUrl(profile.pendingAvatarUrl),
  };
}

let started = false;
export function startMobileAccountQueryLifecycle(): void {
  if (started) return;
  started = true;
  focusManager.setEventListener(setFocused => {
    const subscription = AppState.addEventListener("change", state => setFocused(state === "active"));
    setFocused(AppState.currentState === "active");
    return () => subscription.remove();
  });
  onlineManager.setEventListener(setOnline => {
    const subscription = Network.addNetworkStateListener(state => {
      setOnline(state.isInternetReachable ?? state.isConnected ?? true);
    });
    void Network.getNetworkStateAsync().then(state => {
      setOnline(state.isInternetReachable ?? state.isConnected ?? true);
    }).catch(() => setOnline(true));
    return () => subscription.remove();
  });
}
