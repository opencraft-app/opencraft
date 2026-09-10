import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyWindowChromeDocumentAttributes,
  getHeaderStartMinimumWidth,
  getWindowChromePolicy,
  resolveWindowChrome,
} from "../apps/workbench-web/src/window-chrome";

test("management modal preserves panel geometry while launchers follow conversation interaction ownership", () => {
  const app = readFileSync(new URL("../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  assert.match(app, /toolbarActions=\{conversationRouteOpen \? panelToolbarActions : \[\]\}/);
  assert.match(app, /const conversationSurfaceVisible = conversationRouteOpen \|\| managementSettingsOpen;/);
  assert.match(app, /rightPanelOpen=\{conversationSurfaceVisible && presentedRightPanelOpen\}/);
});

test("renderer host identity is installed above body for the viewport contract", () => {
  const root = { dataset: {} as DOMStringMap };

  applyWindowChromeDocumentAttributes(root, {
    kind: "browser",
    platform: "darwin",
  });

  assert.equal(root.dataset.codexWindowType, "browser");
  assert.equal(root.dataset.codexOs, "darwin");
});

test("ordinary browsers do not inherit a macOS renderer safe area", () => {
  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    navigatorPlatform: "MacIntel",
    viewportWidth: 1440,
  });

  assert.deepEqual(snapshot, {
    kind: "browser",
    platform: "darwin",
    safeArea: { left: 0, right: 0 },
  });
  assert.equal(getHeaderStartMinimumWidth(snapshot), 140);
  assert.deepEqual(getWindowChromePolicy(snapshot).leadingNavigationActions, [
    "home",
    "sidebar-toggle",
    "back",
    "forward",
  ]);
});

test("macOS Electron reserves the native traffic-light interaction space", () => {
  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "MacIntel",
    viewportWidth: 1440,
  });

  assert.equal(snapshot.kind, "electron");
  assert.equal(snapshot.platform, "darwin");
  assert.deepEqual(snapshot.safeArea, { left: 78, right: 0 });
  assert.equal(getHeaderStartMinimumWidth(snapshot), 186);
  assert.deepEqual(getWindowChromePolicy(snapshot).leadingNavigationActions, [
    "sidebar-toggle",
    "back",
    "forward",
  ]);
});

test("native fullscreen atomically removes the macOS traffic-light safe area", () => {
  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "MacIntel",
    viewportWidth: 1440,
    fullscreenOverride: true,
    safeAreaOverride: { left: 92, right: 0 },
  });

  assert.deepEqual(snapshot.safeArea, { left: 0, right: 0 });
  assert.equal(getHeaderStartMinimumWidth(snapshot), 108);
});

test("Windows and Linux renderers have no implicit left safe area", () => {
  const windows = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "Win32",
    viewportWidth: 1440,
  });
  const linux = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "Linux x86_64",
    viewportWidth: 1440,
  });

  assert.deepEqual(windows.safeArea, { left: 0, right: 0 });
  assert.deepEqual(linux.safeArea, { left: 0, right: 0 });
});

test("Window Controls Overlay geometry wins over platform defaults", () => {
  const overlay = new EventTarget() as EventTarget & {
    visible: boolean;
    getTitlebarAreaRect(): DOMRect;
  };
  overlay.visible = true;
  overlay.getTitlebarAreaRect = () => ({ x: 72, width: 1268 }) as DOMRect;

  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "MacIntel",
    viewportWidth: 1440,
    overlay,
  });

  assert.deepEqual(snapshot.safeArea, { left: 72, right: 100 });
});

test("Electron preload can inject exact cross-platform window chrome insets", () => {
  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0 Electron/40.0.0",
    navigatorPlatform: "Win32",
    viewportWidth: 1440,
    safeAreaOverride: { left: "0", right: "138" },
  });

  assert.deepEqual(snapshot, {
    kind: "electron",
    platform: "win32",
    safeArea: { left: 0, right: 138 },
  });
});

test("ordinary browsers ignore Electron preload-only inset attributes", () => {
  const snapshot = resolveWindowChrome({
    userAgent: "Mozilla/5.0",
    navigatorPlatform: "Linux x86_64",
    viewportWidth: 1440,
    safeAreaOverride: { left: 80, right: 120 },
  });

  assert.deepEqual(snapshot.safeArea, { left: 0, right: 0 });
});

