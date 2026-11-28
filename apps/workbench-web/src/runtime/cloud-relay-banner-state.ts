export interface CloudRelayPairingBannerState {
  readonly phase: "idle" | "redeeming" | "pending_approval" | "connected" | "offline" | "error";
  readonly shortCode?: string;
  readonly machineId?: string;
  readonly machineName?: string;
  readonly relayOrigin?: string;
  readonly errorMessage?: string;
}

let pairingBannerState: CloudRelayPairingBannerState = { phase: "idle" };
const pairingBannerListeners = new Set<() => void>();

export function setCloudRelayPairingState(next: CloudRelayPairingBannerState): void {
  pairingBannerState = next;
  for (const listener of pairingBannerListeners) listener();
}

export function getCloudRelayPairingState(): CloudRelayPairingBannerState {
  return pairingBannerState;
}

export function subscribeCloudRelayPairingState(listener: () => void): () => void {
  pairingBannerListeners.add(listener);
  return () => pairingBannerListeners.delete(listener);
}

export function dismissCloudRelayPairingState(): void {
  setCloudRelayPairingState({ phase: "idle" });
}

let standalonePortalOpen = (() => {
  try {
    return (
      typeof window !== "undefined" &&
      (window.location.pathname.replace(/\/+$/u, "") === "/claim" ||
        window.sessionStorage.getItem("opencraft.pending-claim-href") !== null)
    );
  } catch {
    return false;
  }
})();

const standalonePortalListeners = new Set<() => void>();

export function getCloudRelayStandalonePortalOpen(): boolean {
  return standalonePortalOpen;
}

export function openCloudRelayStandalonePortal(): void {
  if (standalonePortalOpen) return;
  standalonePortalOpen = true;
  for (const listener of standalonePortalListeners) listener();
}

export function closeCloudRelayStandalonePortal(): void {
  if (!standalonePortalOpen) return;
  standalonePortalOpen = false;
  for (const listener of standalonePortalListeners) listener();
}

export function subscribeCloudRelayStandalonePortal(listener: () => void): () => void {
  standalonePortalListeners.add(listener);
  return () => standalonePortalListeners.delete(listener);
}
