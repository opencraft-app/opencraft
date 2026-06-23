import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("velaDesktop", {
  getDesktopInfo: () => ipcRenderer.invoke("vela:desktop-info"),
});

