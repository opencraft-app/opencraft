import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isWindowAppearanceMessage, applyNativeWindowAppearance, type WindowAppearanceMessage } from "./window-appearance.js";
import { execFileSync, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { NativeSpeechManager } from "./native-speech.js";
import type { NativeSpeechInfo, NativeSpeechPreferences, NativeSpeechOptions } from "@opencraft/app-host-protocol";
import { DesktopLightVelaLogin, forwardLoginCallback } from "./lightvela-login.js";
import { createDesktopSessionStore } from "./lightvela-session-store.js";
import { desktopAccountPublicError, requestDesktopAccount, type DesktopAccountRequest } from "./lightvela-account-http.js";
import { desktopSkillHubPublicError, requestDesktopSkillHub } from "./skillhub-http.js";
import { resolveDesktopProduct } from "./product-identity.js";
import {
  prepareDesktopDirectories,
  resolveDesktopDirectoryPlan,
  type DesktopDirectoryPlan,
} from "./desktop-directories.js";
import { DesktopLifecycle } from "./desktop-lifecycle.js";
import { createDesktopTray } from "./desktop-tray.js";
import { createDesktopLocaleRuntime, requireDesktopLocale } from "./desktop-locale.js";
import { installBrowserGuests } from "./browser-guests.js";
import { createFilePrivateStorage } from "./private-storage.js";
import { BrowserPermissionPolicy } from "./browser-permissions.js";
import { ProjectFolderPicker } from "./project-folder-picker.js";
import { SqliteDebugReader } from "./sqlite-debug-reader.js";
import { DesktopUiPreferenceStore } from "./ui-preferences-store.js";
import { DesktopConnectorConfigurationStore } from "./connector-configuration-store.js";
import { SqliteDocumentStore as DesktopExtensionDataStore } from "@opencraft/document-storage/sqlite";
import { registerExtensionDataIpc } from "./extension-data-ipc.js";
import { workbenchWindowMetrics } from "@opencraft/workbench-runtime/window-metrics";
import { resolveCodexExecutable } from "./codex-executable.js";

import {
  BrowserWindow,
  Tray,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
  session,
  type MessagePortMain,
  type WebContents,
} from "electron";
import {
  CONNECT_APP_HOST_MESSAGE,
  isConnectAppHostMessage,
} from "@opencraft/app-host-protocol";

import {
  createWorkbenchStaticServer,
  type WorkbenchStaticServer,
} from "../../../scripts/serve-workbench-static.mjs";
import {
  OpenCraftDaemonClientManager,
  type OpenCraftDaemonAppHostConnection,
} from "./daemon-client.js";

// Resolve storage before requestSingleInstanceLock, session creation or the daemon.
// A brand change must not create a second runtime owner for the same local work.
const executableName = basename(process.execPath, extname(process.execPath));
const desktopProduct = resolveDesktopProduct(executableName);
app.setName(desktopProduct.displayName);
const requestedProfile = app.commandLine.getSwitchValue("user-data-dir");
const directoryPlan = resolveDesktopDirectoryPlan({
  appDataDirectory: app.getPath("appData"),
  homeDirectory: homedir(),
  product: desktopProduct,
  requestedUserDataDirectory: requestedProfile,
  requestedProductHomeDirectory: process.env.OPENCRAFT_HOME,
});
let desktopPaths!: DesktopDirectoryPlan;

let mainWindow: BrowserWindow | null = null;
let mainWebContents: WebContents | null = null;
let browserGuests: ReturnType<typeof installBrowserGuests> | null = null;
let browserPermissions!: BrowserPermissionPolicy;
let tray: Tray | null = null;
let loopbackHost: WorkbenchStaticServer | null = null;
let rendererOrigin: string | null = null;
let daemonManager: OpenCraftDaemonClientManager | null = null;
const daemonBridges = new Set<{ close(): void }>();
let desktopSessions!: ReturnType<typeof createDesktopSessionStore>;
let sqliteDebugReader!: SqliteDebugReader;
let uiPreferences!: DesktopUiPreferenceStore;
const desktopLocale = createDesktopLocaleRuntime();
let connectorConfiguration: DesktopConnectorConfigurationStore | null = null;
const connectorStore = () => connectorConfiguration ??= new DesktopConnectorConfigurationStore(join(desktopPaths.userDataDirectory, "opencraft-connectors.sqlite"));
let extensionData: DesktopExtensionDataStore | null = null;
registerExtensionDataIpc(() => extensionData ??= new DesktopExtensionDataStore(join(desktopPaths.userDataDirectory, "opencraft-extensions.sqlite")), trustedLoginCaller);
let desktopLogin!: DesktopLightVelaLogin;
let desktopLoginReady = false;
const pendingLoginCallbacks: string[] = [];
let startupCallbackFlight: Promise<boolean> | null = null;

function receiveLoginCallback(url: string): void {
  if (!desktopLoginReady) { pendingLoginCallbacks.push(url); return; }
  if (desktopLogin.receive(url)) return;
  const forwarding = forwardLoginCallback(url);
  if (mainWindow === null && daemonManager === null) startupCallbackFlight = forwarding;
}
// macOS may deliver an open-url before app.whenReady(). The live transaction
// broker also routes callbacks delivered to a different preview/profile.
app.on("open-url", (event, url) => { event.preventDefault(); receiveLoginCallback(url); });

function trustedLoginCaller(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === mainWebContents && event.senderFrame === mainWebContents?.mainFrame
    && rendererOrigin !== null && event.senderFrame?.url.startsWith(`${rendererOrigin}/`) === true;
}

function initializeDesktopProfile(paths: DesktopDirectoryPlan): void {
  desktopPaths = paths;
  app.commandLine.appendSwitch("user-data-dir", paths.userDataDirectory);
  app.setPath("userData", paths.userDataDirectory);
  process.chdir(desktopPaths.runtimeDirectory);
  browserPermissions = new BrowserPermissionPolicy({
    read: () => {
      const raw = createFilePrivateStorage(join(paths.userDataDirectory, "browser-metadata")).read("permissions");
      return raw ? JSON.parse(raw) : {};
    },
    write: value => createFilePrivateStorage(join(paths.userDataDirectory, "browser-metadata")).write("permissions", JSON.stringify(value)),
  }, async (origin, permission) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { allow: false, remember: false };
    const labels: Record<string, string> = { camera: "摄像头", microphone: "麦克风", geolocation: "位置", notifications: "通知" };
    const result = await dialog.showMessageBox(mainWindow, { type: "question",
      message: `${origin} 请求使用${labels[permission] ?? permission}`,
      detail: "只授权给当前网站。可从浏览器的“网站权限”入口撤销。",
      buttons: ["不允许", "允许"], defaultId: 0, cancelId: 0, checkboxLabel: "记住此网站的选择", checkboxChecked: false });
    return { allow: result.response === 1, remember: result.checkboxChecked };
  });
  desktopSessions = createDesktopSessionStore(paths.userDataDirectory);
  sqliteDebugReader = new SqliteDebugReader(paths.dshDataDirectory);
  uiPreferences = new DesktopUiPreferenceStore(join(paths.userDataDirectory, "opencraft-ui.sqlite"));
  speechPreferences = createFilePrivateStorage(join(paths.userDataDirectory, "voice-input"));
  desktopLogin = new DesktopLightVelaLogin({
    openExternal: url => shell.openExternal(url),
    saveSession: (value, signal) => desktopSessions.save(value, signal),
    onSuccess: () => { void ensureMainWindow().catch(() => {}); },
  });
  desktopLoginReady = true;
  for (const url of pendingLoginCallbacks.splice(0)) receiveLoginCallback(url);
}

