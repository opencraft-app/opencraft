import { contextBridge, ipcRenderer } from "electron";
import {
  CONNECT_APP_HOST_MESSAGE,
  isConnectAppHostMessage,
} from "@opencraft/app-host-protocol";

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isConnectAppHostMessage(event.data) || event.ports.length !== 1) return;
  ipcRenderer.postMessage(CONNECT_APP_HOST_MESSAGE, event.data, [event.ports[0]!]);
});

contextBridge.exposeInMainWorld("opencraftDesktop", Object.freeze({
  kind: "electron",
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron }),
  getWindowFullscreen(): boolean {
    return ipcRenderer.sendSync("vela:get-window-fullscreen") === true;
  },
  onWindowFullscreenChanged(listener: (isFullScreen: boolean) => void) {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: { readonly isFullScreen: boolean },
    ) => listener(payload.isFullScreen);
    ipcRenderer.on("vela:window-fullscreen-changed", receive);
    return () => ipcRenderer.off("vela:window-fullscreen-changed", receive);
  },
  setWindowAppearance(appearance: {
    readonly themeSource: "system" | "light" | "dark";
    readonly resolvedTheme: "light" | "dark";
  }): void {
    ipcRenderer.send("vela:set-window-appearance", appearance);
  },
}));
