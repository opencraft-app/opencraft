import assert from "node:assert/strict";
import test from "node:test";

import type { AppServerClient, AppServerClientRegistryService } from "@opencraft/appserver-client";
import type { AppServerBotDescriptor, BotConversationsCapability } from "@opencraft/appserver-protocol";
import {
  AppServerBotDirectory,
  type AppServerBotConversationService,
} from "@opencraft/bot-conversation-appserver";

const capability: BotConversationsCapability = {
  version: 1,
  topologies: ["direct"],
  features: {
    messageStreaming: true,
    executionCancellation: true,
    attachments: true,
    interactions: false,
    botManagement: true,
    botAssets: false,
    groupMembership: false,
    configuration: false,
    routines: false,
  },
  limits: { maxPageSize: 1, maxInlineAttachmentBytes: 1024, maxParticipants: 2 },
};

const bot = (botId: string): AppServerBotDescriptor => ({
  botId,
  revision: 1,
  name: botId,
  status: "available",
  capabilities: [],
});

test("Bot directory drains opaque pages and retains entities while a Host is offline", async () => {
  let status = { state: "idle" as const };
  let statusListener: (() => void) | null = null;
  const client = {
    hostId: "remote",
    get status() { return status; },
    initializeResult: null,
    subscribeStatus(listener: () => void) {
      statusListener = listener;
      return () => { statusListener = null; };
    },
  } as unknown as AppServerClient;
  const clients = {
    getAll: () => [client],
    get: (hostId: string) => hostId === "remote" ? client : null,
    subscribeEvent: () => () => undefined,
  } as unknown as AppServerClientRegistryService;
  const cursors: Array<string | undefined> = [];
  const service = {
    subscribe: () => () => undefined,
    waitForCapability: async () => capability,
    listBots: async (_hostId: string, params: { readonly cursor?: string }) => {
      cursors.push(params.cursor);
      return params.cursor === undefined
        ? { data: [bot("one")], nextCursor: "page-2" }
        : { data: [bot("two")] };
    },
  } as unknown as AppServerBotConversationService;
  const directory = new AppServerBotDirectory(service, clients);

  await directory.refresh("remote");
  assert.deepEqual(cursors, [undefined, "page-2"]);
  assert.deepEqual(directory.getSnapshot().entries.map((entry) => entry.bot.botId), ["one", "two"]);
  assert.ok(directory.getSnapshot().entries.every((entry) => entry.availability === "available"));

  status = { state: "closed" };
  statusListener?.();
  assert.equal(directory.getSnapshot().hosts[0]?.phase, "offline");
  assert.ok(directory.getSnapshot().entries.every((entry) => entry.availability === "unavailable"));
  directory.dispose();
});

test("a late Bot create result cannot repopulate a replaced Host", async () => {
  let resolveCreate: ((value: unknown) => void) | undefined;
  const original = { hostId: "remote", connectionGeneration: 1, subscribeStatus: () => () => {}, status: { state: "idle" } } as unknown as AppServerClient;
  let current: AppServerClient | null = original;
  const clients = { getAll: () => [], get: () => current, subscribeEvent: () => () => {} } as unknown as AppServerClientRegistryService;
  const service = { subscribe: () => () => {}, waitForCapability: async () => capability,
    createBot: () => new Promise(resolve => { resolveCreate = resolve; }),
  } as unknown as AppServerBotConversationService;
  const directory = new AppServerBotDirectory(service, clients);
  const pending = directory.create("remote", { clientRequestId: "create", name: "New" });
  await new Promise(resolve => setImmediate(resolve));
  current = null;
  resolveCreate!({ bot: bot("late"), replayed: false });
  await assert.rejects(pending, /连接已改变/);
  assert.deepEqual(directory.getSnapshot().entries, []);
  directory.dispose();
});
