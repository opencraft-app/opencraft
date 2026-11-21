import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { ChannelSync, type ChannelArrival, type ChannelSyncTransport } from "../../plugins/im/src/channel-sync";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "connection-isolation-"));
  let storage = await openServerDatabase(directory),
    actors = new ActorStore(storage),
    service = new Collaboration(storage, actors);
  const actor = actors.resolveHuman({
    provider: "fixture",
    subject: "operator",
    displayName: "Operator",
    expiresAt: Date.now() + 120000,
  })!;
  const stops: (() => Promise<void>)[] = [];
  const call = (method: string, params: Record<string, unknown>) =>
    service.communicate(actor, "opencraft/channels/" + method, params);
  const groups = await Promise.all(
    ["a", "b", "c"].map((id) => call("group/create", { title: id, memberActorIds: [], clientRequestId: id })),
  );
  const bindings = groups.map((g, i) => ({ source: "fixture-source-" + i, channelId: g.id }));
  const sync = (
    connectionId: string | undefined,
    incarnation: string,
    method: string,
    params: Record<string, unknown> = {},
  ) =>
    service.synchronizeChannels({
      method,
      params: { ...params, ...(connectionId === undefined ? {} : { connectionId }), incarnation },
    });
  const configure = (id: string, incarnation: string, index: number) =>
    sync(id, incarnation, "configure", { bindings: [bindings[index]], images: true });
  const send = (index: number, key: string) =>
    call("messages/send", { channelId: groups[index].id, clientMessageId: key, parts: [{ type: "text", text: key }] });
  const states = () =>
    storage.database.prepare("SELECT source,state,attempt_id FROM actor_channel_outbox ORDER BY rowid").all();
  const incoming = (index: number) => ({
    source: bindings[index].source,
    id: "same-external-id",
    author: "external-member",
    text: "hello",
    at: 1000,
  });
  t.after(async () => {
    for (const stop of stops.reverse()) await stop();
    await service.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get storage() {
      return storage;
    },
    get service() {
      return service;
    },
    bindings,
    groups,
    actor,
    call,
    sync,
    configure,
    send,
    states,
    incoming,
    stops,
    async reopen() {
      await service.close();
      actors.close();
      await storage.close();
      storage = await openServerDatabase(directory);
      actors = new ActorStore(storage);
      service = new Collaboration(storage, actors);
    },
  };
}
const attempt = (row: any) => ({ source: row.source, messageId: row.messageId, attemptId: row.attemptId });
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Connection work did not settle");
}

test("restarting A fences only its old attempts and never resets or consumes B work", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "a1", 0);
  await f.configure("adapter.b", "b1", 1);
  await f.send(0, "a-claimed");
  await f.send(0, "a-queued");
  await f.send(1, "b-claimed");
  await f.send(1, "b-queued");
  const a = await f.sync("adapter.a", "a1", "claim"),
    b = await f.sync("adapter.b", "b1", "claim");
  assert.equal(a.source, f.bindings[0].source);
  assert.equal(b.source, f.bindings[1].source);
  await f.configure("adapter.a", "a2", 0);
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["unknown", "queued", "sending", "queued"],
  );
  await assert.rejects(f.sync("adapter.a", "a1", "settle", { ...attempt(a), status: "delivered" }), /retired/);
  await f.sync("adapter.b", "b1", "settle", { ...attempt(b), status: "delivered" });
  const next = await f.sync("adapter.a", "a2", "claim");
  assert.equal(next.text, "a-queued");
  await f.sync("adapter.a", "a2", "settle", { ...attempt(next), status: "delivered" });
  assert.equal(await f.sync("adapter.a", "a2", "claim"), null);
  assert.equal((await f.sync("adapter.b", "b1", "claim")).text, "b-queued");
});

test("removing A bindings preserves B pending images, attribution and queued messages", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "a1", 0);
  await f.configure("adapter.b", "b1", 1);
  await f.send(0, "remove-a");
  await f.send(1, "keep-b");
  const arrival = { ...f.incoming(1), text: "", mediaId: "fixture-image" };
  const receipt = await f.sync("adapter.b", "b1", "ingest", { source: arrival.source, arrival });
  const before = await f.sync("adapter.b", "b1", "pendingImage");
  assert.equal(before.messageId, receipt.messageId);
  f.storage.database
    .prepare("UPDATE actor_channel_images SET attribution='sending' WHERE message_id=?")
    .run(receipt.messageId);
  await f.sync("adapter.a", "a2", "configure", { bindings: [], images: false });
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["rejected", "queued"],
  );
  assert.deepEqual(await f.sync("adapter.b", "b1", "pendingImage"), before);
  assert.equal(
    f.storage.database
      .prepare("SELECT attribution FROM actor_channel_images WHERE message_id=?")
      .get(receipt.messageId)!.attribution,
    "sending",
  );
  assert.equal((await f.sync("adapter.b", "b1", "claim")).text, "keep-b");
});

