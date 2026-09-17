import { contextBridge, ipcRenderer } from "electron";
import type { NativeSpeechEvent, NativeSpeechOptions, NativeSpeechPreferences } from "@opencraft/app-host-protocol";
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
  ...(process.platform === "darwin" ? { speech: Object.freeze({
    probe: (language?: string) => ipcRenderer.invoke("opencraft:speech-probe", language),
    readPreferences: () => ipcRenderer.invoke("opencraft:speech-preferences-read"),
    writePreferences: (value: NativeSpeechPreferences) => ipcRenderer.invoke("opencraft:speech-preferences-write", value),
    start: (id: string, options: NativeSpeechOptions) => ipcRenderer.invoke("opencraft:speech-start", id, options),
    stop: (id: string) => ipcRenderer.invoke("opencraft:speech-stop", id),
    cancel: (id: string) => ipcRenderer.invoke("opencraft:speech-cancel", id),
    onEvent: (listener: (event: NativeSpeechEvent) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, packet: NativeSpeechEvent) => listener(packet);
      ipcRenderer.on("opencraft:speech-event", receive); return () => ipcRenderer.off("opencraft:speech-event", receive);
    },
  }) } : {}),
  projects: Object.freeze({
    pickDirectory: () => ipcRenderer.invoke("opencraft:project-folder-pick"),
  }),
  browserState: Object.freeze({
    read: () => ipcRenderer.invoke("opencraft:browser-state-read"),
    write: (key: string, value: string) => ipcRenderer.invoke("opencraft:browser-state-write", key, value),
  }),
  browser: Object.freeze({
    trackPointer: (guestId: number, trackingId: string, enabled: boolean) => ipcRenderer.invoke("opencraft:browser-track-pointer", guestId, trackingId, enabled),
    onPointer: (listener: (event: { guestId: number; trackingId: string; x: number; y: number; leave: boolean }) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
      ipcRenderer.on("opencraft:browser-pointer", receive);
      return () => ipcRenderer.off("opencraft:browser-pointer", receive);
    },
    clearClosedData: () => ipcRenderer.invoke("opencraft:browser-clear-closed-data"),
    siteSettings: (guestId: number, action: "permissions" | "clear-data") => ipcRenderer.invoke("opencraft:browser-site-settings", guestId, action),
    onNewWindow: (listener: (event: { guestId: number; url: string; background: boolean }) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, payload: { guestId: number; url: string; background: boolean }) => listener(payload);
      ipcRenderer.on("opencraft:browser-new-window", receive);
      return () => ipcRenderer.off("opencraft:browser-new-window", receive);
    },
  }),
  platform: process.platform,
  versions: Object.freeze({ electron: process.versions.electron }),
  lightvelaAccount: Object.freeze({
    async signIn(region: "cn" | "intl") {
      const result = await ipcRenderer.invoke("vela:lightvela-login", region);
      if (!result.ok) throw new Error(result.error);
      return result.session;
    },
    cancel: () => ipcRenderer.invoke("vela:lightvela-login-cancel"),
    readSession: () => ipcRenderer.invoke("vela:lightvela-session-read"),
    clearSession: () => ipcRenderer.invoke("vela:lightvela-session-clear"),
    signOut: () => ipcRenderer.invoke("vela:lightvela-sign-out"),
    request: (input: { url: string; method: string; contentType?: string; body?: Uint8Array }) => ipcRenderer.invoke("vela:lightvela-account-request", input),
  }),
  getWindowFullscreen(): boolean {
    return ipcRenderer.sendSync("vela:get-window-fullscreen") === true;
  },
  getWindowFocused(): boolean { return ipcRenderer.sendSync("opencraft:window-focused") === true; },
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
