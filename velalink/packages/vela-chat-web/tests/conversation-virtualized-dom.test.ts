import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import type { ChatSurface } from "../../vela-chat-surface/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("web partial virtualized first client mount renders rows for a non-empty virtual band", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const webModel = toWebChatModel(
      buildChatRenderModel(buildLargeConversationSurface(), { kind: "desktop_web" }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(VelaConversation, { webModel }));
    });
    await act(async () => {
      dom.flushAnimationFrame(16);
    });

    const band = container.querySelector(".virtualizedHistoryBand");
    assert.notEqual(band, null, "expected a virtualized history band for long conversations");
    assert.ok(
      Number((band as HTMLElement).dataset.virtualizedHistoryCount) > 0,
      "expected strategy instrumentation to report virtualized history rows",
    );
    assert.ok(
      Number((band as HTMLElement).dataset.virtualizedTotalSize) > 0,
      "expected strategy instrumentation to report a non-zero virtualized total size",
    );
    assert.ok(
      Number((band as HTMLElement).dataset.virtualizedRenderedCount) > 0,
      "expected strategy instrumentation to report rendered virtual rows",
    );
    assert.ok(
      Number.parseFloat((band as HTMLElement).style.height) > 0,
      "expected the virtualized history band to reserve height",
    );
    assert.ok(
      container.querySelectorAll(".virtualizedHistoryItem").length > 0,
      "a non-empty virtualized history band must not mount with zero rendered virtual rows",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("web partial virtualized strategy does not create an empty positive-height band without a scroll element", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const {
      buildConversationRuntimeSegments,
      buildConversationStreamItems,
    } = await import("../src/conversation-runtime/model");
    const { VelaTurnList } = await import("../src/components/conversation/VelaTurnList");

    const webModel = toWebChatModel(
      buildChatRenderModel(buildLargeConversationSurface(), { kind: "desktop_web" }),
    );
    const items = buildConversationStreamItems(webModel.turns);
    const segments = buildConversationRuntimeSegments(items, {
      partialVirtualizationEnabled: true,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(VelaTurnList, {
          hostKind: "desktop_web",
          segments,
        }),
      );
    });
    await act(async () => {
      dom.flushAnimationFrame(16);
    });

    const band = container.querySelector(".virtualizedHistoryBand") as HTMLElement | null;
    assert.notEqual(band, null, "expected a virtualized history band for the direct strategy render");
    const totalSize = Number(band?.dataset.virtualizedTotalSize ?? 0);
    const renderedCount = Number(band?.dataset.virtualizedRenderedCount ?? 0);

    assert.ok(
      totalSize <= 0 || renderedCount > 0,
      "partial virtualization must not expose a positive-height empty band while waiting for the scroll element",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function buildLargeConversationSurface(): ChatSurface {
  const items: ChatSurface["conversation"]["items"] = [];
  for (let index = 0; index < 130; index += 1) {
    const id = `assistant_${index}`;
    const at = new Date(Date.UTC(2026, 5, 22, 0, 0, index)).toISOString();
    items.push({
      id,
      kind: "assistant_message",
      text: `第 ${index} 条历史消息，用来撑开 partial virtualized history。`,
      parts: [
        {
          id: `${id}:part:0`,
          type: "text",
          text: `第 ${index} 条历史消息，用来撑开 partial virtualized history。`,
        },
      ],
      created_at: at,
      updated_at: at,
      turn_id: `turn_${index}`,
      status: "completed",
      revision: 1,
      debug: debug(`evt_${id}`),
    });
  }

  return {
    session_id: "sess_virtualized_dom",
    conversation: {
      items,
      window: {
        first_item_id: "assistant_0",
        last_item_id: "assistant_129",
        has_older: false,
        has_newer: false,
      },
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: false, running: false },
  };
}

function debug(eventId: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [eventId],
    source_event_ranges: [],
  };
}

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:3000/chat" });
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
      return this.className === "conversation" ? 900 : 760;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this.className === "conversation" ? 600 : 48;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const className = String(this.className ?? "");
    const width = className === "conversation" ? 900 : 760;
    const height = className === "conversation" ? 600 : className === "virtualizedHistoryItem" ? 48 : 120;
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
  Object.defineProperty(globalThis, "document", { configurable: true, value: window.document });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
  Object.defineProperty(globalThis, "Node", { configurable: true, value: window.Node });
  Object.defineProperty(globalThis, "Element", { configurable: true, value: window.Element });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: window.HTMLElement });
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
