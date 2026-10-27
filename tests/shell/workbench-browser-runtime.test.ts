import assert from "node:assert/strict";
import test from "node:test";

import {
  WebBrowserPageRuntime,
} from "../../apps/workbench-web/src/browser/web-browser-runtime";
import { BrowserWorkbenchCoordinator } from "../../apps/workbench-web/src/browser/browser-workbench-coordinator";
import { browserControlAttributesAreSensitive } from "@opencraft/browser-core";
import {
  asConversationScopeId,
  createConversationBindingStore,
} from "@opencraft/workbench-runtime";

test("browser control policy redacts credential-shaped fields beyond password inputs", () => {
  assert.equal(browserControlAttributesAreSensitive({ type: "password" }), true);
  assert.equal(browserControlAttributesAreSensitive({ name: "CUSTOM_API_KEY" }), true);
  assert.equal(browserControlAttributesAreSensitive({ autocomplete: "one-time-code" }), true);
  assert.equal(browserControlAttributesAreSensitive({ name: "project_title", type: "text" }), false);
});

test("browser pages retain stable ownership independently from Workbench tabs", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  const runtime = new WebBrowserPageRuntime();
  try {
    const viewId = "client-new-thread:draft";
    const pageId = runtime.create({ ownerId: viewId });

    assert.equal(runtime.listForOwner(viewId)[0]?.id, pageId);
    assert.equal(runtime.getSnapshot(pageId)?.ownerId, viewId);
    assert.match([...values.values()][0] ?? "", /"ownerId":"client-new-thread:draft"/u);
  } finally {
    runtime.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});

test("Browser resources and panel state are Scope-owned while Views are disposable presentations", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: { getItem: () => null, setItem: () => undefined },
    },
  });
  const runtime = new WebBrowserPageRuntime();
  const openedViews: string[] = [];
  const panels = {
    open(viewId: string, _kind: string, params: { browserTabId: string }) {
      openedViews.push(viewId);
      return { id: `browser:${params.browserTabId}` };
    },
    ensureOwner() { return undefined; },
    dispatch() { return undefined; },
    close() { return undefined; },
  };
  const coordinator = new BrowserWorkbenchCoordinator(
    runtime,
    panels as never,
    createConversationBindingStore(),
  );
  try {
    const scopeId = asConversationScopeId("conversation:browser-shared");
    coordinator.bindView(scopeId, "view-a");
    coordinator.bindView(scopeId, "view-b");
    const opened = coordinator.open(scopeId);
    coordinator.bindView(scopeId, "view-b");
    assert.deepEqual(openedViews, [scopeId]);

    coordinator.setViewportMode(opened.tabId, {
      type: "device",
      presetId: "ipad-pro-11",
      width: 834,
      height: 1194,
    });
    assert.deepEqual(coordinator.getTabSnapshot(opened.tabId)?.viewportMode, {
      type: "device",
      presetId: "ipad-pro-11",
      width: 834,
      height: 1194,
    });
    assert.equal("viewportMode" in (runtime.getSnapshot(opened.pageId) ?? {}), false);

    coordinator.releaseView("view-a");
    assert.notEqual(runtime.getSnapshot(opened.pageId), null);
    coordinator.releasePanel(scopeId, opened.tabId, true);
    assert.equal(runtime.getSnapshot(opened.pageId), null);
  } finally {
    runtime.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});


test("browser restoration works without iterator helpers on Safari 16", () => {
  const iteratorPrototype = Object.getPrototypeOf(new Map().values());
  const previousMap = Object.getOwnPropertyDescriptor(iteratorPrototype, "map");
  Object.defineProperty(iteratorPrototype, "map", { configurable: true, value: undefined });
  const records = new Map<string, string>();
  const storage = {
    getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { records.set(key, value); },
  };
  const runtime = new WebBrowserPageRuntime(undefined, null, undefined, storage);
  let coordinator: BrowserWorkbenchCoordinator | undefined;
  try {
    coordinator = new BrowserWorkbenchCoordinator(runtime, {} as never, createConversationBindingStore(), storage);
    coordinator.restorePersistedTabs(); // A fresh installation must start too.
    const ownerId = asConversationScopeId("conversation:restored-browser");
    const retainedPage = runtime.create({ ownerId });
    const orphanPage = runtime.create({ ownerId });
    records.set("opencraft.browser-tabs.v1", JSON.stringify([
      { id: "retained-tab", pageId: retainedPage, ownerId, createdAt: 1 },
      { id: "missing-page-tab", pageId: "missing-page", ownerId, createdAt: 2 },
    ]));
    coordinator.dispose();
    coordinator = new BrowserWorkbenchCoordinator(runtime, {} as never, createConversationBindingStore(), storage);
    coordinator.restorePersistedTabs();
    assert.deepEqual(coordinator.listForOwner(ownerId).map(({ tab }) => tab.pageId), [retainedPage]);
    assert.notEqual(runtime.getSnapshot(retainedPage), null, "an unresolved Scope retains its page");
    assert.equal(runtime.getSnapshot(orphanPage), null, "unlinked pages are still cleaned up");
    assert.equal(coordinator.getTabSnapshot("missing-page-tab" as never), null);
  } finally {
    coordinator?.dispose();
    runtime.dispose();
    if (previousMap) Object.defineProperty(iteratorPrototype, "map", previousMap);
    else delete iteratorPrototype.map;
  }
});