function speechHelperPath(): string {
  // Explicit diagnostic override; never supplied by the renderer.
  return process.env.OPENCRAFT_NATIVE_SPEECH_HELPER ?? (app.isPackaged
    ? join(process.resourcesPath, "native", "opencraft-speech-helper")
    : resolve(dirname(fileURLToPath(import.meta.url)), "../build/native/opencraft-speech-helper"));
}
let speechPreferences!: ReturnType<typeof createFilePrivateStorage>;
function validateSpeechPreferences(value: unknown): asserts value is NativeSpeechPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid speech preferences");
  const entry = value as NativeSpeechPreferences;
  if (Object.keys(entry).some(key => !["deviceId", "language"].includes(key))
    || (entry.deviceId !== null && (typeof entry.deviceId !== "string" || !entry.deviceId || entry.deviceId.length > 1024))
    || (entry.language !== null && (typeof entry.language !== "string" || !/^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8})*$/.test(entry.language))))
    throw new Error("Invalid speech preferences");
}
function readSpeechPreferences(): NativeSpeechPreferences {
  const stored = speechPreferences.read("preferences");
  if (stored === null) return { deviceId: null, language: null };
  const value: unknown = JSON.parse(stored); validateSpeechPreferences(value); return value;
}
const nativeSpeech = new NativeSpeechManager({ spawn: () => spawn(speechHelperPath(), [], { stdio: "pipe" }) });
ipcMain.handle("opencraft:speech-preferences-read", event => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted speech caller"); return readSpeechPreferences();
});
ipcMain.handle("opencraft:speech-preferences-write", (event, value: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted speech caller"); validateSpeechPreferences(value);
  speechPreferences.write("preferences", JSON.stringify(value));
});
ipcMain.handle("opencraft:speech-probe", async (event, requestedLanguage: unknown) => {
  if (!trustedLoginCaller(event) || process.platform !== "darwin") throw new Error("Unsupported speech caller");
  const language = requestedLanguage ?? readSpeechPreferences().language ?? app.getLocale();
  if (typeof language !== "string" || !/^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{2,8})*$/.test(language)) throw new Error("Invalid speech language");
  const { stdout } = await promisify(execFile)(speechHelperPath(), ["--probe", language], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout) as NativeSpeechInfo;
  if (typeof info.supported !== "boolean" || typeof info.supportsOnDeviceRecognition !== "boolean" || !Array.isArray(info.devices)) throw new Error("Invalid speech metadata");
  return info;
});
ipcMain.handle("opencraft:speech-start", async (event, id: string, input: NativeSpeechOptions) => {
  if (!trustedLoginCaller(event) || process.platform !== "darwin" || !input || typeof input !== "object") throw new Error("Unsupported speech caller");
  const preferences = readSpeechPreferences();
  await nativeSpeech.start(event.sender.id, id, { language: preferences.language ?? input.language ?? app.getLocale(),
    deviceId: input.deviceId === undefined ? preferences.deviceId : input.deviceId }, packet => {
      if (!event.sender.isDestroyed()) event.sender.send("opencraft:speech-event", packet);
    });
});
ipcMain.handle("opencraft:speech-stop", (event, id: string) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted speech caller"); return nativeSpeech.stop(event.sender.id, id);
});
ipcMain.handle("opencraft:speech-cancel", (event, id: string) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted speech caller"); return nativeSpeech.cancel(event.sender.id, id);
});

