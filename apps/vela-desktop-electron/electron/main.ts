import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let mainWindow: BrowserWindow | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function runtimeEnv(name: string) {
  return globalThis.process?.env?.[name];
}

const veladListenAddr = runtimeEnv("VELA_DESKTOP_VELAD_LISTEN_ADDR") ?? "127.0.0.1:3857";

async function createWindow() {
  console.log(`[velad] using external velad at http://${veladListenAddr}/api/v1`);
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
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

ipcMain.handle("vela:desktop-info", () => ({
  apiBaseUrl: `http://${veladListenAddr}/api/v1`,
  platform: process.platform,
}));

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  mainWindow = null;
});
