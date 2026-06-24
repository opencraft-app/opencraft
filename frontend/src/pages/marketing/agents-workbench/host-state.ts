import {
  createBrowserVelaClientStateStore,
  createBrowserVelaSessionSelectionStore,
  createBrowserVelaShellLayoutStore,
  type VelaClientStateStore,
  type VelaSessionSelectionStore,
  type VelaShellLayoutStore,
} from "velachat/packages/vela-chat-host-state/src";

export interface WorkbenchDesktopHostStateStores {
  clientStateStore: VelaClientStateStore | null;
  sessionSelectionStore: VelaSessionSelectionStore | null;
  shellLayoutStore: VelaShellLayoutStore | null;
}

const WORKBENCH_HOST_STATE_ID = "mono2-vela-workbench";

export function createWorkbenchDesktopHostStateStores(): WorkbenchDesktopHostStateStores {
  return {
    clientStateStore: createBrowserVelaClientStateStore({
      hostId: WORKBENCH_HOST_STATE_ID,
    }),
    sessionSelectionStore: createBrowserVelaSessionSelectionStore({
      hostId: WORKBENCH_HOST_STATE_ID,
    }),
    shellLayoutStore: createBrowserVelaShellLayoutStore({
      hostId: WORKBENCH_HOST_STATE_ID,
    }),
  };
}
