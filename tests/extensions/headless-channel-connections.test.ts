import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { ActorStore } from "../../packages/access-control/src/actors";
import { Collaboration } from "../../packages/access-control/src/collaboration";
import { ImChannelService } from "../../apps/headless-server/src/im-channel-service.mjs";
import { createChannelSyncDependencies } from "../../apps/headless-server/src/im-plugins.mjs";
import { startHeadlessServer } from "../../apps/headless-server/src/headless-server.mjs";
import type { ChannelSyncTransport, ChannelArrival } from "../../plugins/im/src/channel-sync";

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "headless-channels-"));
  const storage = await openServerDatabase(directory);
  const actors = new ActorStore(storage);
  const collaboration = new Collaboration(storage, actors, {
    hostId: "fixture",
    serverId: "server:fixture",
    async validate() {
      throw Error("unexpected execution");
    },
    async receipt() {
      return null;
    },
    async add() {
      throw Error("unexpected execution");
    },
    async steer() {
      throw Error("unexpected execution");
    },
    async cancel() {
      return false;
    },
  });
  const actor = actors.resolveHuman({
    provider: "fixture",
    subject: "operator",
    displayName: "Operator",
    expiresAt: Date.now() + 120000,
  })!;
  let service: ImChannelService | undefined;
  t.after(async () => {
    await service?.close().catch(() => {});
    await collaboration.close();
    actors.close();
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    storage,
    actors,
    collaboration,
    actor,
    call: (method: string, params: Record<string, unknown>) =>
      collaboration.communicate(actor, "opencraft/channels/" + method, params),
    async open(transports: ChannelSyncTransport[], legacy = false) {
      service = await ImChannelService.open([], {
        dataDirectory: directory,
        actors,
        collaboration,
        ...(legacy ? { channelSync: transports[0] } : { channelSyncs: transports }),
      });
      return service;
    },
  };
}
function adapter(connectionId: string, bindings: ChannelSyncTransport["bindings"] = []) {
  const calls: unknown[] = [];
  let receive: ((arrival: ChannelArrival) => Promise<void>) | undefined;
  let stops = 0,
    subscriptions = 0;
  const transport: ChannelSyncTransport = {
    connectionId,
    bindings,
    subscribe(value) {
      receive = value;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    async send(value) {
      calls.push(value);
      return "delivered";
    },
    async close() {
      stops++;
    },
    callback: {
      path: "/__opencraft_im/channel-callback/" + connectionId,
      async handle(_req, res) {
        res.end(connectionId);
      },
    },
  };
  return {
    transport,
    calls,
    get stops() {
      return stops;
    },
    get subscriptions() {
      return subscriptions;
    },
    receive: (arrival: ChannelArrival) => receive!(arrival),
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "connection work did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Headless IM composition routes two native connections, callbacks and shutdown independently", async (t) => {
  const f = await fixture(t);
  const groups = await Promise.all(
    ["a", "b"].map((id) => f.call("group/create", { title: id, memberActorIds: [], clientRequestId: id })),
  );
  const bindings = groups.map((g, i) => ({ source: "provider-" + i, channelId: g.id }));
  const a = adapter("alpha", [bindings[0]]),
    b = adapter("beta", [bindings[1]]);
  const service = await f.open([a.transport, b.transport]);
  assert.equal(service.channelSync, undefined, "multi-connection actions cannot select an arbitrary provider");
  for (let i = 0; i < groups.length; i++)
    await f.call("messages/send", {
      channelId: groups[i].id,
      clientMessageId: "out-" + i,
      parts: [{ type: "text", text: "message-" + i }],
    });
  await until(() => a.calls.length === 1 && b.calls.length === 1);
  assert.equal((a.calls[0] as any).source, bindings[0].source);
  assert.equal((b.calls[0] as any).source, bindings[1].source);
  await a.receive({ source: bindings[0].source, id: "same-id", author: "external", text: "a", at: 1000 });
  await b.receive({ source: bindings[1].source, id: "same-id", author: "external", text: "b", at: 1000 });
  const ended: string[] = [];
  const response = { end: (value: string) => ended.push(value) };
  assert.equal(await service.handleChannelCallback({ method: "POST" }, response, b.transport.callback!.path), true);
  assert.equal(await service.handleChannelCallback({ method: "POST" }, response, a.transport.callback!.path), true);
  assert.equal(await service.handleChannelCallback({ method: "GET" }, response, a.transport.callback!.path), false);
  assert.equal(
    await service.handleChannelCallback({ method: "POST" }, response, "/__opencraft_im/channel-callback/unknown"),
    false,
  );
  assert.deepEqual(ended, ["beta", "alpha"]);
  const registered = a.transport.callback!.path;
  a.transport.callback = {
    path: b.transport.callback!.path,
    async handle() {
      throw Error("unregistered callback");
    },
  };
  assert.equal(await service.handleChannelCallback({ method: "POST" }, response, registered), true);
  assert.deepEqual(ended, ["beta", "alpha", "alpha"]);
  const closing = service.close();
  assert.equal(service.close(), closing);
  await closing;
  assert.deepEqual([a.stops, b.stops, a.subscriptions, b.subscriptions], [1, 1, 0, 0]);
  assert.equal(await service.handleChannelCallback({ method: "POST" }, response, a.transport.callback!.path), false);
  await assert.rejects(
    a.receive({ source: bindings[0].source, id: "late", author: "external", text: "late", at: 1001 }),
  );
  assert.deepEqual(
    f.storage.database
      .prepare("SELECT active FROM actor_channel_connections ORDER BY id")
      .all()
      .map((row) => row.active),
    [0, 0],
  );
});

test("composition preflight rejects duplicate IDs, callback paths and bindings before touching storage", async () => {
  const a = adapter("alpha").transport,
    b = adapter("beta").transport;
  const cases: [unknown, RegExp][] = [
    [{ channelSync: a, channelSyncs: [b] }, /Conflicting/],
    [{ channelSyncs: {} }, /Invalid channel composition/],
    [{ channelSyncs: [a, { ...b, connectionId: "alpha" }] }, /Duplicate channel connection ID/],
    [{ channelSyncs: [a, { ...b, callback: a.callback }] }, /Duplicate channel callback route/],
    [{ channelSyncs: [{ ...a, connectionId: "not valid" }] }, /Invalid channel connection ID/],
    [{ channelSyncs: [{ ...a, callback: { ...a.callback, path: "/arbitrary" } }] }, /Invalid channel callback route/],
    [
      {
        channelSyncs: [
          { ...a, bindings: [{ source: "s", channelId: "c1" }] },
          { ...b, bindings: [{ source: "s", channelId: "c2" }] },
        ],
      },
      /Duplicate channel source binding/,
    ],
    [
      {
        channelSyncs: [
          { ...a, bindings: [{ source: "s1", channelId: "c" }] },
          { ...b, bindings: [{ source: "s2", channelId: "c" }] },
        ],
      },
      /Duplicate channel source binding/,
    ],
    [
      {
        channelSyncs: [
          { ...a, connectionId: undefined },
          { ...b, connectionId: "legacy" },
        ],
      },
      /Duplicate channel connection ID/,
    ],
  ];
  for (const [dependencies, error] of cases) await assert.rejects(ImChannelService.open([], dependencies), error);
});

test("a later startup failure releases started, failed and unstarted connections", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    b = adapter("beta"),
    c = adapter("gamma");
  b.transport.subscribe = () => {
    throw Error("synthetic subscribe failure");
  };
  await assert.rejects(f.open([a.transport, b.transport, c.transport]), /synthetic subscribe failure/);
  assert.deepEqual([a.stops, b.stops, c.stops, a.subscriptions], [1, 1, 1, 0]);
  assert.deepEqual(
    f.storage.database
      .prepare("SELECT active FROM actor_channel_connections ORDER BY id")
      .all()
      .map((row) => row.active),
    [0, 0],
  );
});

test("capability rejection closes its transport and releases the remaining composition", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    b = adapter("beta");
  const methods: string[] = [];
  f.collaboration.synchronizeChannels = async (command) => {
    methods.push(command.method);
    return { version: 0 };
  };
  await assert.rejects(f.open([a.transport, b.transport]), /Channel connection isolation unavailable/);
  assert.deepEqual([a.stops, b.stops, a.subscriptions, b.subscriptions], [1, 1, 0, 0]);
  assert.deepEqual(methods, ["connectionCapabilities"], "an old owner must never receive configure or deactivate");
});

