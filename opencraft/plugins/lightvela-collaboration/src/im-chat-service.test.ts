import assert from "node:assert/strict";
import test from "node:test";

import type {
  ConversationAddress,
  Message,
  SendTextInput,
} from "@lightvela/vela-chat-client-core";
import { ImChatService } from "./im-chat-service";

const channel: ConversationAddress = {
  channelId: "channel-1",
  conversationId: "GROUPtopic-1",
  imGroupId: "community-1",
  imTopicId: "topic-1",
  targetId: "topic-1",
};
const direct: ConversationAddress = {
  conversationId: "GROUPdirect-group-1",
  directConversationId: "direct-1",
  imGroupId: "direct-group-1",
  targetId: "direct-group-1",
};

function message(id: string, conversationId: string, text: string): Message {
  return {
    id,
    conversationId,
    content: { kind: "text", text },
    createdAt: "2026-09-14T12:00:00Z",
    delivery: { state: "sent" },
    direction: "incoming",
    kind: "text",
    mentions: [],
    rawType: "TIMTextElem",
    reactions: [],
    read: { state: "unknown" },
    senderId: "human-2",
    senderName: "Ada",
    text,
  };
}

test("one IM Chat service switches between Channel and private Group conversations", async () => {
  let live: (messages: Message[]) => void = () => undefined;
  const opened: ConversationAddress[] = [];
  const service = new ImChatService({
    loadHistory: async (address) => {
      opened.push(address);
      return {
        completed: true,
        messages: [message(`history:${address.conversationId}`, address.conversationId, "history")],
      };
    },
    markRead: async () => undefined,
    sendText: async () => message("sent", direct.conversationId, "hello"),
    subscribeMessages(listener) {
      live = listener;
      return () => { live = () => undefined; };
    },
    waitUntilReady: async () => undefined,
  });

  await service.open(channel);
  live([
    message("channel-live", channel.conversationId, "channel"),
    message("outside", direct.conversationId, "outside"),
  ]);
  assert.deepEqual(service.getSnapshot().messages.map(({ id }) => id), [
    `history:${channel.conversationId}`,
    "channel-live",
  ]);

  await service.open(direct);
  assert.deepEqual(opened, [channel, direct]);
  assert.equal(service.getSnapshot().address?.conversationId, direct.conversationId);
  assert.deepEqual(service.getSnapshot().messages.map(({ id }) => id), [
    `history:${direct.conversationId}`,
  ]);
  service.dispose();
});

test("IM Chat sends the active draft through the same service for a private Group", async () => {
  const sent: SendTextInput[] = [];
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    async sendText(input) {
      sent.push(input);
      return message("sent-1", input.channel.conversationId, input.text);
    },
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  }, { createRequestId: () => "request-1" });
  await service.open(direct);
  service.setDraft("hello");

  await service.sendDraft();

  assert.deepEqual(sent, [{
    channel: direct,
    clientRequestId: "request-1",
    mentions: [],
    text: "hello",
  }]);
  assert.equal(service.getSnapshot().draft, "");
  assert.deepEqual(service.getSnapshot().messages.map(({ id }) => id), ["sent-1"]);
  service.dispose();
});
