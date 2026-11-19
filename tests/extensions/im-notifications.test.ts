import test from "node:test";
import assert from "node:assert/strict";
import { ImChannelService } from "../../scripts/im-channel-service.mjs";
import { SlackPlugin } from "../../plugins/slack/src/server";
test("IM notification targets require verified personal bindings and revoke immediately without SQL reads", async () => {
  const calls: any[] = [];
  const service = Object.create(ImChannelService.prototype);
  service.dependencies = {
    actors: { get: (id: string) => ({ id, enabled: true, kind: "human" }) },
    admittedActor: () => true,
  };
  service.store = new Proxy(
    {},
    {
      get() {
        throw Error("notification path must not perform SQL");
      },
    },
  );
  service.adapters = new Map([
    [
      "channel",
      {
        name: "Work",
        notificationSenders: new Map([
          ["self", "human-a"],
          ["other", "human-b"],
        ]),
        adapter: {
          state: "ready",
          sendDirect: async (...args: any[]) => {
            calls.push(args);
          },
        },
      },
    ],
  ]);
  assert.deepEqual(service.notificationTargets("human-a"), [
    { channelId: "channel", senderId: "self", label: "Work · self" },
  ]);
  assert.throws(() => service.prepareDirectNotification("channel", "other", "human-a"));
  const send = service.prepareDirectNotification("channel", "self", "human-a");
  await send("Finished", "event1");
  assert.equal(calls.length, 1);
  service.adapters.get("channel").notificationSenders.delete("self");
  await assert.rejects(send("Finished", "event2"));
  assert.equal(calls.length, 1);
  service.dependencies.admittedActor = () => false;
  assert.equal(service.notificationTargets("human-b").length, 0);
});
test("Slack direct notifications resolve the selected user and suppress link previews", async () => {
  const calls: any[] = [];
  const adapter = new SlackPlugin(
    {
      botToken: "synthetic",
      appToken: "synthetic-app",
      workspaceId: "TTEST",
      botUserId: "UBOT",
      receive: async () => {},
    },
    async (_token, method, body) => {
      calls.push({ method, body });
      return method === "conversations.open" ? { channel: { id: "DTEST" } } : { ts: "1.1" };
    },
  );
  (adapter as any).phase = "ready";
  await adapter.sendDirect("UTEST", "Response complete", "event");
  assert.deepEqual(calls, [
    { method: "conversations.open", body: { users: "UTEST" } },
    {
      method: "chat.postMessage",
      body: { channel: "DTEST", text: "Response complete", unfurl_links: false, unfurl_media: false },
    },
  ]);
  await assert.rejects(adapter.sendDirect("group", "Response complete", "event"));
  adapter.close();
  await assert.rejects(adapter.sendDirect("UTEST", "Response complete", "event"));
});
test("Slack rechecks the identity lease after resolving the DM and before sending", async () => {
  let current = true;
  const calls: string[] = [];
  const adapter = new SlackPlugin(
    {
      botToken: "synthetic",
      appToken: "synthetic-app",
      workspaceId: "TTEST",
      botUserId: "UBOT",
      receive: async () => {},
    },
    async (_token, method) => {
      calls.push(method);
      current = false;
      return { channel: { id: "DTEST" } };
    },
  );
  (adapter as any).phase = "ready";
  await assert.rejects(
    adapter.sendDirect("UTEST", "private title", "event", () => {
      if (!current) throw Error("revoked");
    }),
  );
  assert.deepEqual(calls, ["conversations.open"]);
  adapter.close();
});

test("connection-owned notification methods join the existing personal port without creating chats or allowing other recipients", async () => {
  const service = Object.create(ImChannelService.prototype),
    calls: any[] = [];
  let linked = true;
  service.dependencies = {
    actors: { get: (id: string) => ({ id, enabled: true, kind: "human" }) },
    admittedActor: () => true,
  };
  service.adapters = new Map();
  const port = {
    targets: (actorId: string) =>
      linked && actorId === "human-a"
        ? [
            {
              channelId: "product.channel",
              senderId: "self",
              label: "My account",
              methodId: "product.notifications",
              methodLabel: "Product channel",
            },
          ]
        : [],
    async send(actorId: string, target: any, content: string, id: string, assertCurrent: () => void) {
      assertCurrent();
      calls.push({ actorId, target, content, id });
    },
  };
  service.channelSync = { transport: { notifications: port } };
  assert.equal(service.notificationTargets("human-b").length, 0);
  assert.equal(service.notificationTargets("human-a")[0].methodLabel, "Product channel");
  assert.throws(() => service.prepareDirectNotification("product.channel", "other", "human-a"));
  const send = service.prepareDirectNotification("product.channel", "self", "human-a");
  await send("Finished", "once");
  assert.equal(calls.length, 1);
  linked = false;
  await assert.rejects(send("Finished", "revoked"));
  assert.equal(calls.length, 1);
  linked = true;
  service.channelSync.transport.notifications = { ...port };
  await assert.rejects(send("Finished", "replaced"));
  assert.equal(calls.length, 1);
});
