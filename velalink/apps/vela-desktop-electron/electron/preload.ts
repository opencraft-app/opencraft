import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("velaDesktop", {
  getDesktopInfo: () => ipcRenderer.invoke("vela:desktop-info"),
  retryDesktopBootstrap: () => ipcRenderer.invoke("vela:desktop-bootstrap-retry"),
  getDesktopSettings: () => ipcRenderer.invoke("vela:desktop-settings-get"),
  setDesktopSettings: (patch: unknown) =>
    ipcRenderer.invoke("vela:desktop-settings-set", patch),
  getDesktopChromeState: () => ipcRenderer.invoke("vela:desktop-chrome-state"),
  leaveFullscreen: () => ipcRenderer.invoke("vela:desktop-leave-fullscreen"),
  selectWorkingDirectory: () =>
    ipcRenderer.invoke("vela:desktop-select-working-directory"),
  showPathInFolder: (path: string) =>
    ipcRenderer.invoke("vela:desktop-show-path-in-folder", path),
  openWorkMonitor: (sessionId: string) =>
    ipcRenderer.invoke("vela:work-monitor-open", sessionId),
  closeWorkMonitor: () => ipcRenderer.invoke("vela:work-monitor-close"),
  moveWorkMonitorBy: (deltaX: number, deltaY: number) =>
    ipcRenderer.invoke("vela:work-monitor-move-by", deltaX, deltaY),
  startSessionDragPreview: (sessionId: string, screenX: number, screenY: number) =>
    ipcRenderer.invoke("vela:session-drag-preview-start", sessionId, screenX, screenY),
  moveSessionDragPreview: (screenX: number, screenY: number) =>
    ipcRenderer.invoke("vela:session-drag-preview-move", screenX, screenY),
  endSessionDragPreview: () => ipcRenderer.invoke("vela:session-drag-preview-end"),
  isMacosSpeechAvailable: () => ipcRenderer.invoke("vela:voice-macos-available"),
  startMacosSpeech: (options: unknown) =>
    ipcRenderer.invoke("vela:voice-macos-start", options),
  stopMacosSpeech: () => ipcRenderer.invoke("vela:voice-macos-stop"),
  onMacosSpeechEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on("vela:voice-macos-event", handler);
    return () => ipcRenderer.removeListener("vela:voice-macos-event", handler);
  },
  onDesktopChromeStateChange: (listener: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("vela:desktop-chrome-state", handler);
    return () => ipcRenderer.removeListener("vela:desktop-chrome-state", handler);
  },
});
