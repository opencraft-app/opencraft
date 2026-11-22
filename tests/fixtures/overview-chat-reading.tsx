import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { Context } from '@deepseek-ai/cordis';
import { createWorkbenchPanelReactRuntime } from '@opencraft/workbench-panels-react';
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from '@opencraft/chat-core';
import { createConversationScopeRegistry } from '@opencraft/workbench-runtime';
import { NewThreadDraftPage } from '../../apps/workbench-web/src/components/new-thread-draft-page';
import { createComposerController } from '@opencraft/composer-core';
import { OpenCraftComposer } from '@opencraft/composer-editor';
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from '@opencraft/timeline-render-react';
import { BuiltinTimelineRendererPlugin } from '../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { AppShell } from '../../apps/workbench-web/src/components/app-shell';
import { AppShellHeader } from '../../apps/workbench-web/src/components/app-shell-header';
import { RightPanel } from '../../apps/workbench-web/src/components/right-panel';
import { PanelOverviewButton, usePanelOverviewPresentation } from '../../apps/workbench-web/src/components/panel-overview-presentation';
import { WorkbenchPanelRuntimeProvider } from '../../apps/workbench-web/src/runtime/panel-runtime-context';
import { initializeAppearanceTheme } from '../../apps/workbench-web/src/appearance-theme';
import { createIntlTestRoot } from './intl-root';
import '../../apps/workbench-web/src/styles/app.scss';

initializeAppearanceTheme();
const query = new URLSearchParams(location.search);
document.documentElement.dataset.uiDensity = 'touch';
document.documentElement.style.setProperty('--safe-layout-inset-top', '20px');
document.documentElement.style.setProperty('--safe-layout-inset-bottom', query.get('safe') ?? '34px');
const context = new Context();
const panelRuntime = await createWorkbenchPanelReactRuntime({}, context);
await context.plugin(TimelineBlockRendererRegistryService);
await context.plugin(BuiltinTimelineRendererPlugin);
const panels = context.workbenchPanels;
panels.register({ kind: 'document', createTab: () => ({ id: 'file', kind: 'document', region: 'right', title: 'Open document', icon: 'file', closable: true, preview: false }) });
panels.open('scope', 'document', {});
panels.dispatch('scope', { type: 'toggle-right-full-width' });
const key = createConversationKey('fixture', 'overview');
const controller = createComposerController({ type: 'existing-thread', key }, { now: Date.now, createId: () => crypto.randomUUID() });
const draft = createConversationScopeRegistry({ initialDraft: null }).openDraft({ execution: { hostId: 'fixture', workspace: { cwd: '/fixture', runtimeWorkspaceRoots: ['/fixture'] } }, entrypoint: 'home' });
const draftController = createComposerController(draft.target, { now: Date.now, createId: () => crypto.randomUUID() });
const timeline = projectTimeline({ key, revision: 1, authoritative: true, phase: 'live', turns: [{ id: 'turn', status: query.has('short') ? 'complete' : 'streaming', items: [
  { id: 'prompt', type: 'userMessage', payload: { content: [{ type: 'inputText', text: 'Keep reading position' }] } },
  { id: 'answer', type: 'agentMessage', payload: { text: Array.from({ length: query.has('short') ? 4 : 80 }, (_, i) => `Paragraph ${i}: Read the original conversation.`).join('\n\n'), phase: 'commentary', completed: true } },
] }] }, createDefaultTimelineProjectorRegistry());
function Chat() {
  const overview = usePanelOverviewPresentation();
  useEffect(() => { (window as any).readingOverview = overview; }, [overview]);
  const input = <OpenCraftComposer controller={controller} isStreaming={!query.has('short')} placeholder="Draft" onSubmit={() => false} onCancel={() => {}}
    navigationActions={<PanelOverviewButton composer />} />;
  if (query.has('draft')) return <NewThreadDraftPage draft={draft} controller={draftController} composerPresentationEnabled={false}
    showExecutionControls={false} selectionCatalog={{ models: [], permissionProfiles: [] }} catalog={{ search: async () => [] }}
    workspaceOptions={[]} activeHostId="fixture" hostOptions={[]} connectionPhase="ready" onSelectHost={() => {}} onSelectWorkspace={() => {}}
    onBrowseWorkspace={() => {}} onSubmit={() => false} composerTrailingActions={<PanelOverviewButton composer />} />;
  return <TimelineBlockRendererProvider registry={context.timelineBlockRenderers}>
    <Conversation timeline={timeline} scrollPolicy="natural" footer={<div className="thread-composer-region">
      {input}
    </div>} />
  </TimelineBlockRendererProvider>;
}
function FileView() { return <div data-reading-tool style={{ height: '100%', paddingTop: 80, boxSizing: 'border-box' }}>File preview <PanelOverviewButton /></div>; }
const renderers = [{ kind: 'document', Component: FileView, preview: () => ({ kind: 'text' as const, text: 'Open document' }) }];
const navigation = { actions: [{ id: 'chat', title: 'Chat', icon: 'chat', onInvoke() {} }], settingsActive: false, onOpenSettings() {}, account: null };
function App() {
  const state = useSyncExternalStore(listener => panels.subscribeOwner('scope', listener), () => panels.getOwnerSnapshot('scope'));
  const [sidebar, setSidebar] = useState(false);
  return <AppShell sceneOwnerId="scope" foreground={state.foreground} onForegroundChange={foreground => panels.dispatch('scope', { type: 'select-foreground', foreground })}
    layoutScope="overview-reading" mainContentLayout="thread-edge-scroll" primaryReading={!query.has('draft')} navigation={navigation}
    sidebarOpen={sidebar} sidebarWidth={275} onSidebarCollapse={() => setSidebar(false)} onSidebarExpand={() => setSidebar(true)} onSidebarResizeEnd={() => {}}
    floatingSidebarHeader={() => null} leftPanel={<p>Navigation</p>}
    windowChrome={{ kind: 'browser', platform: 'linux', safeArea: { left: 0, right: 0 } }}
    header={<AppShellHeader conversationHeader title="Conversation" project={null} sidebarOpen={sidebar} rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth}
      onToggleSidebar={() => setSidebar(!sidebar)} onToggleRightPanel={() => panels.dispatch('scope', { type: 'set-region-open', region: 'right', open: !state.right.open })}
      onHome={() => {}} canGoBack={false} canGoForward={false} onBack={() => {}} onForward={() => {}} navigationActions={['sidebar-toggle']} />}
    rightPanel={<RightPanel state={state} presentationId="reading" renderers={renderers} toolbarActions={[]} toolbarActionContext={{ownerId:"scope",resourceOwnerId:"scope",hostId:"fixture",cwd:null}} onAction={action => panels.dispatch('scope', action)} onCloseTab={tab => panels.close('scope', tab.region, tab.id)} />}
    rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth} onRightPanelOpenChange={open => panels.dispatch('scope', { type: 'set-region-open', region: 'right', open })}>
    <Chat />
  </AppShell>;
}
createIntlTestRoot(document.getElementById('root')!).render(<WorkbenchPanelRuntimeProvider runtime={panelRuntime}><App /></WorkbenchPanelRuntimeProvider>);
