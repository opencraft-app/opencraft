import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import type { ChatSurface } from "../../vela-chat-surface/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("streaming markdown renderer does not show the full target on first client mount", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StreamingMarkdownRenderer } = await import(
      "../src/renderers/markdown/StreamingMarkdownRenderer"
    );
    const text = "这是一段首次进入视图的流式文本，不能在首帧像 chunk 一样全量出现。";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streaming: true },
          text,
        ),
      );
    });

    const initialText = container.textContent ?? "";
    assert.ok(
      initialText.length < text.length,
      `expected partial initial text, got full text: ${initialText}`,
    );
    assert.ok(text.startsWith(initialText));

    await flushFramesUntil(dom, () => (container.textContent ?? "").length > 0, {
      endMs: 800,
      stepMs: 16,
    });

    const afterFrames = container.textContent ?? "";
    assert.ok(text.startsWith(afterFrames));
    assert.ok(
      afterFrames.length <= 4,
      `expected at most 4 grapheme-ish units after first release frame, got ${afterFrames}`,
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("streaming markdown renderer keeps visible text when the same stream target diverges", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StreamingMarkdownRenderer } = await import(
      "../src/renderers/markdown/StreamingMarkdownRenderer"
    );
    const initialText = "旧回答正在流式输出。";
    const replacementText = "新的回答从另一个开头开始，不属于同一个 stream identity。";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streamKey: "assistant-a", streaming: true },
          initialText,
        ),
      );
    });

    await flushFramesUntil(dom, () => (container.textContent ?? "").length > 0, {
      endMs: 800,
      stepMs: 16,
    });

    const oldVisibleText = container.textContent ?? "";
    assert.ok(oldVisibleText.length > 0);

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streamKey: "assistant-a", streaming: true },
          replacementText,
        ),
      );
    });

    const textAfterReplacement = container.textContent ?? "";
    assert.equal(textAfterReplacement, oldVisibleText);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("streaming markdown renderer resets buffered text only when the stream identity changes", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StreamingMarkdownRenderer } = await import(
      "../src/renderers/markdown/StreamingMarkdownRenderer"
    );
    const initialText = "旧回答正在流式输出，已经有一部分出现在屏幕上。";
    const replacementText = "新的回答从另一个开头开始，必须作为新的流重新释放。";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streamKey: "assistant-a", streaming: true },
          initialText,
        ),
      );
    });

    await flushFramesUntil(dom, () => (container.textContent ?? "").length > 0, {
      endMs: 800,
      stepMs: 16,
    });

    const oldVisibleText = container.textContent ?? "";
    assert.ok(
      oldVisibleText.length > 0,
      "expected the first stream to reveal text before replacing it",
    );

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streamKey: "assistant-b", streaming: true },
          replacementText,
        ),
      );
    });

    const textAfterIdentityReset = container.textContent ?? "";
    assert.notEqual(
      textAfterIdentityReset,
      oldVisibleText,
      "a new stream identity must not keep showing text from the previous stream",
    );
    assert.equal(
      textAfterIdentityReset.length === 0 ||
        replacementText.startsWith(textAfterIdentityReset),
      true,
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("streaming markdown renderer exposes a 500 character stream at a stable DOM output rate", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { StreamingMarkdownRenderer } = await import(
      "../src/renderers/markdown/StreamingMarkdownRenderer"
    );
    const finalText = "流".repeat(500);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const perSecondDeltas: number[] = [];
    let previousVisibleCount = 0;
    let currentTarget = "";

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streaming: true },
          currentTarget,
        ),
      );
    });

    for (let nowMs = 0; nowMs <= 10_000; nowMs += 20) {
      const targetLength = Math.min(500, Math.floor((nowMs / 1000) * 50));
      const nextTarget = finalText.slice(0, targetLength);

      if (nextTarget !== currentTarget) {
        await act(async () => {
          currentTarget = nextTarget;
          root.render(
            React.createElement(
              StreamingMarkdownRenderer,
              { streaming: true },
              currentTarget,
            ),
          );
        });
      }

      await act(async () => {
        dom.flushAnimationFrame(nowMs);
      });

      if (nowMs > 0 && nowMs % 1000 === 0) {
        const visibleCount = container.textContent?.length ?? 0;
        const delta = visibleCount - previousVisibleCount;
        perSecondDeltas.push(delta);
        previousVisibleCount = visibleCount;
        assert.ok(
          targetLength - visibleCount <= 10,
          `expected DOM output to track input at ${nowMs}ms, got backlog ${targetLength - visibleCount}`,
        );
      }
    }

    assert.equal(perSecondDeltas.length, 10);
    for (const [index, delta] of perSecondDeltas.entries()) {
      assert.ok(
        delta >= 40 && delta <= 60,
        `expected second ${index + 1} to reveal around 50 characters, got ${delta}`,
      );
    }

    await act(async () => {
      root.render(
        React.createElement(
          StreamingMarkdownRenderer,
          { streaming: false },
          finalText,
        ),
      );
    });

    await act(async () => {
      dom.flushAnimationFrame(10_020);
      dom.flushAnimationFrame(10_220);
    });

    assert.equal(container.textContent, finalText);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation client does not eagerly replace buffered assistant text on fresh snapshots", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        await createConversationElement(
          surfaceWithAssistantText([
            "第一段已经稳定。",
            "",
            "第二段正在流式输出。",
          ].join("\n")),
        ),
      );
      dom.flushAnimationFrame(16);
      dom.flushAnimationFrame(32);
    });

    await act(async () => {
      root.render(
        await createConversationElement(
          surfaceWithAssistantText([
            "第一段已经稳定。",
            "",
            "第二段已经变成稳定前缀。",
            "",
            "第三段才是新的 live tail。",
          ].join("\n")),
        ),
      );
    });

    const textAfterSnapshot = container.textContent ?? "";
    assert.doesNotMatch(
      textAfterSnapshot,
      /第二段已经变成稳定前缀。/,
      "fresh read-model snapshots must not bypass the live assistant buffer in the same client frame",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation client does not reduce visible assistant text when markdown splits into blocks", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        await createConversationElement(
          surfaceWithAssistantText(
            "第一段正在流式输出，还没有段落边界，第二段内容已经露出一些。",
          ),
        ),
      );
    });

    await flushFramesUntil(dom, () => assistantVisibleText(container).length > 12, {
      endMs: 800,
      stepMs: 16,
    });

    const visibleBeforeSplit = assistantVisibleText(container);
    assert.ok(
      visibleBeforeSplit.length > 12,
      "expected enough visible text before the markdown split to measure regression",
    );

    await act(async () => {
      root.render(
        await createConversationElement(
          surfaceWithAssistantText([
            "第一段正在流式输出。",
            "",
            "第二段内容已经露出一些，并继续增长。",
          ].join("\n")),
        ),
      );
    });

    const visibleAfterSplit = assistantVisibleText(container);
    assert.ok(
      visibleAfterSplit.length >= visibleBeforeSplit.length,
      `assistant visible text regressed after block split: ${visibleBeforeSplit.length} -> ${visibleAfterSplit.length}`,
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation client releases assistant markdown through one stream clock", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        await createConversationElement(
          surfaceWithAssistantText([
            "第一段正在流式输出，先不要让后续段落并行出现。这里故意写得很长很长，让共享时钟在多帧之后仍然停留在第一段内部。",
            "",
            "第二段如果拥有自己的 clock，就会过早露出来。",
            "",
            "最后一段也不应该在首轮帧里一起出现。",
          ].join("\n")),
        ),
      );
      for (let now = 16; now <= 160; now += 16) {
        dom.flushAnimationFrame(now);
      }
    });

    const textAfterFirstFrames = container.textContent ?? "";
    assert.doesNotMatch(
      textAfterFirstFrames,
      /第二段/,
      "later markdown text must wait for the assistant stream clock to reach it",
    );
    assert.doesNotMatch(
      textAfterFirstFrames,
      /最后一段/,
      "the tail must not run an independent streaming clock",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

function assistantVisibleText(container: Element): string {
  return Array.from(container.querySelectorAll("[data-streaming-markdown]"))
    .map((node) => node.textContent ?? "")
    .join("");
}

async function flushFramesUntil(
  dom: ReturnType<typeof installDomRuntime>,
  predicate: () => boolean,
  options: { endMs: number; stepMs: number },
) {
  const { act } = await import("react");
  for (let now = options.stepMs; now <= options.endMs; now += options.stepMs) {
    await act(async () => {
      dom.flushAnimationFrame(now);
    });
    if (predicate()) return;
  }
}

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:3000/chat" });
  const previous = {
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    matchMedia: globalThis.window?.matchMedia,
    navigator: globalThis.navigator,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
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

  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;
  window.matchMedia = () =>
    ({
      addEventListener() {},
      matches: false,
      removeEventListener() {},
    }) as unknown as MediaQueryList;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: window,
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: window.navigator,
  });
  Object.defineProperty(globalThis, "Node", {
    configurable: true,
    value: window.Node,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
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
      restoreGlobal("HTMLElement", previous.HTMLElement);
      restoreGlobal("requestAnimationFrame", previous.requestAnimationFrame);
      restoreGlobal("cancelAnimationFrame", previous.cancelAnimationFrame);
      restoreGlobal(
        "IS_REACT_ACT_ENVIRONMENT",
        previous.IS_REACT_ACT_ENVIRONMENT,
      );
    },
  };
}

