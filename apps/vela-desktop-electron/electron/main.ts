import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

let mainWindow: BrowserWindow | null = null;
let logWriter: RotatingLogWriter | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runtimeEnv(name: string) {
  return globalThis.process?.env?.[name];
}

const configuredVeladListenAddr = runtimeEnv("VELA_DESKTOP_VELAD_LISTEN_ADDR") ?? "";
const externalVeladListenAddr = configuredVeladListenAddr || "127.0.0.1:3857";
const veladListenAddr = externalVeladListenAddr;
let veladReadyPromise: Promise<void> | null = null;
const maxLogBytes = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_BYTES") ?? 5 * 1024 * 1024);
const maxLogFiles = Number(runtimeEnv("VELA_DESKTOP_LOG_MAX_FILES") ?? 5);
const veladReadyTimeoutMs = Number(runtimeEnv("VELA_DESKTOP_VELAD_READY_TIMEOUT_MS") ?? 15_000);
const macosChromeMetrics = {
  trafficLightPosition: { x: 24, y: 22 },
};

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

async function waitForVeladReady() {
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
    console.log(`[velad] using external velad at http://${veladListenAddr}/api/v1`);
    logLine("[host]", `using external velad at http://${veladListenAddr}/api/v1`);
    veladReadyPromise = waitForVeladReady();
  }
  return veladReadyPromise;
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
    frame: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: macosChromeMetrics.trafficLightPosition,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devServerUrl = runtimeEnv("VITE_DEV_SERVER_URL");
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

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  mainWindow = null;
});
