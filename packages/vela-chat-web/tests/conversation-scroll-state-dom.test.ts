import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import {
  createMemoryKeyValueStore,
  createVelaClientStateStore,
} from "../../vela-chat-host-state/src";
import type { ChatSurface } from "../../vela-chat-surface/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("conversation persists the current detached scroll offset when switching session tabs", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelFor = (sessionId: string) =>
      toWebChatModel(
        buildChatRenderModel(buildLongConversationSurface(sessionId), {
          kind: "desktop_web",
        }),
      );

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_a"),
        }),
      );
    });
    await act(async () => {
      dom.flushAnimationFrame(16);
      dom.flushAnimationFrame(32);
    });

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    assert.ok(
      (scrollElement?.scrollHeight ?? 0) > (scrollElement?.clientHeight ?? 0),
      "test fixture must represent a scrollable long conversation",
    );

    scrollElement!.scrollTop = 420;

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_b"),
        }),
      );
    });

    assert.deepEqual(
      clientStateStore.conversationScroll.read("sess_a"),
      {
        followOutput: false,
        routeKey: "sess_a",
        scrollTop: 420,
      },
      "switching away from a middle-scrolled tab must persist the latest DOM offset before the route key changes",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation restores a middle scroll offset after switching away and back", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-roundtrip-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelFor = (sessionId: string) =>
      toWebChatModel(
        buildChatRenderModel(buildLongConversationSurface(sessionId), {
          kind: "desktop_web",
        }),
      );

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_a"),
        }),
      );
    });
    await flushFrames(act, dom, [16, 32]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    scrollElement!.scrollTop = 420;

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_b"),
        }),
      );
    });
    scrollElement!.scrollTop = 0;

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_a"),
        }),
      );
    });
    await flushFrames(act, dom, [48, 64, 80]);

    assert.equal(
      scrollElement!.scrollTop,
      420,
      "returning to a middle-scrolled conversation must restore the previous offset instead of leaving the route at the top",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation records middle scroll events as detached even without wheel intent", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-geometry-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: toWebChatModel(
            buildChatRenderModel(buildLongConversationSurface("sess_a"), {
              kind: "desktop_web",
            }),
          ),
        }),
      );
    });
    await flushFrames(act, dom, [16, 32]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");

    scrollElement!.scrollTop = 420;
    const scrollEvent = document.createEvent("Event");
    scrollEvent.initEvent("scroll", true, false);
    scrollElement!.dispatchEvent(scrollEvent);
    await flushFrames(act, dom, [48, 64]);

    assert.deepEqual(clientStateStore.conversationScroll.read("sess_a"), {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

async function flushFrames(
  act: typeof import("react").act,
  dom: ReturnType<typeof installDomRuntime>,
  frames: number[],
) {
  await act(async () => {
    for (const frame of frames) {
      dom.flushAnimationFrame(frame);
    }
  });
}

function buildLongConversationSurface(sessionId: string): ChatSurface {
  const items: ChatSurface["conversation"]["items"] = [];
  for (let index = 0; index < 140; index += 1) {
    const id = `${sessionId}:assistant_${index}`;
    const at = new Date(Date.UTC(2026, 5, 23, 0, 0, index)).toISOString();
    items.push({
      created_at: at,
      debug: {
        projection: "conversation",
        source_event_ids: [`evt_${id}`],
        source_event_ranges: [],
      },
      id,
      kind: "assistant_message",
      parts: [
        {
          id: `${id}:part:0`,
          text: `第 ${index} 条长会话消息，用来测试切换 tab 时的滚动位置记忆。`,
          type: "text",
        },
      ],
      revision: 1,
      status: "completed",
      text: `第 ${index} 条长会话消息，用来测试切换 tab 时的滚动位置记忆。`,
      turn_id: `${sessionId}:turn_${index}`,
      updated_at: at,
    });
  }

  return {
    conversation: {
      items,
      window: {
        first_item_id: `${sessionId}:assistant_0`,
        has_newer: false,
        has_older: false,
        last_item_id: `${sessionId}:assistant_139`,
      },
    },
    cursors: {},
    pending_requests: { items: [] },
    session_id: sessionId,
    stream: { connected: false, running: false },
  };
}

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:5173/" });
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    window: globalThis.window,
  };
  let nextFrameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    nextFrameId += 1;
    frames.set(nextFrameId, callback);
    return nextFrameId;
  };
  const cancelAnimationFrame = (handle: number) => {
    frames.delete(handle);
  };

  class TestResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: target.getBoundingClientRect(),
          } as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }

    disconnect() {}
    unobserve() {}
  }

  Object.defineProperty(window.HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return String(this.className ?? "").includes("conversation") ? 900 : 760;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return String(this.className ?? "").includes("conversation") ? 600 : 80;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      const className = String(this.className ?? "");
      if (className.includes("conversation") || className.includes("turnList")) {
        return 2600;
      }
      if (className.includes("virtualizedHistoryItem")) return 80;
      return 120;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const className = String(this.className ?? "");
    const width = className.includes("conversation") ? 900 : 760;
    const height = className.includes("conversation")
      ? 600
      : className.includes("virtualizedHistoryItem")
        ? 80
        : 120;
    return {
      bottom: height,
      height,
      left: 0,
      right: width,
      toJSON() {
        return {};
      },
      top: 0,
      width,
      x: 0,
      y: 0,
    } as DOMRect;
  };

  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: window.Node });
  Object.defineProperty(globalThis, "Element", {
    configurable: true,
    value: window.Element,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: requestAnimationFrame,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: cancelAnimationFrame,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  return {
    flushAnimationFrame(now: number) {
      const callbacks = Array.from(frames.values());
      frames.clear();
      for (const callback of callbacks) callback(now);
    },
    restore() {
      restoreGlobal("window", previous.window);
      restoreGlobal("document", previous.document);
      restoreGlobal("navigator", previous.navigator);
      restoreGlobal("Node", previous.Node);
      restoreGlobal("Element", previous.Element);
      restoreGlobal("HTMLElement", previous.HTMLElement);
      restoreGlobal("ResizeObserver", previous.ResizeObserver);
      restoreGlobal("requestAnimationFrame", previous.requestAnimationFrame);
      restoreGlobal("cancelAnimationFrame", previous.cancelAnimationFrame);
      restoreGlobal("IS_REACT_ACT_ENVIRONMENT", previous.IS_REACT_ACT_ENVIRONMENT);
    },
  };
}

function restoreGlobal(key: keyof typeof globalThis, value: unknown) {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, key);
    return;
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
  });
}
