import {
  createBrowserVelaClientStateStore,
  createBrowserVelaSessionSelectionStore,
  createBrowserVelaShellLayoutStore,
  type VelaClientStateStore,
  type VelaSessionSelectionStore,
  type VelaShellLayoutStore,
} from "../../../packages/vela-chat-host-state/src";

export interface DesktopHostStateStores {
  clientStateStore: VelaClientStateStore | null;
  sessionSelectionStore: VelaSessionSelectionStore | null;
  shellLayoutStore: VelaShellLayoutStore | null;
}

const DESKTOP_HOST_STATE_ID = "vela-desktop";

export function createDesktopHostStateStores(): DesktopHostStateStores {
  return {
    clientStateStore: createBrowserVelaClientStateStore({
      hostId: DESKTOP_HOST_STATE_ID,
    }),
    sessionSelectionStore: createBrowserVelaSessionSelectionStore({
      hostId: DESKTOP_HOST_STATE_ID,
    }),
    shellLayoutStore: createBrowserVelaShellLayoutStore({
      hostId: DESKTOP_HOST_STATE_ID,
    }),
  };
}
