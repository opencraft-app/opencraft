import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Context } from "@deepseek-ai/cordis";
import { WorkbenchPanelService } from "@opencraft/workbench-panels";
import { BlobResourceService } from "@opencraft/blob-resources";
import { FilePreviewProvider, FilePreviewService } from "@opencraft/file-preview-web";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { RightPanel } from "../../apps/workbench-web/src/components/right-panel";
import { ComposerPanelToggle } from "../../apps/workbench-web/src/components/composer-panel-toggle";
import {
  PanelOverviewButton,
  usePanelOverviewPresentation,
} from "../../apps/workbench-web/src/components/panel-overview-presentation";
import { useShellPresentation } from "../../apps/workbench-web/src/components/shell-presentation";
import { WorkbenchPanelRuntimeProvider } from "../../apps/workbench-web/src/runtime/panel-runtime-context";
import { WorkspaceResourcePreviewPanel } from "../../apps/workbench-web/src/panels/workspace-resource-panel";
import { initializeAppearanceTheme } from "../../apps/workbench-web/src/appearance-theme";
import { installSideChatPreviewFixture } from "./side-chat-preview";
import { setMediaFixtureBlobs, mediaFixtureReads } from "./workspace-media-runtime";
import { createIntlTestRoot } from "./intl-root";
import "@xterm/xterm/css/xterm.css";
import "../../apps/workbench-web/src/styles/app.scss";

// External terminal bytes, file IO, and browser renderer readiness are fixtures.
// All scene navigation, retained allocation, and animation belong to the Shell.
initializeAppearanceTheme();
document.documentElement.dataset.uiDensity = "touch";
document.documentElement.style.setProperty("--safe-layout-inset-top", "20px");
document.documentElement.style.setProperty("--safe-layout-inset-bottom", "34px");
const context = new Context();
await context.plugin(WorkbenchPanelService);
await context.plugin(BlobResourceService);
await context.plugin(FilePreviewService);
setMediaFixtureBlobs(context.blobResources);
const panels = context.workbenchPanels;
const side = await installSideChatPreviewFixture(context);
const runtime = { panels, context };
for (const [kind, id, title, resource, icon] of [
  ["terminal", "terminal", "Retained terminal", "terminal", "terminal"],
  ["resource", "file", "Handoff file", "/fixture/handoff.txt", "file"],
  ["browser", "browser", "Browser renderer", "browser", "browser"],
])
  panels.register({
    kind,
    createTab: () => ({ id, kind, title, resource, icon, region: "right", closable: true, preview: false }),
  });
for (const kind of ["terminal", "resource", "browser"]) panels.open("scope", kind, {});
panels.open("scope", "sidechat", {
  id: "sidechat:side-preview",
  resource: "side-preview",
  title: "Side chat",
  pending: false,
});
panels.dispatch("scope", { type: "set-region-open", region: "right", open: true });
panels.dispatch("scope", { type: "toggle-right-full-width" });
panels.dispatch("scope", { type: "select-foreground", foreground: "primary" });
const query = new QueryClient();
const terminals = new Map<string, Terminal>();
const counts = {
  terminalMounts: 0,
  terminalDisposals: 0,
  fileMounts: 0,
  fileUnmounts: 0,
  chatMounts: 0,
  frameLoads: 0,
  retainedPreviewCalls: 0,
};
const w = window as any;
w.toolFixture = { panels, terminals, counts, fileReads: mediaFixtureReads };

