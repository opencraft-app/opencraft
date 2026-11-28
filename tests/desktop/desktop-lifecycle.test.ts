import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopLifecycle,
  type DesktopDockMode,
  type DesktopQuitDecision,
  type DesktopQuitSource,
  type LifecycleWindow,
} from "../../apps/desktop/src/desktop-lifecycle";
import { createDesktopLocaleRuntime } from "../../apps/desktop/src/desktop-locale";
import {
  evaluateDesktopQuit,
  type PersistedQuitBehavior,
  type QuitConfirmationDialogSpec,
} from "../../apps/desktop/src/desktop-quit-guard";
import {
  bindDesktopTrayPlatformEvents,
  buildDesktopTrayTemplate,
  formatDesktopTrayTooltip,
  resolveDesktopTrayIconSpec,
} from "../../apps/desktop/src/desktop-tray-model";

function fixture(options?: {
  dockMode?: () => DesktopDockMode;
  confirmQuit?: (source: DesktopQuitSource) => Promise<DesktopQuitDecision>;
}) {
  const calls: string[] = [];
  let visible = true;
  let close: (event: { preventDefault(): void }) => void = () => {};
  const window: LifecycleWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => visible,
    hide: () => {
      visible = false;
      calls.push("hide");
    },
    show: () => {
      visible = true;
      calls.push("show");
    },
    focus: () => {
      calls.push("focus");
    },
    restore: () => {
      calls.push("restore");
    },
    on: (_, listener) => {
      close = listener;
    },
  };
  const ports = {
    getWindow: () => window as LifecycleWindow | null,
    createWindow: async () => {
      calls.push("create");
    },
    showDock: async () => {
      calls.push("dock-show");
    },
    hideDock: () => {
      calls.push("dock-hide");
    },
    dockMode: options?.dockMode,
    confirmQuit: options?.confirmQuit,
    stopRuntime: async () => {
      calls.push("stop");
    },
    destroyTray: () => {
      calls.push("tray-destroy");
    },
    exit: (code: number) => {
      calls.push(`exit:${code}`);
    },
    reportError: () => {
      calls.push("error");
    },
  };
  const lifecycle = new DesktopLifecycle(ports);
  lifecycle.bindWindow(window);
  return {
    lifecycle,
    calls,
    ports,
    close: () => close({ preventDefault: () => calls.push("prevent") }),
  };
}

test("close hides window while keeping Dock icon visible by default; show restores the same window", async () => {
  const f = fixture();
  f.close();
  assert.deepEqual(f.calls, ["prevent", "hide"]);
  await f.lifecycle.show();
  assert.deepEqual(f.calls.slice(2), ["dock-show", "restore", "show", "focus"]);
});

test("close hides Dock icon only when menu-bar-only mode is enabled, and syncDock restores it when disabled", async () => {
  let mode: DesktopDockMode = "menu-bar-only";
  const f = fixture({ dockMode: () => mode });
  f.close();
  assert.deepEqual(f.calls, ["prevent", "hide", "dock-hide"]);

  mode = "keep";
  await f.lifecycle.syncDock();
  assert.deepEqual(f.calls.slice(3), ["dock-show"]);

  mode = "menu-bar-only";
  await f.lifecycle.syncDock();
  assert.deepEqual(f.calls.slice(4), ["dock-hide"]);
});

test("requestQuit hides window on 'hide', does nothing on 'cancel', and deduplicates concurrent prompts", async () => {
  let resolveDecision!: (decision: DesktopQuitDecision) => void;
  const sources: DesktopQuitSource[] = [];
  const f = fixture({
    confirmQuit: (source) => {
      sources.push(source);
      return new Promise<DesktopQuitDecision>((resolve) => {
        resolveDecision = resolve;
      });
    },
  });

  const first = f.lifecycle.requestQuit("app");
  const second = f.lifecycle.requestQuit("app");
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(sources, ["app"]);

  resolveDecision("hide");
  await first;
  assert.deepEqual(f.calls, ["hide"]);
  assert.equal(f.lifecycle.quitting, false);

  let nextDecision: DesktopQuitDecision = "cancel";
  f.ports.confirmQuit = async () => nextDecision;
  await f.lifecycle.requestQuit("app");
  assert.deepEqual(f.calls, ["hide"]);

  nextDecision = "quit";
  await f.lifecycle.requestQuit("tray");
  assert.deepEqual(f.calls, ["hide", "stop", "tray-destroy", "exit:0"]);
});

