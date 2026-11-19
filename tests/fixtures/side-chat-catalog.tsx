import React, { useState, useSyncExternalStore } from 'react';
import { Context } from '@deepseek-ai/cordis';
import { createConversationKey } from '@opencraft/chat-core';
import { SideChatService, threadServerOrigin } from '@opencraft/workbench-runtime';
import { SidebarLayoutStore } from '@opencraft/sidebar-layout';
import { Sidebar, type SidebarThread } from '../../apps/workbench-web/src/components/sidebar';
import { useOrdinaryConversationCatalog } from '../../apps/workbench-web/src/runtime/use-ordinary-conversation-catalog';
import { createSideChatPersistence } from '../../apps/workbench-web/src/runtime/side-chat-persistence';
import { initializeAppearanceTheme } from '../../apps/workbench-web/src/appearance-theme';
import { createIntlTestRoot } from './intl-root';
import '../../apps/workbench-web/src/styles/app.scss';

initializeAppearanceTheme();
const parent = createConversationKey('host', 'main');
const persistence = createSideChatPersistence(localStorage);
if (!persistence.directory?.().length) persistence.put({ id: 'saved', parent, key: createConversationKey('host', 'saved-child') });
const now = Date.now() / 1000;
const row = (id: string, title: string, host = 'host'): SidebarThread => ({ id, title,
  connectionHostId: host, connectionHostLabel: host, serverOrigin: threadServerOrigin({ serverId: host, label: host }),
  serverRouteLocality: 'local', project: 'Workspace', lineage: id === 'ordinary-fork' ? 'fork' : 'root',
  time: 'now', createdAt: now, updatedAt: now, status: 'ready' });
let threads = [row('main', 'Main conversation'), row('ordinary-fork', 'Ordinary fork'),
  row('saved-child', 'Saved owned conversation'), row('saved-child', 'Other Host conversation', 'other-host')];
if (localStorage.getItem('fixture-native-child')) threads = [...threads, row('new-child', 'New owned conversation')];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => threads;
const calls = JSON.parse(localStorage.getItem('fixture-native-calls') ?? '{"fork":0,"inject":0,"acquire":0,"release":0,"unsubscribe":0}');
const count = (key: string) => { calls[key]++; localStorage.setItem('fixture-native-calls', JSON.stringify(calls)); };
let finishBoundary: (() => void) | undefined;
const host: any = { resources: { threads: {
  supportsSideChat: () => true,
  fork: async () => {
    count('fork'); localStorage.setItem('fixture-native-child', 'yes');
    threads = [...threads, row('new-child', 'New owned conversation')];
    for (const listener of listeners) listener();
    return { id: 'new-child' };
  },
  injectItems: async () => { count('inject'); await new Promise<void>(resolve => { finishBoundary = resolve; }); },
  unsubscribe: async () => { count('unsubscribe'); },
} }, acquireThread: async () => {
  count('acquire'); return { getSnapshot: () => ({ activeTurn: null, timeline: { frames: [] } }), release() { count('release'); } };
} };
const ctx = new Context(); await ctx.plugin(SideChatService, { persistence, resolveHost: async () => host });
const service = ctx.sideChats;
const layout = await SidebarLayoutStore.open({ load: async () => null, save: async (_key, value) => value });
let opening: Promise<unknown> | undefined;
(window as any).catalogProbe = {
  begin() { opening = service.open('new', parent, null); },
  async finish() { finishBoundary?.(); await opening; },
  close: (id: string) => service.close(id),
  inspect: () => ({ calls, rawCount: threads.length, pendingBoundary: Boolean(finishBoundary),
    newOwnership: service.ownershipOf(createConversationKey('host', 'new-child')).kind,
    directory: persistence.directory?.() }),
};
function App() {
  const raw = useSyncExternalStore(subscribe, snapshot, snapshot);
  const ordinary = useOrdinaryConversationCatalog(raw, service);
  const [selected, select] = useState({ host: 'host', id: 'main' });
  return <div style={{ width: 'min(100vw, 320px)', height: '100dvh' }}>
    <Sidebar threads={ordinary} activeHostId={selected.host} activeThreadId={selected.id} sidebarLayout={layout}
      onSelectThread={(host, id) => { select({ host, id }); }} onNewTask={() => {}} onOpenSettings={() => {}} showFooter={false} />
  </div>;
}
createIntlTestRoot(document.getElementById('root')!).render(<App />);