test("an old incarnation cannot add new sources, claim work or close its replacement", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "old", 0);
  await f.configure("adapter.a", "new", 0);
  await f.configure("adapter.b", "b1", 1);
  await assert.rejects(f.sync("adapter.a", "old", "addSource", { binding: f.bindings[2] }), /retired/);
  for (const method of ["claim", "pendingImage"]) await assert.rejects(f.sync("adapter.a", "old", method), /retired/);
  await f.sync("adapter.a", "old", "deactivate");
  assert.equal(
    f.storage.database.prepare("SELECT active FROM actor_channel_sources WHERE source=?").get(f.bindings[0].source)!
      .active,
    1,
  );
  await f.sync("adapter.a", "new", "addSource", { binding: f.bindings[2] });
  await f.send(2, "dynamic-a");
  await f.send(1, "still-b");
  assert.equal((await f.sync("adapter.a", "new", "claim")).text, "dynamic-a");
  assert.equal((await f.sync("adapter.b", "b1", "claim")).text, "still-b");
});

test("ownership rejects cross-connection adoption, reads and retire even with the same incarnation token", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "same-token", 0);
  await f.configure("adapter.b", "same-token", 1);
  await f.send(1, "b-pending");
  await assert.rejects(f.configure("adapter.b", "new-b", 0), /connection_conflict/);
  await assert.rejects(
    f.sync("adapter.b", "same-token", "addSource", { binding: f.bindings[0] }),
    /connection_conflict/,
  );
  const arrival = f.incoming(0);
  await f.sync("adapter.a", "same-token", "ingest", { source: arrival.source, arrival });
  await assert.rejects(f.sync("adapter.b", "same-token", "ingest", { source: arrival.source, arrival }), /retired/);
  await assert.rejects(
    f.sync("adapter.b", "same-token", "received", { source: arrival.source, arrival }),
    /invalid_input/,
  );
  await assert.rejects(
    f.sync("adapter.b", "same-token", "externalHistory", { source: arrival.source, after: 0, query: "hello" }),
    /invalid_input/,
  );
  await assert.rejects(f.sync("adapter.b", "same-token", "retireSource", { source: arrival.source }), /retired/);
  await assert.rejects(f.sync(undefined, "legacy", "configure", { bindings: [f.bindings[0]] }), /connection_conflict/);
  assert.equal((await f.sync("adapter.b", "same-token", "claim")).text, "b-pending");
});

test("source ownership and unknown outcomes survive reopening the real storage owner", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "a1", 0);
  await f.configure("adapter.b", "b1", 1);
  await f.send(0, "uncertain-a");
  await f.send(1, "queued-b");
  await f.sync("adapter.a", "a1", "claim");
  const before = f.storage.database.prepare("SELECT * FROM actor_channel_source_owners ORDER BY source").all();
  await f.reopen();
  assert.deepEqual(
    f.storage.database.prepare("SELECT * FROM actor_channel_source_owners ORDER BY source").all(),
    before,
  );
  await f.configure("adapter.b", "b2", 1);
  assert.equal(f.states()[0].state, "sending");
  await f.configure("adapter.a", "a2", 0);
  assert.equal(f.states()[0].state, "unknown");
  assert.equal(await f.sync("adapter.a", "a2", "claim"), null);
  assert.equal((await f.sync("adapter.b", "b2", "claim")).text, "queued-b");
});

