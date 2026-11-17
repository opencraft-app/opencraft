import React, {useState} from 'react';
import {createComposerController} from '@opencraft/composer-core';
import {createConversationKey} from '@opencraft/chat-core';
import {OpenCraftComposer, type AttachmentProgress} from '@opencraft/composer-editor';
import {createAppServerWorkbenchRuntime} from '@opencraft/workbench-runtime';
import {WebSocketTransport} from '@opencraft/appserver-transport-websocket';
import {AppShell} from '../../apps/workbench-web/src/components/app-shell';
import {AppShellHeader} from '../../apps/workbench-web/src/components/app-shell-header';
import {useTimelineViewportHost} from '../../apps/workbench-web/src/timeline-viewport';
import {initializeAppearanceTheme, setThemePreference} from '../../apps/workbench-web/src/appearance-theme';
import {resolveBrowserAttachmentForHost} from '../../apps/workbench-web/src/runtime/browser-attachment-resolver';
import {createIntlTestRoot} from './intl-root';
import '../../apps/workbench-web/src/styles/app.scss';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.opencraftWindowType = 'browser';
initializeAppearanceTheme(); setThemePreference(mode);
const runtime = createAppServerWorkbenchRuntime({hostId: 'fixture', autoReconnect: true, reconnectDelaysMs: [20],
  createTransport: () => new WebSocketTransport({url: params.get('rpc')!})});
const ready = runtime.connect();
const controller = createComposerController({type: 'existing-thread', key: createConversationKey('fixture', 'one')}, {now: () => Date.now(), createId: () => crypto.randomUUID()});
let submissions = 0;
const chrome = {kind: "browser", platform: "linux", safeArea: {left: 0, right: 0}} as const;
const noop = () => {};
function Fixture() {
 useTimelineViewportHost(chrome);
 const [mounted, setMounted] = useState(true);
 Object.assign(window, {uploadFixture: {controller, runtime, ready, setMounted, getSubmissionCount: () => submissions}});
 return <AppShell layoutScope="thread" mainContentLayout="thread-edge-scroll" navigation={{layout: "unified", actions: [], account: null, onOpenSettings: noop}}
   header={<AppShellHeader conversationHeader title="Attachments" project={null} sidebarOpen={false} rightPanelOpen={false} rightPanelFullWidth={false}
     onToggleSidebar={noop} onToggleRightPanel={noop} onHome={noop} canGoBack={false} canGoForward={false} onBack={noop} onForward={noop} navigationActions={["sidebar-toggle"]} />}
   windowChrome={chrome} sidebarOpen={false} sidebarWidth={275} onSidebarCollapse={noop} onSidebarExpand={noop} onSidebarResizeEnd={noop}
   floatingSidebarHeader={() => null} leftPanel={null} rightPanelOpen={false} rightPanelFullWidth={false} onRightPanelOpenChange={noop} rightPanel={null}>
  <main style={{minHeight: '100%', padding: 12, background: 'var(--color-background-primary)', color: 'var(--color-text)'}}>
   <div style={{maxWidth: 760, margin: '80px auto 0'}}>
    {mounted ? <OpenCraftComposer controller={controller} isStreaming={false} onSubmit={() => { submissions++; return false; }} onCancel={() => { throw new Error("No remote Turn is running in this fixture"); }}
      onResolveAttachment={(file, pending, signal, onProgress) => resolveBrowserAttachmentForHost(runtime, file, pending, undefined, signal, onProgress as ((progress: AttachmentProgress | null) => void) | undefined)}
      onRemoveAttachment={async attachment => {
        const ref = attachment.metadata?.attachmentRef;
        if (typeof ref === 'object' && ref !== null && 'id' in ref && typeof ref.id === 'string') await runtime.resources.attachments.remove(ref.id);
      }} /> : null}
   </div>
 </main>
 </AppShell>;
}
createIntlTestRoot(document.getElementById('root')!).render(<Fixture />);
