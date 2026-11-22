import React from "react";
import { MicrophoneIcon } from "@opencraft/design-system-web/action-icons";
import { createComposerController, type ComposerExecutionTarget } from "@opencraft/composer-core";
import { createConversationScopeRegistry } from "@opencraft/workbench-runtime";
import { WorkspaceDirectoryPicker } from "../../apps/workbench-web/src/components/workspace-directory-picker";
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
const scopes = createConversationScopeRegistry({ initialDraft: null });
const initialDraft = scopes.openDraft({ execution: { hostId: "fixture", workspace: { cwd: null, runtimeWorkspaceRoots: [] } }, entrypoint: "home" });
const controller = createComposerController(initialDraft.target, { now: Date.now, createId: () => crypto.randomUUID() });
const toolbar = params.has("toolbar");
const models = [{ id: "test-model", value: "test-model", label: "Test model", isDefault: true, description: null, efforts: params.has("inline") ? ["low", "medium", "high", "xhigh", "max", "ultra"].map(value => ({value, label: value, description: null})) : [], defaultEffort: params.has("inline") ? "medium" : null, serviceTiers: params.has("inline") ? [{id: "fast", name: "Fast", description: "Fixture Fast"}] : [], inputModalities: ["text"] as const }];
const permissionProfiles = [
  { id: "full", value: "full", label: "Full access", mode: "full" as const, description: null },
  { id: "read", value: "read", label: "Read only", mode: "read-only" as const, description: null },
];
const chrome = { kind: "browser", platform: "linux", safeArea: { left: 0, right: 0 } } as const;
const noop = () => {};
const environment = {version:1,configurationId:'e2b',templateId:'general'} as const;
const catalog = {version:1 as const,environments:[environment,{...environment,configurationId:'other'}].map(target=>({target,name:target.configurationId,status:'configured' as const,resources:{cpuMillis:4000,memoryBytes:8589934592}})),libraries:[{id:'shared',name:'Shared library',status:'configured' as const,environmentIds:['e2b']}]};
function App() {
  const [directoryOpen, setDirectoryOpen] = React.useState(false);
  const [directoryRevision, reloadDirectory] = React.useReducer(value => value + 1, 0);
  const pendingDirectory = React.useRef<(() => void) | null>(null);
  const holdDirectory = React.useRef(false);
  const readDirectory = React.useCallback(async () => {
    void directoryRevision;
    if (holdDirectory.current) await new Promise<void>(resolve => { pendingDirectory.current = resolve; });
    return Array.from({ length: 20 }, (_, index) => ({ fileName: `folder-${String(index).padStart(2, '0')}`, isDirectory: true, isFile: false }));
  }, [directoryRevision]);
  Object.assign(window, { directory: {
    refresh: () => { holdDirectory.current = true; reloadDirectory(); },
    finish: () => { holdDirectory.current = false; pendingDirectory.current?.(); },
  } });
  const [draft,setDraft] = React.useState(initialDraft);
  const [available,setAvailable] = React.useState(true);
  const [loading,setLoading] = React.useState(false);
  const placement = {catalog, available,selectable:available && !loading,loading,error:null,refresh:()=>{},select:(execution:ComposerExecutionTarget)=>{const next=scopes.retargetDraft(draft.id,execution);controller.dispatch({type:'switch-target',target:next.target,preserveDraft:true});setDraft(next)}};
  Object.assign(window, {picker:{setAvailable,setLoading,execution:()=>controller.getSnapshot().draft.target}});
  useTimelineViewportHost(chrome);
  const [recovering, setRecovering] = React.useState(params.has("recovering"));
  Object.assign(window, { fixture: { controller, setRecovering } });
  return <AppShell layoutScope="home" mainContentLayout="thread-edge-scroll" navigation={{actions:[],account:null,onOpenSettings:noop}} header={<AppShellHeader
    conversationHeader={!params.has("legacyHeader")} title="Home" project={null} sidebarOpen={false}
    rightPanelOpen={false} rightPanelFullWidth={false} onToggleSidebar={noop} onToggleRightPanel={noop}
    onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop}
    navigationActions={["sidebar-toggle"]} />} windowChrome={chrome}
    sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
    floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={false} rightPanelFullWidth={false}
    onRightPanelOpenChange={noop} rightPanel={null}>
    <NewThreadDraftPage placement={placement} setupBlocksSubmission={!available} showExecutionControls draft={draft} controller={controller} selectionCatalog={{ models: toolbar ? models : [], permissionProfiles: toolbar ? permissionProfiles : [] }}
      modelSelectionPolicy={params.get("policy") === "session" ? "session" : params.get("policy") === "host-default" ? "host-default" : "user"}
      composerEndActions={toolbar ? <button className="opencraft-composer-icon-button" aria-label="Microphone"><MicrophoneIcon size={16} /></button> : undefined}
      catalog={{ search: async () => [] }} workspaceOptions={[{ cwd: '/home/demo/opencraft', runtimeWorkspaceRoots: ['/home/demo/opencraft'], projectId: 'project', label: 'opencraft', rootLabel: 'opencraft', branch: 'main' }]} activeHostId="fixture" hostOptions={[{ id: 'fixture', hostIds: ['fixture'], label: 'GitHub-Demo', platform: 'linux', resource: null, cloud: false, role: 'server', connectable: true }]}
      placeholderPending={recovering} connectionPhase={recovering ? "reconnecting" : "ready"} onSelectHost={noop} onSelectWorkspace={workspace => placement.select({ hostId: 'fixture', workspace: { cwd: workspace.cwd, runtimeWorkspaceRoots: workspace.runtimeWorkspaceRoots, projectId: workspace.projectId } })} onBrowseWorkspace={() => params.has("directory") ? setDirectoryOpen(true) : placement.select({ hostId: 'fixture', workspace: { cwd: '/opened-folder', runtimeWorkspaceRoots: ['/opened-folder'] } })}
      onSubmit={() => false} heading="要做点什么？" placeholder="聊聊你的想法，或交给我一件事" />
    {directoryOpen ? <WorkspaceDirectoryPicker open rootPath="/workspace" title="Open folder" confirmLabel="Use folder"
      onReadDirectory={readDirectory} onCancel={() => setDirectoryOpen(false)} onChoose={async () => setDirectoryOpen(false)} /> : null}
  </AppShell>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, params.get("locale") ?? "en-US").render(<App />);
