import assert from "node:assert/strict";
import test from "node:test";

import {
  AppServerBotConversationResolver,
  AppServerBotConversationSource,
  createCordisBotConversationRuntime,
  type HostBotConversationEvent,
} from "@opencraft/bot-conversation-appserver";
import type { AppServerBotConversationService } from "@opencraft/bot-conversation-appserver";
import { createCordisAppServerRegistry } from "@opencraft/appserver-client";
import { projectBotTimeline } from "@opencraft/bot-conversation";
import { createConversationKey } from "@opencraft/chat-core";
import type { SubmitIntent } from "@opencraft/composer-core";

const HUMAN = {
  participantId: "person:you",
  kind: "human" as const,
  displayName: "You",
};

const BOT = {
  participantId: "bot:fixture",
  kind: "bot" as const,
  displayName: "Fixture",
};

const CONVERSATION = {
  conversationId: "remote-conversation",
  revision: 1,
  topology: "direct" as const,
  title: "Fixture conversation",
  participantIds: [HUMAN.participantId, BOT.participantId],
  createdAtMs: 1,
  updatedAtMs: 1,
};

function botMessage(
  messageId: string,
  text: string,
  options: { clientMessageId?: string; state?: "streaming" | "complete" | "failed" } = {},
) {
  return {
    messageId,
    conversationId: CONVERSATION.conversationId,
    ...(options.clientMessageId === undefined ? {} : { clientMessageId: options.clientMessageId }),
    author: BOT,
    createdAtMs: 2,
    updatedAtMs: 2,
    state: options.state ?? "complete",
    content: [{ type: "text" as const, text }],
  };
}

class FakeBotService {
  private listener: ((event: HostBotConversationEvent) => void) | null = null;
  onRead: (() => void) | null = null;
  readCalls = 0;
  sendCalls = 0;
  respondCalls = 0;
  interactions: Array<{
    interactionId: string;
    conversationId: string;
    executionId: string;
    participantId: string;
    kind: "approval";
    status: "pending" | "resolved" | "expired";
    title: string;
    choices: Array<{ choiceId: string; label: string }>;
  }> = [];

  subscribe(listener: (event: HostBotConversationEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(event: HostBotConversationEvent): void {
    this.listener?.(event);
  }

  async listConversations() {
    return { data: [CONVERSATION] };
  }

  async waitForCapability() {
    return { version: 1 };
  }

  async readConversation() {
    this.readCalls += 1;
    this.onRead?.();
    return {
      conversation: CONVERSATION,
      participants: [HUMAN, BOT],
      initialMessagesPage: { data: [] },
      executions: [],
      interactions: this.interactions,
      presence: [],
      liveCursor: { epoch: "epoch-1", nextSeq: 0 },
    };
  }

  async sendMessage(_hostId: string, params: { clientMessageId: string }) {
    this.sendCalls += 1;
    return {
      message: {
        ...botMessage("server-message", "hello", { clientMessageId: params.clientMessageId }),
        author: HUMAN,
      },
      executions: [],
      replayed: false,
    };
  }

  async uploadAttachment(): Promise<never> {
    throw new Error("not expected");
  }

  async respondToInteraction(
    _hostId: string,
    params: { interactionId: string },
  ) {
    this.respondCalls += 1;
    const current = this.interactions.find(
      (interaction) => interaction.interactionId === params.interactionId,
    );
    if (current === undefined) throw new Error("unknown interaction");
    const resolved = { ...current, status: "resolved" as const };
    this.interactions = this.interactions.map((interaction) =>
      interaction.interactionId === params.interactionId ? resolved : interaction
    );
    return resolved;
  }
}

const asService = (value: FakeBotService): AppServerBotConversationService =>
  value as unknown as AppServerBotConversationService;

test("deleted Bot invalidates its open conversation and rejects further sends without a request", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  await source.load(key);
  service.emit({ hostId: "host-a", method: "bot/deleted", params: { botId: "fixture", revision: 2 } });
  assert.equal(source.getSnapshot(key).phase, "error");
  await assert.rejects(source.load(key), /已删除/);
  assert.equal(service.sendCalls, 0);
  source.dispose();
});

test("Bot AppServer Cordis service declares and resolves its client-registry dependency", async () => {
  const registry = await createCordisAppServerRegistry();
  try {
    const bots = await createCordisBotConversationRuntime(registry.context);
    try {
      assert.equal(bots.service.supports("missing-host"), false);
    } finally {
      await bots.dispose();
    }
  } finally {
    await registry.dispose();
  }
});

test("Bot AppServer Source commits snapshot and buffered live events as one hydration frame", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  const observed: Array<{ phase: string; messages: number }> = [];
  source.subscribe(key, () => {
    const snapshot = source.getSnapshot(key);
    observed.push({ phase: snapshot.phase, messages: snapshot.transcript.length });
  });
  service.onRead = () => service.emit({
    hostId: "host-a",
    method: "bot/message/started",
    params: {
      conversationId: CONVERSATION.conversationId,
      stamp: { epoch: "epoch-1", seq: 0 },
      message: botMessage("live-message", "streaming", { state: "streaming" }),
    },
  });

  await source.load(key);

  assert.deepEqual(observed, [
    { phase: "loading", messages: 0 },
    { phase: "ready", messages: 1 },
  ]);
  assert.equal(source.getSnapshot(key).transcript[0]?.id, "live-message");
  source.dispose();
});