async function createConversationElement(surface: ChatSurface) {
  const React = await import("react");
  const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
  const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
  const {
    buildConversationRuntimeSegments,
    buildConversationStreamItems,
  } = await import("../src/conversation-runtime/model");
  const { VelaTurnList } = await import("../src/components/conversation/VelaTurnList");
  const webModel = toWebChatModel(
    buildChatRenderModel(surface, { kind: "desktop_web" }),
  );
  const items = buildConversationStreamItems(webModel.turns);
  const segments = buildConversationRuntimeSegments(items, {
    partialVirtualizationEnabled: false,
  });
  return React.createElement(VelaTurnList, {
    hostKind: "desktop_web",
    segments,
  });
}

function surfaceWithAssistantText(text: string): ChatSurface {
  return {
    session_id: "sess_streaming_client",
    conversation: {
      items: [
        {
          id: "user_1",
          kind: "user_message",
          text: "继续",
          parts: [{ id: "user_1:part:0", type: "text", text: "继续" }],
          created_at: "2026-06-22T00:00:00Z",
          updated_at: "2026-06-22T00:00:00Z",
          turn_id: "turn_1",
          status: "completed",
          revision: 1,
          debug: debug("evt_user_1"),
        },
        {
          id: "turn_meta_1",
          kind: "turn_meta",
          turn_id: "turn_1",
          created_at: "2026-06-22T00:00:00Z",
          updated_at: "2026-06-22T00:00:01Z",
          completed_at: null,
          status: "running",
          revision: 1,
          debug: debug("evt_turn_1"),
        },
        {
          id: "assistant_1",
          kind: "assistant_message",
          text,
          parts: [{ id: "assistant_1:part:0", type: "text", text }],
          created_at: "2026-06-22T00:00:01Z",
          updated_at: "2026-06-22T00:00:01Z",
          turn_id: "turn_1",
          status: "streaming",
          revision: 1,
          debug: debug("evt_assistant_1"),
        },
      ],
      window: {
        first_item_id: "user_1",
        last_item_id: "assistant_1",
        has_older: false,
        has_newer: false,
      },
    },
    pending_requests: { items: [] },
    cursors: {},
    stream: { connected: true, running: true },
  };
}

function debug(eventId: string) {
  return {
    projection: "conversation" as const,
    source_event_ids: [eventId],
    source_event_ranges: [],
  };
}

function restoreGlobal(key: string, value: unknown) {
  if (value === undefined) {
    delete (globalThis as Record<string, unknown>)[key];
    return;
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
  });
}
