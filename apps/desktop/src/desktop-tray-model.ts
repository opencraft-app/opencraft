import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import type { IntlPort } from "@opencraft/i18n";

export type TrayRelayConnectionState = "disabled" | "connecting" | "online";
export type TraySleepProtectionMode = "ac" | "always" | "off";

export interface DesktopTrayState {
  readonly relay?: {
    readonly status: TrayRelayConnectionState;
    readonly activeWatchers: number;
    readonly sleepProtectionMode: TraySleepProtectionMode;
    readonly sleepBlockerActive: boolean;
  };
  readonly activeTaskCount?: number;
  readonly taskKeepAwakeActive?: boolean;
  readonly openAtLogin?: boolean;
  readonly menuBarOnly?: boolean;
}

export interface DesktopTrayCommands {
  open(): void;
  quit(): void;
  openRemoteSettings?(): void;
  setSleepProtectionMode?(mode: TraySleepProtectionMode): void;
  setOpenAtLogin?(enabled: boolean): void;
  setMenuBarOnly?(enabled: boolean): void;
}

export function buildDesktopTrayTemplate(
  commands: DesktopTrayCommands,
  locale: IntlPort,
  state?: DesktopTrayState,
): MenuItemConstructorOptions[] {
  const intl = locale.getSnapshot().intl;
  const openItem: MenuItemConstructorOptions = {
    label: intl.formatMessage({ id: "desktop.open", defaultMessage: "Open OpenCraft" }),
    click: commands.open,
  };
  const quitItem: MenuItemConstructorOptions = {
    label: intl.formatMessage({ id: "desktop.quit", defaultMessage: "Quit OpenCraft" }),
    click: commands.quit,
  };

  if (!state) {
    return [openItem, { type: "separator" }, quitItem];
  }

  const template: MenuItemConstructorOptions[] = [openItem];
  const activeTaskCount = Math.max(0, state.activeTaskCount ?? 0);
  const sleepActive = Boolean(state.relay?.sleepBlockerActive || state.taskKeepAwakeActive);

  if (state.relay || activeTaskCount > 0 || sleepActive) {
    template.push({ type: "separator" });
    if (state.relay) {
      const relayLabel =
        state.relay.status === "online"
          ? state.relay.activeWatchers > 0
            ? intl.formatMessage(
                {
                  id: "desktop.tray.relay.onlineActive",
                  defaultMessage: "● Remote Control: Online ({count, plural, one {# session} other {# sessions}})",
                },
                { count: state.relay.activeWatchers },
              )
            : intl.formatMessage({
                id: "desktop.tray.relay.online",
                defaultMessage: "● Remote Control: Online",
              })
          : state.relay.status === "connecting"
            ? intl.formatMessage({
                id: "desktop.tray.relay.connecting",
                defaultMessage: "◐ Remote Control: Connecting…",
              })
            : intl.formatMessage({
                id: "desktop.tray.relay.off",
                defaultMessage: "○ Remote Control: Off",
              });
      template.push({ label: relayLabel, enabled: false });
    }
    if (activeTaskCount > 0) {
      template.push({
        label: intl.formatMessage(
          {
            id: "desktop.tray.tasks.running",
            defaultMessage: "⚡ {count, plural, one {# local task running} other {# local tasks running}}",
          },
          { count: activeTaskCount },
        ),
        enabled: false,
      });
    }
    if (sleepActive) {
      template.push({
        label: intl.formatMessage({
          id: "desktop.tray.sleep.active",
          defaultMessage: "☕ Preventing automatic sleep",
        }),
        enabled: false,
      });
    }
    if (state.relay && commands.setSleepProtectionMode) {
      const setMode = commands.setSleepProtectionMode;
      const currentMode = state.relay.sleepProtectionMode;
      template.push({
        label: intl.formatMessage({
          id: "desktop.tray.sleep.menu",
          defaultMessage: "Prevent Automatic Sleep",
        }),
        submenu: [
          {
            label: intl.formatMessage({
              id: "desktop.tray.sleep.ac",
              defaultMessage: "On Power Adapter",
            }),
            type: "radio",
            checked: currentMode === "ac",
            click: () => setMode("ac"),
          },
          {
            label: intl.formatMessage({
              id: "desktop.tray.sleep.always",
              defaultMessage: "Always",
            }),
            type: "radio",
            checked: currentMode === "always",
            click: () => setMode("always"),
          },
          {
            label: intl.formatMessage({
              id: "desktop.tray.sleep.off",
              defaultMessage: "Off",
            }),
            type: "radio",
            checked: currentMode === "off",
            click: () => setMode("off"),
          },
        ],
      });
    }
    if (state.relay && commands.openRemoteSettings) {
      template.push({
        label: intl.formatMessage({
          id: "desktop.tray.relay.settings",
          defaultMessage: "Remote Control Settings…",
        }),
        click: commands.openRemoteSettings,
      });
    }
  }

  const hasLoginItem = state.openAtLogin !== undefined && commands.setOpenAtLogin !== undefined;
  const hasMenuBarOnly = state.menuBarOnly !== undefined && commands.setMenuBarOnly !== undefined;
  if (hasLoginItem || hasMenuBarOnly) {
    template.push({ type: "separator" });
    if (hasLoginItem) {
      const toggleLogin = commands.setOpenAtLogin!;
      const checked = state.openAtLogin === true;
      template.push({
        label: intl.formatMessage({
          id: "desktop.tray.openAtLogin",
          defaultMessage: "Launch at Login",
        }),
        type: "checkbox",
        checked,
        click: (item) => toggleLogin(item.checked),
      });
    }
    if (hasMenuBarOnly) {
      const toggleMenuBarOnly = commands.setMenuBarOnly!;
      const checked = state.menuBarOnly === true;
      template.push({
        label: intl.formatMessage({
          id: "desktop.tray.menuBarOnly",
          defaultMessage: "Hide Dock Icon When Closed",
        }),
        type: "checkbox",
        checked,
        click: (item) => toggleMenuBarOnly(item.checked),
      });
    }
  }

  template.push({ type: "separator" }, quitItem);
  return template;
}