const projectFolderPicker = new ProjectFolderPicker({
  open: () => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error("No active project window");
    return dialog.showOpenDialog(mainWindow, {
      title: "选择项目文件夹",
      buttonLabel: "选择文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
  },
});
ipcMain.handle("opencraft:project-folder-pick", async event => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted project picker caller");
  return projectFolderPicker.pick();
});
ipcMain.handle("opencraft:sqlite-debug-list", event => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted SQLite debug caller");
  return sqliteDebugReader.list();
});
ipcMain.handle("opencraft:sqlite-debug-tables", (event, databaseId: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted SQLite debug caller");
  return sqliteDebugReader.tables(databaseId);
});
ipcMain.handle("opencraft:sqlite-debug-rows", (event, databaseId: unknown, table: unknown, offset: unknown, limit: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted SQLite debug caller");
  return sqliteDebugReader.rows(databaseId, table, offset, limit);
});
ipcMain.handle("opencraft:connector-configuration-load", (event) => {
  if (event.sender !== mainWebContents) throw new Error("Untrusted Connector configuration request");
  return connectorStore().load();
});
ipcMain.handle("opencraft:connector-configuration-save", (event, revision: unknown, value: unknown) => {
  if (event.sender !== mainWebContents) throw new Error("Untrusted Connector configuration request");
  const result = connectorStore().compareAndSet(revision, value);
  if (result.updated) event.sender.send("opencraft:connector-configuration-changed");
  return result;
});
ipcMain.handle("opencraft:system-locale", event => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted locale caller");
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale();
});
ipcMain.handle("opencraft:application-locale", (event, value: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted locale caller");
  return desktopLocale.update({ localeOverride: requireDesktopLocale(value) });
});
ipcMain.handle("opencraft:ui-preference-load", (event, key: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted UI preference caller");
  return uiPreferences.load(key);
});
ipcMain.handle("opencraft:ui-preference-compare-and-set", (event, key: unknown, expectedRevision: unknown, valueJson: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted UI preference caller");
  const result = uiPreferences.compareAndSet(key, expectedRevision, valueJson);
  if (result.outcome === "updated" && !event.sender.isDestroyed()) {
    event.sender.send("opencraft:ui-preference-changed", result.record.key);
  }
  return result;
});

