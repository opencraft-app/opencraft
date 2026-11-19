import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkbenchPanelReactRuntime } from '@opencraft/workbench-panels-react';
import { WorkbenchTerminalSessionRegistry, createTerminalWorkbenchPanelPlugin } from '../../plugins/terminal/src/index';
import { WebBrowserPageRuntime } from '../../apps/workbench-web/src/browser/web-browser-runtime';
import { BrowserWorkbenchCoordinator } from '../../apps/workbench-web/src/browser/browser-workbench-coordinator';
import { createBrowserWorkbenchPanelPlugin } from '../../apps/workbench-web/src/browser/browser-panel-plugin';
import { createConversationBindingStore } from '@opencraft/workbench-runtime';

test('conversation panel owner preserves visibility, selection and tabs across route presentations', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  try {
    const owner = 'scope:host-a:thread-a';
    runtime.panels.dispatch(owner, { type: 'open-tab', tab: {
      id: 'terminal:a', kind: 'terminal', region: 'right', title: 'Terminal', closable: true, preview: false,
    } });
    const original = runtime.panels.getOwnerSnapshot(owner);
    runtime.panels.getOwnerSnapshot('scope:host-a:thread-b');
    // Route disposal cannot erase its parent conversation's panel state.
    runtime.panels.releaseOwner('route:a:first');
    assert.equal(runtime.panels.getOwnerSnapshot(owner), original);
    assert.equal(original.right.activeTabId, 'terminal:a');
    assert.equal(original.right.open, true);
    assert.equal(runtime.panels.getOwnerSnapshot('scope:host-b:thread-a').right.tabs.length, 0);
  } finally { await runtime.dispose(); }
});

test('terminal outlives panel cache eviction and only explicit tab close terminates', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let killed = 0;
  let detached = 0;
  const registry = new WorkbenchTerminalSessionRegistry(() => ({ resources: { terminal: {
    open: () => ({ processId: 'pty', getSnapshot: () => ({ phase: 'running', exitCode: null, output: [] }),
      subscribe: () => () => {}, terminate: async () => { killed++; }, dispose: async () => { detached++; } }),
  } } } as any));
  await runtime.install(createTerminalWorkbenchPanelPlugin(registry));
  try {
    const sessionId = registry.open({ hostId: 'host', cwd: null, resourceOwnerId: 'conversation' });
    runtime.panels.open('conversation', 'terminal', { sessionId });
    runtime.panels.releaseOwner('route:old');
    assert.equal(killed, 0);
    runtime.panels.releaseOwner('conversation');
    assert.equal(killed, 0, 'owner release is not terminal close');
    assert.ok(registry.get(sessionId));
    assert.deepEqual(registry.listForOwner('conversation'), [sessionId]);
    const restored = runtime.panels.ensureOwner('conversation');
    assert.equal(restored.right.tabs[0]?.id, `terminal:${sessionId}`);
    runtime.panels.close('conversation', 'right', `terminal:${sessionId}`);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(killed, 1);
    assert.equal(detached, 1);
    assert.deepEqual(registry.listForOwner('conversation'), []);
  } finally { await runtime.dispose(); await registry.dispose(); }
});

test('terminal setup failure never registers a phantom owned resource', () => {
  const registry = new WorkbenchTerminalSessionRegistry(() => ({ resources: { terminal: {
    open() { throw new Error('offline'); },
  } } } as any));
  assert.throws(() => registry.open({ hostId: 'h', cwd: null, resourceOwnerId: 'c' }), /offline/);
  assert.deepEqual(registry.listForOwner('c'), []);
});

test('browser resource directory rebuilds an evicted closed panel projection', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage: { getItem: () => null, setItem: () => undefined } },
  });
  const runtime = await createWorkbenchPanelReactRuntime();
  const pages = new WebBrowserPageRuntime();
  const workbench = new BrowserWorkbenchCoordinator(
    pages,
    runtime.panels,
    createConversationBindingStore(),
  );
  await runtime.install(createBrowserWorkbenchPanelPlugin(workbench));
  try {
    const ownerId = 'conversation:browser-rebuild';
    const opened = workbench.open(ownerId);
    assert.equal(runtime.panels.getOwnerSnapshot(ownerId).right.open, true);
    runtime.panels.releaseOwner(ownerId);
    assert.notEqual(pages.getSnapshot(opened.pageId), null);

    const rebuilt = runtime.panels.ensureOwner(ownerId);
    assert.equal(rebuilt.right.open, false);
    assert.equal(rebuilt.right.tabs[0]?.id, `browser:${opened.tabId}`);

    runtime.panels.close(ownerId, 'right', `browser:${opened.tabId}`);
    assert.equal(pages.getSnapshot(opened.pageId), null);
  } finally {
    workbench.dispose();
    pages.dispose();
    await runtime.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, 'window', previousWindow);
  }
});


