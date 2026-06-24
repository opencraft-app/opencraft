import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";

let mainWindow: BrowserWindow | null = null;
let veladProcess: ChildProcessWithoutNullStreams | null = null;
let logWriter: RotatingLogWriter | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runtimeEnv(name: string) {
  return process.env[name];
}

const configuredVeladListenAddr = runtimeEnv("VELA_DESKTOP_VELAD_LISTEN_ADDR") ?? "";
const externalVeladListenAddr = "127.0.0.1:3857";
let veladListenAddr = configuredVeladListenAddr;
let veladReadyPromise: Promise<void> | null = null;
const maxLogBytes = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_BYTES") ?? 5 * 1024 * 1024);
const maxLogFiles = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_FILES") ?? 5);
const veladReadyTimeoutMs = Number(runtimeEnv("VELA_DESKTOP_VELAD_READY_TIMEOUT_MS") ?? 15_000);
const macosChromeMetrics = {
  trafficLightPosition: { x: 24, y: 22 },
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

class RotatingLogWriter {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(path: string, maxBytes: number, maxFiles: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(source: string, message: string) {
    const lines = message
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    const timestamp = new Date().toISOString();
    const payload = lines.map((line) => `${timestamp} ${source} ${line}`).join("\n") + "\n";
    this.rotateIfNeeded(Buffer.byteLength(payload));
    appendFileSync(this.path, payload);
  }

  private rotateIfNeeded(incomingBytes: number) {
    const currentBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentBytes + incomingBytes <= this.maxBytes) return;

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = `${this.path}.${index}`;
      const to = `${this.path}.${index + 1}`;
      if (existsSync(to)) rmSync(to, { force: true });
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
  }
}

function getLogWriter() {
  if (!logWriter) {
    logWriter = new RotatingLogWriter(
      join(app.getPath("userData"), "logs", "vela-desktop.log"),
      maxLogBytes,
      maxLogFiles,
    );
  }
  return logWriter;
}

function logLine(source: string, message: string) {
  getLogWriter().write(source, message);
}

function bundledVeladPath() {
  const packagedPath = join(process.resourcesPath, "bin", "velad");
  if (existsSync(packagedPath)) return packagedPath;
  return null;
}

function bundledVeladDatabaseUrl() {
  const configuredDatabaseUrl = runtimeEnv("VELAD_DATABASE_URL");
  if (configuredDatabaseUrl) return configuredDatabaseUrl;

  const dataDir = join(app.getPath("userData"), "runtime", "velad");
  mkdirSync(dataDir, { recursive: true });
  return `${pathToFileURL(join(dataDir, "vela.sqlite")).href.replace(/^file:/, "sqlite:")}?mode=rwc`;
}

function desktopRuntimeEnv() {
  const home = process.env.HOME ?? app.getPath("home");
  const pathEntries = [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH ?? "",
  ].filter(Boolean);
  return {
    ...process.env,
    PATH: Array.from(new Set(pathEntries.flatMap((entry) => entry.split(":")).filter(Boolean))).join(":"),
  };
}

function reserveLoopbackListenAddr() {
  return new Promise<string>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to reserve a velad port")));
        return;
      }
      const listenAddr = `127.0.0.1:${address.port}`;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(listenAddr);
      });
    });
  });
}

async function ensureVeladListenAddr() {
  if (veladListenAddr) return veladListenAddr;
  veladListenAddr = bundledVeladPath() ? await reserveLoopbackListenAddr() : externalVeladListenAddr;
  return veladListenAddr;
}

async function startBundledVelad() {
  const listenAddr = await ensureVeladListenAddr();
  const binaryPath = bundledVeladPath();
  if (!binaryPath) {
    console.log(`[velad] using external velad at http://${listenAddr}/api/v1`);
    logLine("[host]", `using external velad at http://${listenAddr}/api/v1`);
    return;
  }
  if (veladProcess) return;
  const databaseUrl = bundledVeladDatabaseUrl();

  console.log(`[velad] starting bundled velad at ${binaryPath} on ${listenAddr}`);
  logLine("[host]", `starting bundled velad at ${binaryPath} on ${listenAddr}`);
  logLine("[host]", `using bundled velad database ${databaseUrl}`);
  veladProcess = spawn(binaryPath, {
    env: {
      ...desktopRuntimeEnv(),
      VELAD_LISTEN_ADDR: listenAddr,
      VELAD_DATABASE_URL: databaseUrl,
      RUST_LOG: process.env.RUST_LOG ?? "warn",
    },
    stdio: "pipe",
  });
  veladProcess.stdout.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    console.log(`[velad] ${message}`);
    logLine("[velad:stdout]", message);
  });
  veladProcess.stderr.on("data", (chunk) => {
    const message = String(chunk).trimEnd();
    console.error(`[velad] ${message}`);
    logLine("[velad:stderr]", message);
  });
  veladProcess.on("exit", (code, signal) => {
    console.log(`[velad] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    logLine("[host]", `velad exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    veladProcess = null;
  });
}

async function waitForVeladReady() {
  await ensureVeladListenAddr();
  const startedAt = Date.now();
  const url = `http://${veladListenAddr}/api/v1/backends`;
  let lastError: unknown = null;

  while (Date.now() - startedAt < veladReadyTimeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        logLine("[host]", `velad ready at ${url}`);
        return;
      }
      lastError = new Error(`velad readiness returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  throw new Error(
    `velad did not become ready at ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function ensureVeladReady() {
  if (!veladReadyPromise) {
    veladReadyPromise = startBundledVelad().then(waitForVeladReady);
  }
  return veladReadyPromise;
}

function stopBundledVelad() {
  const child = veladProcess;
  if (!child) return;
  veladProcess = null;
  child.kill("SIGTERM");
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
  logLine("[host]", `log file ${join(app.getPath("userData"), "logs", "vela-desktop.log")}`);
  void ensureVeladReady().catch((err) => {
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
  const logPath = join(app.getPath("userData"), "logs", "vela-desktop.log");
  try {
    await ensureVeladReady();
    return {
      status: "ready",
      apiBaseUrl: `http://${veladListenAddr}/api/v1`,
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
  veladReadyPromise = null;
  const logPath = join(app.getPath("userData"), "logs", "vela-desktop.log");
  try {
    await ensureVeladReady();
    return {
      status: "ready",
      apiBaseUrl: `http://${veladListenAddr}/api/v1`,
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

app.on("before-quit", () => {
  stopBundledVelad();
  mainWindow = null;
});
