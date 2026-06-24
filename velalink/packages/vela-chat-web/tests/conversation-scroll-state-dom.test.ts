import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import test from "node:test";

import { Window } from "happy-dom";
import {
  createMemoryKeyValueStore,
  createVelaClientStateStore,
} from "../../vela-chat-host-state/src";
import type { ChatSurface } from "../../vela-chat-surface/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

const root = process.cwd();
const desktopCss = readFileSync(
  join(root, "packages/vela-chat-web/src/styles/desktop.module.css"),
  "utf8",
);

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

test("conversation route leave prefers the current DOM offset over an older follow-output snapshot", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-stale-follow-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: true,
      routeKey: "sess_a",
      scrollTop: 1800,
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
    scrollElement!.scrollTop = 620;

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
        scrollTop: 620,
      },
      "a stale bottom-follow snapshot must not survive a route leave after the user moved the scroll container",
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

test("conversation confirms route restore after post-layout scroll correction before persisting", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-post-layout-confirmation-red-test",
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
    for (const frame of [48, 64, 80]) {
      await flushFrames(act, dom, [frame]);
      if (scrollElement!.scrollTop === 420) break;
    }
    assert.equal(
      scrollElement!.scrollTop,
      420,
      "route resume should restore the saved offset after switching back to the session",
    );

    await act(async () => {
      scrollElement!.scrollTop = 83;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });

    await flushFrames(act, dom, [96, 112, 128]);

    assert.equal(
      scrollElement!.scrollTop,
      420,
      "a post-layout scroll correction must not be accepted until the saved route offset is confirmed",
    );
    assert.deepEqual(
      clientStateStore.conversationScroll.read("sess_a"),
      {
        followOutput: false,
        routeKey: "sess_a",
        scrollTop: 420,
      },
      "post-layout correction must not overwrite the saved route offset before restore confirmation",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation lets an explicit user scroll cancel a pending route restore", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-user-cancel-route-restore-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 780,
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
    await flushFrames(act, dom, [16]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    assert.equal(
      scrollElement!.scrollTop,
      780,
      "test fixture should begin while the saved route restore is pending confirmation",
    );

    await act(async () => {
      scrollElement!.dispatchEvent(
        new window.WheelEvent("wheel", { bubbles: true, deltaY: -120 }),
      );
      scrollElement!.scrollTop = 120;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });
    await flushFrames(act, dom, [32, 48, 64, 80, 96, 112]);

    assert.equal(
      scrollElement!.scrollTop,
      120,
      "explicit user scroll during pending route restore must not be snapped back to the stale saved offset",
    );
    assertScrollStateMatches(
      clientStateStore.conversationScroll.read("sess_a"),
      { followOutput: false, routeKey: "sess_a", scrollTop: 120 },
      "explicit user scroll during pending route restore must replace the stale saved route offset",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation restores a just-scrolled offset when switching tabs before the pending writer frame", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-immediate-tab-switch-test",
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

    await act(async () => {
      scrollElement!.scrollTop = 600;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_b"),
        }),
      );
    });

    assertScrollStateMatches(
      clientStateStore.conversationScroll.read("sess_a"),
      { followOutput: false, routeKey: "sess_a", scrollTop: 600 },
      "route cleanup must flush the latest just-scrolled offset before the scheduled writer frame runs",
    );

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
      600,
      "returning to the tab must restore the just-scrolled offset captured during the immediate switch",
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

    await act(async () => {
      scrollElement!.scrollTop = 420;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });
    await flushFrames(act, dom, [48, 64, 80, 96, 112, 128]);

    assertScrollStateMatches(clientStateStore.conversationScroll.read("sess_a"), {
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

test("conversation restores saved offset when route content becomes tall enough after mount", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-late-content-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelFor = (count: number) =>
      toWebChatModel(
        buildChatRenderModel(buildConversationSurface("sess_a", count), {
          kind: "desktop_web",
        }),
      );

    dom.setConversationScrollHeight(600);
    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor(2),
        }),
      );
    });
    await flushFrames(act, dom, [16, 32]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    scrollElement!.scrollTop = 0;
    assert.deepEqual(clientStateStore.conversationScroll.read("sess_a"), {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });

    dom.setConversationScrollHeight(2600);
    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor(140),
        }),
      );
    });
    await flushFrames(act, dom, [48, 64, 80, 96, 112, 128]);
    assert.equal(
      scrollElement!.scrollTop,
      420,
      "a pending route resume must retry when the same session receives enough content to contain the saved offset",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation restores a saved detached offset on a fresh tall mount", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-fresh-tall-mount-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    dom.setConversationScrollHeight(2600);
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
    await flushFrames(act, dom, [16, 32, 48, 64, 80, 96, 112, 128]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected conversation to mount");
    assert.equal(
      scrollElement!.scrollTop,
      420,
      "a saved detached offset must be restored on a fresh mount when the route content is already tall enough",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation history readiness does not restart the route lifecycle", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const baseClientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-history-ready-route-lifecycle-red-test",
    });
    baseClientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });
    const readScopes: string[] = [];
    const clientStateStore = {
      ...baseClientStateStore,
      conversationScroll: {
        ...baseClientStateStore.conversationScroll,
        read(scope: string) {
          readScopes.push(scope);
          return baseClientStateStore.conversationScroll.read(scope);
        },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const webModel = toWebChatModel(
      buildChatRenderModel(buildLongConversationSurface("sess_a"), {
        kind: "desktop_web",
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          isHistoryReady: false,
          webModel,
        }),
      );
    });
    await flushFrames(act, dom, [16, 32]);
    const readsAfterRouteMount = readScopes.length;

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          isHistoryReady: true,
          webModel,
        }),
      );
    });
    await flushFrames(act, dom, [48, 64, 80]);

    assert.equal(
      readScopes.length,
      readsAfterRouteMount,
      "history readiness changing for the same session must not rerun route initialization or reread route resume state",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench preserves a session scroll offset across history hydration unmounts", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "workbench-hydration-scroll-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelFor = (sessionId: string) =>
      buildChatRenderModel(buildLongConversationSurface(sessionId), {
        kind: "desktop_web",
      });
    const renderWorkbench = async (
      sessionId: string,
      historyPhase: "hydrating_history" | "ready",
    ) => {
      await act(async () => {
        root.render(
          React.createElement(ChatWorkbenchView, {
            clientStateStore,
            draft: "",
            historyPhase,
            model: modelFor(sessionId),
            onDraftChange: () => {},
            onSubmit: () => {},
          }),
        );
      });
    };

    await renderWorkbench("sess_a", "ready");
    await flushFrames(act, dom, [16, 32]);
    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    scrollElement!.scrollTop = 420;

    await renderWorkbench("sess_b", "hydrating_history");

    assert.deepEqual(
      clientStateStore.conversationScroll.read("sess_a"),
      {
        followOutput: false,
        routeKey: "sess_a",
        scrollTop: 420,
      },
      "entering another session's full-history hydration screen must persist the previous session scroll before the conversation unmounts",
    );

    await renderWorkbench("sess_b", "ready");
    await flushFrames(act, dom, [48, 64]);
    await renderWorkbench("sess_a", "hydrating_history");
    await renderWorkbench("sess_a", "ready");
    await flushFrames(act, dom, [80, 96, 112, 128, 144, 160, 176, 192]);

    const restoredScrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(restoredScrollElement, null, "expected conversation to remount");
    assert.equal(
      restoredScrollElement!.scrollTop,
      420,
      "returning after the session's own hydration screen must restore the remembered historical offset",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench keeps stable chrome mounted while full history is hydrating", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          draft: "",
          historyPhase: "hydrating_history",
          model: buildChatRenderModel(buildLongConversationSurface("sess_a"), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });

    assert.notEqual(
      container.querySelector(".conversationShell"),
      null,
      "full-history hydration must keep the conversation chrome mounted",
    );
    assert.notEqual(
      container.querySelector(".composerDock"),
      null,
      "full-history hydration must keep the composer chrome mounted",
    );
    assert.notEqual(
      container.querySelector('[aria-label="Loading conversation history"]'),
      null,
      "full-history hydration should be represented as an overlay state",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench mounts conversation for measurement but hides it during full-history hydration", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          draft: "",
          historyPhase: "hydrating_history",
          model: buildChatRenderModel(buildLongConversationSurface("sess_a"), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });

    const revealGate = container.querySelector("[data-conversation-reveal-state]");
    assert.notEqual(revealGate, null, "workbench should expose an explicit conversation reveal state");
    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "measuring",
      "full-history hydration should mount candidate conversation only for measurement",
    );
    assert.equal(
      revealGate?.getAttribute("aria-hidden"),
      "true",
      "candidate conversation should not be exposed while it is only measuring",
    );
    assert.notEqual(
      revealGate?.querySelector(".conversationShell"),
      null,
      "measuring state must still mount the real conversation so scroll and layout can settle",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation reveal gate preserves the scroll container height chain", () => {
  assert.match(
    desktopCss,
    /\.conversationReveal\s*\{[^}]*height:\s*100%;/s,
    "the reveal gate wraps the scroll container, so it must fill the workbench grid row",
  );
  assert.match(
    desktopCss,
    /\.conversationShell\s*\{[^}]*height:\s*100%;/s,
    "the conversation shell must preserve the 100% height chain down to the scroll element",
  );
});

