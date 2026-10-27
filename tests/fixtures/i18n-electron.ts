import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { createDesktopLocaleRuntime, requireDesktopLocale } from "../../apps/workbench-electron/src/desktop-locale";
import { createDesktopTrayMenu } from "../../apps/workbench-electron/src/desktop-tray";

app.setPath("userData", process.env.OPENCRAFT_LOCALE_PROFILE!);
const locale = createDesktopLocaleRuntime();
void app.whenReady().then(async () => {
const window = new BrowserWindow({ show: false, width: 1000, height: 650, webPreferences: {
  preload: join(process.env.OPENCRAFT_LOCALE_PROFILE!, "preload.cjs"), contextIsolation: true, nodeIntegration: false,
} });
ipcMain.handle("opencraft:system-locale", event => {
  if (event.sender !== window.webContents) throw new Error("Untrusted locale caller");
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale();
});
ipcMain.handle("opencraft:application-locale", (event, value: unknown) => {
  if (event.sender !== window.webContents) throw new Error("Untrusted locale caller");
  return locale.update({ localeOverride: requireDesktopLocale(value) });
});
(globalThis as any).__localeNativeProbe = () => createDesktopTrayMenu({ open() {}, quit() {} }, locale).items.map(item => item.label);
await window.loadURL(process.env.OPENCRAFT_LOCALE_SMOKE_URL!);
app.on("window-all-closed", () => { locale.dispose(); app.quit(); });
});