test("macOS desktop uses a snapshot-safe focus-driven native surface", () => {
  const desktopMain = readFileSync(
    new URL("../apps/workbench-electron/src/main.ts", import.meta.url),
    "utf8",
  );
  const desktopPreload = readFileSync(
    new URL("../apps/workbench-electron/src/preload.ts", import.meta.url),
    "utf8",
  );
  const rendererMain = readFileSync(
    new URL("../apps/workbench-web/src/main.tsx", import.meta.url),
    "utf8",
  );
  const appStyles = readFileSync(
    new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url),
    "utf8",
  );
  const appShellHeader = readFileSync(
    new URL("../apps/workbench-web/src/components/app-shell-header.tsx", import.meta.url),
    "utf8",
  );

  assert.match(desktopMain, /backgroundColor:\s*initialBackgroundColor/u);
  assert.doesNotMatch(desktopMain, /transparent:\s*false/u);
  assert.doesNotMatch(desktopMain, /isSystemBackdropSupported/u);
  assert.doesNotMatch(desktopMain, /opacity:\s*1/u);
  assert.doesNotMatch(desktopMain, /roundedCorners:\s*true/u);
  assert.doesNotMatch(desktopMain, /hasShadow:\s*true/u);
  assert.match(desktopMain, /vibrancy:\s*process\.platform === "darwin" \? "menu"/u);
  assert.doesNotMatch(desktopMain, /^\s*visualEffectState\s*:/mu);
  assert.match(desktopMain, /function applyWindowAppearance/u);
  assert.match(desktopMain, /nativeTheme\.themeSource = appearance\.themeSource/u);
  assert.match(desktopMain, /const useOpaqueSurface = !window\.isFocused\(\)/u);
  assert.match(desktopMain, /window\.setVibrancy\(useOpaqueSurface \? null : "menu"\)/u);
  assert.doesNotMatch(desktopMain, /setWindowButtonVisibility/u);
  assert.match(desktopMain, /const APP_SHELL_HEADER_HEIGHT = 46/u);
  assert.match(desktopMain, /const MACOS_WINDOW_BUTTON_SIZE = 14/u);
  assert.match(desktopMain, /const MACOS_WINDOW_BUTTON_X = 16/u);
  assert.match(desktopMain, /function getMacWindowButtonPosition/u);
  assert.match(desktopMain, /trafficLightPosition:\s*process\.platform === "darwin"/u);
  assert.match(desktopMain, /acceptFirstMouse:\s*process\.platform === "darwin"/u);
  assert.match(desktopMain, /scrollBounce:\s*process\.platform === "darwin"/u);
  assert.match(desktopMain, /webContents\.setZoomLevel\(0\)/u);
  assert.match(desktopMain, /show:\s*true/u);
  assert.doesNotMatch(desktopMain, /once\("ready-to-show"/u);
  assert.match(desktopMain, /window\.on\("blur", refreshWindowAppearance\)/u);
  assert.match(desktopMain, /window\.on\("focus", refreshWindowAppearance\)/u);
  assert.match(desktopMain, /window\.on\("show", refreshWindowAppearance\)/u);
  assert.match(desktopMain, /window\.on\("hide", refreshWindowAppearance\)/u);
  assert.doesNotMatch(desktopMain, /window\.on\("minimize"/u);
  assert.match(
    desktopMain,
    /window\.once\("closed", \(\) => \{[\s\S]*?if \(mainWindow === window\) mainWindow = null;[\s\S]*?if \(mainWebContents === webContents\) mainWebContents = null;/u,
  );
  assert.doesNotMatch(
    desktopMain,
    /return \(\) => \{[\s\S]{0,900}?window\.webContents/u,
  );
  assert.match(desktopMain, /ipcMain\.on\("vela:set-window-appearance"/u);
  assert.match(desktopPreload, /setWindowAppearance/u);
  assert.match(desktopMain, /ipcMain\.on\("vela:get-window-fullscreen"/u);
  assert.match(desktopMain, /window\.on\("enter-full-screen", publishEnteredFullscreen\)/u);
  assert.match(desktopMain, /window\.on\("leave-full-screen", publishLeftFullscreen\)/u);
  assert.match(desktopPreload, /getWindowFullscreen/u);
  assert.match(desktopPreload, /onWindowFullscreenChanged/u);
  assert.match(rendererMain, /data(?:set)?\.opencraftWindowFullscreen/u);
  assert.doesNotMatch(rendererMain, /electron-opaque/u);
  assert.doesNotMatch(appStyles, /electron-opaque/u);
  assert.match(appShellHeader, /app-shell-header__traffic-light-snapshot/u);
  assert.match(
    appStyles,
    /data-codex-window-type="electron"\]\[data-codex-os="darwin"\]\[data-opencraft-window-fullscreen="false"\][\s\S]*?\.app-shell-header__traffic-light-snapshot/u,
  );
  assert.match(appStyles, /\.app-shell-header__traffic-light-snapshot[\s\S]*?pointer-events:\s*none/u);
  assert.match(appStyles, /top:\s*16px[\s\S]*?left:\s*16px/u);
  assert.match(appStyles, /gap:\s*9px[\s\S]*?width:\s*60px/u);
});
