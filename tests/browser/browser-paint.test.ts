import { BROWSER_TOOL_CATALOG } from "@opencraft/browser-core";
import test from "node:test";
import assert from "node:assert/strict";
import { waitForBrowserPaint } from "../../apps/workbench-web/src/browser/browser-paint";
import { WebBrowserDynamicToolHost } from "../../apps/workbench-web/src/browser/web-browser-tool-host";

function scheduler() {
  const previous = ["document", "requestAnimationFrame", "cancelAnimationFrame"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: document },
    requestAnimationFrame: {
      configurable: true,
      value: (fn: FrameRequestCallback) => {
        frames.set(++sequence, fn);
        return sequence;
      },
    },
    cancelAnimationFrame: { configurable: true, value: (id: number) => frames.delete(id) },
  });
  return {
    document,
    frames,
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(0);
    },
    dispose() {
      for (const [key, descriptor] of previous)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test("foreground ACK requires presentation through two frame callbacks", async () => {
  const clock = scheduler();
  let mounted = false,
    completed = false;
  try {
    const reply = waitForBrowserPaint(() => mounted, { expiresAt: Date.now() + 1000, current: () => true }).then(
      (result) => {
        completed = true;
        return result;
      },
    );
    clock.frame();
    clock.frame();
    await Promise.resolve();
    assert.equal(completed, false);
    mounted = true;
    clock.frame();
    await Promise.resolve();
    assert.equal(completed, false);
    clock.frame();
    assert.equal(await reply, true);
    assert.equal(clock.frames.size, 0);
  } finally {
    clock.dispose();
  }
});

for (const reason of ["hidden", "cancelled", "revoked", "expiry"] as const)
  test(`foreground paint cannot succeed after ${reason}`, async () => {
    const clock = scheduler(),
      controller = new AbortController();
    let current = true;
    try {
      const reply = waitForBrowserPaint(() => true, {
        expiresAt: Date.now() + (reason === "expiry" ? 20 : 1000),
        signal: controller.signal,
        current: () => current,
      });
      clock.frame();
      if (reason === "hidden") {
        clock.document.visibilityState = "hidden";
        clock.document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "cancelled") controller.abort();
      if (reason === "revoked") {
        current = false;
        clock.frame();
      }
      assert.equal(await reply, false);
      assert.equal(clock.frames.size, 0);
    } finally {
      controller.abort();
      clock.dispose();
    }
  });

test("local tool foreground result waits for its presentation owner acknowledgement", async () => {
  let acknowledge!: (visible: boolean) => void,
    opened = 0,
    complete = false;
  const paint = new Promise<boolean>((resolve) => {
    acknowledge = resolve;
  });
  const workbench = {
    scopeForThread: () => "scope",
    canPresentConversation: () => true,
    open() {
      opened++;
      return { tabId: "tab", pageId: "page", tab: { id: "panel" } };
    },
    waitForConversationPresentation: () => paint,
  };
  const host = new WebBrowserDynamicToolHost({ getSnapshot: () => null } as never, workbench as never);
  const result = Promise.resolve(
    host.open(
      { hostId: "host", threadId: "thread", turnId: "turn", callId: "call" },
      { url: "https://example.test", visible: true },
    ),
  ).then((value) => {
    complete = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(complete, false);
  acknowledge(true);
  assert.equal(((await result) as any).visible, true);
});

test("cancellation during the visibility probe leaves no future paint callback", async () => {
  const clock = scheduler(),
    controller = new AbortController();
  try {
    const result = waitForBrowserPaint(
      () => {
        controller.abort();
        return true;
      },
      { expiresAt: Date.now() + 1000, signal: controller.signal, current: () => true },
    );
    clock.frame();
    assert.equal(await result, false);
    assert.equal(clock.frames.size, 0);
  } finally {
    controller.abort();
    clock.dispose();
  }
});

test("an inactive conversation cannot create or present a foreground browser resource", async () => {
  let opened = 0;
  const host = new WebBrowserDynamicToolHost(
    {} as never,
    {
      scopeForThread: () => "scope",
      canPresentConversation: () => false,
      open() {
        opened++;
      },
    } as never,
  );
  assert.throws(
    () =>
      host.open(
        { hostId: "host", threadId: "thread", turnId: "turn", callId: "call" },
        { url: "https://example.test", visible: true },
      ),
    { code: "PRESENTATION_UNAVAILABLE", outcome: "not-dispatched" },
  );
  assert.equal(opened, 0);
});

test("omitting visible stays in the background and non-boolean visibility cannot dispatch", async () => {
  const options: unknown[] = [];
  const host = new WebBrowserDynamicToolHost(
    { getSnapshot: () => null } as never,
    {
      scopeForThread: () => "scope",
      open(_owner: string, value: unknown) {
        options.push(value);
        return { tabId: "tab", pageId: "page" };
      },
    } as never,
  );
  const context = { hostId: "host", threadId: "thread", turnId: "turn", callId: "call" };
  const result = host.open(context, { url: "https://example.test" }) as any;
  const schema = BROWSER_TOOL_CATALOG.find((namespace) => namespace.name === "opencraft_app")!.tools.find(
    (tool) => tool.name === "open_in_opencraft",
  )!.inputSchema as any;
  assert.equal(schema.properties.visible.default, false);
  assert.equal(result.visible, schema.properties.visible.default);
  assert.deepEqual(options, [{ visible: false, initialUrl: "https://example.test" }]);
  assert.throws(() => host.open(context, { url: "https://example.test", visible: "true" }), {
    code: "INVALID_ARGUMENT",
    outcome: "not-dispatched",
  });
  assert.equal(options.length, 1);
});

test("physical visibility cannot acknowledge an attached surface before its drawable frame", async () => {
  const { BrowserPresentationCoordinator } =
    await import("../../apps/workbench-web/src/browser/browser-presentation-coordinator");
  const coordinator: any = Object.create(BrowserPresentationCoordinator.prototype);
  const record = {
    disposed: false,
    painted: false,
    snapshot: { tabId: "tab", viewId: "view" },
    host: { isPainted: () => true },
    slot: {
      isConnected: true,
      ownerDocument: { visibilityState: "visible", defaultView: { innerWidth: 100, innerHeight: 100 } },
      getBoundingClientRect: () => ({ width: 80, height: 80, left: 0, top: 0 }),
    },
  };
  coordinator.records = new Map([["one", record]]);
  assert.equal(coordinator.isTabVisible("tab", ["view"]), false);
  record.painted = true;
  assert.equal(coordinator.isTabVisible("tab", ["view"]), true);
});
