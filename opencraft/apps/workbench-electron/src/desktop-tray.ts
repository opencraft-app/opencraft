import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";

export function createDesktopTray(commands: { open(): void; quit(): void }): Tray {
  const root = app.isPackaged ? join(process.resourcesPath, "tray") : join(app.getAppPath(), "build/tray");
  const icon = nativeImage.createFromPath(join(root, "trayTemplate.png"));
  if (icon.isEmpty()) throw new Error("Packaged tray icon is missing");
  if (process.platform === "darwin") icon.setTemplateImage(true);
  const tray = new Tray(icon);
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  tray.setToolTip("OpenCraft");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: chinese ? "打开 OpenCraft" : "Open OpenCraft", click: commands.open },
    { type: "separator" },
    { label: chinese ? "退出 OpenCraft" : "Quit OpenCraft", click: commands.quit },
  ]));
  // Clicking the status item opens its native menu, not the main window.
  return tray;
}
