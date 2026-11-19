import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationKey } from '@opencraft/chat-core';
import { createConversationBindingStore } from '@opencraft/workbench-runtime';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';

function fixture(records = new Map<string, string>(), aliases: { scopeId: string; hostId: string; threadId: string | null }[] = []) {
  const listeners = new Map<string, Set<() => void>>(), snapshots = new Map<string, any>();
  let created = 0, prepared = 0, closed = 0, opened = 0;
  const pages: any = {
    setSessionClosedHandler() {}, setNewWindowHandler() {}, openExternalIfRequired: () => false,
    create({ ownerId }: any) {
      const id = `page-${++created}`;
      snapshots.set(id, { id, ownerId, title: `Title ${created}`, navigation: { currentUrl: `https://example.com/${created}`, isLoading: false } });
      return id;
    },
    getSnapshot: (id: string) => snapshots.get(id) ?? null, list: () => [...snapshots.values()],
    subscribe(id: string, listener: () => void) { const set = listeners.get(id) ?? new Set(); set.add(listener); listeners.set(id, set); return () => set.delete(listener); },
    prepareSurface() { prepared++; throw Error('metadata must not prepare native pages'); },
    close(id: string) { closed++; snapshots.delete(id); },
  };
  const panels: any = { open() { opened++; return { id: 'panel' }; }, close() {}, dispatch() {}, ensureOwner() {} };
  const bindings = createConversationBindingStore({ persistence: { load: () => aliases } });
  const storage = { getItem: (k: string) => records.get(k) ?? null, setItem: (k: string, v: string) => records.set(k, v) };
  const workbench = new BrowserWorkbenchCoordinator(pages, panels, bindings, storage);
  const update = (id: string, patch: any) => { snapshots.set(id, { ...snapshots.get(id), ...patch }); for (const l of listeners.get(id) ?? []) l(); };
  return { workbench, bindings, pages, snapshots, records, update, counts: () => ({ created, prepared, closed, opened }) };
}

test('conversation resources isolate identical Thread IDs by Host, update only their owner, and never wake surfaces', t => {
  const f = fixture(); t.after(() => f.workbench.dispose());
  f.bindings.bind('scope-a' as never, createConversationKey('host-a', 'same'));
  f.bindings.bind('scope-b' as never, createConversationKey('host-b', 'same'));
  let changedA = 0, changedB = 0;
  f.workbench.subscribeConversationTabs('host-a', 'same', () => changedA++);
  f.workbench.subscribeConversationTabs('host-b', 'same', () => changedB++);
  assert.equal(f.workbench.getConversationTabs('host-a', 'same').length, 0);
  const a = f.workbench.open('scope-a')!, b = f.workbench.open('scope-b')!;
  assert.deepEqual(f.workbench.getConversationTabs('host-a', 'same').map(t => t.tabId), [a.tabId]);
  assert.deepEqual(f.workbench.getConversationTabs('host-b', 'same').map(t => t.tabId), [b.tabId]);
  const previous = f.workbench.getConversationTabs('host-a', 'same'), calls = [changedA, changedB];
  f.update(a.pageId, { navigation: { ...f.snapshots.get(a.pageId).navigation, isLoading: true } });
  assert.equal(f.workbench.getConversationTabs('host-a', 'same'), previous, 'irrelevant native changes keep snapshot identity');
  assert.deepEqual([changedA, changedB], calls);
  f.update(a.pageId, { title: 'Updated title' }); assert.equal(changedA, calls[0] + 1); assert.equal(changedB, calls[1]);
  assert.equal(f.workbench.getConversationTabs('host-a', 'same')[0]?.title, 'Updated title');
  const before = f.counts(); f.workbench.open('scope-a', { tabId: a.tabId });
  assert.equal(f.counts().created, before.created, 'opening an existing resource never creates a tab');
  f.workbench.close('scope-a', a.tabId);
  assert.equal(f.workbench.getConversationTabs('host-a', 'same').length, 0); assert.equal(f.workbench.getConversationTabs('host-b', 'same').length, 1);
  assert.equal(f.counts().closed, 1); assert.equal(f.counts().prepared, 0);
});

