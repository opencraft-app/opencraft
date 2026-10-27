import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserPageSnapshot, BrowserTabSnapshot } from "@opencraft/browser-core";
import { createConversationKey } from "@opencraft/chat-core";
import { asConversationScopeId, createConversationBindingStore } from "@opencraft/workbench-runtime";

import { WebBrowserDynamicToolHost } from "../../apps/workbench-web/src/browser/web-browser-tool-host";
import { BrowserWorkbenchCoordinator, type BrowserTabWithPage } from "../../apps/workbench-web/src/browser/browser-workbench-coordinator";

function browser(overrides: Partial<BrowserPageSnapshot> = {}): BrowserTabWithPage {
  const page: BrowserPageSnapshot = {
    revision: 1,
    id: "page-1" as BrowserPageSnapshot["id"],
    ownerId: "host-1:thread-1",
    createdAt: 1,
    title: "Preview <unsafe>",
    navigation: {
      currentUrl: "http://127.0.0.1:5173/?q=<unsafe>",
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    },
    error: null,
    ...overrides,
  };
  const tab: BrowserTabSnapshot = {
    id: "tab-1" as BrowserTabSnapshot["id"],
    pageId: page.id,
    ownerId: page.ownerId,
    createdAt: page.createdAt,
    viewportMode: { type: "responsive" },
  };
  return { tab, page };
}

test("dynamic browser tools authorize logical Tab IDs, then operate their Pages", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => null, setItem: () => undefined } },
  });
  const createdOwners: string[] = [];
  const pageSnapshots = new Map<string, BrowserPageSnapshot>();
  let nextPage = 0;
  const pages = {
    setNewWindowHandler() {},
    openExternalIfRequired() { return false; },
    create(input: { ownerId: string }) {
      createdOwners.push(input.ownerId);
      const id = `page-${++nextPage}` as BrowserPageSnapshot["id"];
      pageSnapshots.set(id, browser({ id, ownerId: input.ownerId }).page);
      return id;
    },
    getSnapshot(id: string) { return pageSnapshots.get(id) ?? null; },
    list() { return [...pageSnapshots.values()]; },
    subscribe() { return () => undefined; },
    close(id: string) { pageSnapshots.delete(id); },
    inspectPage() { return Promise.resolve({ pageId: "page", url: null, title: "", revision: 1, elements: [] }); },
  };
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
  const bindings = createConversationBindingStore();
  const ownedScope = asConversationScopeId("scope-owned");
  const ownedKey = createConversationKey("host-1", "thread-1");
  bindings.register(ownedScope, ownedKey.hostId);
  bindings.bind(ownedScope, ownedKey);
  const workbench = new BrowserWorkbenchCoordinator(pages as never, panels as never, bindings);
  try {
    workbench.bindView(ownedScope, "view-owned");
    const host = new WebBrowserDynamicToolHost(pages as never, workbench);
    const context = { hostId: "host-1", threadId: "thread-1", turnId: "turn-1", callId: "call-1" };
    const opened = await host.open(context, { url: "http://127.0.0.1:5173/" }) as { tabId: string };
    const other = workbench.open("scope-other");

    const listed = await host.browserUse(context, { action: "list_tabs" }) as { tabs: readonly { tabId: string }[] };
    assert.deepEqual(createdOwners, [ownedScope, "scope-other"]);
    assert.deepEqual(openedViews, [ownedScope, "scope-other"]);
    assert.deepEqual(listed.tabs.map((entry) => entry.tabId), [opened.tabId]);
    await assert.rejects(
      Promise.resolve(host.browserUse(context, { action: "inspect", tab_id: other.tabId })),
      /another Conversation Scope/u,
    );
    await assert.rejects(
      Promise.resolve(host.browserUse(context, { action: "click", tab_id: opened.tabId, ref: "e1" })),
      /expected_revision must be a non-negative integer/u,
    );
  } finally {
    workbench.dispose();
    if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else Object.defineProperty(globalThis, "window", previousWindow);
  }
});
