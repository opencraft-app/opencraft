import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ResourceStore } from "@opencraft/blob-resources";
import { useChatMediaSource, type ChatMediaSourceLoader, type ChatMediaSourceRequest, type ChatMediaSourceSnapshot } from "@opencraft/chat-render-react";
const request: ChatMediaSourceRequest = { source: "a.png", resolvedTarget: "file:///a.png", resourceKind: "file", hostId: "host", conversationId: "a", documentId: "image", cwd: "/" };
const resource = { scope: "authority", path: "/a.png" };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test("returning image renders the shared ready snapshot before effects; legacy late leases are released", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("root")!);
  const store = new ResourceStore(async () => ({ value: { source: "blob:shared" }, sizeBytes: 1 }));
  const snapshots: ChatMediaSourceSnapshot[] = [];
  let prepared = 0;
  const loader: ChatMediaSourceLoader = Object.assign(async () => { throw new Error("shared consumers must not use legacy IO"); }, {
    getSnapshot: () => store.getSnapshot(resource),
    subscribe: (_: unknown, notify: () => void) => store.subscribe(resource, notify),
  });
  function Image({ provider = loader, target = request }: { provider?: ChatMediaSourceLoader; target?: ChatMediaSourceRequest }) {
    const snapshot = useChatMediaSource(provider, target); snapshots.push(snapshot);
    return React.createElement("span", null, snapshot.value?.source ?? snapshot.status);
  }
  try {
    await act(async () => { root.render(React.createElement(Image)); await tick(); });
    assert.equal(snapshots.at(-1)?.status, "ready");
    await act(() => root.render(null)); snapshots.length = 0;
    await act(() => root.render(React.createElement(Image)));
    assert.equal(snapshots[0].status, "ready", "no loading render on a warm return");
    assert.equal(document.querySelector("span")?.textContent, "blob:shared");
    const pending: ((value: any) => void)[] = [];
    const legacy: ChatMediaSourceLoader = () => new Promise(resolve => pending.push(resolve));
    await act(() => root.render(React.createElement(Image, { provider: legacy })));
    const replacement = { ...request, source: "b.png", resolvedTarget: "file:///b.png" };
    await act(() => root.render(React.createElement(Image, { provider: legacy, target: replacement })));
    await act(async () => { pending[0]({ source: "blob:old", release: () => prepared++ }); await tick(); });
    assert.equal(prepared, 1); assert.equal(document.querySelector("span")?.textContent, "loading");
    await act(async () => { pending[1]({ source: "blob:new", release: () => prepared++ }); await tick(); });
    assert.equal(document.querySelector("span")?.textContent, "blob:new");
    await act(() => root.render(null)); assert.equal(prepared, 2);
  } finally {
    await act(() => root.unmount()); store.close(); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
