import React, { useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createConversationKey, createDefaultTimelineProjectorRegistry, projectTimeline } from '@opencraft/chat-core';
import { SideChatService, createConversationBindingStore } from '@opencraft/workbench-runtime';
import { createWorkbenchPanelReactRuntime } from '@opencraft/workbench-panels-react';
import { TimelineBlockRendererProvider, TimelineBlockRendererRegistryService } from '@opencraft/timeline-render-react';
import { BuiltinTimelineRendererPlugin } from '../../apps/workbench-web/src/components/conversation-renderers/builtin-timeline-renderer-plugin';
import { createSideChatPanelPlugin } from '../../apps/workbench-web/src/panels/side-chat-panel-plugin';
import { RemoteBrowserStorage } from "../../apps/workbench-web/src/browser/remote-browser-storage";
import { createSideChatPersistence, createSynchronizedSideChatPersistence } from '../../apps/workbench-web/src/runtime/side-chat-persistence';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';
import { WebIframeSurfaceHost } from '../../apps/workbench-web/src/browser/web-browser-surface-host';
import { BrowserPresentationCoordinator } from '../../apps/workbench-web/src/browser/browser-presentation-coordinator';
import { BrowserEnvironmentProvider, BrowserPresentationRoot } from '../../apps/workbench-web/src/browser/browser-runtime-context';
import { createBrowserWorkbenchPanelPlugin } from '../../apps/workbench-web/src/browser/browser-panel-plugin';
import { WorkbenchPanelRuntimeProvider } from '../../apps/workbench-web/src/runtime/panel-runtime-context';
import { WorkbenchComposer, WorkbenchComposerProvider } from '../../apps/workbench-web/src/components/workbench-composer';
import { usePanelOverviewPresentation } from '../../apps/workbench-web/src/components/panel-overview-presentation';
import { panelViewKey } from '../../apps/workbench-web/src/components/retained-view-preview';
import { Conversation } from '../../apps/workbench-web/src/components/conversation';
import { ComposerActionRendererRegistry } from '@opencraft/extension-react';
import { createComposerController } from '@opencraft/composer-core';
import { createVoiceInputAction } from '../../plugins/voice-input/src/voice-input-action';
import { AppShell } from '../../apps/workbench-web/src/components/app-shell';
import { RightPanel } from '../../apps/workbench-web/src/components/right-panel';
import { initializeAppearanceTheme, setAppearanceThemeId, setThemePreference } from '../../apps/workbench-web/src/appearance-theme';
import { createIntlTestRoot } from './intl-root';
import '../../apps/workbench-web/src/styles/app.scss';

initializeAppearanceTheme();
if (new URLSearchParams(location.search).has('composer')) setAppearanceThemeId('opencraft.core.see');
const params = new URLSearchParams(location.search), promoted = params.has('promoted');
const ownerId = promoted ? 'canonical-owner' : 'draft-owner';
const metadata = params.has("sync") ? await RemoteBrowserStorage.create(undefined, async () => {}) : null;
const persistence = metadata ? createSynchronizedSideChatPersistence(metadata, localStorage) : createSideChatPersistence(localStorage);
const parent = createConversationKey('fixture-host', 'parent');
const aliasRows: any[] = [];
const bindings = createConversationBindingStore({ persistence: { load: () => aliasRows } });
bindings.bind(ownerId as never, parent);
const panel = await createWorkbenchPanelReactRuntime();
const surfaces = new WebIframeSurfaceHost();
const pages = new WebBrowserPageRuntime(surfaces, null, () => null, localStorage);
const presentations = new BrowserPresentationCoordinator(pages, surfaces);
const browser = new BrowserWorkbenchCoordinator(pages, panel.panels, bindings, localStorage);
const projectors = createDefaultTimelineProjectorRegistry();
const parentComposer = createComposerController({ type: 'existing-thread', key: parent }, { now: Date.now, createId: () => crypto.randomUUID() });
const actions = new ComposerActionRendererRegistry();
let voiceCancelled = 0;
actions.register('fixture', { id: 'fixture.voice', Component: createVoiceInputAction({
  id: 'fixture-speech', isAvailable: () => true,
  start(observer) {
    return { phase: 'listening', stop() { observer.commit('Voice text for this conversation'); observer.end(); }, cancel() { voiceCancelled++; } };
  },
}) });
const composerEnvironment = { actionIds: 'all' as const, registry: actions, platform: 'web' as const, navigationEnabled: true };
const leases = new Map<string, { setRunning(value: boolean): void; setAuthoritative(value: boolean): void }>();

