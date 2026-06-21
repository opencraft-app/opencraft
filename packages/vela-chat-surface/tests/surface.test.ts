import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatSurfaceFromReadModels,
  buildConversationHistoryPrependPlan,
  canApplyConversationHistoryPrependPlan,
  deriveConversationWindowState,
  prependConversationWindow,
} from "../src";

function conversationView(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess_1",
    items: [],
    window: {
      first_item_id: null,
      last_item_id: null,
      has_older: false,
      has_newer: false,
    },
    cursor: { event_id: "evt_1", epoch: 1, seq: 1 },
    ...overrides,
  };
}

function conversationItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item_1",
    kind: "assistant_message",
    created_at: "2026-06-18T10:00:00Z",
    updated_at: "2026-06-18T10:00:00Z",
    revision: 1,
    status: "completed",
    source_event_ids: ["evt_1"],
    text: "",
    ...overrides,
  };
}

test("normalizes ConversationView items into stable semantic surface lanes", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_1",
    conversation: conversationView({
      items: [
        conversationItem({
          id: "evt_user_1",
          kind: "user_message",
          turn_id: "turn_1",
          text: "导入功能在哪了 至少前端没看到?",
          parts: [
            {
              id: "evt_user_1:part:0",
              type: "text",
              text: "导入功能在哪了 至少前端没看到?",
            },
            {
              id: "evt_user_1:part:1",
              type: "image",
              data: {
                mime_type: "image/png",
                data: "aGVsbG8=",
                size_bytes: 5,
              },
            },
          ],
          source_event_ids: ["evt_user_1"],
        }),
        conversationItem({
          id: "turn_1:meta",
          kind: "turn_meta",
          turn_id: "turn_1",
          created_at: "2026-06-18T10:00:00Z",
          updated_at: "2026-06-18T10:00:03Z",
          source_event_ids: ["evt_turn_started", "evt_turn_completed"],
        }),
        conversationItem({
          id: "evt_assistant_1",
          kind: "assistant_message",
          turn_id: "turn_1",
          created_at: "2026-06-18T10:00:01Z",
          updated_at: "2026-06-18T10:00:03Z",
          text: "我先按前端入口查。",
          source_event_ids: ["evt_assistant_started", "evt_assistant_delta"],
        }),
        conversationItem({
          id: "work_1",
          kind: "agent_work",
          turn_id: "turn_1",
          title: "Ran command",
          summary: "npm test",
          detail: { type: "shell", command: "npm test" },
          created_at: "2026-06-18T10:00:02Z",
          updated_at: "2026-06-18T10:00:03Z",
          event_range: {
            from_event_id: "evt_tool_started",
            to_event_id: "evt_tool_completed",
          },
          source_event_ids: ["evt_tool_started", "evt_tool_completed"],
        }),
      ],
      window: {
        first_item_id: "evt_user_1",
        last_item_id: "work_1",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_tool_completed", epoch: 1, seq: 4 },
    }),
  });

  assert.equal(surface.session_id, "sess_1");
  assert.deepEqual(
    surface.conversation.items.map((item) => item.kind),
    ["user_message", "turn_meta", "assistant_message", "agent_work"],
  );
  assert.equal(surface.conversation.items[0]?.debug.projection, "conversation");
  assert.equal(surface.conversation.items[0]?.kind, "user_message");
  assert.equal(surface.conversation.items[0]?.parts[1]?.type, "image");
  assert.equal(surface.conversation.items[0]?.parts[1]?.data?.mime_type, "image/png");
  assert.equal(surface.conversation.items[0]?.turn_id, "turn_1");
  assert.equal(surface.conversation.items[1]?.kind, "turn_meta");
  assert.equal(surface.conversation.items[1]?.status, "completed");
  assert.deepEqual(surface.conversation.items[2]?.debug.source_event_ids, [
    "evt_assistant_started",
    "evt_assistant_delta",
  ]);
  assert.equal(surface.conversation.window?.has_older, true);
  assert.equal(surface.conversation.window?.last_item_id, "work_1");
  assert.equal(surface.conversation.items[3]?.kind, "agent_work");
  assert.equal(surface.conversation.items[3]?.title, "Ran command");
  assert.equal(surface.conversation.items[3]?.summary, "npm test");
  assert.deepEqual(surface.conversation.items[3]?.debug.source_event_ids, [
    "evt_tool_started",
    "evt_tool_completed",
  ]);
  assert.equal(surface.cursors.conversation?.event_id, "evt_tool_completed");
  assert.equal("transcript" in surface, false);
  assert.equal("activity" in surface, false);
});

