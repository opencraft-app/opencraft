import assert from "node:assert/strict";
import test from "node:test";

import {
  MessagingSendError,
  type ConversationAddress,
  type Message,
  type MessagePage,
  type SendTextInput,
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
    reconcileMessage: async () => { throw new Error("not used"); },
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

test("a live message received during history loading remains visible after the page arrives", async () => {
  let emitLive: (messages: Message[]) => void = () => undefined;
  let resolveHistory: ((page: MessagePage) => void) | null = null;
  let historyStarted!: () => void;
  const waitingForHistory = new Promise<void>((resolve) => { historyStarted = resolve; });
  const service = new ImChatService({
    loadHistory: async () => new Promise<MessagePage>((resolve) => {
      resolveHistory = resolve;
      historyStarted();
    }),
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
    sendText: async () => { throw new Error("not used"); },
    subscribeMessages(listener) {
      emitLive = listener;
      return () => { emitLive = () => undefined; };
    },
    waitUntilReady: async () => undefined,
  });

  const opening = service.open(channel);
  await waitingForHistory;
  emitLive([{
    ...message("live-1", channel.conversationId, "new"),
    createdAt: "2026-09-14T12:01:00Z",
  }]);
  assert.deepEqual(service.getSnapshot().messages.map((item) => item.id), ["live-1"]);
  resolveHistory!({
    completed: true,
    messages: [message("history-1", channel.conversationId, "older")],
  });
  await opening;
  assert.deepEqual(service.getSnapshot().messages.map((item) => item.id), [
    "history-1",
    "live-1",
  ]);
  service.dispose();
});

test("IM Chat sends the active draft through the same service for a private Group", async () => {
  const sent: SendTextInput[] = [];
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
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

test("an uncertain send is reconciled by its original request ID before another send", async () => {
  const sent: SendTextInput[] = [];
  const reconciled: string[] = [];
  const confirmed = { ...message("confirmed-1", channel.conversationId, "hello"), direction: "outgoing" as const };
  let confirmedRemotely = false;
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    sendText: async (input) => {
      sent.push(input);
      throw new MessagingSendError("ack lost", { outcome: "uncertain", retryable: false });
    },
    reconcileMessage: async (input) => {
      reconciled.push(input.clientRequestId);
      return confirmedRemotely ? { state: "sent", message: confirmed } : { state: "pending" };
    },
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  });
  await service.open(channel);
  service.setDraft("hello");

  await service.sendDraft();
  assert.equal(service.getSnapshot().draft, "hello");
  confirmedRemotely = true;
  await service.sendDraft();

  assert.equal(sent.length, 1);
  assert.ok(reconciled.length > 0);
  assert.ok(reconciled.every((id) => id === sent[0]?.clientRequestId));
  assert.deepEqual(service.getSnapshot().messages.map((item) => item.id), ["confirmed-1"]);
  assert.equal(service.getSnapshot().draft, "");
  service.dispose();
});

test("IM Chat keeps Channel and private drafts separate when switching conversations", async () => {
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
    sendText: async () => { throw new Error("not used"); },
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  });

  await service.open(channel);
  service.setDraft("channel draft");
  await service.open(direct);
  assert.equal(service.getSnapshot().draft, "");
  service.setDraft("private draft");
  await service.open(channel);
  assert.equal(service.getSnapshot().draft, "channel draft");
  await service.open(direct);
  assert.equal(service.getSnapshot().draft, "private draft");
  service.dispose();
});

test("a late send clears only its original conversation draft", async () => {
  let resolveSend: ((value: Message) => void) | null = null;
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
    sendText: async () => new Promise<Message>((resolve) => { resolveSend = resolve; }),
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  });

  await service.open(channel);
  service.setDraft("sent from channel");
  const sending = service.sendDraft();
  await service.open(direct);
  service.setDraft("private draft");
  resolveSend!(message("sent-1", channel.conversationId, "sent from channel"));
  await sending;
  assert.equal(service.getSnapshot().draft, "private draft");
  await service.open(channel);
  assert.equal(service.getSnapshot().draft, "");
  service.dispose();
});

test("reopening a conversation cannot submit its in-flight draft twice", async () => {
  let resolveSend!: (value: Message) => void;
  const sent: SendTextInput[] = [];
  const service = new ImChatService({
    loadHistory: async () => ({ completed: true, messages: [] }),
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
    sendText: async (input) => {
      sent.push(input);
      if (sent.length === 1) return new Promise<Message>((resolve) => { resolveSend = resolve; });
      return message("duplicate", input.channel.conversationId, input.text);
    },
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  });
  await service.open(channel);
  service.setDraft("one message");
  const first = service.sendDraft();
  try {
    await service.open(direct);
    await service.open(channel);
    await service.sendDraft();
    assert.equal(sent.length, 1);
    assert.equal(service.getSnapshot().phase, "sending");
  } finally {
    resolveSend(message("sent-1", channel.conversationId, "one message"));
    await first;
    service.dispose();
  }
});

test("IM Chat loads older pages in chronological order without duplicating messages", async () => {
  const cursors: Array<string | undefined> = [];
  const at = (id: string, minute: number) => ({
    ...message(id, channel.conversationId, id),
    createdAt: `2026-09-14T12:${String(minute).padStart(2, "0")}:00Z`,
  });
  const service = new ImChatService({
    loadHistory: async (_address, cursor) => {
      cursors.push(cursor);
      return cursor === undefined
        ? { completed: false, nextCursor: "older-1", messages: [at("m3", 3)] }
        : { completed: true, messages: [at("m1", 1), at("m2", 2), at("m3", 3)] };
    },
    markRead: async () => undefined,
    reconcileMessage: async () => { throw new Error("not used"); },
    sendText: async () => { throw new Error("not used"); },
    subscribeMessages: () => () => undefined,
    waitUntilReady: async () => undefined,
  });

  await service.open(channel);
  assert.equal(service.getSnapshot().historyCompleted, false);
  await service.loadOlder();
  assert.deepEqual(cursors, [undefined, "older-1"]);
  assert.deepEqual(service.getSnapshot().messages.map((item) => item.id), ["m1", "m2", "m3"]);
  assert.equal(service.getSnapshot().historyCompleted, true);
  service.dispose();
});
