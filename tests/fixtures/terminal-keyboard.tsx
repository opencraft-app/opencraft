import React, { useState, useSyncExternalStore } from "react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { WorkbenchTerminalSessionRegistry, createTerminalWorkbenchPanelPlugin } from "../../plugins/terminal/src/index";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { ThreadComposerPresentation } from "../../apps/workbench-web/src/components/thread-composer-presentation";
import { useTimelineViewportHost } from "../../apps/workbench-web/src/timeline-viewport";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const sizes: { cols: number; rows: number }[] = [];
const snapshot = { revision: 0, phase: "running", output: [{ sequence: 1, deltaBase64: btoa(Array.from({ length: 80 }, (_, i) => `Terminal output ${i}\r\n`).join("")) }], error: null };
const session = { processId: "test", getSnapshot: () => snapshot, subscribe: () => () => {},
  resize: async (cols: number, rows: number) => { sizes.push({ cols, rows }); },
  write: async () => { throw new Error("No user shell input in this fixture"); }, terminate: async () => {}, dispose: async () => {} };
const registry = new WorkbenchTerminalSessionRegistry(() => ({ resources: { terminal: { open: () => session } } }) as any);
const resource = registry.open({ hostId: "test", cwd: null });
const runtime = await createWorkbenchPanelReactRuntime();
await runtime.install(TimelineBlockRendererRegistryService);
await runtime.install(BuiltinTimelineRendererPlugin);
await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
runtime.panels.open("keyboard", "terminal", {sessionId: resource});
runtime.panels.dispatch("keyboard", {type:"toggle-right-full-width"});
const subscribe = (f: () => void) => runtime.panels.subscribeOwner("keyboard", f);
const getState = () => runtime.panels.getOwnerSnapshot("keyboard");
const controller = createComposerController({ type: "existing-thread", key: { hostId: "test", threadId: "one" } }, { now: Date.now, createId: () => crypto.randomUUID() });
const chrome = { kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } } as const;
function App() {
  const state = useSyncExternalStore(subscribe, getState);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  useTimelineViewportHost(chrome);
  Object.assign(window, { fixture: { sizes, controller, setOverlayEnabled, setThemePreference } });
  return <AppShell layoutScope="keyboard" mainContentLayout="default" header={<AppShellHeader title="Terminal" project={null} sidebarOpen={false} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onToggleSidebar={() => {}} onToggleRightPanel={() => {}} onHome={() => {}} canGoBack={false} canGoForward={false} onBack={() => {}} onForward={() => {}} navigationActions={['sidebar-toggle']} />} windowChrome={chrome}
    sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={() => {}} onSidebarExpand={() => {}} onSidebarResizeEnd={() => {}}
    floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open => runtime.panels.dispatch("keyboard", {type:"set-region-open",region:"right",open})}
    rightPanel={<RightPanel state={state} presentationId="test" renderers={runtime.renderers.getSnapshot()} toolbarActions={[]} toolbarActionContext={{ownerId:"keyboard",resourceOwnerId:"keyboard",hostId:"test",cwd:null}} onAction={action => runtime.panels.dispatch("keyboard",action)} onCloseTab={tab => runtime.panels.close("keyboard",tab.region,tab.id)} />}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><p style={{flex: 1}}>Parent conversation</p>
    {<ThreadComposerPresentation scopeId="keyboard" controller={controller} activeTabId={`terminal:${resource}`} enabled={overlayEnabled} timeline={{key: {hostId: "test",threadId:"one"}, revision:1,phase:"live",authoritative:true,anchorFrameIds:new Map(),frames:[{id:"answer-frame",type:"assistant",turnId:"turn",status:"complete",durationMs:1000,hookStats:null,anchors:[],blocks:[{id:"answer",type:"text",text:"Latest answer\n\n" + "A bounded response paragraph.\n\n".repeat(40),sourceItemIds:["answer"],streaming:false,completed:true,phase:"final_answer"}]}]}} documentContext={{conversationId:"one",hostId:"test",cwd:null,theme:"light"}}>
      <div className="thread-composer-region"><OpenCraftComposer controller={controller} placeholder="Write a message" onSubmit={() => false} onCancel={() => {}} /></div>
    </ThreadComposerPresentation>}</div>
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!).render(<TimelineBlockRendererProvider registry={runtime.context.timelineBlockRenderers}><App /></TimelineBlockRendererProvider>);