export function formatDesktopTrayTooltip(locale: IntlPort, state?: DesktopTrayState): string {
  const intl = locale.getSnapshot().intl;
  const parts = ["OpenCraft"];
  if (state?.relay?.status === "online") {
    parts.push(
      intl.formatMessage({
        id: "desktop.tray.tooltip.relayOnline",
        defaultMessage: "Remote Control Online",
      }),
    );
  } else if (state?.relay?.status === "connecting") {
    parts.push(
      intl.formatMessage({
        id: "desktop.tray.tooltip.relayConnecting",
        defaultMessage: "Remote Control Connecting",
      }),
    );
  }
  const activeTaskCount = Math.max(0, state?.activeTaskCount ?? 0);
  if (activeTaskCount > 0) {
    parts.push(
      intl.formatMessage(
        {
          id: "desktop.tray.tooltip.tasksRunning",
          defaultMessage: "{count, plural, one {# task running} other {# tasks running}}",
        },
        { count: activeTaskCount },
      ),
    );
  }
  return parts.join(" · ");
}

export function resolveDesktopTrayIconSpec(
  trayRoot: string,
  platform: NodeJS.Platform = process.platform,
): { readonly iconPath: string; readonly fallbackIconPath?: string; readonly templateImage: boolean } {
  if (platform === "darwin") {
    return { iconPath: join(trayRoot, "trayTemplate.png"), templateImage: true };
  }
  return {
    iconPath: join(trayRoot, "trayIcon.png"),
    fallbackIconPath: join(trayRoot, "trayTemplate.png"),
    templateImage: false,
  };
}

export function bindDesktopTrayPlatformEvents(
  tray: { on(event: "click" | "double-click", listener: () => void): unknown },
  commands: Pick<DesktopTrayCommands, "open">,
  platform: NodeJS.Platform = process.platform,
): void {
  // On macOS, clicking the status item opens its native menu via setContextMenu.
  // On Windows and Linux, left-clicking or double-clicking opens the main window.
  if (platform !== "darwin") {
    tray.on("click", () => commands.open());
    tray.on("double-click", () => commands.open());
  }
}
