import React from "react";
import { MicrophoneIcon } from "@opencraft/design-system-web/action-icons";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationScopeRegistry } from "@opencraft/workbench-runtime";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { NewThreadDraftPage } from "../../apps/workbench-web/src/components/new-thread-draft-page";
import { useTimelineViewportHost } from "../../apps/workbench-web/src/timeline-viewport";
import { initializeAppearanceTheme, setThemePreference } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.opencraftWindowType = "browser";
initializeAppearanceTheme(); setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
document.documentElement.dataset.uiDensity = params.has("desktop") || params.has("ordinary") ? "compact" : "touch";
const draft = createConversationScopeRegistry({ initialDraft: null }).openDraft({ execution: { hostId: "fixture", workspace: { cwd: params.has("longPath") ? "/data/a-very-long-workspace-directory-name-for-mobile-layout" : "/data", runtimeWorkspaceRoots: ["/data"] } }, entrypoint: "home" });
const controller = createComposerController(draft.target, { now: Date.now, createId: () => crypto.randomUUID() });
const toolbar = params.has("toolbar");
const models = [{ id: "test-model", value: "test-model", label: "Test model", isDefault: true, description: null, efforts: params.has("inline") ? ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({value, label: value, description: null})) : [], defaultEffort: params.has("inline") ? "medium" : null, serviceTiers: params.has("inline") ? [{id: "fast", name: "Fast", description: "Fixture Fast"}] : [], inputModalities: ["text"] as const }];
const permissionProfiles = [
  { id: "full", value: "full", label: "Full access", mode: "full" as const, description: null },
  { id: "read", value: "read", label: "Read only", mode: "read-only" as const, description: null },
];
const chrome = { kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } } as const;
const noop = () => {};
function App() {
  useTimelineViewportHost(chrome);
  Object.assign(window, { fixture: { controller } });
  return <AppShell layoutScope="home" mainContentLayout="thread-edge-scroll" navigation={{layout:"unified",actions:[],account:null,onOpenSettings:noop}} header={<AppShellHeader
    conversationHeader={!params.has("legacyHeader")} title="Home" project={null} sidebarOpen={false}
    rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={noop} onToggleRightPanel={noop}
    onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop}
    navigationActions={["sidebar-toggle"]} />} windowChrome={chrome}
    sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
    floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={false} rightPanelFullWidth={false}
    onRightPanelOpenChange={noop} rightPanel={null}>
    <NewThreadDraftPage showExecutionControls={!params.has("inline")} draft={draft} controller={controller} selectionCatalog={{ models: toolbar ? models : [], permissionProfiles: toolbar ? permissionProfiles : [] }}
      modelSelectionPolicy={params.get("policy") === "session" ? "session" : params.get("policy") === "host-default" ? "host-default" : "user"}
      composerEndActions={toolbar ? <button className="opencraft-composer-icon-button" aria-label="Microphone"><MicrophoneIcon size={16} /></button> : undefined}
      catalog={{ search: async () => [] }} workspaceOptions={[]} activeHostId="fixture" hostOptions={[]}
      connectionPhase="ready" onSelectHost={noop} onSelectWorkspace={noop} onBrowseWorkspace={noop}
      onSubmit={() => false} heading="要做点什么？" placeholder="聊聊你的想法，或交给我一件事" />
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<App />);
