import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("velaDesktop", {
  getDesktopInfo: () => ipcRenderer.invoke("vela:desktop-info"),
  retryDesktopBootstrap: () => ipcRenderer.invoke("vela:desktop-bootstrap-retry"),
  getDesktopChromeState: () => ipcRenderer.invoke("vela:desktop-chrome-state"),
  leaveFullscreen: () => ipcRenderer.invoke("vela:desktop-leave-fullscreen"),
  onDesktopChromeStateChange: (listener: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("vela:desktop-chrome-state", handler);
    return () => ipcRenderer.removeListener("vela:desktop-chrome-state", handler);
  },
});
