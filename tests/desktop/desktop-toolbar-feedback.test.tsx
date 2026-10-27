import assert from "node:assert/strict";
import test from "node:test";
import React, { act, useLayoutEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { createWorkbenchPanelReactRuntime } from "@opencraft/workbench-panels-react";
import { createCloudDesktopWorkbenchPanelPlugin } from "../../plugins/cloud-desktop/src/index";
import type { DesktopBackend, DesktopTarget } from "../../plugins/cloud-desktop/src/contract";

test("restoring an unchanged conversation cannot feed toolbar updates back into React", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const values = { window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const runtime = await createWorkbenchPanelReactRuntime();
  const listeners = new Set<() => void>();
  let target: DesktopTarget | null = null;
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const backend: DesktopBackend = {
    resolveTarget: () => target,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    prepare: async () => { throw new Error("No desktop preparation in toolbar test"); },
  };
  const installed = await runtime.install(createCloudDesktopWorkbenchPanelPlugin({ backend,
    surfaces: { mount: () => { throw new Error("No media mount in toolbar test"); } } }));
  const root = createRoot(dom.window.document.getElementById("root")!);
  let renders = 0;
  function Toolbar() {
    const actions = useSyncExternalStore(runtime.panels.subscribeToolbarActions, runtime.panels.getToolbarActionSnapshot);
    ++renders;
    // Restoring/observing the same conversation may notify its runtime again.
    useLayoutEffect(notify);
    return <div>{actions.filter(action => action.isAvailable?.({ ownerId: "view", resourceOwnerId: "scope", hostId: "host", cwd: null })).map(action => <button key={action.id}>{action.label}</button>)}</div>;
  }
  try {
    await act(async () => root.render(<Toolbar />));
    assert.ok(renders < 5);
    assert.equal(dom.window.document.querySelectorAll("button").length, 0);
    const stable = renders;
    await act(async () => { for (let index = 0; index < 20; ++index) notify(); });
    assert.equal(renders, stable, "unrelated runtime changes must not republish toolbar chrome");
    target = { conversationId: "scope", serverId: "server", environmentId: "env", principalId: "principal" };
    await act(async () => notify());
    assert.equal(dom.window.document.querySelectorAll("button").length, 1);
    target = null;
    await act(async () => notify());
    assert.equal(dom.window.document.querySelectorAll("button").length, 0);
    assert.ok(renders < 10);
  } finally {
    await act(async () => root.unmount());
    await installed.dispose(); await runtime.dispose(); dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
