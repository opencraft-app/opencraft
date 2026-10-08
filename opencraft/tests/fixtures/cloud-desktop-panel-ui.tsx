import React, { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { buildCodexThemeCssProperties, codexThemePalette } from "@opencraft/design-system/theme-engine";
import { ProgressIndicator } from "@opencraft/design-system-web/progress";
import { bindTouchInteractionMode } from "../../apps/workbench-web/src/runtime/pointer-modality";
import chineseMessages from "../../apps/workbench-web/src/i18n/locales/zh-CN.json";
import { captureFramePreview } from "../../plugins/cloud-desktop/src/frame-preview";
import { createCloudDesktopWorkbenchPanelPlugin, type DesktopConnectionSnapshot,
  type DesktopControlLease } from "../../plugins/cloud-desktop/src/index";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { MemoryUiPreferenceStore, UiPreferencesRuntime } from "@opencraft/ui-preferences";
import { UiPreferencesProvider } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";

// Only authorization/media boundaries are synthetic. The real plugin, controller,
// panel registry and production CSS render every state; never import from bootstrap.
let state: DesktopConnectionSnapshot = { mediaAspectRatio: 960 / 600, videoReady: false, inputReady: false,
  controlAvailable: true, ended: false };
let authorized = true, valid = false, mounts = 0, preparations = 0, requests = 0, releases = 0, connectionCloses = 0, attachmentReleases = 0;
let pasteAvailable = true;
let toolMounts = 0, toolCloses = 0;
let grant: ((lease: DesktopControlLease) => void) | null = null;
const listeners = new Set<() => void>(), authorityListeners = new Set<() => void>();
const revoked = new Set<() => void>();
const lease: DesktopControlLease = { isValid: () => valid,
  subscribeRevoked: listener => { revoked.add(listener); return () => { revoked.delete(listener); }; },
  release: () => { releases++; valid = false; } };
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
const unbindPointerMode = bindTouchInteractionMode(document);
let progressProbe: { root: ReturnType<typeof createRoot>; element: HTMLElement } | null = null;
const target = { conversationId: "fixture", environmentId: "environment:test", serverId: "server:test", principalId: "account:test" };
const runtime = await createWorkbenchPanelReactRuntime();
await runtime.install(createCloudDesktopWorkbenchPanelPlugin({
  backend: {
    resolveTarget: () => authorized ? target : null,
    subscribe: listener => { authorityListeners.add(listener); return () => { authorityListeners.delete(listener); }; },
    async prepare() {
      preparations++;
      return { target, resourceId: "resource:test", incarnation: "instance:test", release() { attachmentReleases++; },
        async connect() { return {
          getSnapshot: () => state,
          capturePreview: () => {
            const canvas = document.querySelector('.cloud-desktop-panel__surface canvas') as HTMLCanvasElement | null;
            return canvas ? captureFramePreview(canvas) : null;
          },
          subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          requestControl: () => new Promise(resolve => { requests++; grant = resolve; }), close() { connectionCloses++; },
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
    return { setActive() {}, enableInput() {}, disableInput() {}, focus() { canvas.focus({ preventScroll: true }); },
      get pasteText() { return pasteAvailable ? async () => {} : undefined; }, dispose() { canvas.remove(); } };
  } },
}));
const locale = new LocaleRuntime([{ locale: "zh-CN", label: "简体中文", load: async () => chineseMessages }]);
await locale.update({ ideLocale: "en-US" });
const preferences = await UiPreferencesRuntime.open({ installation: new MemoryUiPreferenceStore() });
const root = createRoot(document.getElementById("root")!);
const tab = runtime.panels.open("fixture-panel", "cloud-desktop", { conversationId: "fixture" });
runtime.panels.register({ kind: "fixture-tool", createTab: () => ({ id: "other-tool", resource: "other-tool",
  kind: "fixture-tool", region: "right", title: "Other tool", icon: "terminal", closable: true, preview: false }) });
function OtherTool() {
  useEffect(() => { toolMounts++; return () => { toolCloses++; }; }, []);
  return <div data-other-tool>Other tool</div>;
}
runtime.renderers.register({ kind: "fixture-tool", Component: OtherTool });
const Panel = runtime.renderers.getSnapshot().find(item => item.kind === "cloud-desktop")!.Component;
const shell = new URL(location.href).searchParams.has("shell");
if (shell) runtime.panels.dispatch("fixture-panel", { type: "set-region-open", region: "right", open: false });
const subscribe = (listener: () => void) => runtime.panels.subscribeOwner("fixture-panel", listener);
const getState = () => runtime.panels.getOwnerSnapshot("fixture-panel");
function ShellFixture() {
  const state = useSyncExternalStore(subscribe, getState);
  return <AppShell layoutScope="fixture-panel" mainContentLayout="default" header={<span>Fixture</span>}
    floatingSidebarHeader={() => null} sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={() => {}}
    onSidebarExpand={() => {}} onSidebarResizeEnd={() => {}}
    windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}
    rightPanelKeepMounted={state.right.tabs.some(tab => tab.kind === "cloud-desktop")}
    rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth || window.innerWidth < 960}
    onRightPanelOpenChange={open => runtime.panels.dispatch("fixture-panel", { type: "set-region-open", region: "right", open })}
    rightPanel={<RightPanel state={state} presentationId="fixture-view" renderers={runtime.renderers.getSnapshot()}
      toolbarActions={[]} toolbarActionContext={{ ownerId: "fixture-panel", resourceOwnerId: "fixture", hostId: "fixture", cwd: null }}
      onAction={action => runtime.panels.dispatch("fixture-panel", action)}
      onCloseTab={tab => runtime.panels.close("fixture-panel", tab.region, tab.id)} />}>
    <p>Parent conversation</p>
  </AppShell>;
}
root.render(<UiPreferencesProvider runtime={preferences}><IntlRuntimeProvider runtime={locale}>{shell ? <ShellFixture /> : <Panel tab={tab} ownerId="fixture-panel"
  presentationId="fixture-view" />}</IntlRuntimeProvider></UiPreferencesProvider>);
Object.assign(window, { __desktopUi: {
  mountProgressProbe() {
    const element = document.createElement("div");
    element.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none";
    document.body.append(element);
    const root = createRoot(element);
    root.render(<ProgressIndicator className="motion-probe" />);
    progressProbe = { root, element };
  },
  theme,
  locale: (value: string) => locale.update({ localeOverride: value }),
  ready(controlAvailable = true, supportsPaste = true) {
    pasteAvailable = supportsPaste;
    state = { mediaAspectRatio: 960 / 600, videoReady: true, inputReady: true, controlAvailable, ended: false }; notify();
  },
  fail() { state = { ...state, ended: true }; notify(); },
  connecting() { state = { mediaAspectRatio: 960 / 600, videoReady: false, inputReady: false, controlAvailable: true, ended: false }; },
  grant() { valid = true; const resolve = grant; grant = null; resolve?.(lease); },
  unavailable() { authorized = false; for (const listener of authorityListeners) listener(); },
  counts: () => ({ mounts, preparations, requests, releases, connectionCloses, attachmentReleases, toolMounts, toolCloses }),
  other: () => runtime.panels.open("fixture-panel", "fixture-tool", {}),
  desktop: () => runtime.panels.dispatch("fixture-panel", { type: "activate-tab", region: "right", tabId: tab.id }),
  hide: () => runtime.panels.dispatch("fixture-panel", { type: "set-region-open", region: "right", open: false }),
  show: () => runtime.panels.dispatch("fixture-panel", { type: "set-region-open", region: "right", open: true }),
  close: () => runtime.panels.close("fixture-panel", "right", tab.id),
  async dispose() {
    progressProbe?.root.unmount(); progressProbe?.element.remove();
    unbindPointerMode(); root.unmount(); await runtime.dispose(); locale.dispose(); await preferences.close();
  },
} });