test("shutdown errors do not skip other connections or native deactivation", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    b = adapter("beta");
  a.transport.close = async () => {
    throw Error("synthetic close failure");
  };
  const service = await f.open([a.transport, b.transport]);
  await assert.rejects(service.close(), AggregateError);
  assert.equal(b.stops, 1);
  assert.deepEqual([a.subscriptions, b.subscriptions], [0, 0]);
  assert.deepEqual(
    f.storage.database
      .prepare("SELECT active FROM actor_channel_connections ORDER BY id")
      .all()
      .map((row) => row.active),
    [0, 0],
  );
  assert.deepEqual(service.notificationTargets(f.actor.actorId), []);
});

function notifications(channelId: string, actorId: string) {
  let linked = true;
  const sent: unknown[] = [];
  const port = {
    targets: (actor: string) =>
      linked && actor === actorId
        ? [{ channelId, senderId: "same-sender", label: channelId, methodId: "fixture", methodLabel: "Fixture" }]
        : [],
    async send(actor: string, target: unknown, content: string, id: string, assertCurrent: () => void) {
      assertCurrent();
      sent.push({ actor, target, content, id });
    },
  };
  return {
    port,
    sent,
    revoke: () => {
      linked = false;
    },
  };
}

test("notifications pin the exact connection, reject ambiguous pairs and recheck revocation", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    b = adapter("beta");
  const na = notifications("alpha.personal", f.actor.actorId),
    nb = notifications("beta.personal", f.actor.actorId);
  a.transport.notifications = na.port;
  b.transport.notifications = nb.port;
  const service = await f.open([a.transport, b.transport]);
  assert.equal(service.notificationTargets(f.actor.actorId).length, 2);
  assert.deepEqual(service.notificationTargets("other-actor"), []);
  const send = service.prepareDirectNotification("alpha.personal", "same-sender", f.actor.actorId);
  await send("done", "once");
  assert.deepEqual([na.sent.length, nb.sent.length], [1, 0]);
  b.transport.notifications = notifications("alpha.personal", f.actor.actorId).port;
  assert.deepEqual(service.notificationTargets(f.actor.actorId), []);
  await assert.rejects(send("done", "ambiguous"), /notification_binding_denied/);
  b.transport.notifications = nb.port;
  na.revoke();
  await assert.rejects(send("done", "revoked"), /notification_binding_denied/);
  const second = service.prepareDirectNotification("beta.personal", "same-sender", f.actor.actorId);
  b.transport.notifications = { ...nb.port };
  await assert.rejects(second("done", "replaced"), /notification_binding_denied/);
  assert.deepEqual([na.sent.length, nb.sent.length], [1, 0]);
});

