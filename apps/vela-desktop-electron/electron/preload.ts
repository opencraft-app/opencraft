import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("velaDesktop", {
  getDesktopInfo: () => ipcRenderer.invoke("vela:desktop-info"),
  retryDesktopBootstrap: () => ipcRenderer.invoke("vela:desktop-bootstrap-retry"),
  getVelaEngineSettings: () => ipcRenderer.invoke("vela:engine-settings-get"),
  setVelaEngineSettings: (patch: unknown) =>
    ipcRenderer.invoke("vela:engine-settings-set", patch),
  getDesktopChromeState: () => ipcRenderer.invoke("vela:desktop-chrome-state"),
  leaveFullscreen: () => ipcRenderer.invoke("vela:desktop-leave-fullscreen"),
  openWorkMonitor: (sessionId: string) =>
    ipcRenderer.invoke("vela:work-monitor-open", sessionId),
  hideWorkMonitor: () => ipcRenderer.invoke("vela:work-monitor-hide"),
  moveWorkMonitorBy: (deltaX: number, deltaY: number) =>
    ipcRenderer.invoke("vela:work-monitor-move-by", deltaX, deltaY),
  focusDesktopSession: (sessionId: string) =>
    ipcRenderer.invoke("vela:desktop-focus-session", sessionId),
  onDesktopChromeStateChange: (listener: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("vela:desktop-chrome-state", handler);
    return () => ipcRenderer.removeListener("vela:desktop-chrome-state", handler);
  },
  onOpenDesktopSession: (listener: (sessionId: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, sessionId: unknown) => listener(sessionId);
    ipcRenderer.on("vela:desktop-open-session", handler);
    return () => ipcRenderer.removeListener("vela:desktop-open-session", handler);
  },
});