test("Bot AppServer Source repairs a live cursor gap with one unpublished resync", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  const observed: string[] = [];
  let resolveReady!: () => void;
  const repaired = new Promise<void>((resolve) => { resolveReady = resolve; });
  source.subscribe(key, () => {
    const phase = source.getSnapshot(key).phase;
    observed.push(phase);
    if (phase === "ready") resolveReady();
  });
  service.onRead = () => {
    if (service.readCalls !== 1) return;
    service.emit({
      hostId: "host-a",
      method: "bot/message/started",
      params: {
        conversationId: CONVERSATION.conversationId,
        stamp: { epoch: "epoch-1", seq: 1 },
        message: botMessage("gap-message", "missing prefix", { state: "streaming" }),
      },
    });
  };

  await source.load(key);
  await repaired;

  assert.equal(service.readCalls, 2);
  assert.deepEqual(observed, ["loading", "ready"]);
  source.dispose();
});

test("Bot AppServer Source reconciles optimistic and acknowledged messages by client identity", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  await source.load(key);
  const intent: SubmitIntent = {
    commandId: "command-1",
    clientMessageId: "client-message-1",
    target: { type: "existing-thread", key },
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "hello" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 10,
  };

  await source.send(key, intent);

  const transcript = source.getSnapshot(key).transcript;
  assert.equal(service.sendCalls, 1);
  assert.equal(service.readCalls, 1);
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0]?.id, "server-message");
  assert.equal(transcript[0]?.clientMessageId, "client-message-1");
  assert.equal(transcript[0]?.delivery, "sent");
  source.dispose();
});

test("sending retains the live transcript without rehydrating from lagging history", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  await source.load(key);
  service.emit({
    hostId: "host-a",
    method: "bot/message/completed",
    params: {
      conversationId: CONVERSATION.conversationId,
      stamp: { epoch: "epoch-1", seq: 0 },
      message: botMessage("historical-live-message", "previous answer"),
    },
  });
  const intent: SubmitIntent = {
    commandId: "command-after-history",
    clientMessageId: "client-after-history",
    target: { type: "existing-thread", key },
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: [{ type: "text", text: "next question" }] }],
    },
    attachments: [],
    context: [],
    selections: {},
    options: { autoContext: true },
    createdAt: 20,
  };

  await source.send(key, intent);

  assert.equal(service.readCalls, 1);
  assert.deepEqual(
    source.getSnapshot(key).transcript.map(({ id }) => id),
    ["historical-live-message", "server-message"],
  );
  source.dispose();
});