ipcMain.handle("vela:lightvela-login", async (event, region: unknown) => {
  if (!trustedLoginCaller(event)) return { ok: false, error: "Untrusted login caller" };
  if (region !== "cn" && region !== "intl") return { ok: false, error: "Invalid login region" };
  try {
    if (process.platform === "darwin" && app.isPackaged) {
      execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", [
        "-f", dirname(dirname(dirname(process.execPath))),
      ], { stdio: "ignore", timeout: 5000 });
    }
    const registered = app.isPackaged ? app.setAsDefaultProtocolClient("opencraft")
      : app.setAsDefaultProtocolClient("opencraft", process.execPath, [app.getAppPath()]);
    if (!registered) throw new Error("Could not register the desktop login callback. Please reopen the installed app.");
    return { ok: true, session: await desktopLogin.start(region) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not start login" };
  }
});
ipcMain.handle("vela:lightvela-login-cancel", event => { if (trustedLoginCaller(event)) desktopLogin.cancel(); });
ipcMain.handle("vela:lightvela-session-read", event => trustedLoginCaller(event) ? desktopSessions.read() : null);
const browserMetadataKeys = new Set(["vela.browser-pages.v1", "vela.browser-tabs.v1", "opencraft.browser-storage.v1", "vela.conversation-bindings.v1", "opencraft.browser-retired-storage.v1"]);
const readBrowserMetadata = (): Record<string, string> => {
  const raw = createFilePrivateStorage(join(app.getPath("userData"), "browser-metadata")).read("state");
  if (raw === null) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid browser metadata");
  return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => browserMetadataKeys.has(key) && typeof value === "string")) as Record<string, string>;
};
ipcMain.handle("opencraft:browser-state-read", event => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted browser metadata caller");
  return readBrowserMetadata();
});
ipcMain.handle("opencraft:browser-state-write", (event, key: unknown, value: unknown) => {
  if (!trustedLoginCaller(event) || typeof key !== "string" || !browserMetadataKeys.has(key) || typeof value !== "string") throw new Error("Invalid browser metadata write");
  JSON.parse(value);
  createFilePrivateStorage(join(app.getPath("userData"), "browser-metadata")).write("state", JSON.stringify({ ...readBrowserMetadata(), [key]: value }));
});
ipcMain.handle("opencraft:browser-track-pointer", (event, guestId: unknown, trackingId: unknown, enabled: unknown) => {
  if (!trustedLoginCaller(event) || !Number.isSafeInteger(guestId) || typeof trackingId !== "string" || trackingId.length > 100 || typeof enabled !== "boolean") throw new Error("Invalid browser pointer tracking request");
  browserGuests?.trackPointer(guestId as number, trackingId, enabled);
});
ipcMain.on("opencraft:window-focused", event => {
  event.returnValue = trustedLoginCaller(event) && mainWindow?.isFocused() === true;
});
ipcMain.handle("opencraft:browser-site-settings", async (event, guestId: unknown, action: unknown) => {
  if (!trustedLoginCaller(event) || typeof guestId !== "number" || !["permissions", "clear-data"].includes(String(action))) throw new Error("Invalid browser settings request");
  const entry = browserGuests?.require(guestId);
  if (!entry || !mainWindow) throw new Error("Browser page is unavailable");
  const origin = new URL(entry.guest.getURL()).origin;
  if (!origin.startsWith("http")) throw new Error("当前页面没有网站权限");
  const permissions = ["camera", "microphone", "geolocation", "notifications"];
  const decision = await dialog.showMessageBox(mainWindow, {
    type: action === "clear-data" ? "warning" : "info",
    message: action === "clear-data" ? `清除此浏览器标签的网站数据？` : `网站权限：${origin}`,
    detail: action === "clear-data" ? "将清除此标签独立分区中的 Cookie、缓存及网站存储，网站可能退出登录。不会影响其他标签。"
      : permissions.map(p => `${p}: ${browserPermissions.check(entry.partition, origin, p) ? "已允许" : "未允许"}`).join("\n") + "\n撤销后会重新加载页面，停止当前页面使用这些权限。",
    buttons: ["取消", action === "clear-data" ? "清除数据" : "撤销权限并重新加载"], defaultId: 0, cancelId: 0,
  });
  if (decision.response !== 1) return { changed: false };
  if (entry.guest.isDestroyed() || new URL(entry.guest.getURL()).origin !== origin) throw new Error("页面已改变，请重新操作");
  browserPermissions.revoke(entry.partition, origin);
  if (action === "clear-data") {
    await entry.guest.session.clearStorageData();
    await entry.guest.session.clearCache();
  }
  if (!entry.guest.isDestroyed()) entry.guest.reload();
  return { changed: true };
});
ipcMain.handle("opencraft:browser-clear-closed-data", async event => {
  if (!trustedLoginCaller(event) || !mainWindow) throw new Error("Untrusted browser settings caller");
  const state = readBrowserMetadata();
  const retired = JSON.parse(state["opencraft.browser-retired-storage.v1"] ?? "[]");
  const active = new Set(Object.values(JSON.parse(state["opencraft.browser-storage.v1"] ?? "{}")));
  if (!Array.isArray(retired)) throw new Error("Invalid retired browser storage");
  const ids = retired.filter((id): id is string => typeof id === "string" && /^browser[:-][a-zA-Z0-9-]+$/.test(id) && !active.has(id));
  const result = await dialog.showMessageBox(mainWindow, { type:"warning",message:`清理 ${ids.length} 个已关闭标签的网站数据？`,
    detail:"将删除这些标签留下的 Cookie、缓存和网站存储，不影响当前打开的标签。",buttons:["取消","清理"],defaultId:0,cancelId:0 });
  if (result.response !== 1) return {cleared:0};
  let cleared=0;
  for (const id of ids) {
    const current = readBrowserMetadata();
    if (Object.values(JSON.parse(current["opencraft.browser-storage.v1"] ?? "{}")).includes(id)) continue;
    const partition = session.fromPartition(`persist:opencraft-browser:${id.replace("browser:","browser-")}`);
    const storagePath = partition.getStoragePath();
    if (storagePath) browserPermissions.clearPartition(storagePath);
    await partition.clearStorageData(); await partition.clearCache(); cleared++;
  }
  const current = readBrowserMetadata();
  const remaining = (JSON.parse(current["opencraft.browser-retired-storage.v1"] ?? "[]") as string[]).filter(id => !ids.includes(id));
  createFilePrivateStorage(join(app.getPath("userData"),"browser-metadata")).write("state",JSON.stringify({...current,"opencraft.browser-retired-storage.v1":JSON.stringify(remaining)}));
  return {cleared};
});
ipcMain.handle("vela:lightvela-session-clear", event => {
  if (trustedLoginCaller(event)) { desktopLogin.cancel(); desktopSessions.clear(); }
});
ipcMain.handle("vela:lightvela-account-request", async (event, input: DesktopAccountRequest) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted account caller");
  const account = await desktopSessions.read();
  if (!account) return { status: 401, contentType: "application/json", body: new Uint8Array() };
  try { return await requestDesktopAccount(input, account); }
  catch (error) { throw desktopAccountPublicError(error); }
});
ipcMain.handle("opencraft:skillhub-get", async (event, path: unknown) => {
  if (!trustedLoginCaller(event)) throw new Error("Untrusted SkillHub caller");
  try { return await requestDesktopSkillHub(path); }
  catch (error) { throw desktopSkillHubPublicError(error); }
});
ipcMain.handle("vela:lightvela-sign-out", async event => {
  if (!trustedLoginCaller(event)) return;
  const account = await desktopSessions.read();
  desktopLogin.cancel(); desktopSessions.clear();
  if (!account) return;
  try {
    const base = account.region === "cn" ? "https://api.lightvela.com" : "https://api.lightvela.ai";
    const response = await fetch(`${base}/auth/session`, {
      method: "DELETE", headers: { Authorization: `Bearer ${account.token}` },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok && response.status !== 401 && response.status !== 403) throw new Error();
  } catch { throw new Error("Signed out locally; server revocation could not be confirmed."); }
});

function rejectAppHostPort(
  port: MessagePortMain,
  code: string,
  message: string,
): void {
  port.start();
  port.postMessage({
    type: "fatal",
    error: { code, message, retryable: true },
  });
  // Queue the close after the fatal frame. Closing synchronously can discard
  // the frame in Electron before the Renderer observes the failure.
  setImmediate(() => {
    try { port.close(); } catch { /* Native port already destroyed. */ }
  });
}

ipcMain.on("vela:get-window-fullscreen", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = window !== null && !window.isDestroyed() && window.isFullScreen();
});