test("normalizes pending requests as a separate surface lane", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_requests",
    conversation: conversationView({ session_id: "sess_requests" }),
    requests: {
      requests: [
        {
          id: "req_allow_shell",
          session_id: "sess_requests",
          type: "permission",
          status: "pending",
          title: "Allow command?",
          description: "bash: npm test",
          payload: { command: "npm test" },
          created_at: "2026-06-18T10:00:02Z",
        },
      ],
      cursor: { latest_event_id: "evt_request_opened" },
    },
  });

  assert.equal(surface.pending_requests.items.length, 1);
  assert.equal(surface.pending_requests.items[0]?.id, "req_allow_shell");
  assert.equal(surface.pending_requests.items[0]?.title, "Allow command?");
  assert.equal(surface.pending_requests.items[0]?.debug.projection, "requests");
  assert.deepEqual(surface.pending_requests.items[0]?.debug.source_event_ids, []);
  assert.equal(surface.cursors.requests?.latest_event_id, "evt_request_opened");
});

test("does not invent source event ids for projected items without provenance", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_projected_provenance",
    conversation: conversationView({
      items: [
        conversationItem({
          id: "work_1",
          kind: "agent_work",
          title: "Tool",
          detail: { type: "tool" },
          source_event_ids: [],
        }),
      ],
    }),
    requests: {
      requests: [
        {
          id: "req_question_1",
          session_id: "sess_projected_provenance",
          type: "question",
          status: "pending",
          created_at: "2026-06-18T10:00:04Z",
        },
      ],
      cursor: { latest_event_id: "evt_request_opened" },
    },
  });

  assert.deepEqual(surface.conversation.items[0]?.debug.source_event_ids, []);
  assert.deepEqual(surface.pending_requests.items[0]?.debug.source_event_ids, []);
});

test("deduplicates single-event agent work provenance ranges", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_agent_work_single_event",
    conversation: conversationView({
      items: [
        conversationItem({
          id: "work_1",
          kind: "agent_work",
          title: "Tool",
          detail: { type: "tool" },
          event_range: {
            from_event_id: "evt_tool_1",
            to_event_id: "evt_tool_1",
          },
          source_event_ids: ["evt_tool_1"],
        }),
      ],
    }),
  });

  assert.deepEqual(surface.conversation.items[0]?.debug.source_event_ids, ["evt_tool_1"]);
});

test("uses status conversation items as working surface rows", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_labels",
    conversation: conversationView({
      items: [
        conversationItem({
          id: "status_1",
          kind: "status",
          text: "Searched code",
          source_event_ids: ["evt_reasoning_1"],
        }),
      ],
    }),
  });

  assert.equal(surface.conversation.items[0]?.kind, "status");
  assert.equal(surface.conversation.items[0]?.text, "Searched code");
});

test("preserves conversation item correlation ids in surface lanes", () => {
  const surface = buildChatSurfaceFromReadModels({
    sessionId: "sess_correlation",
    conversation: conversationView({
      items: [
        conversationItem({
          id: "row_assistant_1",
          kind: "assistant_message",
          turn_id: "turn_1",
          text: "我来查。",
        }),
        conversationItem({
          id: "work_1",
          kind: "agent_work",
          turn_id: "turn_1",
          title: "Ran command",
          detail: { type: "shell", command: "ls -la" },
        }),
      ],
    }),
  });

  assert.equal(surface.conversation.items[0]?.turn_id, "turn_1");
  assert.equal(surface.conversation.items[1]?.turn_id, "turn_1");
});

test("keeps surface renderer-free", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );

  assert.equal(source.includes("react"), false);
  assert.equal(source.includes("next/"), false);
});

test("does not expose retired transcript or activity read-model inputs", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );

  assert.doesNotMatch(source, /ChatTranscriptWireView/);
  assert.doesNotMatch(source, /ActivityWireView/);
  assert.doesNotMatch(source, /prependTranscriptWindow/);
  assert.doesNotMatch(source, /prependActivityWindow/);
});

test("keeps OpenAPI-required conversation item fields required in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const itemBaseInterface =
    source.match(/export interface ConversationWireItemBase \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(itemBaseInterface, /updated_at:\s*string/);
  assert.match(itemBaseInterface, /revision:\s*number/);
  assert.match(itemBaseInterface, /status:\s*ConversationItemStatusWire/);
  assert.match(itemBaseInterface, /source_event_ids:\s*string\[\]/);
  assert.match(itemBaseInterface, /turn_id\?:\s*string/);
  assert.doesNotMatch(itemBaseInterface, /updated_at\?:\s*string/);
  assert.doesNotMatch(itemBaseInterface, /revision\?:\s*number/);
  assert.doesNotMatch(itemBaseInterface, /status\?:\s*string/);
  assert.doesNotMatch(itemBaseInterface, /source_event_ids\?:\s*string\[\]/);
});