function TerminalFixture({ tab, active, overviewPreview }: any) {
  const host = useRef<HTMLDivElement>(null);
  const [presented, setPresented] = useState(Boolean(active));
  if ((active || overviewPreview) && !presented) setPresented(true);
  useEffect(() => {
    if (!presented) return;
    counts.terminalMounts++;
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      theme: { background: "#191919", foreground: "#e5e5e5" },
    });
    terminal.open(host.current!);
    terminal.write("\x1b[32m$ npm run build\x1b[0m\r\nBuild complete\r\n$ ");
    terminals.set(tab.id, terminal);
    return () => {
      counts.terminalDisposals++;
      terminals.delete(tab.id);
      terminal.dispose();
    };
  }, [presented]);
  return (
    <div data-tool-terminal className="terminal-panel" style={{ height: "100%", background: "#191919" }}>
      <div ref={host} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
function FileFixture(props: any) {
  useEffect(() => {
    counts.fileMounts++;
    return () => {
      counts.fileUnmounts++;
    };
  }, []);
  return (
    <div data-tool-file style={{ width: "100%", height: "100%" }}>
      <WorkspaceResourcePreviewPanel {...props} />
    </div>
  );
}
function BrowserFixture({ onPresentationReady }: any) {
  useEffect(() => {
    if (!onPresentationReady) return;
    w.browserRequestedAt = performance.now();
    w.releaseBrowserPresentation = () => {
      w.browserAcknowledgedAt = performance.now();
      onPresentationReady();
    };
    if (!w.holdBrowserPresentation) w.releaseBrowserPresentation();
    return () => {
      w.releaseBrowserPresentation = null;
    };
  }, [onPresentationReady]);
  return (
    <div data-tool-browser style={{ width: "100%", height: "100%", background: "#245c45" }}>
      Browser renderer
      <PanelOverviewButton />
    </div>
  );
}
function ChatFixture() {
  const overview = usePanelOverviewPresentation();
  const scene = useShellPresentation();
  useEffect(() => {
    w.overview = overview;
    w.scene = scene;
  }, [overview, scene]);
  useEffect(() => {
    counts.chatMounts++;
  }, []);
  return (
    <div
      data-tool-primary
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        position: "relative",
        paddingTop: 80,
        boxSizing: "border-box",
      }}
    >
      <input aria-label="Primary draft" defaultValue="Keep primary draft" />
      <span style={{ position: "absolute", bottom: 16, right: 16 }}>
        {scene?.contentPresentation === "split" ? (
          <PanelOverviewButton composer placement="toolbar" />
        ) : (
          <ComposerPanelToggle />
        )}
      </span>
      <iframe
        title="Stateful primary resource"
        srcDoc="<script>window.marker=1</script><p>Live frame</p>"
        onLoad={() => counts.frameLoads++}
      />
      {Array.from({ length: 20 }, (_, i) => (
        <p key={i}>Original primary paragraph {i}</p>
      ))}
    </div>
  );
}
const retainedPreview = () => {
  counts.retainedPreviewCalls++;
  throw Error("Retained tool requested a duplicate raster");
};
const renderers = [
  side,
  {
    kind: "terminal",
    Component: TerminalFixture,
    residency: "while-tab-open",
    previewPresentation: "retained-view",
    previewFallback: "reparent-safe",
    preview: retainedPreview,
  },
  {
    kind: "resource",
    Component: FileFixture,
    residency: "while-tab-open",
    previewPresentation: "retained-view",
    previewAnchor: "start",
    preview: retainedPreview,
  },
  {
    kind: "browser",
    Component: BrowserFixture,
    presentationReadiness: "renderer",
    preview: () => {
      const canvas = document.createElement("canvas");
      canvas.width = 390;
      canvas.height = 800;
      const paint = canvas.getContext("2d")!;
      paint.fillStyle = "#245c45";
      paint.fillRect(0, 0, 390, 800);
      paint.fillStyle = "white";
      paint.font = "24px sans-serif";
      paint.fillText("Browser preview", 24, 50);
      return { kind: "image", src: canvas.toDataURL() };
    },
  },
];
const navigation = {
  layout: "unified" as const,
  actions: [{ id: "chat", title: "Chat", icon: "chat", onInvoke() {} }],
  settingsActive: false,
  onOpenSettings() {},
  account: null,
};
function App() {
  const state = useSyncExternalStore(
    (listener) => panels.subscribeOwner("scope", listener),
    () => panels.getOwnerSnapshot("scope"),
  );
  const [sidebar, setSidebar] = useState(false);
  return (
    <AppShell
      sceneOwnerId="scope"
      foreground={state.foreground}
      onForegroundChange={(foreground) => panels.dispatch("scope", { type: "select-foreground", foreground })}
      layoutScope="overview-tool-handoff"
      mainContentLayout="thread-edge-scroll"
      navigation={navigation}
      sidebarOpen={sidebar}
      sidebarWidth={275}
      onSidebarCollapse={() => setSidebar(false)}
      onSidebarExpand={() => setSidebar(true)}
      onSidebarResizeEnd={() => {}}
      floatingSidebarHeader={() => null}
      leftPanel={<p>Navigation</p>}
      windowChrome={{ kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } }}
      header={
        <AppShellHeader
          conversationHeader
          title="Conversation"
          project={null}
          sidebarOpen={sidebar}
          rightPanelOpen={state.right.open}
          rightPanelFullWidth={state.rightPanelFullWidth}
          onToggleSidebar={() => setSidebar(!sidebar)}
          onToggleRightPanel={() =>
            panels.dispatch("scope", { type: "set-region-open", region: "right", open: !state.right.open })
          }
          onHome={() => {}}
          canGoBack={false}
          canGoForward={false}
          onBack={() => {}}
          onForward={() => {}}
          navigationActions={["sidebar-toggle"]}
        />
      }
      rightPanel={
        <RightPanel
          state={state}
          presentationId="tool-handoff"
          renderers={renderers as any}
          toolbarActions={[]}
          toolbarActionContext={{ ownerId: "scope", resourceOwnerId: "scope", hostId: "fixture", cwd: null }}
          onAction={(action) => panels.dispatch("scope", action)}
          onCloseTab={(tab) => panels.close("scope", tab.region, tab.id)}
        />
      }
      rightPanelOpen={state.right.open}
      rightPanelFullWidth={state.rightPanelFullWidth}
      onRightPanelOpenChange={(open) => panels.dispatch("scope", { type: "set-region-open", region: "right", open })}
    >
      <ChatFixture />
    </AppShell>
  );
}
createIntlTestRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={query}>
    <FilePreviewProvider service={context.filePreviews}>
      <WorkbenchPanelRuntimeProvider runtime={runtime}>
        <App />
      </WorkbenchPanelRuntimeProvider>
    </FilePreviewProvider>
  </QueryClientProvider>,
);