test("workbench reveals ready conversation only after route scroll resume has settled", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "workbench-reveal-after-scroll-settled-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 420,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          clientStateStore,
          draft: "",
          historyPhase: "ready",
          model: buildChatRenderModel(buildLongConversationSurface("sess_a"), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });

    const revealGate = container.querySelector("[data-conversation-reveal-state]");
    assert.notEqual(revealGate, null, "workbench should expose an explicit conversation reveal state");
    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "measuring",
      "a ready read model with pending route restore should remain hidden until scroll settles",
    );

    await flushFrames(act, dom, [16, 32, 48, 64, 80, 96]);

    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "revealed",
      "conversation should reveal after route resume verification settles",
    );
    assert.equal(
      revealGate?.hasAttribute("aria-hidden"),
      false,
      "revealed conversation should be visible to assistive technology",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench reveals the first selected web session without requiring a tab switch", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          draft: "",
          historyPhase: "unselected",
          model: buildChatRenderModel(buildConversationSurface("", 0), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          draft: "",
          historyPhase: "ready",
          model: buildChatRenderModel(buildLongConversationSurface("sess_a"), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });
    await flushFrames(act, dom, [16, 32, 48]);

    const revealGate = container.querySelector("[data-conversation-reveal-state]");
    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "revealed",
      "the first selected session must not stay hidden waiting for a manual session switch",
    );
    assert.equal(
      revealGate?.hasAttribute("aria-hidden"),
      false,
      "the first selected session should be visible to assistive technology after it settles",
    );
    assert.notEqual(
      findTurnGroupByText(container, "第 0 条长会话消息"),
      null,
      "the first selected session should render real conversation rows without a tab switch",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench clamps stale local scroll state instead of hiding the first web session", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "first-web-session-stale-scroll-state-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 999_999,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(ChatWorkbenchView, {
          clientStateStore,
          draft: "",
          historyPhase: "ready",
          model: buildChatRenderModel(buildLongConversationSurface("sess_a"), {
            kind: "desktop_web",
          }),
          onDraftChange: () => {},
          onSubmit: () => {},
        }),
      );
    });
    await flushFrames(act, dom, [16, 32, 48, 64]);

    const revealGate = container.querySelector("[data-conversation-reveal-state]");
    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "revealed",
      "a stale impossible local scroll offset must not keep a ready web session hidden",
    );
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    assert.equal(
      scrollElement!.scrollTop,
      scrollElement!.scrollHeight - scrollElement!.clientHeight,
      "stale saved offsets should clamp to the maximum real scroll position",
    );
    assert.notEqual(
      findTurnGroupByText(container, "第 0 条长会话消息"),
      null,
      "the ready conversation should still render rows after clamping stale local state",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench reveals after full-preload hydration clamps stale local scroll state", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "first-web-session-full-preload-stale-scroll-red-test",
    });
    clientStateStore.conversationScroll.write("sess_a", {
      followOutput: false,
      routeKey: "sess_a",
      scrollTop: 999_999,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const model = buildChatRenderModel(buildLongConversationSurface("sess_a"), {
      kind: "desktop_web",
    });
    const render = async (
      historyPhase: "hydrating_history" | "ready",
    ) => {
      await act(async () => {
        root.render(
          React.createElement(ChatWorkbenchView, {
            clientStateStore,
            draft: "",
            historyPhase,
            model,
            onDraftChange: () => {},
            onSubmit: () => {},
          }),
        );
      });
    };

    await render("hydrating_history");
    await flushFrames(act, dom, [16, 32]);
    await render("ready");
    await flushFrames(act, dom, [48, 64, 80, 96, 112, 128]);

    const revealGate = container.querySelector("[data-conversation-reveal-state]");
    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.equal(
      revealGate?.getAttribute("data-conversation-reveal-state"),
      "revealed",
      "full-preload hydration must not leave a ready web session hidden after clamping stale local scroll state",
    );
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    assert.equal(
      scrollElement!.scrollTop,
      scrollElement!.scrollHeight - scrollElement!.clientHeight,
      "the stale full-preload scroll offset should clamp to the maximum real scroll position",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("workbench keeps hydrated history and scroll offset stable after repeated session switches", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "workbench-repeated-hydration-scroll-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelFor = (sessionId: string) =>
      buildChatRenderModel(buildLongConversationSurface(sessionId), {
        kind: "desktop_web",
      });
    const renderWorkbench = async (
      sessionId: string,
      historyPhase: "hydrating_history" | "ready",
    ) => {
      await act(async () => {
        root.render(
          React.createElement(ChatWorkbenchView, {
            clientStateStore,
            draft: "",
            historyPhase,
            model: modelFor(sessionId),
            onDraftChange: () => {},
            onSubmit: () => {},
          }),
        );
      });
    };

    await renderWorkbench("sess_a", "ready");
    await flushFrames(act, dom, [16, 32]);
    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the conversation scroll element to mount");
    scrollElement!.scrollTop = 780;

    for (let index = 0; index < 4; index += 1) {
      await renderWorkbench("sess_b", "hydrating_history");
      await renderWorkbench("sess_b", "ready");
      await flushFrames(act, dom, [48 + index * 96, 64 + index * 96]);
      await renderWorkbench("sess_a", "hydrating_history");
      await renderWorkbench("sess_a", "ready");
      await flushFrames(act, dom, [80 + index * 96, 96 + index * 96, 112 + index * 96, 128 + index * 96]);

      const restoredScrollElement = container.querySelector(".conversation") as HTMLElement | null;
      assert.notEqual(restoredScrollElement, null, "expected conversation to remount");
      assert.equal(
        restoredScrollElement!.scrollTop,
        780,
        `session scroll offset drifted after switch ${index + 1}`,
      );
      assert.deepEqual(
        clientStateStore.conversationScroll.read("sess_a"),
        {
          followOutput: false,
          routeKey: "sess_a",
          scrollTop: 780,
        },
        `persisted session scroll state drifted after switch ${index + 1}`,
      );
    }

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("conversation restores the same visible stream item when content above it changes height", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { buildChatRenderModel } = await import("../../vela-chat-render-model/src");
    const { toWebChatModel } = await import("../src/adapters/toWebBlocks");
    const { VelaConversation } = await import("../src/components/conversation/VelaConversation");

    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "scroll-state-anchor-drift-red-test",
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

    await act(async () => {
      scrollElement!.scrollTop = 720;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });
    const anchorBefore = findTurnGroupByText(container, "第 6 条长会话消息");
    assert.notEqual(anchorBefore, null, "expected test fixture item to exist");
    assert.equal(
      anchorBefore!.getBoundingClientRect().top,
      0,
      "test fixture should start with the chosen item pinned at the viewport top",
    );

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_b"),
        }),
      );
    });

    dom.setTurnGroupLayoutShift({ fromIndex: 6, offsetPx: 120 });

    await act(async () => {
      root.render(
        React.createElement(VelaConversation, {
          clientStateStore,
          webModel: modelFor("sess_a"),
        }),
      );
    });
    await flushFrames(act, dom, [48, 64, 80, 96, 112, 128]);

    const anchorAfter = findTurnGroupByText(container, "第 6 条长会话消息");
    assert.notEqual(anchorAfter, null, "expected chosen item after route restore");
    assert.equal(
      anchorAfter!.getBoundingClientRect().top,
      0,
      "returning to a session should preserve the visible item anchor, not only the old pixel offset",
    );
    assert.equal(
      scrollElement!.scrollTop,
      840,
      "the restored pixel offset should compensate for new content height above the saved anchor",
    );

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

