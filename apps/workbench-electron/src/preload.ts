import { createDesktopPreload } from "./desktop-product-preload-entry.js";
import { composeDesktopBridge } from "./desktop-product-lifetime.js";
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

contextBridge.exposeInMainWorld("opencraftDesktop", composeDesktopBridge({
  kind: "electron",
  locale: Object.freeze({
    getSystemLocale: () => ipcRenderer.invoke("opencraft:system-locale"),
    setApplicationLocale: (locale: string) => ipcRenderer.invoke("opencraft:application-locale", locale),
  }),
  extensionData: Object.freeze({
    read: (scope: string) => ipcRenderer.invoke("opencraft:extension-data-read", scope),
    compareAndSet: (scope: string, revision: number, version: number, value: unknown) => ipcRenderer.invoke("opencraft:extension-data-commit", scope, revision, version, value),
    subscribe: (listener: (scope: string) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, scope: string) => listener(scope);
      ipcRenderer.on("opencraft:extension-data-changed", receive);
      return () => ipcRenderer.off("opencraft:extension-data-changed", receive);
    },
  }),
  connectorConfiguration: Object.freeze({
    load: () => ipcRenderer.invoke("opencraft:connector-configuration-load"),
    compareAndSet: (revision: number, value: unknown) => ipcRenderer.invoke("opencraft:connector-configuration-save", revision, value),
    subscribe: (listener: () => void) => {
      const receive = () => listener();
      ipcRenderer.on("opencraft:connector-configuration-changed", receive);
      return () => ipcRenderer.off("opencraft:connector-configuration-changed", receive);
    },
  }),
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
  sqliteDebug: Object.freeze({
    list: () => ipcRenderer.invoke("opencraft:sqlite-debug-list"),
    tables: (databaseId: string) => ipcRenderer.invoke("opencraft:sqlite-debug-tables", databaseId),
    rows: (databaseId: string, table: string, offset: number, limit: number) =>
      ipcRenderer.invoke("opencraft:sqlite-debug-rows", databaseId, table, offset, limit),
  }),
  uiPreferences: Object.freeze({
    load: (key: string) => ipcRenderer.invoke("opencraft:ui-preference-load", key),
    compareAndSet: (key: string, expectedRevision: number, valueJson: string) =>
      ipcRenderer.invoke("opencraft:ui-preference-compare-and-set", key, expectedRevision, valueJson),
    subscribe: (listener: (key: string) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, key: string) => listener(key);
      ipcRenderer.on("opencraft:ui-preference-changed", receive);
      return () => ipcRenderer.off("opencraft:ui-preference-changed", receive);
    },
  }),
  skillHub: Object.freeze({
    get: (path: string) => ipcRenderer.invoke("opencraft:skillhub-get", path),
  }),
  browserState: Object.freeze({
    read: () => ipcRenderer.invoke("opencraft:browser-state-read"),
    write: (key: string, value: string) => ipcRenderer.invoke("opencraft:browser-state-write", key, value),
  }),
  remoteBrowserMenu: Object.freeze({
    show: (id: string, x: number, y: number, items: readonly { id: string; label: string; enabled: boolean }[]) =>
      ipcRenderer.invoke('opencraft:remote-browser-menu-show', id, x, y, items),
    cancel: (id: string) => { void ipcRenderer.invoke('opencraft:remote-browser-menu-cancel', id).catch(() => {}); },
    writeClipboard: (data: { text?: string; html?: string }) => ipcRenderer.invoke('opencraft:remote-browser-clipboard-write', data),
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
  getWindowFullscreen(): boolean {
    return ipcRenderer.sendSync("opencraft:get-window-fullscreen") === true;
  },
  getWindowFocused(): boolean { return ipcRenderer.sendSync("opencraft:window-focused") === true; },
  onWindowFullscreenChanged(listener: (isFullScreen: boolean) => void) {
    const receive = (
      _event: Electron.IpcRendererEvent,
      payload: { readonly isFullScreen: boolean },
    ) => listener(payload.isFullScreen);
    ipcRenderer.on("opencraft:window-fullscreen-changed", receive);
    return () => ipcRenderer.off("opencraft:window-fullscreen-changed", receive);
  },
  setWindowAppearance(appearance: import("@opencraft/design-system/theme-options").ThemeWindowAppearance): void {
    ipcRenderer.send("opencraft:set-window-appearance", appearance);
  },
}, createDesktopPreload(ipcRenderer)));
