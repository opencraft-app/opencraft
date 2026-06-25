import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { env as nodeEnv } from "node:process";
import { VelaLocalTracer } from "../../../packages/vela-observability-client/src";
import { buildRuntimeProcessEnv, RotatingLogWriter, runtimeLogPath, VeladRuntimeManager } from "./runtime";
import { WorkMonitorWindowManager } from "./work-monitor";

let mainWindow: BrowserWindow | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runtimeEnv(name: string) {
  return nodeEnv[name];
}

const remoteDebuggingPort = runtimeEnv("VELA_DESKTOP_REMOTE_DEBUGGING_PORT")?.trim();
if (!app.isPackaged && remoteDebuggingPort) {
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
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
const observability = new VelaLocalTracer({
  serviceName: "vela-desktop-electron",
  tracerName: "vela.desktop.electron",
  timeoutMs: veladRequestTimeoutMs,
});
const runtimeProcessEnv = buildRuntimeProcessEnv();
const veladRuntime = new VeladRuntimeManager({
  host: app,
  resourcesPath: process.resourcesPath,
  env: runtimeProcessEnv.env,
  logger: logWriter,
  observability,
  readyTimeoutMs: veladReadyTimeoutMs,
  shutdownTimeoutMs: veladShutdownTimeoutMs,
  requestTimeoutMs: veladRequestTimeoutMs,
});
const workMonitor = new WorkMonitorWindowManager({
  preloadPath: join(__dirname, "preload.cjs"),
  getAnchorWindow: () => mainWindow,
  loadRenderer: loadRendererWindow,
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

function attachRendererDiagnostics(window: BrowserWindow, label: string) {
  window.webContents.on("did-start-navigation", (_event, url, isInPlace, isMainFrame) => {
    logLine(
      `[${label}:renderer]`,
      `did-start-navigation main=${isMainFrame} inPlace=${isInPlace} url=${url}`,
    );
  });
  window.webContents.on("did-finish-load", () => {
    logLine(`[${label}:renderer]`, `did-finish-load url=${window.webContents.getURL()}`);
  });
  if (runtimeEnv("VELA_DESKTOP_RENDERER_CONSOLE_LOGS") === "1") {
    window.webContents.on("console-message", (_event, details) => {
      logLine(
        `[${label}:renderer]`,
        `console level=${details.level} ${details.message} (${details.sourceId}:${details.lineNumber})`,
      );
    });
  }
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logLine(
        `[${label}:renderer]`,
        `did-fail-load code=${errorCode} main=${isMainFrame} url=${validatedURL} ${errorDescription}`,
      );
    },
  );
  window.webContents.on("render-process-gone", (_event, details) => {
    logLine(
      `[${label}:renderer]`,
      `render-process-gone reason=${details.reason} exitCode=${details.exitCode}`,
    );
  });
}

async function createWindow() {
  logLine("[host]", `log file ${runtimeLogPath(app.getPath("userData"))}`);
  logLine(
    "[host]",
    runtimeProcessEnv.loginShellEnvApplied
      ? "runtime login shell environment applied"
      : `runtime using process environment: ${runtimeProcessEnv.loginShellEnvError ?? "login shell environment unavailable"}`,
  );
  logLine("[host]", `runtime PATH ${runtimeProcessEnv.env.PATH ?? ""}`);
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
  attachRendererDiagnostics(mainWindow, "main");

  await loadRendererWindow(mainWindow, {});
}

async function loadRendererWindow(
  window: BrowserWindow,
  query: Record<string, string>,
) {
  const devServerUrl = runtimeEnv("VITE_DEV_SERVER_URL") ?? (!app.isPackaged ? "http://127.0.0.1:5173" : "");
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    logLine("[host]", `loading renderer ${url.toString()}`);
    await window.loadURL(url.toString());
    return;
  }
  logLine("[host]", "loading packaged renderer");
  await window.loadFile(join(__dirname, "../dist/index.html"), { query });
}

ipcMain.handle("vela:desktop-info", async () => {
  const logPath = runtimeLogPath(app.getPath("userData"));
  try {
    const info = await veladRuntime.ensureReady();
    return {
      status: "ready",
      apiBaseUrl: info.apiBaseUrl,
      otelBaseUrl: info.otelBaseUrl,
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
      otelBaseUrl: info.otelBaseUrl,
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

ipcMain.handle("vela:work-monitor-open", async (_event, sessionId: unknown) => {
  if (typeof sessionId !== "string") return { accepted: false };
  await workMonitor.open(sessionId);
  return { accepted: true };
});

ipcMain.handle("vela:work-monitor-hide", async () => {
  workMonitor.hide();
  return { accepted: true };
});

ipcMain.handle("vela:work-monitor-move-by", async (event, deltaX: unknown, deltaY: unknown) => ({
  accepted:
    typeof deltaX === "number" &&
    typeof deltaY === "number" &&
    workMonitor.moveBySender(event.sender, deltaX, deltaY),
}));

ipcMain.handle("vela:desktop-focus-session", async (_event, sessionId: unknown) => {
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    return { accepted: false };
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("vela:desktop-open-session", sessionId.trim());
  }
  return { accepted: true };
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
      workMonitor.close();
      quitAfterRuntimeStop = true;
      app.exit(0);
    });
});
