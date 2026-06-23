import {
  createBrowserVelaClientStateStore,
  createBrowserVelaShellLayoutStore,
  type VelaClientStateStore,
  type VelaShellLayoutStore,
} from "../../../packages/vela-chat-host-state/src";

export interface DesktopHostStateStores {
  clientStateStore: VelaClientStateStore | null;
  shellLayoutStore: VelaShellLayoutStore | null;
}

const DESKTOP_HOST_STATE_ID = "vela-desktop";

export function createDesktopHostStateStores(): DesktopHostStateStores {
  return {
    clientStateStore: createBrowserVelaClientStateStore({
      hostId: DESKTOP_HOST_STATE_ID,
    }),
    shellLayoutStore: createBrowserVelaShellLayoutStore({
      hostId: DESKTOP_HOST_STATE_ID,
    }),
  };
}