test("ordinary adapters and contributed targets cannot claim the same recipient pair", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    n = notifications("duplicate", f.actor.actorId);
  a.transport.notifications = n.port;
  const service = await f.open([a.transport]);
  service.adapters.set("duplicate", {
    name: "Ordinary",
    notificationSenders: new Map([["same-sender", f.actor.actorId]]),
    adapter: { sendDirect: async () => {}, close() {} },
  });
  assert.deepEqual(service.notificationTargets(f.actor.actorId), []);
  assert.throws(
    () => service.prepareDirectNotification("duplicate", "same-sender", f.actor.actorId),
    /notification_binding_denied/,
  );
  service.adapters.delete("duplicate");
});

test("trusted composition supports legacy and plural factories without invoking conflicting factories", async () => {
  const transports = [adapter("alpha").transport, adapter("beta").transport];
  const context = { collaboration: {} };
  assert.deepEqual(
    await createChannelSyncDependencies(
      {
        createChannelSyncs: async (value: unknown) => {
          assert.equal(value, context);
          return transports;
        },
      },
      context,
    ),
    { channelSyncs: transports },
  );
  assert.deepEqual(await createChannelSyncDependencies({ createChannelSync: async () => transports[0] }, context), {
    channelSync: transports[0],
  });
  assert.deepEqual(await createChannelSyncDependencies({ channelSyncs: transports }, context), {
    channelSyncs: transports,
  });
  let called = false;
  await assert.rejects(
    createChannelSyncDependencies(
      {
        createChannelSync: async () => {
          called = true;
        },
        channelSyncs: transports,
      },
      context,
    ),
    /Conflicting/,
  );
  assert.equal(called, false);
  await assert.rejects(
    createChannelSyncDependencies({ createChannelSyncs: async () => undefined }, context),
    /Invalid channel composition/,
  );
});