test("two real ChannelSync adapters independently ingest, send, restart and close", async (t) => {
  const f = await fixture(t);
  const sent = [[] as string[], [] as string[]];
  const receivers: Array<(a: ChannelArrival) => Promise<void>> = [];
  const adapter = (i: number): ChannelSyncTransport => ({
    connectionId: "synthetic." + i,
    bindings: [f.bindings[i]],
    subscribe(fn) {
      receivers[i] = fn;
      return () => {};
    },
    async send(input) {
      sent[i].push(input.text);
      return "delivered";
    },
  });
  let a = await ChannelSync.open(adapter(0), f.service);
  const b = await ChannelSync.open(adapter(1), f.service);
  f.stops.push(
    () => a.close(),
    () => b.close(),
  );
  await receivers[0](f.incoming(0));
  await receivers[1](f.incoming(1));
  await f.send(0, "send-a");
  await f.send(1, "send-b");
  await until(async () => sent[0].length === 1 && sent[1].length === 1);
  assert.deepEqual(sent, [["send-a"], ["send-b"]]);
  const old = receivers[0];
  await a.close();
  await f.send(1, "b-after-a-close");
  await until(async () => sent[1].length === 2);
  await assert.rejects(old({ ...f.incoming(0), id: "after-close" }));
  a = await ChannelSync.open(adapter(0), f.service);
  await f.send(0, "a-after-restart");
  await f.send(1, "b-after-a-restart");
  await until(async () => sent[0].length === 2 && sent[1].length === 3);
  assert.deepEqual(sent, [
    ["send-a", "a-after-restart"],
    ["send-b", "b-after-a-close", "b-after-a-restart"],
  ]);
  await assert.rejects(ChannelSync.open({ ...adapter(0), connectionId: "bad/id" }, f.service), /connection ID/);
});

test("an older owner cannot silently fall back to global configuration for an explicit connection", async () => {
  const calls: string[] = [];
  const transport: ChannelSyncTransport = {
    connectionId: "synthetic.new",
    bindings: [],
    subscribe() {
      assert.fail("Must not subscribe");
    },
    async send() {
      return "delivered";
    },
  };
  const port = {
    channels: {
      onChange() {
        assert.fail("Must not watch");
      },
    },
    async synchronizeChannels(command: { method: string }) {
      calls.push(command.method);
      return undefined;
    },
  };
  await assert.rejects(ChannelSync.open(transport, port), /isolation unavailable/);
  assert.deepEqual(calls, ["connectionCapabilities"]);
});

test("restart reconciles only its outbound image attribution even when image rows have no source", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "a1", 0);
  await f.configure("adapter.b", "b1", 1);
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  for (const i of [0, 1])
    await f.service.communicate(f.actor, "channel/image/send", {
      channelId: f.groups[i].id,
      clientMessageId: "image-" + i,
      type: "image/png",
      bytes,
    });
  const a = await f.sync("adapter.a", "a1", "claim"),
    b = await f.sync("adapter.b", "b1", "claim");
  await f.sync("adapter.a", "a1", "attribution", { ...attempt(a), status: "sending" });
  await f.sync("adapter.b", "b1", "attribution", { ...attempt(b), status: "sending" });
  await f.configure("adapter.a", "a2", 0);
  const image = (id: string) =>
    f.storage.database.prepare("SELECT source,attribution FROM actor_channel_images WHERE message_id=?").get(id)!;
  assert.equal(image(a.messageId).source, null);
  assert.equal(image(a.messageId).attribution, "unknown");
  assert.equal(image(b.messageId).attribution, "sending");
});

test("the default legacy transport and an explicit connection coexist without global resets", async (t) => {
  const f = await fixture(t);
  await f.sync(undefined, "old-legacy", "configure", { bindings: [f.bindings[0]], images: true });
  await f.configure("adapter.b", "b1", 1);
  await f.send(0, "legacy-work");
  await f.send(1, "explicit-work");
  const b = await f.sync("adapter.b", "b1", "claim");
  await f.sync(undefined, "new-legacy", "configure", { bindings: [f.bindings[0]], images: true });
  assert.deepEqual(
    f.states().map((r) => r.state),
    ["queued", "sending"],
  );
  await f.sync("adapter.b", "b1", "settle", { ...attempt(b), status: "delivered" });
  assert.equal((await f.sync(undefined, "new-legacy", "claim")).text, "legacy-work");
});

test("a late channel uniqueness failure rolls back only the attempted reconfiguration", async (t) => {
  const f = await fixture(t);
  await f.configure("adapter.a", "a1", 0);
  await f.configure("adapter.b", "b1", 1);
  await f.send(0, "in-flight-a");
  await f.send(1, "queued-b");
  const claimed = await f.sync("adapter.a", "a1", "claim"),
    before = f.states();
  await assert.rejects(
    f.sync("adapter.a", "a2", "configure", {
      bindings: [f.bindings[0], { source: "new-duplicate", channelId: f.groups[1].id }],
      images: true,
    }),
    /UNIQUE|constraint/,
  );
  assert.deepEqual(f.states(), before);
  await f.sync("adapter.a", "a1", "settle", { ...attempt(claimed), status: "delivered" });
  assert.equal((await f.sync("adapter.b", "b1", "claim")).text, "queued-b");
  assert.equal(
    f.storage.database.prepare("SELECT 1 FROM actor_channel_source_owners WHERE source=?").get("new-duplicate"),
    undefined,
  );
});