ipcMain.on(CONNECT_APP_HOST_MESSAGE, (event, message: unknown) => {
  if (
    event.sender !== mainWebContents
    || !isConnectAppHostMessage(message)
    || event.ports.length !== 1
  ) return;
  const nativePort = event.ports[0]!;
  const manager = daemonManager;
  if (manager === null) {
    rejectAppHostPort(nativePort, "DAEMON_NOT_READY", "OpenCraft Daemon is not ready");
    return;
  }
  void connectRendererToDaemon(nativePort, manager, message.rendererId);
});

async function connectRendererToDaemon(
  nativePort: MessagePortMain,
  manager: OpenCraftDaemonClientManager,
  rendererId: string,
): Promise<void> {
  let rendererClosed = false;
  const markRendererClosed = () => { rendererClosed = true; };
  nativePort.once("close", markRendererClosed);
  let daemon: OpenCraftDaemonAppHostConnection;
  try {
    daemon = await manager.connectAppHost(rendererId);
  } catch (cause) {
    nativePort.off("close", markRendererClosed);
    if (rendererClosed) return;
    rejectAppHostPort(
      nativePort,
      "DAEMON_CONNECTION_FAILED",
      cause instanceof Error ? cause.message : String(cause),
    );
    return;
  }
  nativePort.off("close", markRendererClosed);
  if (rendererClosed) {
    daemon.close();
    return;
  }
  let closed = false;
  let closeBridge = (): void => {};
  const receiveRenderer = (event: Electron.MessageEvent) => daemon.send(event.data);
  const unsubscribeDaemon = daemon.subscribeMessage((payload) => {
    if (!closed) nativePort.postMessage(payload);
  });
  const unsubscribeDaemonClose = daemon.subscribeClose((error) => {
    if (closed) return;
    nativePort.postMessage({
      type: "fatal",
      error: {
        code: "DAEMON_CONNECTION_CLOSED",
        message: error?.message ?? "OpenCraft Daemon connection closed",
        retryable: true,
      },
    });
    setImmediate(closeBridge);
  });
  const bridge = {
    close() {
      if (closed) return;
      closed = true;
      daemonBridges.delete(bridge);
      nativePort.off("message", receiveRenderer);
      unsubscribeDaemon();
      unsubscribeDaemonClose();
      daemon.close();
      try { nativePort.close(); } catch { /* Native port already destroyed. */ }
    },
  };
  closeBridge = () => bridge.close();
  daemonBridges.add(bridge);
  nativePort.on("message", receiveRenderer);
  nativePort.once("close", () => bridge.close());
  nativePort.start();
}