test("keeps OpenAPI conversation enums narrow in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const itemBaseInterface =
    source.match(/export interface ConversationWireItemBase \{[\s\S]*?\n\}/)?.[0] ?? "";
  const messagePartInterface =
    source.match(/export interface ConversationMessagePart \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type ConversationItemStatusWire\s*=/);
  assert.match(source, /export type ConversationMessagePartTypeWire\s*=/);
  assert.match(itemBaseInterface, /status:\s*ConversationItemStatusWire/);
  assert.match(messagePartInterface, /type:\s*ConversationMessagePartTypeWire/);
  assert.doesNotMatch(itemBaseInterface, /status:\s*string/);
  assert.doesNotMatch(messagePartInterface, /\|\s*string/);
});

test("keeps OpenAPI-required read model envelope fields required in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const eventCursorInterface =
    source.match(/export interface ChatSurfaceEventCursor \{[\s\S]*?\n\}/)?.[0] ?? "";
  const conversationViewInterface =
    source.match(/export interface ConversationWireView \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(eventCursorInterface, /event_id:\s*string/);
  assert.match(eventCursorInterface, /epoch:\s*number/);
  assert.match(eventCursorInterface, /seq:\s*number/);
  assert.doesNotMatch(eventCursorInterface, /event_id\?:\s*string/);
  assert.match(conversationViewInterface, /session_id:\s*string/);
  assert.match(conversationViewInterface, /items:\s*ConversationWireItem\[\]/);
  assert.match(conversationViewInterface, /window:\s*ConversationWindow/);
  assert.match(conversationViewInterface, /cursor:\s*ChatSurfaceEventCursor/);
  assert.doesNotMatch(conversationViewInterface, /session_id\?:\s*string/);
  assert.doesNotMatch(conversationViewInterface, /items\?:\s*ConversationWireItem\[\]/);
});

test("keeps OpenAPI agent work detail fields narrow in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const detailUnion =
    source.match(/export type AgentWorkDetailWire\s*=[\s\S]*?AgentWorkGenericDetailWire;/)?.[0] ??
    "";

  assert.match(source, /export type AgentWorkDetailTypeWire\s*=/);
  assert.match(source, /export type AgentWorkSearchModeWire\s*=/);
  assert.match(source, /export type AgentWorkDetailWire\s*=/);
  assert.match(detailUnion, /AgentWorkShellDetailWire/);
  assert.match(detailUnion, /AgentWorkFileDetailWire/);
  assert.match(detailUnion, /AgentWorkSearchDetailWire/);
  assert.match(detailUnion, /AgentWorkFetchDetailWire/);
  assert.match(detailUnion, /AgentWorkGenericDetailWire/);
  assert.match(source, /export interface AgentWorkSearchDetailWire \{[\s\S]*?type:\s*"search"[\s\S]*?mode\?:\s*AgentWorkSearchModeWire[\s\S]*?num_matches\?:\s*number/);
  assert.doesNotMatch(source, /mode\?:\s*string/);
});

test("keeps OpenAPI pending request enums narrow in surface wire types", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
  );
  const wireInterface = source.match(/export interface AgentRequestWire \{[\s\S]*?\n\}/)?.[0] ?? "";
  const surfaceInterface =
    source.match(/export interface ChatSurfacePendingRequest \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(source, /export type AgentRequestTypeWire\s*=/);
  assert.match(source, /export type RequestStatusWire\s*=/);
  assert.match(wireInterface, /type:\s*AgentRequestTypeWire/);
  assert.match(wireInterface, /status:\s*RequestStatusWire/);
  assert.match(wireInterface, /backend_ref\?:\s*Record<string,\s*unknown>/);
  assert.match(surfaceInterface, /type:\s*AgentRequestTypeWire/);
  assert.match(surfaceInterface, /status:\s*RequestStatusWire/);
  assert.doesNotMatch(wireInterface, /type:\s*string/);
  assert.doesNotMatch(wireInterface, /status:\s*string/);
  assert.doesNotMatch(surfaceInterface, /type:\s*string/);
  assert.doesNotMatch(surfaceInterface, /status:\s*string/);
});

