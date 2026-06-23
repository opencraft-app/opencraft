import assert from "node:assert/strict";
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
  VeladClient,
} from "../../vela-chat-client/src";

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

class FakeVeladClient implements VeladClient {
  private readonly tailLoadCount = new Map<string, number>();
  private readonly olderLoadCount = new Map<string, number>();

  tailLoads(sessionId: string) {
    return this.tailLoadCount.get(sessionId) ?? 0;
  }

  olderLoads(sessionId: string) {
    return this.olderLoadCount.get(sessionId) ?? 0;
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

function conversationView({
  hasOlder,
  itemId,
  seq,
  sessionId,
}: {
  hasOlder: boolean;
  itemId: string;
  seq: number;
  sessionId: string;
}): ConversationWireView {
  const item = conversationItem({ id: itemId, sessionId, seq });
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

function conversationItem({
  id,
  sessionId,
  seq,
}: {
  id: string;
  sessionId: string;
  seq: number;
}): ConversationWireItem {
  const at = new Date(Date.UTC(2026, 5, 23, 0, 0, seq)).toISOString();
  return {
    created_at: at,
    id,
    kind: "assistant_message",
    parts: [{ id: `${id}:part:0`, text: `message for ${sessionId}`, type: "text" }],
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
    status: "completed",
    text: `message for ${sessionId}`,
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

  window.requestAnimationFrame = requestAnimationFrame;
  window.cancelAnimationFrame = cancelAnimationFrame;
  Object.defineProperty(window, "EventSource", {
    configurable: true,
    value: TestEventSource,
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: window.document,
  });
  Object.defineProperty(globalThis, "EventSource", {
    configurable: true,
    value: TestEventSource,
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
      restoreGlobal("EventSource", previous.EventSource);
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