const TRANSPARENT_WINDOW_BACKGROUND = "#00000000";
const LIGHT_OPAQUE_WINDOW_BACKGROUND = "#f9f9f9";
const DARK_OPAQUE_WINDOW_BACKGROUND = "#181818";
const APP_SHELL_HEADER_HEIGHT = 46;
const MACOS_WINDOW_BUTTON_SIZE = 14;
const MACOS_WINDOW_BUTTON_X = 16;

let currentWindowAppearance: WindowAppearanceMessage = {
  themeSource: "system",
  resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
};

function getMacWindowButtonPosition(windowZoom = 1): { x: number; y: number } {
  return {
    x: MACOS_WINDOW_BUTTON_X,
    y: Math.round(
      (APP_SHELL_HEADER_HEIGHT * windowZoom - MACOS_WINDOW_BUTTON_SIZE) / 2,
    ),
  };
}

/**
 * Main owns the native backing surface; Renderer owns only theme intent.
 *
 * A focused macOS window may expose AppKit's material. An unfocused window
 * must have an opaque, theme-matched backing surface so the Dock snapshot and
 * deminiaturize animation can never reveal windows behind OpenCraft. This mirrors
 * Codex's focus-driven window backdrop policy and deliberately does not make
 * minimize/restore another source of state.
 */
function applyWindowAppearance(
  window: BrowserWindow,
  appearance: WindowAppearanceMessage,
): void {
  if (window.isDestroyed()) return;
  currentWindowAppearance = appearance;
  nativeTheme.themeSource = appearance.themeSource;
  applyNativeWindowAppearance(window, appearance, process.platform);
}

ipcMain.on("vela:set-window-appearance", (event, payload: unknown) => {
  if (event.sender !== mainWebContents || !isWindowAppearanceMessage(payload)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window !== null) applyWindowAppearance(window, payload);
});

function rendererRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "renderer")
    : join(app.getAppPath(), "../workbench-web/dist-electron");
}

async function ensureLoopbackHost(): Promise<string> {
  if (rendererOrigin !== null) return rendererOrigin;
  loopbackHost = await createWorkbenchStaticServer({
    root: rendererRoot(),
  });
  const address = await loopbackHost.listen({ host: "127.0.0.1", port: 0 });
  rendererOrigin = `http://127.0.0.1:${address.port}`;
  return rendererOrigin;
}

