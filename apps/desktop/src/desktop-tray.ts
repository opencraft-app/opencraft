import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";
import type { IntlPort } from "@opencraft/i18n";

export function createDesktopTrayMenu(commands: { open(): void; quit(): void }, locale: IntlPort): Menu {
  const intl = locale.getSnapshot().intl;
  return Menu.buildFromTemplate([
    { label: intl.formatMessage({ id: "desktop.open", defaultMessage: "Open OpenCraft" }), click: commands.open },
    { type: "separator" },
    { label: intl.formatMessage({ id: "desktop.quit", defaultMessage: "Quit OpenCraft" }), click: commands.quit },
  ]);
}

export function createDesktopTray(commands: { open(): void; quit(): void }, locale: IntlPort): Tray {
  const root = app.isPackaged ? join(process.resourcesPath, "tray") : join(app.getAppPath(), "build/tray");
  const icon = nativeImage.createFromPath(join(root, "trayTemplate.png"));
  if (icon.isEmpty()) throw new Error("Packaged tray icon is missing");
  if (process.platform === "darwin") icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip("OpenCraft");
  const update = () => {
    if (tray.isDestroyed()) return;
    tray.setContextMenu(createDesktopTrayMenu(commands, locale));
  };
  update();
  // Both tray and the application-scoped locale runtime retire at app shutdown.
  locale.subscribe(update);
  // Clicking the status item opens its native menu, not the main window.
  return tray;
}