test("prepends conversation windows without duplicating items and preserves latest cursor", () => {
  const current = conversationView({
    items: [
      conversationItem({ id: "item_2", text: "two current", status: "streaming", revision: 2 }),
      conversationItem({ id: "item_3", text: "three" }),
    ],
    window: {
      first_item_id: "item_2",
      last_item_id: "item_3",
      has_older: true,
      has_newer: false,
    },
    cursor: { event_id: "evt_latest", seq: 9 },
  });
  const older = conversationView({
    items: [
      conversationItem({ id: "item_1", kind: "user_message", text: "one" }),
      conversationItem({ id: "item_2", text: "two stale", status: "completed", revision: 1 }),
    ],
    window: {
      first_item_id: "item_1",
      last_item_id: "item_2",
      has_older: false,
      has_newer: true,
    },
    cursor: { event_id: "evt_newer", seq: 10 },
  });
  const merged = prependConversationWindow(current, older);

  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["item_1", "item_2", "item_3"],
  );
  assert.equal(merged.items[1]?.text, "two current");
  assert.equal(merged.items[1]?.status, "streaming");
  assert.equal(merged.items[1]?.revision, 2);
  assert.equal(merged.window?.first_item_id, "item_1");
  assert.equal(merged.window?.last_item_id, "item_3");
  assert.equal(merged.window?.has_older, false);
  assert.equal(merged.window?.has_newer, false);
  assert.equal(merged.cursor.event_id, "evt_newer");
  assert.equal(
    prependConversationWindow(
      { ...current, cursor: { event_id: "evt_live", epoch: 1, seq: 12 } },
      { ...older, cursor: { event_id: "evt_older", epoch: 1, seq: 10 } },
    ).cursor.event_id,
    "evt_live",
  );
  assert.strictEqual(
    prependConversationWindow(current, { ...older, session_id: "sess_other" }),
    current,
  );
});

test("prepend fixtures can omit session ids", () => {
  const conversation = prependConversationWindow(
    conversationView({
      session_id: undefined,
      items: [conversationItem({ id: "item_2" }), conversationItem({ id: "item_3" })],
      window: {
        first_item_id: "item_2",
        last_item_id: "item_3",
        has_older: true,
        has_newer: false,
      },
      cursor: { event_id: "evt_latest", seq: 9 },
    }),
    conversationView({
      session_id: undefined,
      items: [conversationItem({ id: "item_1" }), conversationItem({ id: "item_2" })],
      window: {
        first_item_id: "item_1",
        last_item_id: "item_2",
        has_older: false,
        has_newer: true,
      },
      cursor: { event_id: "evt_newer", seq: 10 },
    }),
  );

  assert.deepEqual(
    conversation.items.map((item) => item.id),
    ["item_1", "item_2", "item_3"],
  );
  assert.equal(conversation.window?.first_item_id, "item_1");
  assert.equal(conversation.window?.last_item_id, "item_3");
  assert.equal(conversation.cursor.event_id, "evt_newer");
});

test("rejects stale conversation history prepend plans after the visible window changes", () => {
  const plan = buildConversationHistoryPrependPlan({
    conversation: conversationView({
      session_id: "sess_old",
      window: {
        first_item_id: "item_10",
        last_item_id: "item_20",
        has_older: true,
        has_newer: false,
      },
    }),
  });

  assert.equal(Reflect.get(plan.conversation ?? {}, "sessionId"), "sess_old");
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      conversation: conversationView({
        session_id: "sess_old",
        window: {
          first_item_id: "item_10",
          last_item_id: "item_21",
          has_older: true,
          has_newer: false,
        },
      }),
    }),
    true,
  );
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      conversation: conversationView({
        session_id: "sess_new",
        window: {
          first_item_id: "item_10",
          last_item_id: "item_21",
          has_older: true,
          has_newer: false,
        },
      }),
    }),
    false,
  );
  assert.equal(
    canApplyConversationHistoryPrependPlan(plan, {
      conversation: conversationView({
        session_id: "sess_old",
        window: {
          first_item_id: "item_09",
          last_item_id: "item_21",
          has_older: true,
          has_newer: false,
        },
      }),
    }),
    false,
  );
});

test("derives conversation window state from the single conversation window", () => {
  const state = deriveConversationWindowState({
    conversation: conversationView({
      window: {
        first_item_id: "item_1",
        last_item_id: "item_8",
        has_older: true,
        has_newer: false,
      },
    }),
  });

  assert.equal(state.has_older, true);
  assert.equal(state.has_newer, false);
  assert.equal(state.first_item_id, "item_1");
  assert.equal(state.last_item_id, "item_8");
});

test("plans older conversation loads from ConversationView anchors", () => {
  const plan = buildConversationHistoryPrependPlan({
    conversation: conversationView({
      window: {
        first_item_id: "item_1",
        last_item_id: "item_8",
        has_older: true,
        has_newer: false,
      },
    }),
    limit: 80,
  });

  assert.equal(plan.has_older, true);
  assert.deepEqual(plan.conversation, {
    direction: "before",
    anchorItemId: "item_1",
    sessionId: "sess_1",
    limit: 80,
  });
});