test('late Host resource hydration cannot revive a released owner or replaced contribution', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  const resolvers: Array<(tabs: any[]) => void> = [];
  const tab = { id: 'late', kind: 'fixture', resource: 'pty', region: 'right' as const, title: 'Terminal', closable: true, preview: false };
  const unregister = runtime.panels.register({ kind: 'fixture', createTab: () => tab,
    hydrateTabs: () => new Promise(resolve => resolvers.push(resolve)) });
  try {
    runtime.panels.ensureOwner('released');
    await new Promise(resolve => setTimeout(resolve, 0));
    runtime.panels.releaseOwner('released');
    resolvers.shift()!([tab]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.panels.getOwnerSnapshot('released').right.tabs.length, 0);
    runtime.panels.ensureOwner('replaced');
    await new Promise(resolve => setTimeout(resolve, 0));
    unregister();
    runtime.panels.register({ kind: 'fixture', createTab: () => tab });
    resolvers.shift()!([tab]);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.panels.getOwnerSnapshot('replaced').right.tabs.length, 0);
  } finally { await runtime.dispose(); }
});

test('Host tab hydration preserves the selected tab and panel visibility', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  const tab = { id: 'restored', kind: 'fixture', resource: 'pty', region: 'right' as const, title: 'Terminal', closable: true, preview: false };
  try {
    runtime.panels.register({ kind: 'fixture', createTab: () => tab, hydrateTabs: async () => [tab] });
    runtime.panels.dispatch('owner', { type: 'open-tab', tab: { ...tab, id: 'existing', resource: 'existing' } });
    const previous = runtime.panels.getOwnerSnapshot('owner');
    await new Promise(resolve => setTimeout(resolve, 0));
    const next = runtime.panels.getOwnerSnapshot('owner');
    assert.equal(next.right.tabs.length, 2);
    assert.equal(next.right.activeTabId, previous.right.activeTabId);
    assert.equal(next.right.open, previous.right.open);
  } finally { await runtime.dispose(); }
});


test('Host readiness retries hydration without resetting existing panel state', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let ready = false;
  const tab = { id: 'recovered', kind: 'fixture', resource: 'pty', region: 'right' as const, title: 'Terminal', closable: true, preview: false };
  try {
    runtime.panels.register({ kind: 'fixture', createTab: () => tab, hydrateTabs: async () => {
      if (!ready) throw new Error('Host unavailable');
      return [tab];
    } });
    runtime.panels.ensureOwner('owner');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 0);
    ready = true;
    runtime.panels.refreshOwnerResources('owner');
    await new Promise(resolve => setTimeout(resolve, 0));
    const restored = runtime.panels.getOwnerSnapshot('owner');
    assert.equal(restored.right.tabs[0]?.id, 'recovered');
    assert.equal(restored.right.open, false);
    runtime.panels.releaseOwner('owner');
    runtime.panels.refreshOwnerResources('owner');
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 0);
  } finally { await runtime.dispose(); }
});

const settleDirectory = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const directoryTab = (id: string, title = id) => ({ id, kind: 'resource', region: 'right' as const,
  title, resource: id, closable: true, preview: false });

test('attachment directory reconciles atomically without disposing resources or disturbing other kinds', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let rows = [directoryTab('a'), directoryTab('b')];
  let changed = () => {}; let failed = false; let disposed = 0; let updates = 0;
  runtime.panels.register({ kind: 'resource', createTab: ({ id }) => directoryTab(String(id)),
    disposeTab: () => { disposed++; }, tabDirectory: {
      read: () => { if (failed) throw Error('offline'); return rows; },
      subscribe: (_owner, listener) => { changed = listener; return () => {}; },
    } });
  try {
    runtime.panels.dispatch('owner', { type: 'open-tab', tab: { ...directoryTab('file'), kind: 'file' } });
    await settleDirectory();
    runtime.panels.subscribeOwner('owner', () => { updates++; });
    rows = [directoryTab('b', 'renamed'), directoryTab('c')]; changed(); changed();
    await settleDirectory();
    const snapshot = runtime.panels.getOwnerSnapshot('owner');
    assert.deepEqual(snapshot.right.tabs.map(t => t.id), ['file', 'b', 'c']);
    assert.equal(snapshot.right.tabs[1]?.title, 'renamed');
    assert.equal(snapshot.right.activeTabId, 'file');
    assert.equal(updates, 1); assert.equal(disposed, 0);
    changed(); await settleDirectory(); assert.equal(updates, 1, 'identical reads do not rebroadcast');
    failed = true; rows = []; changed(); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner'), snapshot, 'offline is not empty');
    failed = false; changed(); await settleDirectory();
    assert.deepEqual(runtime.panels.getOwnerSnapshot('owner').right.tabs.map(t => t.id), ['file']);
    assert.equal(disposed, 0, 'source removal never sends a resource close');
  } finally { await runtime.dispose(); }
});

