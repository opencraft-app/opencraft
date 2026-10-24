import React, { useState, useSyncExternalStore } from "react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createCloudDesktopWorkbenchPanelPlugin, type DesktopControlLease } from "../../plugins/cloud-desktop/src/index";
import { bindDesktopPointerInput } from "../../plugins/cloud-desktop/src/pointer-input";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { ThreadComposerPresentation } from "../../apps/workbench-web/src/components/thread-composer-presentation";
import { useTimelineViewportHost } from "../../apps/workbench-web/src/timeline-viewport";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
// Only the external desktop media/control plane is synthetic. Real Shell,
// Panel/controller, pointer gestures and Composer own DOM and lifecycle.
const packets: number[] = [];
let connections = 0;
const target = { conversationId: "one", serverId: "test", environmentId: "test", principalId: "test" };
const adapter = {
  backend: {
    resolveTarget: () => target, subscribe: () => () => {},
    prepare: async () => ({ target, resourceId: "test", incarnation: "test:1", release() {},
      async connect() {
        connections++;
        return { getSnapshot: () => ({ videoReady: true, inputReady: true, controlAvailable: true, ended: false, mediaAspectRatio: 1.6 }),
          subscribe: () => () => {}, close() {}, async requestControl() {
            let valid = true;
            return { isValid: () => valid, subscribeRevoked: () => () => {}, release() { valid = false; } };
          } };
      } }),
  },
  surfaces: { mount(element: HTMLElement) {
    const canvas = document.createElement("canvas"); canvas.width = 1440; canvas.height = 900; canvas.tabIndex = 0;
    Object.assign(canvas.style, { width: "100%", height: "100%", background: "#246fa7" }); element.append(canvas);
    let lease: DesktopControlLease | null = null, active = true;
    const pointer = bindDesktopPointerInput(element, {
      getInputCanvas: () => canvas, setPointerInputManaged() {}, focus: () => canvas.focus({ preventScroll: true }),
      sendPointer: (_x: number, _y: number, mask: number) => packets.push(mask),
    } as any, () => active && lease?.isValid() === true);
    return { setActive(value: boolean) { active = value; if (!value) pointer.reset(); },
      focus() { canvas.focus({ preventScroll: true }); },
      focusTextInput() { canvas.focus({ preventScroll: true }); },
      enableInput(value: DesktopControlLease) { lease = value; pointer.reset(); },
      disableInput() { pointer.reset(); lease = null; },
      attachTrackpad: pointer.attachTrackpad,
      dispose() { pointer.dispose(); canvas.remove(); } };
  } },
};
const runtime = await createWorkbenchPanelReactRuntime();
await runtime.install(TimelineBlockRendererRegistryService);
await runtime.install(BuiltinTimelineRendererPlugin);
await runtime.install(createCloudDesktopWorkbenchPanelPlugin(adapter));
runtime.panels.open("keyboard", "cloud-desktop", {conversationId: "one"});
runtime.panels.dispatch("keyboard", {type:"toggle-right-full-width"});
const subscribe = (f: () => void) => runtime.panels.subscribeOwner("keyboard", f);
const getState = () => runtime.panels.getOwnerSnapshot("keyboard");
const controller = createComposerController({ type: "existing-thread", key: { hostId: "test", threadId: "one" } }, { now: Date.now, createId: () => crypto.randomUUID() });
const chrome = { kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } } as const;
function App() {
  const state = useSyncExternalStore(subscribe, getState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  useTimelineViewportHost(chrome);
  Object.assign(window, { fixture: { packets, sidebarOpen, setSidebarOpen, get connections() { return connections; }, controller, setOverlayEnabled, setThemePreference, setPanelOpen(open: boolean) { runtime.panels.dispatch("keyboard", {type:"set-region-open",region:"right",open}); } } });
  return <AppShell navigation={{layout:"unified",actions:[],account:{snapshot:{phase:"authenticated",name:"Synthetic user",avatarUrl:null},onOpen() {},async onRefresh() {}},onOpenSettings() {}}} layoutScope="keyboard" mainContentLayout="default" header={<AppShellHeader title="Desktop" project={null} sidebarOpen={sidebarOpen} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} onToggleRightPanel={() => {}} onHome={() => {}} canGoBack={false} canGoForward={false} onBack={() => {}} onForward={() => {}} navigationActions={['sidebar-toggle']} />} windowChrome={chrome}
    sidebarOpen={sidebarOpen} sidebarWidth={275} onSidebarCollapse={() => setSidebarOpen(false)} onSidebarExpand={() => setSidebarOpen(true)} onSidebarResizeEnd={() => {}}
    floatingSidebarHeader={() => null} leftPanel={<div>Conversations</div>} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open => runtime.panels.dispatch("keyboard", {type:"set-region-open",region:"right",open})}
    rightPanel={<RightPanel state={state} presentationId="test" renderers={runtime.renderers.getSnapshot()} toolbarActions={[]} toolbarActionContext={{ownerId:"keyboard",resourceOwnerId:"keyboard",hostId:"test",cwd:null}} onAction={action => runtime.panels.dispatch("keyboard",action)} onCloseTab={tab => runtime.panels.close("keyboard",tab.region,tab.id)} />}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><p style={{flex: 1}}>Parent conversation</p>
    {<ThreadComposerPresentation scopeId="keyboard" controller={controller} activeTabId="cloud-desktop" enabled={overlayEnabled} timeline={{key: {hostId: "test",threadId:"one"}, revision:1,phase:"live",authoritative:true,anchorFrameIds:new Map(),frames:[{id:"answer-frame",type:"assistant",turnId:"turn",status:"complete",durationMs:1000,hookStats:null,anchors:[],blocks:[{id:"answer",type:"text",text:"Latest answer\n\n" + "A bounded response paragraph.\n\n".repeat(40),sourceItemIds:["answer"],streaming:false,completed:true,phase:"final_answer"}]}]}} documentContext={{conversationId:"one",hostId:"test",cwd:null,theme:"light"}}>
      <div className="thread-composer-region"><OpenCraftComposer controller={controller} placeholder="Write a message" onSubmit={() => false} onCancel={() => {}} /></div>
    </ThreadComposerPresentation>}</div>
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!).render(<TimelineBlockRendererProvider registry={runtime.context.timelineBlockRenderers}><App /></TimelineBlockRendererProvider>);