test("legacy single-transport composition retains its connection and personal notification port", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha");
  delete (a.transport as { connectionId?: string }).connectionId;
  const n = notifications("personal", f.actor.actorId);
  a.transport.notifications = n.port;
  const service = await f.open([a.transport], true);
  assert.equal(service.channelSync?.transport, a.transport);
  await service.prepareDirectNotification("personal", "same-sender", f.actor.actorId)("done", "legacy");
  assert.equal(n.sent.length, 1);
  assert.deepEqual(
    f.storage.database
      .prepare("SELECT id FROM actor_channel_connections")
      .all()
      .map((row) => row.id),
    ["legacy"],
  );
});

test("a provider can recheck the captured notification lease after asynchronous preparation", async (t) => {
  const f = await fixture(t),
    a = adapter("alpha"),
    n = notifications("personal", f.actor.actorId);
  let prepared!: () => void, release!: () => void;
  const preparing = new Promise<void>((resolve) => {
      prepared = resolve;
    }),
    resume = new Promise<void>((resolve) => {
      release = resolve;
    });
  n.port.send = async (actor, target, content, id, assertCurrent) => {
    prepared();
    await resume;
    assertCurrent();
    n.sent.push({ actor, target, content, id });
  };
  a.transport.notifications = n.port;
  const service = await f.open([a.transport]);
  const sent = service.prepareDirectNotification("personal", "same-sender", f.actor.actorId)("private", "delayed");
  await preparing;
  n.revoke();
  release();
  await assert.rejects(sent, /notification_binding_denied/);
  assert.equal(n.sent.length, 0);
});

test("actual Headless application mounts both factory callback routes and retires both on close", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "headless-channel-app-")),
    webRoot = join(root, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Fixture</title>");
  await writeFile(
    join(webRoot, "version.json"),
    JSON.stringify({
      schemaVersion: 1,
      buildId: "channel-test",
      headlessServer: true,
      headlessHostId: "opencraft-server",
    }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = adapter("alpha"),
    b = adapter("beta");
  const app = await startHeadlessServer(
    {
      root,
      webRoot,
      dataDirectory: join(root, "data"),
      port: 0,
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
    },
    {
      createChannelSyncs: async ({ collaboration }: any) => {
        assert.equal(typeof collaboration.synchronizeChannels, "function");
        return [a.transport, b.transport];
      },
    },
  );
  t.after(() => app.close());
  for (const id of ["alpha", "beta"]) {
    const response = await fetch(app.url + "/__opencraft_im/channel-callback/" + id, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), id);
  }
  await app.close();
  assert.deepEqual([a.stops, b.stops], [1, 1]);
});