test('retained tabs become visible on late canonical binding without opening a panel or surface', t => {
  const f = fixture(); t.after(() => f.workbench.dispose());
  const a = f.workbench.open('unresolved-scope')!;
  let changes = 0; const unsubscribe = f.workbench.subscribeConversationTabs('host', 'thread', () => changes++);
  assert.equal(f.workbench.getConversationTabs('host', 'thread').length, 0);
  const before = f.counts(); f.bindings.bind('unresolved-scope' as never, createConversationKey('host', 'thread'));
  assert.equal(changes, 1); assert.equal(f.workbench.getConversationTabs('host', 'thread')[0]?.tabId, a.tabId);
  assert.deepEqual(f.counts(), before);
  f.bindings.remove('unresolved-scope' as never); assert.equal(changes, 2); assert.equal(f.workbench.getConversationTabs('host', 'thread').length, 0);
  assert.equal(f.snapshots.has(a.pageId), true, 'unresolved ownership is not a close command');
  unsubscribe(); f.update(a.pageId, { title: 'No subscriber' }); assert.equal(changes, 2);
});

test('restored logical tabs are readable before presentation and close-all affects only their original scope', t => {
  const first = fixture(), a = first.workbench.open('scope-a')!, b = first.workbench.open('scope-a')!, c = first.workbench.open('scope-b')!;
  first.workbench.dispose();
  const restored = fixture(first.records); t.after(() => restored.workbench.dispose());
  for (const [id, snapshot] of first.snapshots) restored.snapshots.set(id, snapshot);
  restored.bindings.bind('scope-a' as never, createConversationKey('h', 'a')); restored.bindings.bind('scope-b' as never, createConversationKey('h', 'b'));
  const rows = restored.workbench.getConversationTabs('h', 'a'); assert.deepEqual(rows.map(t => t.tabId), [a.tabId, b.tabId]);
  assert.deepEqual(restored.counts(), { created: 0, prepared: 0, closed: 0, opened: 0 });
  for (const tab of rows) restored.workbench.close(tab.ownerId, tab.tabId);
  assert.equal(restored.workbench.getConversationTabs('h', 'a').length, 0); assert.equal(restored.workbench.getConversationTabs('h', 'b')[0]?.tabId, c.tabId);
  assert.deepEqual(restored.counts(), { created: 0, prepared: 0, closed: 2, opened: 0 });
});

test('a tab opened on another device appears here and a remote close removes it', t => {
  const f = fixture(); t.after(() => f.workbench.dispose());
  f.bindings.bind('scope-a' as never, createConversationKey('host-a', 'thread'));
  let changed = 0;
  f.workbench.subscribeConversationTabs('host-a', 'thread', () => changed++);
  // What the page runtime's pushed-directory pass does before tabs are merged.
  (f.pages as any).reconcile = () => {
    const rows = JSON.parse(f.records.get('opencraft.browser-pages.v1') ?? '[]');
    for (const row of rows) if (!f.snapshots.has(row.id)) f.snapshots.set(row.id, {
      id: row.id, ownerId: row.ownerId, title: 'Remote', navigation: { currentUrl: row.entries[0]?.url ?? 'https://example.com', isLoading: false },
    });
  };
  const tabId = 'tab-remote'; const pageId = 'page-remote';
  f.records.set('opencraft.browser-pages.v1', JSON.stringify([{ id: pageId, ownerId: 'scope-a', createdAt: 5, entries: [{ url: 'https://example.com/remote', title: 'Remote' }], index: 0 }]));
  f.records.set('opencraft.browser-tabs.v1', JSON.stringify([{ id: tabId, pageId, ownerId: 'scope-a', createdAt: 5, viewportMode: 'responsive', panelAttached: true }]));
  (f.pages as any).reconcile();
  f.workbench.reconcileStoredTabs();
  assert.deepEqual(f.workbench.getConversationTabs('host-a', 'thread').map(tab => tab.tabId), [tabId]);
  assert.equal(changed, 1);
  assert.equal(f.counts().prepared, 0, 'a pushed tab must not wake a native surface');
  const before = changed;
  f.records.set('opencraft.browser-tabs.v1', '[]');
  f.workbench.reconcileStoredTabs();
  assert.deepEqual(f.workbench.getConversationTabs('host-a', 'thread'), []);
  assert.equal(changed, before + 1);
  assert.equal(f.counts().closed, 0, 'remote projection removal must not destroy a shared page');
});