test('late hydration cannot reopen a closed tab; explicit open can', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let finish!: (rows: ReturnType<typeof directoryTab>[]) => void;
  runtime.panels.register({ kind: 'resource', createTab: ({ id }) => directoryTab(String(id)),
    hydrateTabs: () => new Promise(resolve => { finish = resolve; }) });
  try {
    runtime.panels.open('owner', 'resource', { id: 'a' });
    await settleDirectory();
    runtime.panels.close('owner', 'right', 'a');
    finish([directoryTab('a')]); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 0);
    runtime.panels.open('owner', 'resource', { id: 'a' });
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 1);
  } finally { await runtime.dispose(); }
});

test('directory callbacks from an evicted owner cannot mutate its replacement', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  const callbacks: (() => void)[] = []; let reads = 0; let stopped = 0;
  runtime.panels.register({ kind: 'resource', createTab: () => directoryTab('a'), tabDirectory: {
    read: () => { reads++; return []; },
    subscribe: (_owner, cb) => { callbacks.push(cb); return () => { stopped++; }; },
  } });
  try {
    runtime.panels.ensureOwner('owner'); callbacks[0]!();
    runtime.panels.releaseOwner('owner'); runtime.panels.ensureOwner('owner');
    await settleDirectory(); assert.equal(reads, 1); assert.equal(stopped, 1);
    callbacks[0]!(); await settleDirectory(); assert.equal(reads, 1);
  } finally { await runtime.dispose(); }
});

test('browser hidden resources stay outside panel counts across projection eviction and metadata reload', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  const pages = new WebBrowserPageRuntime();
  // Surface allocation is independent of attachment ownership in this unit test.
  pages.prepareSurface = () => {};
  const stored = new Map<string, string>();
  const storage = { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); } };
  const workbench = new BrowserWorkbenchCoordinator(pages, runtime.panels, createConversationBindingStore(), storage);
  await runtime.install(createBrowserWorkbenchPanelPlugin(workbench));
  try {
    runtime.panels.ensureOwner('owner');
    const hidden = workbench.open('owner', { visible: false })!;
    const shown = workbench.open('owner')!;
    await settleDirectory();
    assert.equal(workbench.listForOwner('owner').length, 2);
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 1);
    runtime.panels.releaseOwner('owner'); runtime.panels.ensureOwner('owner'); await settleDirectory();
    assert.deepEqual(runtime.panels.getOwnerSnapshot('owner').right.tabs.map(t => t.resource), [shown.tabId]);
    const restored = new BrowserWorkbenchCoordinator(pages, runtime.panels, createConversationBindingStore(), storage);
    assert.deepEqual(restored.listPanelTabs('owner').map(t => t.tab.id), [shown.tabId]);
    restored.dispose();
    workbench.open('owner', { tabId: hidden.tabId }); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 2);
    runtime.panels.close('owner', 'right', `browser:${hidden.tabId}`); await settleDirectory();
    assert.equal(workbench.listForOwner('owner').length, 1);
  } finally { workbench.dispose(); pages.dispose(); await runtime.dispose(); }
});

test('authoritative reads ignore invalid snapshots and suppress stale closed entries until explicit reopen', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let rows = [directoryTab('a')]; let changed = () => {}; let closes = 0;
  runtime.panels.register({ kind: 'resource', createTab: ({ id }) => directoryTab(String(id)),
    disposeTab: (_tab, _owner, reason) => { if (reason === 'close') closes++; },
    tabDirectory: { read: () => rows, subscribe: (_owner, cb) => { changed = cb; return () => {}; } } });
  try {
    runtime.panels.ensureOwner('owner'); await settleDirectory();
    const before = runtime.panels.getOwnerSnapshot('owner');
    rows = [directoryTab('b'), directoryTab('b')]; changed(); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner'), before);
    runtime.panels.close('owner', 'right', 'a');
    rows = [directoryTab('a')]; changed(); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 0);
    assert.equal(closes, 1);
    runtime.panels.open('owner', 'resource', { id: 'a' }); changed(); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 1);
  } finally { await runtime.dispose(); }
});

test('directory hydration rereads current authority instead of replaying a stale resource array', async () => {
  const runtime = await createWorkbenchPanelReactRuntime();
  let finish!: (rows: ReturnType<typeof directoryTab>[]) => void;
  runtime.panels.register({ kind: 'resource', createTab: () => directoryTab('a'),
    hydrateTabs: () => new Promise(resolve => { finish = resolve; }),
    tabDirectory: { read: () => [], subscribe: () => () => {} } });
  try {
    runtime.panels.ensureOwner('owner'); await settleDirectory();
    finish([directoryTab('a')]); await settleDirectory();
    assert.equal(runtime.panels.getOwnerSnapshot('owner').right.tabs.length, 0);
  } finally { await runtime.dispose(); }
});
