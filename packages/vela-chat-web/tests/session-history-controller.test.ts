import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { Window } from "happy-dom";
import type {
  BackendKindWire,
  BackendProbeResultWire,
  BackendWireResponse,
  BackendsWireResponse,
  ClientInputPart,
  CommandAckWire,
  ConversationWindowOptions,
  ConversationWireItem,
  ConversationWireView,
  CreateSessionInput,
  CreateSessionWireResponse,
  DiffReviewWireView,
  PendingRequestsOptions,
  PendingRequestsWireView,
  SendSessionInputEventsInput,
  SessionListOptions,
  SessionListViewWireResponse,
  SessionListWireResponse,
  SessionWire,
  SessionWireResponse,
  UpdateAgentConfigWireResponse,
  VelaEventStreamHandlers,
  VelaEventStreamTransport,
  VelaStreamEventWire,
  VeladClient,
} from "../../vela-chat-client/src";
import {
  createMemoryKeyValueStore,
  createVelaClientStateStore,
} from "../../vela-chat-host-state/src";

register(new URL("./css-module-loader.mjs", import.meta.url));

test("full preload does not show history hydration again when switching back to a completed session", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    const snapshots: Array<{ sessionId: string; historyPhase: string }> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      React.useEffect(() => {
        snapshots.push({
          historyPhase: controller.historyPhase,
          sessionId: controller.activeSessionId,
        });
      }, [controller.activeSessionId, controller.historyPhase]);
      return React.createElement("div", {}, controller.historyPhase);
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_a") === 1);
    await renderSession({ React, act, root, Probe, sessionId: "sess_b" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_b") === 1);

    snapshots.length = 0;
    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.tailLoads("sess_a") >= 2);

    assert.equal(
      snapshots.some(
        (snapshot) =>
          snapshot.sessionId === "sess_a" &&
          snapshot.historyPhase === "hydrating_history",
      ),
      false,
      "a completed session must not flash the full-history hydration phase when selected again",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("event stream reconnect delay recovers immediately once and then backs off", async () => {
  const { eventStreamReconnectDelayMs } = await import(
    "../../vela-chat-controller/src/sessionEventStream"
  );

  assert.equal(eventStreamReconnectDelayMs(0), 0);
  assert.equal(eventStreamReconnectDelayMs(1), 250);
  assert.equal(eventStreamReconnectDelayMs(2), 500);
  assert.equal(eventStreamReconnectDelayMs(3), 1000);
  assert.equal(eventStreamReconnectDelayMs(20), 5000);
});

test("controller can stream through host-injected remote transport without EventSource", async () => {
  const dom = installDomRuntime();
  Reflect.deleteProperty(globalThis, "EventSource");
  Reflect.deleteProperty(window, "EventSource");
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    class RemoteVeladClient extends FakeVeladClient {
      override sessionEventStreamUrl(sessionId: string, afterId?: string | null): URL {
        const url = new URL(
          `https://workbench.example.test/velad/sessions/${sessionId}/events/stream`,
        );
        if (afterId) url.searchParams.set("after_id", afterId);
        return url;
      }
    }
    const client = new RemoteVeladClient();
    const transport = new FakeEventStreamTransport();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      useVelaChatSession({
        client,
        eventStreamTransport: transport,
        fetchBackends: false,
        historyPolicy: "tail_only",
        sessionId,
      });
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_remote" });
    await flushHookEffects(act, dom, () => transport.subscribeCount === 1);

    assert.equal(
      transport.urls[0]?.toString(),
      "https://workbench.example.test/velad/sessions/sess_remote/events/stream?after_id=evt_sess_remote%3Atail",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("controller uses injected event stream transport for live session updates", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    client.replaceTailConversation(
      "sess_a",
      conversationView({
        hasOlder: false,
        itemId: "sess_a:tail",
        seq: 10,
        sessionId: "sess_a",
        status: "streaming",
      }),
    );
    const transport = new FakeEventStreamTransport();
    const snapshots: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        eventStreamTransport: transport,
        fetchBackends: false,
        historyPolicy: "tail_only",
        sessionId,
      });
      React.useEffect(() => {
        snapshots.push(controller.conversation?.items.at(-1)?.text ?? "");
      }, [controller.conversation]);
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => transport.subscribeCount === 1);

    assert.equal(
      transport.urls[0]?.toString(),
      "http://127.0.0.1:3857/api/v1/sessions/sess_a/events?after_id=evt_sess_a%3Atail",
    );

    await act(async () => {
      transport.emit({
        event_id: "evt_live_11",
        epoch: 1,
        payload: {
          delta: " live",
          message_id: "sess_a:tail",
        },
        seq: 11,
        session_id: "sess_a",
        type: "assistant.message.delta",
      });
    });

    assert.equal(
      snapshots.at(-1),
      "message for sess_a live",
      "live deltas from the injected transport must update the active conversation without a snapshot/tab refresh",
    );

    await flushHookEffects(act, dom, () => false);
    assert.equal(
      transport.subscribeCount,
      1,
      "a live cursor update must not churn the long-lived event stream subscription",
    );

    await act(async () => {
      transport.emitError(new Error("stream dropped"));
    });
    await flushHookEffects(act, dom, () => transport.subscribeCount === 2);
    assert.equal(
      transport.urls.at(-1)?.toString(),
      "http://127.0.0.1:3857/api/v1/sessions/sess_a/events?after_id=evt_live_11",
      "stream recovery must resume from the newest applied cursor instead of the initial snapshot cursor",
    );

    await act(async () => {
      root.unmount();
    });
    assert.equal(transport.closeCount, transport.subscribeCount);
  } finally {
    dom.restore();
  }
});

test("controller advances follow output token and observability on live tail changes", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    client.replaceTailConversation(
      "sess_follow",
      conversationView({
        hasOlder: false,
        itemId: "sess_follow:tail",
        seq: 10,
        sessionId: "sess_follow",
        status: "streaming",
      }),
    );
    const observability = new FakeObservability();
    const transport = new FakeEventStreamTransport();
    const snapshots: Array<{ text: string; token: number }> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        eventStreamTransport: transport,
        fetchBackends: false,
        historyPolicy: "tail_only",
        observability,
        sessionId,
      });
      React.useEffect(() => {
        snapshots.push({
          text: controller.conversation?.items.at(-1)?.text ?? "",
          token: controller.followOutputToken,
        });
      }, [controller.conversation, controller.followOutputToken]);
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_follow" });
    await flushHookEffects(
      act,
      dom,
      () => transport.subscribeCount === 1 && snapshots.some((snapshot) => snapshot.token > 0),
    );
    const initialToken = snapshots.findLast((snapshot) => snapshot.token > 0)?.token ?? 0;

    await act(async () => {
      transport.emit({
        event_id: "evt_follow_11",
        epoch: 1,
        payload: {
          delta: " live",
          message_id: "sess_follow:tail",
        },
        seq: 11,
        session_id: "sess_follow",
        type: "assistant.message.delta",
      });
    });
    await flushHookEffects(
      act,
      dom,
      () =>
        snapshots.some(
          (snapshot) =>
            snapshot.text === "message for sess_follow live" &&
            snapshot.token > initialToken,
        ),
    );

    assert.ok(
      snapshots.at(-1)!.token > initialToken,
      "live tail output must advance the controller follow token",
    );
    assert.deepEqual(
      observability.spans.map((span) => span.name),
      ["vela.chat.follow_output.advance", "vela.chat.follow_output.advance"],
    );
    assert.equal(
      observability.logs.at(-1)?.attributes?.["vela.follow_output.reason"],
      "tail_changed",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("controller treats sync reset as a full read-model resync", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    const transport = new FakeEventStreamTransport();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      useVelaChatSession({
        client,
        eventStreamTransport: transport,
        fetchBackends: false,
        historyPolicy: "tail_only",
        sessionId,
      });
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => transport.subscribeCount === 1);
    assert.equal(client.tailLoads("sess_a"), 1);

    await act(async () => {
      transport.emit({
        event_id: "evt_reset_11",
        epoch: 1,
        seq: 11,
        session_id: "sess_a",
        type: "sync.reset",
        views: ["workbench"],
      });
    });
    await flushHookEffects(act, dom, () => client.tailLoads("sess_a") >= 2);
    assert.equal(client.tailLoads("sess_a"), 2);

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("controller queues composer submits locally while running and drains after idle", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new QueueAwareVeladClient();
    client.setConversationStatus("sess_queue", "streaming");
    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "queue-controller-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    let latestController: ReturnType<typeof useVelaChatSession> | null = null;

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        clientStateStore,
        fetchBackends: false,
        historyPolicy: "tail_only",
        sessionId,
      });
      React.useEffect(() => {
        latestController = controller;
      });
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_queue" });
    await flushHookEffects(act, dom, () => latestController?.model.composer.is_running === true);

    await act(async () => {
      latestController?.setDraft("queued while running");
    });
    await flushHookEffects(act, dom, () => latestController?.draft === "queued while running");
    await act(async () => {
      await latestController?.send();
    });
    await flushHookEffects(act, dom, () => latestController?.queuedInputs.length === 1);

    assert.equal(client.sentMessages.length, 0, "running submit must not hit velad immediately");
    assert.equal(latestController?.draft, "");
    assert.deepEqual(
      clientStateStore.composerQueue.read("sess_queue")?.items.map((item) => item.previewText),
      ["queued while running"],
    );

    client.setConversationStatus("sess_queue", "completed");
    await act(async () => {
      await latestController?.refreshAll();
    });
    await flushHookEffects(act, dom, () => client.sentMessages.length === 1);

    assert.deepEqual(client.sentMessages[0]?.content, [
      { type: "text", text: "queued while running" },
    ]);
    assert.equal(
      clientStateStore.composerQueue.read("sess_queue"),
      null,
      "accepted queued input must be removed from local queue state",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("full preload does not request older pages again when switching back to a completed session", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      useVelaChatSession({
        client,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_a") === 1);
    await renderSession({ React, act, root, Probe, sessionId: "sess_b" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_b") === 1);

    assert.equal(client.olderLoads("sess_a"), 1);
    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.tailLoads("sess_a") >= 2);

    assert.equal(
      client.olderLoads("sess_a"),
      1,
      "a completed session can refresh tail state but must not restart its full older-page preload loop",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("full preload keeps hydrated history items when switching back to a completed session", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new FakeVeladClient();
    const snapshots: Array<{ itemIds: string[]; sessionId: string }> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      React.useEffect(() => {
        snapshots.push({
          itemIds: controller.conversation?.items.map((item) => item.id) ?? [],
          sessionId: controller.activeSessionId,
        });
      }, [controller.activeSessionId, controller.conversation]);
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_a") === 1);
    assert.deepEqual(
      latestItemIdsForSession(snapshots, "sess_a"),
      ["sess_a:older", "sess_a:tail"],
      "initial full preload fixture must contain the older item before the tail item",
    );

    await renderSession({ React, act, root, Probe, sessionId: "sess_b" });
    await flushHookEffects(act, dom, () => client.olderLoads("sess_b") === 1);
    snapshots.length = 0;

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.tailLoads("sess_a") >= 2);

    assert.deepEqual(
      latestItemIdsForSession(snapshots, "sess_a"),
      ["sess_a:older", "sess_a:tail"],
      "returning to a completed full-preload session must reuse its hydrated history window instead of exposing tail-only content",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("full preload workbench restores a historical DOM anchor after switching completed session tabs", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );
    const client = new LongHistoryVeladClient();
    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "full-preload-workbench-scroll-anchor-red-test",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        clientStateStore,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      return React.createElement(ChatWorkbenchView, {
        clientStateStore,
        draft: controller.draft,
        historyPhase: controller.historyPhase,
        isLoadingOlder: controller.isLoadingOlder,
        model: controller.model,
        onDraftChange: controller.setDraft,
        onLoadOlder: controller.loadOlderConversation,
        onSubmit: controller.send,
      });
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(
      act,
      dom,
      () =>
        client.olderLoads("sess_a") === 1 &&
        container.querySelector(".conversation") !== null,
    );
    await flushFrames(act, dom, [16, 32, 48, 64]);

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the hydrated workbench to mount");
    await act(async () => {
      scrollElement!.scrollTop = 720;
      const scrollEvent = document.createEvent("Event");
      scrollEvent.initEvent("scroll", true, false);
      scrollElement!.dispatchEvent(scrollEvent);
    });
    const anchorBefore = findTurnGroupByText(container, "第 6 条历史消息 for sess_a");
    assert.notEqual(anchorBefore, null, "expected the historical anchor to be rendered before switching away");
    assert.equal(
      anchorBefore!.getBoundingClientRect().top,
      0,
      "test fixture should pin the historical item at the viewport top before switching away",
    );

    await renderSession({ React, act, root, Probe, sessionId: "sess_b" });
    await flushHookEffects(
      act,
      dom,
      () =>
        client.olderLoads("sess_b") === 1 &&
        container.querySelector(".conversation") !== null,
    );
    await flushFrames(act, dom, [80, 96, 112, 128]);

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(
      act,
      dom,
      () =>
        client.tailLoads("sess_a") >= 2 &&
        container.querySelector(".conversation") !== null,
    );
    await flushFrames(act, dom, [144, 160, 176, 192, 208, 224, 240, 256]);

    const restoredScrollElement = container.querySelector(".conversation") as HTMLElement | null;
    const anchorAfter = findTurnGroupByText(container, "第 6 条历史消息 for sess_a");
    assert.notEqual(restoredScrollElement, null, "expected workbench conversation after switching back");
    assert.notEqual(anchorAfter, null, "switching back must keep the preloaded historical DOM anchor available");
    assert.equal(
      restoredScrollElement!.scrollTop,
      720,
      "switching back to a completed full-preload session must restore the remembered historical scroll offset",
    );
    assert.equal(
      anchorAfter!.getBoundingClientRect().top,
      0,
      "switching back must restore the same historical anchor, not just expose some session content",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("stale older-page completion cannot clear the active session hydration state", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const client = new DeferredOlderVeladClient();
    const snapshots: Array<{
      historyPhase: string;
      isLoadingOlder: boolean;
      sessionId: string;
    }> = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      React.useEffect(() => {
        snapshots.push({
          historyPhase: controller.historyPhase,
          isLoadingOlder: controller.isLoadingOlder,
          sessionId: controller.activeSessionId,
        });
      }, [
        controller.activeSessionId,
        controller.historyPhase,
        controller.isLoadingOlder,
      ]);
      return React.createElement("div");
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(act, dom, () => client.hasPendingOlder("sess_a"));

    await renderSession({ React, act, root, Probe, sessionId: "sess_b" });
    await flushHookEffects(act, dom, () => client.hasPendingOlder("sess_b"));
    assert.equal(
      latestHydrationSnapshot(snapshots, "sess_b")?.isLoadingOlder,
      true,
      "fixture must leave the active session in its own full-history hydration request",
    );

    await act(async () => {
      client.resolveOlder("sess_a");
      await Promise.resolve();
    });
    await flushHookEffects(act, dom, () =>
      latestHydrationSnapshot(snapshots, "sess_b")?.isLoadingOlder === false,
    );

    assert.equal(
      latestHydrationSnapshot(snapshots, "sess_b")?.isLoadingOlder,
      true,
      "a stale older-page finally from another session must not clear the active session loading flag",
    );

    await act(async () => {
      client.resolveOlder("sess_b");
      await Promise.resolve();
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

test("full preload does not bottom-anchor the tail page before history hydration completes", async () => {
  const dom = installDomRuntime();
  try {
    const React = await import("react");
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useVelaChatSession } = await import(
      "../../vela-chat-controller/src/useVelaChatSession"
    );
    const { ChatWorkbenchView } = await import(
      "../src/components/workbench/ChatWorkbenchView"
    );
    const client = new DeferredOlderVeladClient();
    const clientStateStore = createVelaClientStateStore(createMemoryKeyValueStore(), {
      hostId: "full-preload-tail-page-must-not-route-initial-anchor",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Probe({ sessionId }: { sessionId: string }) {
      const controller = useVelaChatSession({
        client,
        clientStateStore,
        fetchBackends: false,
        historyPolicy: "full_preload",
        sessionId,
      });
      return React.createElement(ChatWorkbenchView, {
        clientStateStore,
        draft: controller.draft,
        historyPhase: controller.historyPhase,
        isLoadingOlder: controller.isLoadingOlder,
        model: controller.model,
        onDraftChange: controller.setDraft,
        onLoadOlder: controller.loadOlderConversation,
        onSubmit: controller.send,
      });
    }

    await renderSession({ React, act, root, Probe, sessionId: "sess_a" });
    await flushHookEffects(
      act,
      dom,
      () =>
        client.hasPendingOlder("sess_a") &&
        container.querySelector(".conversation") !== null,
    );

    const scrollElement = container.querySelector(".conversation") as HTMLElement | null;
    assert.notEqual(scrollElement, null, "expected the tail page to mount under the hydration overlay");
    await flushFrames(act, dom, [16, 32, 48, 64, 80]);

    assert.equal(
      scrollElement!.scrollTop,
      0,
      "the tail-only page must not perform route_initial_entry before full history is authoritative",
    );

    await act(async () => {
      root.unmount();
    });
  } finally {
    dom.restore();
  }
});

async function renderSession({
  React,
  act,
  root,
  Probe,
  sessionId,
}: {
  React: typeof import("react");
  act: typeof import("react").act;
  root: import("react-dom/client").Root;
  Probe: (props: { sessionId: string }) => import("react").ReactElement;
  sessionId: string;
}) {
  await act(async () => {
    root.render(React.createElement(Probe, { sessionId }));
  });
}

function latestItemIdsForSession(
  snapshots: Array<{ itemIds: string[]; sessionId: string }>,
  sessionId: string,
) {
  return snapshots.findLast((snapshot) => snapshot.sessionId === sessionId)?.itemIds ?? [];
}

function latestHydrationSnapshot(
  snapshots: Array<{
    historyPhase: string;
    isLoadingOlder: boolean;
    sessionId: string;
  }>,
  sessionId: string,
) {
  return snapshots.findLast((snapshot) => snapshot.sessionId === sessionId);
}

async function flushHookEffects(
  act: typeof import("react").act,
  dom: ReturnType<typeof installDomRuntime>,
  done: () => boolean,
) {
  for (let index = 0; index < 30; index += 1) {
    if (done()) return;
    await act(async () => {
      await Promise.resolve();
    });
    dom.flushAnimationFrame(index * 16);
  }
}

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

class FakeEventStreamTransport implements VelaEventStreamTransport {
  closeCount = 0;
  handlers: VelaEventStreamHandlers | null = null;
  subscribeCount = 0;
  urls: URL[] = [];

  subscribe(url: URL, handlers: VelaEventStreamHandlers) {
    this.subscribeCount += 1;
    this.urls.push(url);
    this.handlers = handlers;
    handlers.onOpen?.();
    return {
      close: () => {
        this.closeCount += 1;
      },
    };
  }

  emit(event: VelaStreamEventWire) {
    this.handlers?.onEvent(event);
  }

  emitError(error: unknown) {
    this.handlers?.onError?.(error);
  }
}

class FakeObservability {
  readonly logs: Array<{
    attributes?: Record<string, unknown>;
    body: string;
    severityText?: string;
  }> = [];
  readonly spans: Array<FakeSpan> = [];

  emitLog(record: {
    attributes?: Record<string, unknown>;
    body: string;
    severityText?: string;
  }) {
    this.logs.push(record);
  }

  recordError(span: FakeSpan, error: unknown) {
    span.error = error instanceof Error ? error.message : String(error);
  }

  startSpan(name: string, options?: { attributes?: Record<string, unknown> }) {
    const span = new FakeSpan(name, options?.attributes ?? {});
    this.spans.push(span);
    return span;
  }

  traceparent(span: FakeSpan) {
    return `00-${span.traceId}-${span.spanId}-01`;
  }
}

class FakeSpan {
  ended = false;
  error: string | null = null;
  readonly spanId = "2222222222222222";
  readonly traceId = "11111111111111111111111111111111";
  status: { code: number; message?: string } | null = null;

  constructor(
    readonly name: string,
    readonly attributes: Record<string, unknown>,
  ) {}

  end() {
    this.ended = true;
  }

  setAttribute(key: string, value: string | number | boolean) {
    this.attributes[key] = value;
  }

  setStatus(status: { code: number; message?: string }) {
    this.status = status;
  }

  spanContext() {
    return {
      spanId: this.spanId,
      traceId: this.traceId,
    };
  }
}

class FakeVeladClient implements VeladClient {
  private conversationOverrides = new Map<string, ConversationWireView>();
  private readonly tailLoadCount = new Map<string, number>();
  private readonly olderLoadCount = new Map<string, number>();

  tailLoads(sessionId: string) {
    return this.tailLoadCount.get(sessionId) ?? 0;
  }

  olderLoads(sessionId: string) {
    return this.olderLoadCount.get(sessionId) ?? 0;
  }

  replaceTailConversation(sessionId: string, conversation: ConversationWireView) {
    this.conversationOverrides.set(sessionId, conversation);
  }

  async getConversation(
    sessionId: string,
    options?: ConversationWindowOptions,
  ): Promise<ConversationWireView> {
    if (options?.direction === "before") {
      this.olderLoadCount.set(sessionId, this.olderLoads(sessionId) + 1);
      return conversationView({
        hasOlder: false,
        itemId: `${sessionId}:older`,
        seq: this.tailLoads(sessionId) * 10 + this.olderLoads(sessionId) + 1,
        sessionId,
      });
    }

    this.tailLoadCount.set(sessionId, this.tailLoads(sessionId) + 1);
    const override = this.conversationOverrides.get(sessionId);
    if (override) return override;
    return conversationView({
      hasOlder: true,
      itemId: `${sessionId}:tail`,
      seq: this.tailLoads(sessionId) * 10,
      sessionId,
    });
  }

  async getPendingRequests(
    sessionId: string,
    _options?: PendingRequestsOptions,
  ): Promise<PendingRequestsWireView> {
    return pendingRequestsView(sessionId);
  }

  async getRequests(
    sessionId: string,
    _options?: PendingRequestsOptions,
  ): Promise<PendingRequestsWireView> {
    return pendingRequestsView(sessionId);
  }

  async getSession(sessionId: string): Promise<SessionWireResponse> {
    return {
      cursor: { has_more: false },
      session: sessionWire(sessionId),
    };
  }

  sessionEventStreamUrl(sessionId: string, afterId?: string | null): URL {
    const url = new URL(`http://127.0.0.1:3857/api/v1/sessions/${sessionId}/events`);
    if (afterId) url.searchParams.set("after_id", afterId);
    return url;
  }

  conversationUrl(sessionId: string): URL {
    return new URL(`http://127.0.0.1:3857/api/v1/sessions/${sessionId}/views/conversation`);
  }

  requestsUrl(sessionId: string): URL {
    return new URL(`http://127.0.0.1:3857/api/v1/sessions/${sessionId}/requests`);
  }

  diffsUrl(sessionId: string): URL {
    return new URL(`http://127.0.0.1:3857/api/v1/sessions/${sessionId}/diffs`);
  }

  async getBackends(): Promise<BackendsWireResponse> {
    return { backends: [] };
  }

  async getDiffs(_sessionId: string): Promise<DiffReviewWireView> {
    return { cursor: { has_more: false }, diffs: [] };
  }

  async listSessions(_options?: SessionListOptions): Promise<SessionListWireResponse> {
    return { cursor: { has_more: false }, sessions: [] };
  }

  async getSessionListView(
    _options?: SessionListOptions,
  ): Promise<SessionListViewWireResponse> {
    return { cursor: { has_more: false }, sessions: [] };
  }

  async createSession(_input: CreateSessionInput): Promise<CreateSessionWireResponse> {
    throw new Error("createSession is outside this controller test");
  }

  async getBackend(_backend: BackendKindWire): Promise<BackendWireResponse> {
    throw new Error("getBackend is outside this controller test");
  }

  async probeBackend(_backend: BackendKindWire): Promise<BackendProbeResultWire> {
    throw new Error("probeBackend is outside this controller test");
  }

  async updateAgentConfig(_input: {
    sessionId: string;
    patch: unknown;
    idempotencyKey?: string;
  }): Promise<UpdateAgentConfigWireResponse> {
    throw new Error("updateAgentConfig is outside this controller test");
  }

  async cancelSession(_input: { sessionId: string; idempotencyKey?: string }): Promise<CommandAckWire> {
    throw new Error("cancelSession is outside this controller test");
  }

  async sendSessionInputEvents(_input: SendSessionInputEventsInput): Promise<CommandAckWire> {
    throw new Error("sendSessionInputEvents is outside this controller test");
  }

  async sendUserMessage(_input: {
    sessionId: string;
    text?: string;
    content?: ClientInputPart[];
    idempotencyKey?: string;
  }): Promise<CommandAckWire> {
    throw new Error("sendUserMessage is outside this controller test");
  }
}

class QueueAwareVeladClient extends FakeVeladClient {
  readonly sentMessages: Array<{
    sessionId: string;
    text?: string;
    content?: ClientInputPart[];
  }> = [];

  setConversationStatus(sessionId: string, status: "completed" | "streaming") {
    this.replaceTailConversation(
      sessionId,
      conversationView({
        hasOlder: false,
        itemId: `${sessionId}:tail`,
        seq: this.sentMessages.length + 10,
        sessionId,
        status,
      }),
    );
  }

  override async sendUserMessage(input: {
    sessionId: string;
    text?: string;
    content?: ClientInputPart[];
    idempotencyKey?: string;
  }): Promise<CommandAckWire> {
    this.sentMessages.push({
      sessionId: input.sessionId,
      ...(input.text ? { text: input.text } : {}),
      ...(input.content ? { content: input.content } : {}),
    });
    this.setConversationStatus(input.sessionId, "streaming");
    return {
      status: "accepted",
      command_id: input.idempotencyKey ?? `cmd_${this.sentMessages.length}`,
      session_id: input.sessionId,
      cursor: {
        event_id: `evt_sent_${this.sentMessages.length}`,
        epoch: 1,
        seq: 100 + this.sentMessages.length,
      },
    };
  }
}

class LongHistoryVeladClient extends FakeVeladClient {
  private readonly tailLoadCount = new Map<string, number>();
  private readonly olderLoadCount = new Map<string, number>();

  override tailLoads(sessionId: string) {
    return this.tailLoadCount.get(sessionId) ?? 0;
  }

  override olderLoads(sessionId: string) {
    return this.olderLoadCount.get(sessionId) ?? 0;
  }

  override async getConversation(
    sessionId: string,
    options?: ConversationWindowOptions,
  ): Promise<ConversationWireView> {
    if (options?.direction === "before") {
      this.olderLoadCount.set(sessionId, this.olderLoads(sessionId) + 1);
      return conversationRangeView({
        count: 120,
        hasOlder: false,
        sessionId,
        start: 0,
      });
    }

    this.tailLoadCount.set(sessionId, this.tailLoads(sessionId) + 1);
    return conversationRangeView({
      count: 20,
      hasOlder: true,
      sessionId,
      start: 120,
    });
  }
}

class DeferredOlderVeladClient extends FakeVeladClient {
  private readonly pendingOlderResolvers = new Map<
    string,
    (value: ConversationWireView) => void
  >();
  private readonly pendingOlderPromises = new Map<string, Promise<ConversationWireView>>();
  private readonly tailLoadCount = new Map<string, number>();
  private readonly olderLoadCount = new Map<string, number>();

  hasPendingOlder(sessionId: string) {
    return this.pendingOlderResolvers.has(sessionId);
  }

  resolveOlder(sessionId: string) {
    const resolve = this.pendingOlderResolvers.get(sessionId);
    if (!resolve) throw new Error(`missing pending older request for ${sessionId}`);
    this.pendingOlderResolvers.delete(sessionId);
    this.pendingOlderPromises.delete(sessionId);
    resolve(
      conversationView({
        hasOlder: false,
        itemId: `${sessionId}:older`,
        seq: this.tailLoads(sessionId) * 10 + this.olderLoads(sessionId) + 1,
        sessionId,
      }),
    );
  }

  override tailLoads(sessionId: string) {
    return this.tailLoadCount.get(sessionId) ?? 0;
  }

  override olderLoads(sessionId: string) {
    return this.olderLoadCount.get(sessionId) ?? 0;
  }

  override async getConversation(
    sessionId: string,
    options?: ConversationWindowOptions,
  ): Promise<ConversationWireView> {
    if (options?.direction === "before") {
      this.olderLoadCount.set(sessionId, this.olderLoads(sessionId) + 1);
      const existing = this.pendingOlderPromises.get(sessionId);
      if (existing) return existing;
      const promise = new Promise<ConversationWireView>((resolve) => {
        this.pendingOlderResolvers.set(sessionId, resolve);
      });
      this.pendingOlderPromises.set(sessionId, promise);
      return promise;
    }

    this.tailLoadCount.set(sessionId, this.tailLoads(sessionId) + 1);
    return conversationView({
      hasOlder: true,
      itemId: `${sessionId}:tail`,
      seq: this.tailLoads(sessionId) * 10,
      sessionId,
    });
  }
}

function conversationView({
  hasOlder,
  itemId,
  seq,
  sessionId,
  status = "completed",
}: {
  hasOlder: boolean;
  itemId: string;
  seq: number;
  sessionId: string;
  status?: "completed" | "streaming";
}): ConversationWireView {
  const item = conversationItem({ id: itemId, sessionId, seq, status });
  return {
    cursor: {
      epoch: 1,
      event_id: `evt_${itemId}`,
      seq,
    },
    items: [item],
    session_id: sessionId,
    window: {
      first_item_id: item.id,
      has_newer: false,
      has_older: hasOlder,
      last_item_id: item.id,
    },
  };
}

function conversationRangeView({
  count,
  hasOlder,
  sessionId,
  start,
}: {
  count: number;
  hasOlder: boolean;
  sessionId: string;
  start: number;
}): ConversationWireView {
  const items = Array.from({ length: count }, (_, index) => {
    const itemIndex = start + index;
    return conversationItem({
      id: `${sessionId}:item_${itemIndex}`,
      seq: itemIndex,
      sessionId,
      text: `第 ${itemIndex} 条历史消息 for ${sessionId}`,
    });
  });
  const first = items[0];
  const last = items.at(-1);
  return {
    cursor: {
      epoch: 1,
      event_id: last ? `evt_${last.id}` : `evt_${sessionId}:empty`,
      seq: last?.source_event_ranges[0]?.to_seq ?? 0,
    },
    items,
    session_id: sessionId,
    window: {
      first_item_id: first?.id ?? null,
      has_newer: false,
      has_older: hasOlder,
      last_item_id: last?.id ?? null,
    },
  };
}

function conversationItem({
  id,
  sessionId,
  seq,
  status = "completed",
  text = `message for ${sessionId}`,
}: {
  id: string;
  sessionId: string;
  seq: number;
  status?: "completed" | "streaming";
  text?: string;
}): ConversationWireItem {
  const at = new Date(Date.UTC(2026, 5, 23, 0, 0, seq)).toISOString();
  return {
    created_at: at,
    id,
    kind: "assistant_message",
    parts: [{ id: `${id}:part:0`, text, type: "text" }],
    revision: 1,
    source_event_ids: [`evt_${id}`],
    source_event_ranges: [
      {
        epoch: 1,
        from_event_id: `evt_${id}`,
        from_seq: seq,
        to_event_id: `evt_${id}`,
        to_seq: seq,
      },
    ],
    status,
    text,
    turn_id: `turn_${sessionId}`,
    updated_at: at,
  };
}

function pendingRequestsView(sessionId: string): PendingRequestsWireView {
  return {
    cursor: { has_more: false },
    requests: [],
  };
}

function sessionWire(sessionId: string): SessionWire {
  const at = new Date(Date.UTC(2026, 5, 23, 0, 0, 0)).toISOString();
  return {
    backend: "pi",
    created_at: at,
    id: sessionId,
    status: "idle",
    title: sessionId,
    updated_at: at,
    working_directory: "/tmp",
  };
}

function installDomRuntime() {
  const window = new Window({ url: "http://127.0.0.1:3000/chat" });
  const previous = {
    EventSource: globalThis.EventSource,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
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

  class TestEventSource {
    onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
    onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
    readonly url: string;

    constructor(url: string | URL) {
      this.url = String(url);
    }

    addEventListener() {}
    close() {}
    removeEventListener() {}
  }

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
    if (className.includes("turnGroup")) {
      const groups = Array.from(document.querySelectorAll(".turnGroup"));
      const index = groups.indexOf(this as Element);
      const scrollElement = document.querySelector(".conversation") as HTMLElement | null;
      const itemHeight = 120;
      const top = Math.max(0, index) * itemHeight - (scrollElement?.scrollTop ?? 0);
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

  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;
  window.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    value: TestEventSource,
  });
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
  Object.defineProperty(globalThis, "Element", { configurable: true, value: window.Element });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: window.HTMLElement,
  });
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: TestEventSource,
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
      restoreGlobal("EventSource", previous.EventSource);
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
