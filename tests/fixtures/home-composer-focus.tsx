import React from "react";
import { useIntlRuntime } from "@opencraft/i18n/react";
import type { WorkbenchLocaleController } from "../../apps/workbench-web/src/i18n/workbench-locale";
import { MicrophoneIcon } from "@opencraft/design-system-web/action-icons";
import { createComposerController } from "@opencraft/composer-core";
import { createConversationScopeRegistry } from "@opencraft/workbench-runtime";
import { AppShell } from "../../apps/workbench-web/src/components/app-shell";
import { AppShellHeader } from "../../apps/workbench-web/src/components/app-shell-header";
import { NewThreadDraftPage } from "../../apps/workbench-web/src/components/new-thread-draft-page";
import { useTimelineViewportHost } from "../../apps/workbench-web/src/timeline-viewport";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import { createIntlTestRoot } from "./intl-root";
import "../../apps/workbench-web/src/styles/app.scss";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.opencraftWindowType = "browser";
initializeAppearanceTheme(); setThemePreference(params.get("theme") === "dark" ? "dark" : "light");
if (params.get("theme") === "lavender") setAppearanceThemeId("opencraft.core.lavender");
document.documentElement.dataset.uiDensity = params.has("desktop") || params.has("ordinary") ? "compact" : "touch";
const draft = createConversationScopeRegistry({ initialDraft: null }).openDraft({ execution: { hostId: "fixture", workspace: { cwd: params.has("longPath") ? "/data/a-very-long-workspace-directory-name-for-mobile-layout" : "/data", runtimeWorkspaceRoots: ["/data"] } }, entrypoint: "home" });
const controller = createComposerController(draft.target, { now: Date.now, createId: () => crypto.randomUUID() });
const toolbar = params.has("toolbar");
const models = [{ id: "test-model", value: "test-model", label: "Test model", isDefault: true, description: null, efforts: params.has("inline") ? ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({value, label: value, description: null})) : [], defaultEffort: params.has("inline") ? "medium" : null, serviceTiers: params.has("inline") ? [{id: "fast", name: "Fast", description: "Fixture Fast"}] : [], inputModalities: ["text"] as const }];
const agentModels = [
  { ...models[0]!, id: "codex:one", value: "codex:one", label: "Codex One", agentId: "codex", agentLabel: "Codex", isDefault: true },
  { ...models[0]!, id: "codex:two", value: "codex:two", label: "Codex Two", agentId: "codex", agentLabel: "Codex", isDefault: false },
  { ...models[0]!, id: "cursor:one", value: "cursor:one", label: "Cursor One", agentId: "cursor", agentLabel: "Cursor", isDefault: false },
  { ...models[0]!, id: "pi-cli:one", value: "pi-cli:one", label: "Claude Fable 5.2", agentId: "pi-cli", agentLabel: "Pi", isDefault: false },
];
const permissionProfiles = [
  { id: "full", value: "full", label: "Full access", mode: "full" as const, description: null },
  { id: "read", value: "read", label: "Read only", mode: "read-only" as const, description: null },
];
const chrome = { kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } } as const;
const noop = () => {};
function App() {
  const intlRuntime = useIntlRuntime() as WorkbenchLocaleController;
  useTimelineViewportHost(chrome);
  const [recovering, setRecovering] = React.useState(params.has("recovering"));
  const [agentState, setAgentState] = React.useState("ready");
  const [modelDelay, setModelDelay] = React.useState(false);
  const pendingChoices: React.MutableRefObject<(() => void)[]> = React.useRef([]);
  const calls = React.useRef<string[]>([]);
  const selectionCatalog = params.has("agents") ? {
    models: agentState === "empty" ? [] : agentModels,
    permissionProfiles, isFetching: agentState === "loading", modelError: agentState === "error" ? "unavailable" : null,
    onConfigureAgents: noop, retryModels: () => setAgentState("ready"),
    agentGroups: [{ id: "fixture", label: "Fixture", active: true, models: agentState === "empty" ? [] : agentModels,
      select: async (model: {value:string}) => {
        calls.current.push(model.value);
        if (modelDelay) await new Promise<void>(resolve => pendingChoices.current.push(resolve));
        if (agentState === "selection-error") throw new Error("synthetic selection failure");
      } }],
  } : { models: toolbar ? models : [], permissionProfiles: toolbar ? permissionProfiles : [] };
  Object.assign(window, { fixture: { controller, setRecovering, setAgentState, setModelDelay, calls: calls.current,
    setLocale: (locale: string) => intlRuntime.configure({ ideLocale: locale }),
    releaseChoice: () => pendingChoices.current.shift()?.() } });
  return <AppShell layoutScope="home" mainContentLayout="thread-edge-scroll" navigation={{layout:"unified",actions:[],account:null,onOpenSettings:noop}} header={<AppShellHeader
    conversationHeader={!params.has("legacyHeader")} title="Home" project={null} sidebarOpen={false}
    rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={noop} onToggleRightPanel={noop}
    onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop}
    navigationActions={["sidebar-toggle"]} />} windowChrome={chrome}
    sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
    floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={false} rightPanelFullWidth={false}
    onRightPanelOpenChange={noop} rightPanel={null}>
    <NewThreadDraftPage showExecutionControls={!params.has("inline")} draft={draft} controller={controller} selectionCatalog={selectionCatalog}
      modelSelectionPolicy={params.get("policy") === "session" ? "session" : params.get("policy") === "host-default" ? "host-default" : "user"}
      composerEndActions={toolbar ? <button className="opencraft-composer-icon-button" aria-label="Microphone"><MicrophoneIcon size={16} /></button> : undefined}
      catalog={{ search: async () => [] }} workspaceOptions={[{ projectId: "fixture", cwd: "/data", label: "Workspace", rootLabel: "Data", runtimeWorkspaceRoots: ["/data"] }]} activeHostId="fixture" hostOptions={params.has("agents") ? [{ id: "fixture", hostIds: ["fixture"], label: "Local Mac", platform: "macos", resource: null, cloud: false, role: "local", connectable: true }] : []}
      placeholderPending={recovering} connectionPhase={recovering ? "reconnecting" : "ready"} onSelectHost={noop} onSelectWorkspace={noop} onBrowseWorkspace={noop}
      onSubmit={() => false} heading="要做点什么？" placeholder="聊聊你的想法，或交给我一件事" />
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(<App />);
