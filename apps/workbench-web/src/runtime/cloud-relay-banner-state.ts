export interface CloudRelayPairingBannerState {
  readonly phase: "idle" | "redeeming" | "pending_approval" | "connected" | "error";
  readonly shortCode?: string;
  readonly machineId?: string;
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
