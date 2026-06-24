import assert from "node:assert/strict";
import test from "node:test";

import {
  VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID,
  buildVelaChatDebugSnapshot,
  createVelaChatConsoleEvent,
  installVelaChatDebugApi,
  writeVelaChatDebugDomSnapshot,
  type VelaChatDebugApi,
} from "../src";

test("builds compact CDP-friendly debug snapshots", () => {
  const snapshot = buildVelaChatDebugSnapshot({
    baseUrl: "/chat/api/velad/api/v1",
    sessionIdInput: "draft-session",
    activeSessionId: "sess_1",
    workingDirectoryInput: "/tmp/project",
    draft: "hello",
    error: null,
    streamConnected: true,
    isCreatingSession: true,
    rows: [
      { id: "u1", kind: "user_message", key: "user:u1" },
      { id: "a1", kind: "assistant_message", key: "assistant:a1" },
    ],
    latestEventId: "evt_2",
  });

  assert.deepEqual(snapshot, {
    baseUrl: "/chat/api/velad/api/v1",
    sessionIdInput: "draft-session",
    activeSessionId: "sess_1",
    workingDirectoryInput: "/tmp/project",
    draftLength: 5,
    error: null,
    streamConnected: true,
    isCreatingSession: true,
    isUpdatingAgentConfig: false,
    agentConfig: null,
    backendCount: 0,
    rowCount: 2,
    conversation: null,
    rows: [
      { id: "u1", kind: "user_message", key: "user:u1" },
      { id: "a1", kind: "assistant_message", key: "assistant:a1" },
    ],
    latestEventId: "evt_2",
  });
});

test("includes compact conversation runtime summary when available", () => {
  const snapshot = buildVelaChatDebugSnapshot({
    baseUrl: "/chat/api/velad/api/v1",
    sessionIdInput: "sess_1",
    activeSessionId: "sess_1",
    draft: "",
    error: null,
    streamConnected: true,
    rows: [],
    conversation: {
      strategy: "web-partial-virtualized",
      itemCount: 12,
      historyVirtualizedCount: 6,
      historyMountedCount: 4,
      liveHeadCount: 2,
      mountedItemCount: 6,
      scroll: {
        followOutput: true,
        bottomAnchorBlockedReason: "waiting_for_measurable_content",
        routeResumeStatus: "restored",
        routeResumeScrollTop: 420,
      },
    },
  });

  assert.deepEqual(snapshot.conversation, {
    strategy: "web-partial-virtualized",
    itemCount: 12,
    historyVirtualizedCount: 6,
    historyMountedCount: 4,
    liveHeadCount: 2,
    mountedItemCount: 6,
    scroll: {
      followOutput: true,
      bottomAnchorBlockedReason: "waiting_for_measurable_content",
      routeResumeStatus: "restored",
      routeResumeScrollTop: 420,
    },
  });
});

test("creates structured console events for browser automation", () => {
  assert.deepEqual(createVelaChatConsoleEvent("reload", { sessionId: "sess_1" }), {
    channel: "vela-chat",
    name: "reload",
    detail: { sessionId: "sess_1" },
  });
});

test("mirrors debug snapshots into a DOM-readable JSON element", () => {
  const elements = new Map<string, { id: string; type: string; textContent: string | null }>();
  const created: Array<{ id: string; type: string; textContent: string | null }> = [];
  const documentElement = {
    attributes: new Map<string, string>(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
  };
  const documentRef = {
    documentElement,
    body: {
      appendChild(element: { id: string; type: string; textContent: string | null }) {
        elements.set(element.id, element);
        created.push(element);
      },
    },
    head: null,
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    createElement() {
      return { id: "", type: "", textContent: null };
    },
  } as unknown as Document;
  const snapshot = buildVelaChatDebugSnapshot({
    baseUrl: "/chat/api/velad/api/v1",
    sessionIdInput: "sess_1",
    activeSessionId: "sess_1",
    draft: "",
    error: null,
    streamConnected: false,
    rows: [{ id: "status_1", kind: "status", key: "activity:current_turn" }],
  });

  writeVelaChatDebugDomSnapshot(snapshot, documentRef);

  assert.equal(created.length, 1);
  assert.equal(created[0]?.id, VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID);
  assert.equal(created[0]?.type, "application/json");
  assert.deepEqual(JSON.parse(created[0]?.textContent ?? ""), snapshot);
  assert.equal(documentElement.attributes.get("data-vela-chat-debug-ready"), "true");
});

test("installs debug API and DOM snapshot together for browser automation", () => {
  const elements = new Map<string, { id: string; type: string; textContent: string | null }>();
  const documentRef = {
    documentElement: {
      attributes: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
      },
    },
    body: {
      appendChild(element: { id: string; type: string; textContent: string | null }) {
        elements.set(element.id, element);
      },
    },
    head: null,
    getElementById(id: string) {
      return elements.get(id) ?? null;
    },
    createElement() {
      return { id: "", type: "", textContent: null };
    },
  } as unknown as Document;
  const windowRef = {} as Window;
  const snapshot = buildVelaChatDebugSnapshot({
    baseUrl: "/chat/api/velad/api/v1",
    sessionIdInput: "sess_1",
    activeSessionId: "sess_1",
    draft: "",
    error: null,
    streamConnected: false,
    rows: [],
  });
  const api = {
    version: 1,
    getSnapshot: () => snapshot,
    setBaseUrl: () => undefined,
    setSessionId: () => undefined,
    setWorkingDirectory: () => undefined,
    openSession: () => undefined,
    createSession: async () => undefined,
    setDraft: () => undefined,
    sendMessage: async () => undefined,
    reloadTranscript: async () => undefined,
    clearError: () => undefined,
    logSnapshot: () => snapshot,
  } satisfies VelaChatDebugApi;

  installVelaChatDebugApi({
    api,
    documentRef,
    snapshot,
    windowRef,
  });

  assert.equal(windowRef.__VELA_CHAT_DEBUG__, api);
  assert.deepEqual(
    JSON.parse(elements.get(VELA_CHAT_DEBUG_SNAPSHOT_ELEMENT_ID)?.textContent ?? ""),
    snapshot,
  );
});