function findTurnGroupByText(container: Element, text: string): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll(".turnGroup")).find((element) =>
      element.textContent?.includes(text),
    ) as HTMLElement | undefined
  ) ?? null;
}

function assertScrollStateMatches(
  actual: ReturnType<
    ReturnType<typeof createVelaClientStateStore>["conversationScroll"]["read"]
  >,
  expected: {
    followOutput: boolean;
    routeKey: string;
    scrollTop: number;
  },
  message?: string,
) {
  assert.notEqual(actual, null, message);
  assert.equal(actual?.followOutput, expected.followOutput, message);
  assert.equal(actual?.routeKey, expected.routeKey, message);
  assert.equal(actual?.scrollTop, expected.scrollTop, message);
}

function buildLongConversationSurface(sessionId: string): ChatSurface {
  return buildConversationSurface(sessionId, 140);
}

function buildConversationSurface(
  sessionId: string,
  itemCount: number,
): ChatSurface {
  const items: ChatSurface["conversation"]["items"] = [];
  for (let index = 0; index < itemCount; index += 1) {
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
        last_item_id: `${sessionId}:assistant_${Math.max(0, itemCount - 1)}`,
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
  let conversationScrollHeight = 2600;
  let turnGroupLayoutShift: { fromIndex: number; offsetPx: number } = {
    fromIndex: Number.POSITIVE_INFINITY,
    offsetPx: 0,
  };
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
        return conversationScrollHeight;
      }
      if (className.includes("virtualizedHistoryItem")) return 80;
      return 120;
    },
  });
  window.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const className = String(this.className ?? "");
    if (className.includes("turnGroup")) {
      const groups = Array.from(document.querySelectorAll(".turnGroup"));
      const index = groups.indexOf(this as Element);
      const scrollElement = document.querySelector(".conversation") as HTMLElement | null;
      const itemHeight = 120;
      const shift =
        index >= turnGroupLayoutShift.fromIndex ? turnGroupLayoutShift.offsetPx : 0;
      const top = Math.max(0, index) * itemHeight + shift - (scrollElement?.scrollTop ?? 0);
      return {
        bottom: top + itemHeight,
        height: itemHeight,
        left: 0,
        right: 760,
        toJSON() {
          return {};
        },
        top,
        width: 760,
        x: 0,
        y: top,
      } as DOMRect;
    }
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
  window.HTMLElement.prototype.scrollTo = function scrollTo(
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    const top =
      typeof options === "object"
        ? options.top
        : typeof y === "number"
          ? y
          : typeof options === "number"
            ? options
            : this.scrollTop;
    if (!Number.isFinite(top)) return;
    const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
    this.scrollTop = Math.min(maxScrollTop, Math.max(0, top ?? 0));
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
    setConversationScrollHeight(height: number) {
      conversationScrollHeight = height;
    },
    setTurnGroupLayoutShift(shift: { fromIndex: number; offsetPx: number }) {
      turnGroupLayoutShift = shift;
      conversationScrollHeight += Math.max(0, shift.offsetPx);
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