async function createMainWindow(): Promise<void> {
  const origin = await ensureLoopbackHost();
  const initialBackgroundColor = process.platform === "darwin"
    ? TRANSPARENT_WINDOW_BACKGROUND
    : nativeTheme.shouldUseDarkColors
      ? DARK_OPAQUE_WINDOW_BACKGROUND
      : LIGHT_OPAQUE_WINDOW_BACKGROUND;

  const window = new BrowserWindow({
    title: "OpenCraft",
    width: 1440,
    height: 960,
    minWidth: workbenchWindowMetrics.minimumWidth,
    minHeight: workbenchWindowMetrics.minimumHeight,
    // AppKit owns the material plane while the window is active. The focus
    // state machine below swaps it for an opaque, theme-matched backing before
    // macOS captures minimize/restore snapshots.
    backgroundColor: initialBackgroundColor,
    vibrancy: process.platform === "darwin" ? "menu" : undefined,
    // macOS owns inset traffic lights. Windows and Linux expose their native
    // caption buttons through Window Controls Overlay while the renderer owns
    // the titlebar surface. The renderer consumes the WCO geometry rather than
    // guessing left/right button placement across Wayland, X11, RTL, and user
    // desktop preferences.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: process.platform === "darwin"
      ? getMacWindowButtonPosition()
      : undefined,
    acceptFirstMouse: process.platform === "darwin",
    titleBarOverlay: process.platform === "darwin"
      ? undefined
      : {
          color: "#00000000",
          symbolColor: "#686868",
          height: 46,
        },
    // Let AppKit establish the hidden-inset titlebar and key-window lifecycle
    // from the first frame. Renderer readiness never owns native window chrome.
    show: true,
    webPreferences: {
      preload: join(app.getAppPath(), "dist-host/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      webviewTag: true,
      scrollBounce: process.platform === "darwin",
    },
  });
  browserGuests = installBrowserGuests(window.webContents, {
    permissions: browserPermissions,
    open: (guestId, url, background) => {
      if (!window.isDestroyed()) window.webContents.send("opencraft:browser-new-window", { guestId, url, background });
    },
  });
  const webContents = window.webContents;
  webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) desktopLogin.cancel();
  });
  mainWindow = window;
  lifecycle.bindWindow(window);
  mainWebContents = webContents;
  const speechOwner = webContents.id;
  webContents.once("destroyed", () => { void nativeSpeech.releaseOwner(speechOwner); });
  webContents.on("render-process-gone", () => { void nativeSpeech.releaseOwner(speechOwner); });
  webContents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) void nativeSpeech.releaseOwner(speechOwner);
  });

  const refreshWindowAppearance = () => {
    applyWindowAppearance(window, currentWindowAppearance);
  };
  // Codex treats focus as an input to the native backing surface. A minimize
  // naturally blurs before AppKit captures the window; restore then shows and
  // focuses it. Keeping that lifecycle native avoids animation timers and
  // Renderer-owned visibility workarounds.
  window.on("focus", refreshWindowAppearance);
  window.on("blur", refreshWindowAppearance);
  window.on("show", refreshWindowAppearance);
  window.on("hide", refreshWindowAppearance);
  refreshWindowAppearance();

  const publishFullscreen = (isFullScreen: boolean) => {
    if (!webContents.isDestroyed()) {
      webContents.send("vela:window-fullscreen-changed", { isFullScreen });
    }
  };
  const publishEnteredFullscreen = () => publishFullscreen(true);
  const publishLeftFullscreen = () => publishFullscreen(false);
  window.on("enter-full-screen", publishEnteredFullscreen);
  window.on("leave-full-screen", publishLeftFullscreen);

  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (url !== `${origin}/` && !url.startsWith(`${origin}/`)) event.preventDefault();
  });
  webContents.once("did-finish-load", () => {
    if (!webContents.isDestroyed()) webContents.setZoomLevel(0);
  });
  window.once("closed", () => {
    desktopLogin.cancel();
    window.off("focus", refreshWindowAppearance);
    window.off("blur", refreshWindowAppearance);
    window.off("show", refreshWindowAppearance);
    window.off("hide", refreshWindowAppearance);
    window.off("enter-full-screen", publishEnteredFullscreen);
    window.off("leave-full-screen", publishLeftFullscreen);
    if (mainWindow === window) mainWindow = null;
    if (mainWebContents === webContents) mainWebContents = null;
  });
  try {
    await window.loadURL(origin);
  } catch (error) {
    if (!window.isDestroyed()) throw error;
  }
}

function ensureMainWindow(): Promise<void> { return lifecycle.show(); }

