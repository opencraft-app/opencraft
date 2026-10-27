import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationKey } from '@opencraft/chat-core';
import { createConversationBindingStore } from '@opencraft/workbench-runtime';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';

function fixture(records = new Map<string, string>()) {
  const listeners = new Map<string, Set<() => void>>(), snapshots = new Map<string, any>();
  let created = 0, prepared = 0, closed = 0, opened = 0;
  const pages: any = {
    setNewWindowHandler() {}, openExternalIfRequired: () => false,
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
  const bindings = createConversationBindingStore();
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
