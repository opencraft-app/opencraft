import assert from "node:assert/strict";
import test from "node:test";

import { HermesBotAppServerHandler } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/bot-protocol-handler.js";
import type { HermesAppServerAdapter } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.js";

const methods = [
  "groups.list", "groups.create", "groups.state", "groups.log", "groups.send", "groups.stop",
  "groups.rename", "groups.disband", "groups.approve", "groups.retry",
];

function room(revision = 1) {
  return {
    room_id: "room-review",
    name: "Review room",
    members: [
      { member_id: "main", profile: "default", handle: "main", display_name: "Main", target: { kind: "local", profile: "default" } },
      { member_id: "sales", profile: "sales", handle: "sales", display_name: "Sales", target: { kind: "local", profile: "sales" } },
    ],
    authority_gateway_id: "gateway-1",
    authority_epoch: 2,
    revision,
    created_at: 1,
    updated_at: 2,
    latest_seq: 2,
  };
}

function fixture() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const adapter = {
    async listProfiles() { return [{ name: "default" }, { name: "sales" }]; },
    async callHostedRoom(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "groups.capabilities") return { driver: true, methods };
      if (method === "groups.list") return { rooms: [room()], next_offset: null };
      if (method === "groups.create") return { room: room() };
      if (method === "groups.state") return { room: room(), driver_status: { running: true, working: false, blocked: false, pending_actions: [] } };
      if (method === "groups.log") return {
        events: [
          { room_id: "room-review", seq: 1, event_id: "user-1", kind: "message.user", actor: { kind: "user", id: "desktop" }, payload: { text: "Review this", thread_id: "user-1" }, created_at: 1 },
          { room_id: "room-review", seq: 2, event_id: "member-1", kind: "message.member", actor: { kind: "member", id: "sales" }, payload: { text: "Looks good", member_id: "sales", task_id: "task-1", thread_id: "user-1", turn_id: "turn-1", discussion_event_id: "user-1" }, created_at: 2 },
        ],
        cursor: 2,
        latest_seq: 2,
        has_more: false,
        authority: { gateway_id: "gateway-1", epoch: 2 },
      };
      if (method === "groups.send") return {
        event: { room_id: "room-review", seq: 3, event_id: String(params.event_id), kind: "message.user", actor: { kind: "user", id: "desktop" }, payload: params.payload as Record<string, unknown>, created_at: 3 },
        accepted: true,
      };
      if (method === "groups.stop") return { cancelled: 1 };
      if (method === "groups.rename") return { room: { ...room(2), name: String(params.name) } };
      if (method === "groups.disband") return { tombstone: { room_id: "room-review", disbanded_at: 3, idempotent: false } };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as HermesAppServerAdapter;
  const handler = new HermesBotAppServerHandler(adapter, () => {}, {
    resolveProfileBots: async () => [
      { botId: "main-bot", nativeProfile: "default", name: "Main", status: "available" },
      { botId: "sales-bot", nativeProfile: "sales", name: "Sales", status: "available" },
    ],
  });
  return { handler, calls };
}

test("Hermes hosted rooms project as AppServer group conversations", async () => {
  const { handler } = fixture();
  assert.equal(await handler.prepareCapability(), true);
  assert.equal(handler.groupConversations, true);
  const created = await handler.handle("bot/conversation/create", {
    clientRequestId: "review",
    topology: "group",
    title: "Review room",
    participantIds: ["bot:main-bot", "bot:sales-bot"],
  }) as { conversation: { topology: string; participantIds: string[] } };
  assert.equal(created.conversation.topology, "group");
  assert.deepEqual(created.conversation.participantIds, ["person:you", "bot:main-bot", "bot:sales-bot"]);

  const restored = await handler.handle("bot/conversation/read", {
    conversationId: "room-review",
    initialMessagesPage: { limit: 50 },
  }) as { initialMessagesPage: { data: Array<{ author: { participantId: string }; content: Array<{ text: string }> }> }; liveCursor: { epoch: string } };
  assert.deepEqual(restored.initialMessagesPage.data.map((message) => [message.author.participantId, message.content[0]?.text]), [
    ["person:you", "Review this"],
    ["bot:sales-bot", "Looks good"],
  ]);
  assert.equal(restored.liveCursor.epoch, "gateway-1:2");
});

test("Hermes group send and stop stay owned by the hosted room", async () => {
  const { handler, calls } = fixture();
  await handler.prepareCapability();
  const sent = await handler.handle("bot/message/send", {
    conversationId: "room-review",
    clientMessageId: "client-1",
    content: [{ type: "text", text: "Start" }, { type: "mention", participantId: "bot:sales-bot", label: "sales" }],
  }) as { message: { clientMessageId: string } };
  assert.equal(sent.message.clientMessageId, "client-1");
  assert.deepEqual(calls.find((call) => call.method === "groups.send")?.params.payload, {
    text: "Start\n@sales",
    thread_id: "client-1",
  });
  await handler.handle("bot/execution/cancel", {
    conversationId: "room-review",
    executionId: "task-1",
    commandId: "stop-1",
  });
  assert.equal(calls.some((call) => call.method === "groups.stop" && call.params.cancel_id === "stop-1"), true);
});
