import { app, Menu, nativeImage, Tray } from "electron";
import { join } from "node:path";
import type { IntlPort } from "@opencraft/i18n";
import {
  bindDesktopTrayPlatformEvents,
  buildDesktopTrayTemplate,
  formatDesktopTrayTooltip,
  resolveDesktopTrayIconSpec,
  type DesktopTrayCommands,
  type DesktopTrayState,
} from "./desktop-tray-model.js";

export {
  bindDesktopTrayPlatformEvents,
  buildDesktopTrayTemplate,
  formatDesktopTrayTooltip,
  resolveDesktopTrayIconSpec,
  type DesktopTrayCommands,
  type DesktopTrayState,
  type TrayRelayConnectionState,
  type TraySleepProtectionMode,
} from "./desktop-tray-model.js";

export interface DesktopTrayController {
  readonly tray: Tray;
  setState(state: DesktopTrayState): void;
  destroy(): void;
}

export function createDesktopTrayMenu(
  commands: DesktopTrayCommands,
  locale: IntlPort,
  state?: DesktopTrayState,
): Menu {
  return Menu.buildFromTemplate(buildDesktopTrayTemplate(commands, locale, state));
}

export function createDesktopTray(
  commands: DesktopTrayCommands,
  locale: IntlPort,
  initialState?: DesktopTrayState,
): DesktopTrayController {
  const root = app.isPackaged ? join(process.resourcesPath, "tray") : join(app.getAppPath(), "build/tray");
  const spec = resolveDesktopTrayIconSpec(root, process.platform);
  let icon = nativeImage.createFromPath(spec.iconPath);
  if (icon.isEmpty() && spec.fallbackIconPath) {
    icon = nativeImage.createFromPath(spec.fallbackIconPath);
  }
  if (icon.isEmpty()) throw new Error("Packaged tray icon is missing");
  if (spec.templateImage) icon.setTemplateImage(true);
  const tray = new Tray(icon);
  let currentState = initialState;
  const update = () => {
    if (tray.isDestroyed()) return;
    tray.setToolTip(formatDesktopTrayTooltip(locale, currentState));
    tray.setContextMenu(createDesktopTrayMenu(commands, locale, currentState));
  };
  update();
  const unsubscribeLocale = locale.subscribe(update);
  bindDesktopTrayPlatformEvents(tray, commands, process.platform);
  return {
    tray,
    setState(nextState: DesktopTrayState) {
      currentState = nextState;
      update();
    },
    destroy() {
      unsubscribeLocale();
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
