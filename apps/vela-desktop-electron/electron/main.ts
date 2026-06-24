import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RotatingLogWriter, runtimeLogPath, VeladRuntimeManager } from "./runtime";

let mainWindow: BrowserWindow | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runtimeEnv(name: string) {
  return process.env[name];
}

const maxLogBytes = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_BYTES") ?? 5 * 1024 * 1024);
const maxLogFiles = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_FILES") ?? 5);
const veladReadyTimeoutMs = Number(runtimeEnv("VELA_DESKTOP_VELAD_READY_TIMEOUT_MS") ?? 15_000);
const veladShutdownTimeoutMs = Number(runtimeEnv("VELA_DESKTOP_VELAD_SHUTDOWN_TIMEOUT_MS") ?? 5_000);
const veladRequestTimeoutMs = Number(runtimeEnv("VELA_DESKTOP_VELAD_REQUEST_TIMEOUT_MS") ?? 2_000);
const macosChromeMetrics = {
  trafficLightPosition: { x: 18, y: 18 },
  normalLeadingToolbarInset: 78,
  fullscreenLeadingToolbarInset: 54,
  normalToolbarCenterY: 24,
  normalToolbarIconSize: 24,
  normalToolbarSize: 28,
  fullscreenToolbarCenterY: 24,
  fullscreenToolbarIconSize: 24,
  fullscreenToolbarSize: 28,
};

interface DesktopChromeState {
  platform: NodeJS.Platform;
  isFullscreen: boolean;
  isMaximized: boolean;
  reserveTrafficLightGutter: boolean;
  toolbarCenterY: number;
  toolbarIconSize: number;
  leadingToolbarInset: number;
  toolbarSize: number;
}

const logWriter = new RotatingLogWriter(
  runtimeLogPath(app.getPath("userData")),
  maxLogBytes,
  maxLogFiles,
);
const veladRuntime = new VeladRuntimeManager({
  host: app,
  resourcesPath: process.resourcesPath,
  logger: logWriter,
  readyTimeoutMs: veladReadyTimeoutMs,
  shutdownTimeoutMs: veladShutdownTimeoutMs,
  requestTimeoutMs: veladRequestTimeoutMs,
});

function logLine(source: string, message: string) {
  logWriter.write(source, message);
}

function getDesktopChromeState(window = mainWindow): DesktopChromeState {
  const isFullscreen = window?.isFullScreen() ?? false;
  const isMaximized = window?.isMaximized() ?? false;
  const isMacos = process.platform === "darwin";
  const reserveTrafficLightGutter = isMacos && !isFullscreen;
  return {
    platform: process.platform,
    isFullscreen,
    isMaximized,
    reserveTrafficLightGutter,
    toolbarCenterY: isFullscreen
      ? macosChromeMetrics.fullscreenToolbarCenterY
      : macosChromeMetrics.normalToolbarCenterY,
    toolbarIconSize: isFullscreen
      ? macosChromeMetrics.fullscreenToolbarIconSize
      : macosChromeMetrics.normalToolbarIconSize,
    leadingToolbarInset: reserveTrafficLightGutter
      ? macosChromeMetrics.normalLeadingToolbarInset
      : macosChromeMetrics.fullscreenLeadingToolbarInset,
    toolbarSize: isFullscreen
      ? macosChromeMetrics.fullscreenToolbarSize
      : macosChromeMetrics.normalToolbarSize,
  };
}

function emitDesktopChromeState(window = mainWindow) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("vela:desktop-chrome-state", getDesktopChromeState(window));
}

function attachDesktopChromeStateEvents(window: BrowserWindow) {
  const emit = () => emitDesktopChromeState(window);
  window.on("enter-full-screen", emit);
  window.on("leave-full-screen", emit);
  window.on("maximize", emit);
  window.on("unmaximize", emit);
  window.on("restore", emit);
  window.webContents.on("did-finish-load", emit);
}

async function createWindow() {
  logLine("[host]", `log file ${runtimeLogPath(app.getPath("userData"))}`);
  void veladRuntime.ensureReady().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[velad] bootstrap failed: ${message}`);
    logLine("[host]", `velad bootstrap failed: ${message}`);
  });
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: macosChromeMetrics.trafficLightPosition,
    ...(process.platform === "darwin"
      ? {
          backgroundColor: "#00000000",
          vibrancy: "under-window" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachDesktopChromeStateEvents(mainWindow);

  const devServerUrl = runtimeEnv("VITE_DEV_SERVER_URL") ?? (!app.isPackaged ? "http://127.0.0.1:5173" : "");
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("vela:desktop-info", async () => {
  const logPath = runtimeLogPath(app.getPath("userData"));
  try {
    const info = await veladRuntime.ensureReady();
    return {
      status: "ready",
      apiBaseUrl: info.apiBaseUrl,
      chromeState: getDesktopChromeState(),
      logPath,
      platform: process.platform,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      error: message,
      logPath,
      platform: process.platform,
    };
  }
});

ipcMain.handle("vela:desktop-bootstrap-retry", async () => {
  veladRuntime.resetStart();
  const logPath = runtimeLogPath(app.getPath("userData"));
  try {
    const info = await veladRuntime.ensureReady();
    return {
      status: "ready",
      apiBaseUrl: info.apiBaseUrl,
      chromeState: getDesktopChromeState(),
      logPath,
      platform: process.platform,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "failed",
      error: message,
      logPath,
      platform: process.platform,
    };
  }
});

ipcMain.handle("vela:desktop-chrome-state", async () => getDesktopChromeState());

ipcMain.handle("vela:desktop-leave-fullscreen", async () => {
  const window = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (window?.isFullScreen()) {
    window.setFullScreen(false);
  }
  return getDesktopChromeState(window ?? mainWindow);
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitAfterRuntimeStop = false;
app.on("before-quit", (event) => {
  if (quitAfterRuntimeStop) return;
  event.preventDefault();
  mainWindow = null;
  void veladRuntime
    .stop()
    .catch((err) => {
      logLine("[host]", `velad stop failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      quitAfterRuntimeStop = true;
      app.exit(0);
    });
});
