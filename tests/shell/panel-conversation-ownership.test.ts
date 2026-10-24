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
    open: () => ({ processId: 'pty', terminate: async () => { killed++; }, dispose: async () => { detached++; } }),
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