test('reload with a different scope alias recovers the same browser tab only for the same Host and Thread', t => {
  const first = fixture();
  const opened = first.workbench.open('draft-alias')!;
  first.workbench.dispose();
  const aliases: { scopeId: string; hostId: string; threadId: string | null }[] = [];
  const restored = fixture(first.records, aliases); t.after(() => restored.workbench.dispose());
  for (const [id, snapshot] of first.snapshots) restored.snapshots.set(id, snapshot);
  const parent = createConversationKey('host', 'thread');
  restored.bindings.bind('current' as never, parent);
  let changed = 0;
  restored.workbench.subscribePanelTabs('current', () => changed++);
  assert.deepEqual(restored.workbench.listPanelTabs('current'), []);
  aliases.push({ scopeId: 'draft-alias', hostId: 'host', threadId: 'thread' });
  restored.bindings.restore();
  assert.ok(changed > 0, 'late aliases must invalidate the already-mounted panel directory');
  assert.deepEqual(restored.workbench.listPanelTabs('current').map(row => row.tab.id), [opened.tabId]);
  assert.equal(restored.workbench.requireOwnedTab('current', opened.tabId).tab.id, opened.tabId);
  restored.bindings.bind('other-host' as never, createConversationKey('other', 'thread'));
  restored.bindings.bind('other-thread' as never, createConversationKey('host', 'other'));
  for (const owner of ['other-host', 'other-thread', 'unbound']) {
    assert.deepEqual(restored.workbench.listPanelTabs(owner), []);
    assert.throws(() => restored.workbench.requireOwnedTab(owner, opened.tabId), /another Conversation/);
  }
  restored.workbench.close('current', opened.tabId);
  assert.deepEqual(restored.workbench.listPanelTabs('draft-alias'), []);
  assert.deepEqual(restored.counts(), { created: 0, prepared: 0, closed: 1, opened: 0 });
});


test('foreground presentation uses the mounted alias and checks physical paint in that view', async t => {
  const f = fixture(new Map(),[{scopeId:'canonical',hostId:'host',threadId:'thread'},{scopeId:'draft-alias',hostId:'host',threadId:'thread'}]); t.after(() => f.workbench.dispose());
  const tab = f.workbench.open('draft-alias')!;
  const request = {hostId:'host',threadId:'thread',tabId:tab.tabId};
  f.workbench.bindView('canonical' as never, 'view');
  assert.equal(f.workbench.canPresentConversationTab(request),true);
  const state = {right:{open:false,activeTabId:null,tabs:[]},bottom:{tabs:[]}};
  const owners:string[]=[];
  const panels=(f.workbench as any).panels;
  panels.getOwnerSnapshot=(owner:string)=>{assert.equal(owner,'canonical');return state;};
  panels.open=(owner:string)=>{owners.push(owner);Object.assign(state.right,{open:true,activeTabId:'browser:'+tab.tabId,tabs:[{id:'browser:'+tab.tabId,kind:'browser'}]});return {id:'browser:'+tab.tabId}};
  assert.equal(f.workbench.presentConversationTab(request),true);assert.deepEqual(owners,['canonical']);
  assert.equal(f.workbench.isConversationTabPresented(request),true);
  (f.workbench as any).isPhysicalPresentationVisible=(_tab:string,views:string[])=>{assert.deepEqual(views,['view']);return true;};
  const names=['document','requestAnimationFrame','cancelAnimationFrame'];const saved=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  Object.defineProperties(globalThis,{document:{configurable:true,value:Object.assign(new EventTarget(),{visibilityState:'visible'})},requestAnimationFrame:{configurable:true,value:(fn:any)=>setTimeout(fn,0)},cancelAnimationFrame:{configurable:true,value:clearTimeout}});
  t.after(()=>{for(const name of names){const descriptor=saved.get(name);if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete (globalThis as any)[name]}});
  assert.equal(await f.workbench.waitForConversationPresentation(request),true);
  f.workbench.setViewPresentationActive('view',false);assert.equal(f.workbench.presentationBlockReason(request),'view-inactive');
  assert.equal(f.workbench.canPresentConversationTab(request),false);
});

test('late aliases wake presentation without admitting another Host or Thread', t => {
  const aliases=[{scopeId:'canonical',hostId:'host',threadId:'thread'}];const f=fixture(new Map(),aliases);t.after(()=>f.workbench.dispose());const key=createConversationKey('host','thread');
  const tab=f.workbench.open('alias')!;f.workbench.bindView('canonical' as never,'view');
  const request={hostId:'host',threadId:'thread',tabId:tab.tabId};assert.equal(f.workbench.presentationBlockReason(request),'owner-mismatch');
  let wakes=0;f.workbench.subscribePresentationReadiness(()=>wakes++);aliases.push({scopeId:'alias',hostId:'host',threadId:'thread'});f.bindings.restore();
  assert(wakes>0);assert.equal(f.workbench.canPresentConversationTab(request),true);
  assert.equal(f.workbench.canPresentConversationTab({...request,hostId:'foreign'}),false);
  assert.equal(f.workbench.canPresentConversationTab({...request,threadId:'foreign'}),false);
});