async function rpc(method: string, payload: any = {}) {
  const response = await fetch('/resource-refresh/rpc', { method: 'POST', body: JSON.stringify({ method, ...payload }) });
  if (!response.ok) throw Error('Original child unavailable');
  return response.json();
}
// Synthetic Host stays outside the page; the application-owned service and all
// panel/rendering code are real. No production account, model or browser used.
const host: any = {
  resources: { composerCatalog: { listModels: async () => ({ data: [] }) }, threads: {
    supportsSideChat: () => true,
    fork: (options: any, local: any) => rpc('fork', { options, local }),
    injectItems: (id: string) => rpc('inject', { id }),
    unsubscribe: (id: string) => rpc('unsubscribe', { id }),
  } },
  async acquireThread(id: string) {
    const row = await rpc('acquire', { id });
    const key = createConversationKey(parent.hostId, id);
    let snapshot: any = {
      timeline: projectTimeline({ key, revision: 1, authoritative: true, phase: 'live', turns: [{ id: 'turn-original', status: 'completed', items: [
        { id: 'q', type: 'userMessage', payload: { content: [{ type: 'inputText', text: 'Original side question' }] } },
        { id: 'a', type: 'agentMessage', payload: { text: row.text, phase: 'final_answer', completed: true } },
      ] }] }, projectors),
      error: null, activeTurn: null, authoritative: true, execution: { cwd: '/fixture', model: null, effort: null, serviceTier: null, permissionProfile: null },
      history: { hasOlder: false, loading: false }, pendingInteractions: [],
    };
    const listeners = new Set<() => void>();
    const change = (update: any) => { snapshot = { ...snapshot, ...update }; listeners.forEach(fn => fn()); };
    leases.set(id, {
      setRunning: value => change({ activeTurn: value ? { turnId: 'side-active', status: 'inProgress' } : null }),
      setAuthoritative: value => change({ authoritative: value }),
    });
    return { threadId: id, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, getSnapshot: () => snapshot, release() {},
      submit: (intent: any) => rpc('submit', { id, intent }), interrupt: (turnId: string) => rpc('interrupt', { id, turnId }), loadItemDetails: async () => {} };
  },
};
await panel.install(TimelineBlockRendererRegistryService);
await panel.install(BuiltinTimelineRendererPlugin);
// The owner exists before both plugins, and a restored browser's old alias
// deliberately arrives after hydration, as during deferred metadata startup.
panel.panels.ensureOwner(ownerId);
await panel.install(SideChatService, { resolveHost: async () => host, persistence });
await panel.install(createSideChatPanelPlugin(panel.context.sideChats, bindings, () => host));
await panel.install(createBrowserWorkbenchPanelPlugin(browser));
browser.restorePersistedTabs();
if (promoted) setTimeout(() => {
  aliasRows.push({ scopeId: 'draft-owner', hostId: parent.hostId, threadId: parent.threadId });
  bindings.restore(); browser.restorePersistedTabs();
}, 150);
const context = { ownerId, resourceOwnerId: ownerId, hostId: parent.hostId, cwd: '/fixture' };
const query = new QueryClient();
function OverviewProbe() {
  const overview = usePanelOverviewPresentation();
  return <span hidden data-testid="overview-origin" data-key={overview?.origin?.key} />;
}
function App() {
  const state = useSyncExternalStore(l => panel.panels.subscribeOwner(ownerId, l), () => panel.panels.getOwnerSnapshot(ownerId));
  const renderers = useSyncExternalStore(panel.renderers.subscribe, panel.renderers.getSnapshot);
  return <QueryClientProvider client={query}><TimelineBlockRendererProvider registry={panel.context.timelineBlockRenderers}>
    <BrowserEnvironmentProvider pages={pages} surfaces={surfaces} presentations={presentations} workbench={browser}>
    <WorkbenchPanelRuntimeProvider runtime={panel}>
    <WorkbenchComposerProvider value={composerEnvironment}>
      <AppShell foreground={state.right.open ? 'tools' : 'primary'} layoutScope={ownerId} mainContentLayout="default"
        header={<><button data-testid="new-sidechat" onClick={() => panel.panels.getToolbarActionSnapshot().find(a => a.id === 'sidechat.new')!.run(context)}>New side chat</button>
          <button data-testid="new-browser" onClick={() => browser.open(ownerId, { initialUrl: location.origin + '/resource-refresh/document' })}>New browser</button>
          <button data-testid="show-tools" onClick={() => panel.panels.dispatch(ownerId, { type: 'set-region-open', region: 'right', open: true, allowEmpty: true })}>Show tools</button></>}
        floatingSidebarHeader={() => null} leftPanel={null} sidebarOpen={false} sidebarWidth={275}
        windowChrome={{ kind: 'browser', platform: 'linux', safeArea: { left: 0, right: 0 } }}
        rightPanelKeepMounted rightPanelOpen={state.right.open} rightPanelFullWidth={state.rightPanelFullWidth}
        onRightPanelOpenChange={open => panel.panels.dispatch(ownerId, { type: 'set-region-open', region: 'right', open })}
        rightPanel={<RightPanel state={state} presentationId="resource-view" renderers={renderers}
          toolbarActions={panel.panels.getToolbarActionSnapshot()} toolbarActionContext={context}
          onAction={action => panel.panels.dispatch(ownerId, action)} onCloseTab={tab => panel.panels.close(ownerId, tab.region, tab.id)} />}>
        <OverviewProbe />
        {params.has('composer') ? <Conversation active={!state.right.open} timeline={null}
          footer={<div className="thread-composer-region"><WorkbenchComposer controller={parentComposer}
            actionsDisabled={state.right.open} onSubmit={intent => rpc('submit', { id: 'parent', intent })} /></div>} /> : <p>Resource recovery fixture</p>}
      </AppShell>
      <BrowserPresentationRoot />
    </WorkbenchComposerProvider></WorkbenchPanelRuntimeProvider></BrowserEnvironmentProvider>
  </TimelineBlockRendererProvider></QueryClientProvider>;
}
(window as any).fixture = {
  overviewKey: () => panelViewKey(ownerId, panel.panels.getOwnerSnapshot(ownerId).right.activeTabId!),
  setTheme: (mode: 'dark' | 'light') => setThemePreference(mode),
  composerState: () => ({ parent: parentComposer.getSnapshot(), sides: panel.context.sideChats.list(parent).map(s => ({ id: s.id, key: s.key, snapshot: s.composer.getSnapshot() })), voiceCancelled }),
  setRunning(value: boolean) { leases.forEach(lease => lease.setRunning(value)); },
  setAuthoritative(value: boolean) { leases.forEach(lease => lease.setAuthoritative(value)); },
  hideTools() { panel.panels.dispatch(ownerId, { type: 'set-region-open', region: 'right', open: false }); },
  newBrowser: () => browser.open(ownerId, { initialUrl: location.origin + '/resource-refresh/document' }),
  inspect: () => ({ tabs: panel.panels.getOwnerSnapshot(ownerId).right.tabs.map(tab => ({ id: tab.id, resource: tab.resource, kind: tab.kind })),
    records: panel.context.sideChats.records(parent).map(r => r.id), sessions: panel.context.sideChats.list(parent).map(s => s.key.threadId), pages: browser.listForOwner(ownerId).map(row => ({ id: row.tab.id, page: row.page.id, url: row.page.navigation.currentUrl })) }),
  reconcileSideChats() { panel.panels.refreshOwnerResources(ownerId); return panel.context.sideChats.restore(parent).then(() => metadata?.reconcile()); },
  detachSidechatPresentation() {
    const tab = panel.panels.getOwnerSnapshot(ownerId).right.tabs.find(t => t.kind === 'sidechat');
    const definition = panel.panels.getRegistrySnapshot().find(d => d.kind === 'sidechat');
    if (tab) definition?.disposeTab?.(tab, ownerId, 'definition-unregister');
  },
  disconnectMetadata() { (metadata as any)?.socket?.close(); },
  activate(kind: string) { const tab = panel.panels.getOwnerSnapshot(ownerId).right.tabs.find(t => t.kind === kind)!; panel.panels.dispatch(ownerId, { type: 'activate-tab', region: 'right', tabId: tab.id }); },
  closeAll() { for (const tab of [...panel.panels.getOwnerSnapshot(ownerId).right.tabs]) panel.panels.close(ownerId, 'right', tab.id); },
};
createIntlTestRoot(document.getElementById('root')!, undefined, params.get('locale') ?? 'en-US').render(<App />);
