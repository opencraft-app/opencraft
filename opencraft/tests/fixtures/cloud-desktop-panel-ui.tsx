import React from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { buildCodexThemeCssProperties, codexThemePalette } from "@opencraft/design-system/theme-engine";
import chineseMessages from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import { createCloudDesktopWorkbenchPanelPlugin, type DesktopConnectionSnapshot,
  type DesktopControlLease } from "../../plugins/cloud-desktop/src/index";

// Only authorization/media boundaries are synthetic. The real plugin, controller,
// panel registry and production CSS render every state; never import from bootstrap.
let state: DesktopConnectionSnapshot = { videoReady: false, inputReady: false,
  controlAvailable: true, ended: false };
let authorized = true, valid = false, mounts = 0, preparations = 0;
let grant: ((lease: DesktopControlLease) => void) | null = null;
const listeners = new Set<() => void>(), authorityListeners = new Set<() => void>();
const revoked = new Set<() => void>();
const lease: DesktopControlLease = { isValid: () => valid,
  subscribeRevoked: listener => { revoked.add(listener); return () => { revoked.delete(listener); }; },
  release: () => { valid = false; } };
const notify = () => { for (const listener of listeners) listener(); };
function theme(name: string) {
  const mode = name === "light" ? "light" : "dark";
  const definition = name === "custom" ? { ...codexThemePalette.dark, surface: "#17232f", ink: "#f2e8d3" } : codexThemePalette[mode];
  document.documentElement.dataset.theme = mode;
  for (const [key, value] of Object.entries(buildCodexThemeCssProperties(mode, definition))) {
    document.documentElement.style.setProperty(key, value);
  }
}
theme("light");
const target = { conversationId: "fixture", environmentId: "environment:test", serverId: "server:test", principalId: "account:test" };
const runtime = await createWorkbenchPanelReactRuntime();
await runtime.install(createCloudDesktopWorkbenchPanelPlugin({
  backend: {
    resolveTarget: () => authorized ? target : null,
    subscribe: listener => { authorityListeners.add(listener); return () => { authorityListeners.delete(listener); }; },
    async prepare() {
      preparations++;
      return { target, resourceId: "resource:test", incarnation: "instance:test", release() {},
        async connect() { return {
          getSnapshot: () => state,
          subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          requestControl: () => new Promise(resolve => { grant = resolve; }), close() {},
        }; } };
    },
  },
  surfaces: { mount(element) {
    mounts++;
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 600;
    canvas.style.cssText = "display:block;width:100%;height:100%;object-fit:contain";
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2080e0"; context.fillRect(0, 0, 960, 600);
    element.append(canvas);
    canvas.tabIndex = 0;
    return { enableInput() {}, disableInput() {}, focus() { canvas.focus({ preventScroll: true }); },
      async pasteText() {}, dispose() { canvas.remove(); } };
  } },
}));
const locale = new LocaleRuntime([{ locale: "zh-CN", label: "简体中文", load: async () => chineseMessages }]);
await locale.update({ ideLocale: "en-US" });
const root = createRoot(document.getElementById("root")!);
const tab = runtime.panels.open("fixture-panel", "cloud-desktop", { conversationId: "fixture" });
const Panel = runtime.renderers.getSnapshot().find(item => item.kind === "cloud-desktop")!.Component;
root.render(<IntlRuntimeProvider runtime={locale}><Panel tab={tab} ownerId="fixture-panel"
  presentationId="fixture-view" /></IntlRuntimeProvider>);
Object.assign(window, { __desktopUi: {
  theme,
  locale: (value: string) => locale.update({ localeOverride: value }),
  ready(controlAvailable = true) {
    state = { videoReady: true, inputReady: true, controlAvailable, ended: false }; notify();
  },
  fail() { state = { ...state, ended: true }; notify(); },
  connecting() { state = { videoReady: false, inputReady: false, controlAvailable: true, ended: false }; },
  grant() { valid = true; const resolve = grant; grant = null; resolve?.(lease); },
  unavailable() { authorized = false; for (const listener of authorityListeners) listener(); },
  counts: () => ({ mounts, preparations }),
  async dispose() { root.unmount(); await runtime.dispose(); locale.dispose(); },
} });