test("Bot AppServer Source owns pending interactions through hydration and response", async () => {
  const service = new FakeBotService();
  service.interactions = [{
    interactionId: "approval-1",
    conversationId: CONVERSATION.conversationId,
    executionId: "execution-1",
    participantId: BOT.participantId,
    kind: "approval",
    status: "pending",
    title: "Publish this build?",
    choices: [{ choiceId: "allow", label: "Allow" }],
  }];
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);

  await source.load(key);
  assert.equal(source.getSnapshot(key).interactions[0]?.status, "pending");

  await source.respondToInteraction(
    key,
    "approval-1",
    "execution-1",
    { type: "approval", choiceId: "allow" },
  );

  assert.equal(service.respondCalls, 1);
  assert.equal(source.getSnapshot(key).interactions[0]?.status, "resolved");
  source.dispose();
});

test("failed Bot executions keep only safe error categories in the timeline", async () => {
  const service = new FakeBotService();
  const source = new AppServerBotConversationSource(asService(service));
  const key = createConversationKey("host-a", CONVERSATION.conversationId);
  await source.load(key);
  service.emit({
    hostId: "host-a",
    method: "bot/execution/updated",
    params: {
      conversationId: CONVERSATION.conversationId,
      stamp: { epoch: "epoch-1", seq: 0 },
      execution: {
        executionId: "failed-1",
        conversationId: CONVERSATION.conversationId,
        participantId: BOT.participantId,
        causalMessageId: "message-1",
        status: "failed",
        startedAtMs: 1,
        completedAtMs: 2,
        error: {
          code: "BOT_PROVIDER_QUOTA_LIMIT",
          retryable: false,
          details: { error: "private provider diagnostic" },
        },
      },
    },
  });
  const snapshot = source.getSnapshot(key);
  const failure = snapshot.executions[0];
  assert.deepEqual(failure?.error, { code: "BOT_PROVIDER_QUOTA_LIMIT", retryable: false });
  assert.doesNotMatch(JSON.stringify(failure), /private provider diagnostic/u);
  const timeline = projectBotTimeline({
    transcript: snapshot.transcript,
    executions: snapshot.executions,
    presence: snapshot.presence,
    revision: snapshot.revision,
  });
  assert.equal(timeline.units.find((unit) => unit.kind === "execution")?.kind, "execution");
  source.dispose();
});

test("Bot resolver shares one activation but never reuses its idempotency ticket forever", async () => {
  const conversations: typeof CONVERSATION[] = [];
  const requestIds: string[] = [];
  let conversationSequence = 0;
  const service = {
    async waitForCapability() {
      return { version: 1 };
    },
    async listConversations() {
      return { data: [...conversations] };
    },
    async listBots() {
      return {
        data: [{ botId: "fixture", status: "available" as const }],
      };
    },
    async createConversation(
      _hostId: string,
      params: { clientRequestId: string },
    ) {
      requestIds.push(params.clientRequestId);
      await Promise.resolve();
      const conversation = {
        ...CONVERSATION,
        conversationId: `conversation-${++conversationSequence}`,
      };
      conversations.push(conversation);
      return { conversation, replayed: false };
    },
  } as unknown as AppServerBotConversationService;
  let idSequence = 0;
  const resolver = new AppServerBotConversationResolver(
    service,
    () => `request-${++idSequence}`,
  );

  const [left, right] = await Promise.all([
    resolver.resolve({ hostId: "host-a", botId: "fixture" }),
    resolver.resolve({ hostId: "host-a", botId: "fixture" }),
  ]);
  assert.equal(left.threadId, right.threadId);
  assert.equal(requestIds.length, 1);

  conversations.length = 0;
  const next = await resolver.resolve({ hostId: "host-a", botId: "fixture" });
  assert.notEqual(next.threadId, left.threadId);
  assert.equal(requestIds.length, 2);
  assert.notEqual(requestIds[0], requestIds[1]);
});
