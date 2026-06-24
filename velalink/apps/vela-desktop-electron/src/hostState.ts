import {
  createBrowserVelaClientStateStore,
  createBrowserVelaSessionSelectionStore,
  createBrowserVelaShellLayoutStore,
  type VelaClientStateStore,
  type VelaSessionSelectionStore,
  type VelaShellLayoutStore,
} from "../../../packages/vela-chat-host-state/src";

export interface RuntimeHostStateStores {
  clientStateStore: VelaClientStateStore | null;
  sessionSelectionStore: VelaSessionSelectionStore | null;
  shellLayoutStore: VelaShellLayoutStore | null;
}

const RUNTIME_HOST_STATE_ID = "vela-desktop";

export function createRuntimeHostStateStores(): RuntimeHostStateStores {
  return {
    clientStateStore: createBrowserVelaClientStateStore({
      hostId: RUNTIME_HOST_STATE_ID,
    }),
    sessionSelectionStore: createBrowserVelaSessionSelectionStore({
      hostId: RUNTIME_HOST_STATE_ID,
    }),
    shellLayoutStore: createBrowserVelaShellLayoutStore({
      hostId: RUNTIME_HOST_STATE_ID,
    }),
  };
}

export const createDesktopHostStateStores = createRuntimeHostStateStores;