test("repeated quit awaits one shutdown and destroys tray afterwards", async () => {
  const f = fixture();
  let finish!: () => void;
  f.ports.stopRuntime = () => {
    f.calls.push("stop");
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const first = f.lifecycle.quit();
  const second = f.lifecycle.quit();
  assert.equal(first, second);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(f.calls, ["stop"]);
  await f.lifecycle.show();
  assert.deepEqual(f.calls, ["stop"]);
  finish();
  await first;
  assert.deepEqual(f.calls, ["stop", "tray-destroy", "exit:0"]);
});

test("failed shutdown is reported before exit", async () => {
  const f = fixture();
  f.ports.stopRuntime = async () => {
    throw new Error("failure");
  };
  await f.lifecycle.quit();
  assert.deepEqual(f.calls, ["error", "tray-destroy", "exit:1"]);
});

test("quit during Dock activation never creates or reveals a window", async () => {
  const f = fixture();
  let finish!: () => void;
  f.ports.showDock = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const opening = f.lifecycle.show();
  await Promise.resolve();
  const stopping = f.lifecycle.quit();
  finish();
  await opening;
  await stopping;
  assert.deepEqual(f.calls, ["stop", "tray-destroy", "exit:0"]);
});

test("evaluateDesktopQuit protects active Remote Control and tasks on Cmd+Q while keeping Tray Quit deterministic", async () => {
  const locale = createDesktopLocaleRuntime();
  await locale.update({ localeOverride: "zh-CN", localeSource: "EXPLICIT", systemLocale: "zh-CN" });

  let saved: PersistedQuitBehavior = "ask";
  const shown: QuitConfirmationDialogSpec[] = [];

  // 1. Idle app quit exits immediately without showing a dialog.
  assert.equal(
    await evaluateDesktopQuit({
      source: "app",
      relayEnrolled: false,
      activeTaskCount: 0,
      locale,
      readSavedBehavior: () => saved,
      writeSavedBehavior: (next) => {
        saved = next;
      },
      showDialog: async (spec) => {
        shown.push(spec);
        return { response: 0, checkboxChecked: false };
      },
    }),
    "quit",
  );
  assert.equal(shown.length, 0);

  // 2. Active Remote Control on Cmd+Q prompts and remembers 'hide' when checked.
  assert.equal(
    await evaluateDesktopQuit({
      source: "app",
      relayEnrolled: true,
      activeTaskCount: 0,
      locale,
      readSavedBehavior: () => saved,
      writeSavedBehavior: (next) => {
        saved = next;
      },
      showDialog: async (spec) => {
        shown.push(spec);
        return { response: 0, checkboxChecked: true };
      },
    }),
    "hide",
  );
  assert.equal(shown.length, 1);
  assert.equal(shown[0]!.message, "远程控制正在运行");
  assert.deepEqual(shown[0]!.buttons, ["隐藏到后台继续运行", "彻底退出", "取消"]);
  assert.equal(saved, "hide");

  // 3. Subsequent Cmd+Q honors saved 'hide' without re-prompting.
  assert.equal(
    await evaluateDesktopQuit({
      source: "app",
      relayEnrolled: true,
      activeTaskCount: 0,
      locale,
      readSavedBehavior: () => saved,
      writeSavedBehavior: () => {},
      showDialog: async () => {
        throw new Error("should not prompt");
      },
    }),
    "hide",
  );

  // 4. Explicit Tray Quit NEVER gets trapped by saved 'hide': quits immediately if no tasks run,
  //    and confirms [取消, 彻底退出] when tasks are mid-execution.
  assert.equal(
    await evaluateDesktopQuit({
      source: "tray",
      relayEnrolled: true,
      activeTaskCount: 0,
      locale,
      readSavedBehavior: () => saved,
      writeSavedBehavior: () => {},
      showDialog: async () => {
        throw new Error("should not prompt when idle");
      },
    }),
    "quit",
  );

  assert.equal(
    await evaluateDesktopQuit({
      source: "tray",
      relayEnrolled: true,
      activeTaskCount: 2,
      locale,
      readSavedBehavior: () => saved,
      writeSavedBehavior: () => {},
      showDialog: async (spec) => {
        shown.push(spec);
        return { response: 1, checkboxChecked: false };
      },
    }),
    "quit",
  );
  assert.equal(shown.at(-1)!.message, "当前有 2 个本地任务正在执行");
  assert.deepEqual(shown.at(-1)!.buttons, ["取消", "彻底退出"]);
  locale.dispose();
});

test("cross-platform tray helpers select color icon and left-click open on Windows/Linux and template icon on macOS", async () => {
  const dir = "/virtual/tray";
  const macSpec = resolveDesktopTrayIconSpec(dir, "darwin");
  assert.equal(macSpec.templateImage, true);
  assert.ok(macSpec.iconPath.endsWith("trayTemplate.png"));
  assert.equal(macSpec.fallbackIconPath, undefined);

  const winSpec = resolveDesktopTrayIconSpec(dir, "win32");
  assert.equal(winSpec.templateImage, false);
  assert.ok(winSpec.iconPath.endsWith("trayIcon.png"));
  assert.ok(winSpec.fallbackIconPath?.endsWith("trayTemplate.png"));

  const events = new Map<string, () => void>();
  const fakeTray = {
    on(event: string, listener: () => void) {
      events.set(event, listener);
      return fakeTray as any;
    },
  };
  let opened = 0;
  bindDesktopTrayPlatformEvents(fakeTray as any, { open: () => opened++ }, "darwin");
  assert.equal(events.size, 0);

  bindDesktopTrayPlatformEvents(fakeTray as any, { open: () => opened++ }, "win32");
  events.get("click")?.();
  events.get("double-click")?.();
  assert.equal(opened, 2);

  const locale = createDesktopLocaleRuntime();
  await locale.update({ localeOverride: "zh-CN", localeSource: "EXPLICIT", systemLocale: "zh-CN" });
  assert.equal(
    formatDesktopTrayTooltip(locale, {
      relay: { status: "online", activeWatchers: 1, sleepProtectionMode: "ac", sleepBlockerActive: true },
      activeTaskCount: 3,
    }),
    "OpenCraft · 远程控制在线 · 正在执行 3 个本地任务",
  );

  const minimal = buildDesktopTrayTemplate({ open() {}, quit() {} }, locale);
  assert.deepEqual(
    minimal.map((item) => item.label ?? ""),
    ["打开 OpenCraft", "", "退出 OpenCraft"],
  );

  let chosenSleepMode = "";
  let openedRemoteSettings = 0;
  let toggledLogin: boolean | null = null;
  let toggledMenuBarOnly: boolean | null = null;
  const rich = buildDesktopTrayTemplate(
    {
      open() {},
      quit() {},
      openRemoteSettings: () => {
        openedRemoteSettings++;
      },
      setSleepProtectionMode: (mode) => {
        chosenSleepMode = mode;
      },
      setOpenAtLogin: (enabled) => {
        toggledLogin = enabled;
      },
      setMenuBarOnly: (enabled) => {
        toggledMenuBarOnly = enabled;
      },
    },
    locale,
    {
      relay: {
        status: "online",
        activeWatchers: 2,
        sleepProtectionMode: "always",
        sleepBlockerActive: true,
      },
      activeTaskCount: 1,
      openAtLogin: false,
      menuBarOnly: false,
    },
  );
  const labels = rich.map((item) => item.label ?? "---");
  assert.deepEqual(labels, [
    "打开 OpenCraft",
    "---",
    "● 远程控制：在线（2 个连接）",
    "⚡ 正在执行 1 个本地任务",
    "☕ 正在防止电脑自动休眠",
    "防止电脑自动休眠",
    "远程控制设置…",
    "---",
    "开机自动启动",
    "关窗时隐藏程序坞图标",
    "---",
    "退出 OpenCraft",
  ]);

  const sleepSubmenu = rich.find((item) => item.label === "防止电脑自动休眠")?.submenu as any[];
  assert.equal(sleepSubmenu.find((item) => item.label === "始终")?.checked, true);
  sleepSubmenu.find((item) => item.label === "关闭")?.click();
  assert.equal(chosenSleepMode, "off");

  (rich.find((item) => item.label === "远程控制设置…")?.click as any)?.();
  assert.equal(openedRemoteSettings, 1);

  (rich.find((item) => item.label === "开机自动启动")?.click as any)?.({ checked: true });
  assert.equal(toggledLogin, true);

  (rich.find((item) => item.label === "关窗时隐藏程序坞图标")?.click as any)?.({ checked: true });
  assert.equal(toggledMenuBarOnly, true);

  locale.dispose();
});
