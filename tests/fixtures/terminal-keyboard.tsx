import React, { useState, useSyncExternalStore } from "react";
import { createComposerController } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from "@opencraft/timeline-render-react";
import { BuiltinTimelineRendererPlugin } from "../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { WorkbenchTerminalSessionRegistry, createTerminalWorkbenchPanelPlugin } from "../../plugins/terminal/src/index";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { ComposerPanelToggle } from "../../apps/workbench-web/src/components/composer-panel-toggle";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { ThreadComposerPresentation } from "../../apps/workbench-web/src/components/thread-composer-presentation";
import { useTimelineViewportHost } from "../../apps/workbench-web/src/timeline-viewport";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const writes: string[] = [];
const gestureProbe = new URLSearchParams(location.search).has('gesture');
const listeners = new Set<() => void>();
const sizes: { cols: number; rows: number }[] = [];
let exitOnWrite = false;
let snapshot = { revision: 0, exitCode: null as number | null, phase: "running", output: [{ sequence: 1, deltaBase64: btoa(Array.from({ length: 80 }, (_, i) => `Terminal output ${i}\r\n`).join("")) }], error: null };
const session = { processId: "test", getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  resize: async (cols: number, rows: number) => { sizes.push({ cols, rows }); },
  write: async (data: string) => { writes.push(atob(data)); if (exitOnWrite) { exit(7); throw new Error("Terminal is not accepting input"); } }, terminate: async () => {}, dispose: async () => {} };
function exit(code: number | null) { snapshot = { ...snapshot, phase: "exited", exitCode: code, revision: snapshot.revision + 1 }; for (const f of listeners) f(); }
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
  const [foreground, setForeground] = useState<"primary" | "tools">(!new URLSearchParams(location.search).has("cold-overview") ? "tools" : "primary");
  useTimelineViewportHost(chrome);
  Object.assign(window, { fixture: { writes, sizes, exit, exitDuringNextWrite: () => { exitOnWrite = true; }, controller, setOverlayEnabled, setForeground, setThemePreference, emit: (text: string) => { snapshot.output.push({sequence: snapshot.output.length + 1,deltaBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text)))}); snapshot.revision++; for(const f of listeners) f(); } } });
  return <AppShell foreground={foreground} onForegroundChange={setForeground} navigation={gestureProbe ? {layout:'unified',actions:[],account:{snapshot:{phase:'anonymous'},onOpen:()=>{}},onOpenSettings:()=>{}} : undefined} layoutScope="keyboard" mainContentLayout="default" header={<AppShellHeader title="Terminal" project={null} sidebarOpen={false} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onToggleSidebar={() => {}} onToggleRightPanel={() => {}} onHome={() => {}} canGoBack={false} canGoForward={false} onBack={() => {}} onForward={() => {}} navigationActions={['sidebar-toggle']} />} windowChrome={chrome}
    sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={() => {}} onSidebarExpand={() => {}} onSidebarResizeEnd={() => {}}
    floatingSidebarHeader={() => null} leftPanel={gestureProbe ? <div>Conversations</div> : null} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open => runtime.panels.dispatch("keyboard", {type:"set-region-open",region:"right",open})}
    rightPanel={<RightPanel state={state} presentationId="test" renderers={runtime.renderers.getSnapshot()} toolbarActions={[]} toolbarActionContext={{ownerId:"keyboard",resourceOwnerId:"keyboard",hostId:"test",cwd:null}} onAction={action => { runtime.panels.dispatch("keyboard",action); if (action.type === "activate-tab") setForeground("tools"); }} onCloseTab={tab => runtime.panels.close("keyboard",tab.region,tab.id)} />}>
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}><p style={{flex: 1}}>Parent conversation</p>
    {<ThreadComposerPresentation scopeId="keyboard" controller={controller} activeTabId={`terminal:${resource}`} enabled={overlayEnabled} timeline={{key: {hostId: "test",threadId:"one"}, revision:1,phase:"live",authoritative:true,anchorFrameIds:new Map(),frames:[{id:"answer-frame",type:"assistant",turnId:"turn",status:"complete",durationMs:1000,hookStats:null,anchors:[],blocks:[{id:"answer",type:"text",text:"Latest answer\n\n" + "A bounded response paragraph.\n\n".repeat(40),sourceItemIds:["answer"],streaming:false,completed:true,phase:"final_answer"}]}]}} documentContext={{conversationId:"one",hostId:"test",cwd:null,theme:"light"}}>
      <div className="thread-composer-region"><OpenCraftComposer controller={controller} navigationActions={<ComposerPanelToggle />} placeholder="Write a message" onSubmit={() => false} onCancel={() => {}} /></div>
    </ThreadComposerPresentation>}</div>
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<TimelineBlockRendererProvider registry={runtime.context.timelineBlockRenderers}><App /></TimelineBlockRendererProvider>);