const lifecycle = new DesktopLifecycle({
  getWindow: () => mainWindow,
  createWindow: createMainWindow,
  showDock: async () => { if (process.platform === "darwin") await app.dock?.show(); },
  hideDock: () => { if (process.platform === "darwin") app.dock?.hide(); },
  stopRuntime: async () => {
    desktopLocale.dispose();
    await nativeSpeech.close();
    uiPreferences.close();
    connectorConfiguration?.close();
    extensionData?.close();
    desktopLogin.cancel();
    const daemon = daemonManager;
    const loopback = loopbackHost;
    for (const bridge of [...daemonBridges]) bridge.close();
    daemonBridges.clear();
    daemonManager = null;
    loopbackHost = null;
    rendererOrigin = null;
    const results = await Promise.allSettled([daemon?.shutdown(), loopback?.close()]);
    const errors = results.filter(result => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Desktop shutdown failed");
  },
  destroyTray: () => { if (tray && !tray.isDestroyed()) tray.destroy(); tray = null; },
  reportError: error => console.error("Desktop lifecycle:", error),
  exit: code => app.exit(code),
});

async function bootstrap(): Promise<void> {
  const preparedDirectories = await prepareDesktopDirectories(directoryPlan);
  if (preparedDirectories.diagnostic) console.warn(`[opencraft directories] ${preparedDirectories.diagnostic}`);
  initializeDesktopProfile(preparedDirectories.paths);
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  if (preparedDirectories.status === "legacy-active") {
    throw new Error("The legacy OpenCraft runtime is still active. Quit the existing application and retry the upgrade.");
  }

  app.on("second-instance", (_event, argv) => {
    const callback = argv.find(value => value.startsWith("opencraft://"));
    if (callback) { receiveLoginCallback(callback); return; }
    void ensureMainWindow().catch(console.error);
  });
  app.on("activate", () => { void ensureMainWindow().catch(console.error); });
  app.on("before-quit", event => { event.preventDefault(); void lifecycle.quit(); });
  app.on("window-all-closed", () => { /* Resident host; only explicit Quit stops runtime. */ });

  await app.whenReady();
  for (const value of process.argv) if (value.startsWith("opencraft://")) receiveLoginCallback(value);
  if (startupCallbackFlight && await startupCallbackFlight) {
    // A callback-only launch must not put an anonymous second window in front
    // of the initiating profile, which is about to finish its login.
    app.quit();
    return;
  }
  daemonManager = new OpenCraftDaemonClientManager({
    endpoint: desktopPaths.daemonEndpoint,
    tokenPath: desktopPaths.daemonTokenPath,
    runtimeDirectory: desktopPaths.runtimeDirectory,
    daemonEntry: app.isPackaged
      ? join(process.resourcesPath, "runtime/opencraft-daemon.cjs")
      : join(app.getAppPath(), "../opencraft-daemon/dist/main.cjs"),
    dshExecutable: app.isPackaged
      ? join(process.resourcesPath, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")
      : join(app.getAppPath(), "../../runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dshCapabilityPlugin: app.isPackaged
      ? join(process.resourcesPath, "runtime/dsh/opencraft-capability-plugin.mjs")
      : join(app.getAppPath(), "../local-agent-host/src/dsh-capability-plugin.mjs"),
    dataDirectory: desktopPaths.dshDataDirectory,
    modelStorageDirectory: process.env.OPENCRAFT_MODEL_STORAGE_DIRECTORY?.trim() || desktopPaths.productHomeDirectory,
    skillsDirectory: process.env.OPENCRAFT_SKILLS_DIRECTORY?.trim() || join(desktopPaths.productHomeDirectory, "skills"),
    codexExecutable: resolveCodexExecutable({
      explicit: process.env.OPENCRAFT_CODEX_EXECUTABLE,
      path: process.env.PATH,
      homeDirectory: homedir(),
    }),
    codexDataDirectory: desktopPaths.codexDataDirectory,
    nativeCodexHomeDirectory: process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
    executable: process.execPath,
  });
  let localeOverride: unknown;
  try { localeOverride = JSON.parse(uiPreferences.load("locale.override")?.valueJson ?? '""'); } catch { /* Invalid preferences use system locale. */ }
  await desktopLocale.update({ localeOverride: typeof localeOverride === "string" ? localeOverride : null,
    localeSource: "SYSTEM", systemLocale: app.getPreferredSystemLanguages()[0] ?? app.getLocale() });
  tray = createDesktopTray({ open: () => { void lifecycle.show().catch(console.error); }, quit: () => { void lifecycle.quit(); } }, desktopLocale);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const trustedRenderer = rendererOrigin !== null
      && webContents === mainWebContents
      && details.requestingUrl.startsWith(`${rendererOrigin}/`);
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    const audioOnly = permission === "media"
      && Array.isArray(mediaTypes)
      && mediaTypes.length > 0
      && mediaTypes.every((type) => type === "audio");
    callback(trustedRenderer && (
      permission === "clipboard-sanitized-write"
      || permission === "fullscreen"
      || audioOnly
    ));
  });
  await ensureMainWindow();

}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.message}\n\n${error.stack ?? ""}` : String(error);
  dialog.showErrorBox("OpenCraft failed to start", message);
  app.exit(1);
});
