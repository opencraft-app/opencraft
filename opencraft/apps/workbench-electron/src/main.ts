import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { desktopProduct } from "./product-identity.js";
import { DesktopLifecycle } from "./desktop-lifecycle.js";
import { createDesktopTray } from "./desktop-tray.js";

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
app.setName(desktopProduct.displayName);
const requestedProfile = app.commandLine.getSwitchValue("user-data-dir");
const userDataDirectory = requestedProfile
  ? resolve(requestedProfile)
  : join(app.getPath("appData"), desktopProduct.profileDirectoryName);
// Electron rejects setPath for a missing directory on a fresh machine.
mkdirSync(userDataDirectory, { recursive: true });
app.setPath("userData", userDataDirectory);

let mainWindow: BrowserWindow | null = null;
let mainWebContents: WebContents | null = null;
let tray: Tray | null = null;
let loopbackHost: WorkbenchStaticServer | null = null;
let rendererOrigin: string | null = null;
let daemonManager: OpenCraftDaemonClientManager | null = null;
const daemonBridges = new Set<{ close(): void }>();

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

type WindowThemeSource = "system" | "light" | "dark";
type WindowResolvedTheme = "light" | "dark";

interface WindowAppearanceMessage {
  readonly themeSource: WindowThemeSource;
  readonly resolvedTheme: WindowResolvedTheme;
}

let currentWindowAppearance: WindowAppearanceMessage = {
  themeSource: "system",
  resolvedTheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
};

function isWindowAppearanceMessage(value: unknown): value is WindowAppearanceMessage {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<WindowAppearanceMessage>;
  return (
    (candidate.themeSource === "system"
      || candidate.themeSource === "light"
      || candidate.themeSource === "dark")
    && (candidate.resolvedTheme === "light" || candidate.resolvedTheme === "dark")
  );
}

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
  if (process.platform === "darwin") {
    const useOpaqueSurface = !window.isFocused();
    window.setBackgroundColor(
      useOpaqueSurface
        ? appearance.resolvedTheme === "dark"
          ? DARK_OPAQUE_WINDOW_BACKGROUND
          : LIGHT_OPAQUE_WINDOW_BACKGROUND
        : TRANSPARENT_WINDOW_BACKGROUND,
    );
    window.setVibrancy(useOpaqueSurface ? null : "menu");
    return;
  }
  window.setBackgroundColor(
    appearance.resolvedTheme === "dark"
      ? DARK_OPAQUE_WINDOW_BACKGROUND
      : LIGHT_OPAQUE_WINDOW_BACKGROUND,
  );
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
    minWidth: 760,
    minHeight: 560,
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
    // Codex lets AppKit make the primary window key in the same transaction
    // that creates the hidden-inset titlebar. Deferring the first show until
    // renderer readiness lets the native traffic-light subviews miss that
    // transaction on Electron 44 and they disappear from minimize snapshots.
    show: true,
    webPreferences: {
      preload: join(app.getAppPath(), "dist-host/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      scrollBounce: process.platform === "darwin",
    },
  });
  const webContents = window.webContents;
  mainWindow = window;
  lifecycle.bindWindow(window);
  mainWebContents = webContents;

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
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }

  app.on("second-instance", () => { void ensureMainWindow().catch(console.error); });
  app.on("activate", () => { void ensureMainWindow().catch(console.error); });
  app.on("before-quit", event => { event.preventDefault(); void lifecycle.quit(); });
  app.on("window-all-closed", () => { /* Resident host; only explicit Quit stops runtime. */ });

  await app.whenReady();
  daemonManager = new OpenCraftDaemonClientManager({
    userDataDirectory: app.getPath("userData"),
    daemonEntry: app.isPackaged
      ? join(process.resourcesPath, "runtime/opencraft-daemon.cjs")
      : join(app.getAppPath(), "../opencraft-daemon/dist/main.cjs"),
    dshExecutable: app.isPackaged
      ? join(process.resourcesPath, "runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js")
      : join(app.getAppPath(), "../../runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dataDirectory: join(app.getPath("userData"), "dsh"),
    executable: process.execPath,
  });
  tray = createDesktopTray({ open: () => { void lifecycle.show().catch(console.error); }, quit: () => { void lifecycle.quit(); } });
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
