import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDatabase } from "@opencraft/sqlite-node";
import {
  SwitchboardStore,
  switchboardMigrations,
} from "../../plugins/im/src/store";
import {
  evaluateRoute,
  compileRoute,
  sourceRoute,
} from "../../plugins/im/src/routing";
import { ImPlugin, type ImExecutionPort } from "../../plugins/im/src/server";
import { ImChannelService } from "../../scripts/im-channel-service.mjs";

const event = {
  id: "event",
  channelId: "channel",
  platform: "slack",
  chat: { id: "chat", type: "group" as const },
  sender: { id: "U1", actorId: "human" },
  text: "hello",
};
const config = {
  id: "channel",
  provider: "slack" as const,
  ownerId: "human",
  name: "Channel",
  groupScope: "sender" as const,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function root(t: any) {
  const path = await mkdtemp(join(tmpdir(), "im-programmable-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("router executes in a bounded JSON-only realm with one synchronous decision", async () => {
  await compileRoute(sourceRoute);
  assert.deepEqual(await evaluateRoute(sourceRoute, event), {
    key: ["group", "chat", "human"],
  });
  assert.deepEqual(
    await evaluateRoute(
      "function route(e){return {key:[typeof process,typeof fetch,typeof require]};}",
      event,
    ),
    { key: ["undefined", "undefined", "undefined"] },
  );
  assert.deepEqual(
    await evaluateRoute(
      'function route(e){return {key:[Object.isFrozen(e)&&Object.isFrozen(e.chat)?"frozen":"mutable"]};}',
      event,
    ),
    { key: ["frozen"] },
  );
  for (const source of [
    "function route(){while(true){}}",
    "async function route(){return {ignore:true};}",
    'function route(){return {key:["a"],ignore:true};}',
    'function route(){return {key:["x".repeat(300)]};}',
  ])
    await assert.rejects(evaluateRoute(source, event));
});

test("v1 upgrade preserves existing tuples; route/config/draft updates reject stale versions", async (t) => {
  const path = join(await root(t), "im.sqlite");
  const old = openManagedDatabase({
    path,
    legacyPolicy: "reject",
    migrations: [switchboardMigrations[0]],
  });
  old.database
    .prepare("INSERT INTO switchboard VALUES(?,?,?,?)")
    .run(
      "binding",
      "old",
      "tuple",
      JSON.stringify({ serverId: "s", threadId: "t" }),
    );
  old.database.close();
  const store = new SwitchboardStore(path);
  t.after(() => store.close());
  assert.deepEqual(store.get("old", "tuple"), { serverId: "s", threadId: "t" });
  const first = store.saveChannel(config, true, null),
    draft = store.route(config.id, first.revision, sourceRoute, false);
  assert.equal(draft.route, null);
  assert.ok(draft.revision > first.revision);
  assert.throws(
    () => store.route(config.id, first.revision, sourceRoute, true),
    /revision_conflict/,
  );
  const active = store.route(config.id, draft.revision, sourceRoute, true);
  const renamed = store.saveChannel(
    { ...active, name: "Renamed" },
    true,
    active.revision,
  );
  assert.throws(
    () => store.saveChannel(config, false, active.revision),
    /revision_conflict/,
  );
  assert.equal(renamed.route, sourceRoute);
  assert.equal(store.versions(config.id).length, 1);
});

test("captured target, route and reply survive restart; an uncertain send is never auto-repeated", async (t) => {
  const path = join(await root(t), "im.sqlite"),
    target = { serverId: "s", threadId: "one" };
  let store = new SwitchboardStore(path);
  store.saveChannel(config, true, null);
  store.route(config.id, 1, 'function route(){return {key:["one"]};}', true);
  const answers: string[] = [],
    submitted: string[] = [];
  let created = 0,
    stop = false;
  const execution: ImExecutionPort = {
    human: (actorId) => ({
      actorId,
      generation: 1,
      credentialId: null,
      expiresAt: Date.now() + 60000,
    }),
    authorize() {},
    async create() {
      created++;
      return target;
    },
    async validate() {},
    async submit(_c, _r, key) {
      submitted.push(key);
      return "request";
    },
    async result(_c, _r, _id, signal) {
      if (stop) return "answer";
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("stopped")), {
          once: true,
        }),
      );
    },
  };
  let im = new ImPlugin(store, execution);
  im.register({ ...config, senders: { U1: "human" } });
  const message = {
    id: "event",
    source: { chatId: "chat", chatType: "direct" as const, senderId: "U1" },
    text: "hello",
    replyAddress: { provider: "fixture", expiresAt: Date.now() + 60000 },
    reply: async () => {
      throw Error("old closure");
    },
  };
  const running = im.receive(config.id, message);
  const rejected = assert.rejects(running);
  for (let i = 0; i < 100 && submitted.length === 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(submitted.length, 1);
  await im.close();
  await rejected;
  store = new SwitchboardStore(path);
  store.route(config.id, 2, 'function route(){return {key:["new"]};}', true);
  stop = true;
  im = new ImPlugin(store, execution);
  im.register({ ...config, senders: { U1: "human" } });
  im.setDelivery(async (_id, address, text) => {
    assert.equal(address.provider, "fixture");
    answers.push(text);
    throw Error("lost ACK");
  });
  await im.recover();
  for (
    let i = 0;
    i < 100 && store.messages(config.id)[0].state !== "reply_unknown";
    i++
  )
    await tick();
  assert.equal(store.messages(config.id)[0].state, "reply_unknown");
  assert.equal(created, 1);
  assert.equal(submitted.length, 1);
  assert.deepEqual(answers, ["answer"]);
  await im.receive(config.id, message);
  await im.recover();
  await tick();
  assert.deepEqual(answers, ["answer"]);
  assert.deepEqual(
    JSON.parse(store.messages(config.id)[0].conversation_ref!),
    target,
  );
  assert.equal(store.messages(config.id)[0].route_revision, 2);
  await im.close();
});

test("channel management scopes natural people, hides secrets/code from users and consumes only valid identity proofs", async (t) => {
  const actors = new Map(
    ["human", "other"].map((actorId) => [
      actorId,
      { id: actorId, enabled: true, kind: "human", generation: 1 },
    ]),
  );
  const values = new Map<string, string>();
  const adapters: any[] = [];
  const service = await ImChannelService.open([], {
    dataDirectory: await root(t),
    actors: {
      get: (id: string) => actors.get(id),
      isCurrent: (c: any) => actors.get(c.actorId)?.enabled === true,
    },
    collaboration: { execution: { serverId: "s", hostId: "h" } },
    getAppHost: () => null,
    credentials: {
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
      resolve: async (k: string) => values.get(k),
      remove: async (k: string) => values.delete(k),
    },
    createWeCom: (options: any) => {
      const a = {
        options,
        state: "ready",
        start() {},
        close() {},
        deliver: async () => {},
      };
      adapters.push(a);
      return a;
    },
  });
  t.after(() => service.close());
  const owner = { actorId: "human" },
    other = { actorId: "other" };
  const { channel } = await service.operation(owner, {
    action: "create",
    config: { provider: "wecom", name: "Bot", botId: "bot" },
    credentials: { secret: "fixture-private" },
  });
  assert.equal(JSON.stringify(channel).includes("fixture-private"), false);
  await assert.rejects(
    service.operation(other, {
      action: "route",
      id: channel.id,
      revision: channel.revision,
      source: sourceRoute,
      publish: true,
    }),
    /channel_denied/,
  );
  const proof = await service.operation(other, {
    action: "identity",
    id: channel.id,
  });
  await adapters[0].options.receive({
    id: "verify",
    source: { chatId: "dm", chatType: "direct", senderId: "external" },
    text: proof.command,
    reply: async () => {},
  });
  await assert.rejects(
    adapters[0].options.receive({
      source: { chatType: "direct", senderId: "external" },
      text: proof.command,
      reply: async () => {},
    }),
    /invalid_identity_challenge/,
  );
  const list = await service.operation(other, { action: "list" });
  assert.equal(list.channels.length, 1);
  assert.equal(list.channels[0].route, null);
  assert.equal(list.channels[0].canManage, false);
  assert.equal(list.channels[0].draft, null);
  const revoked = await service.operation(other, {
    action: "identity",
    id: channel.id,
  });
  actors.get("other")!.enabled = false;
  await assert.rejects(
    adapters[0].options.receive({
      source: { chatType: "direct", senderId: "revoked" },
      text: revoked.command,
      reply: async () => {},
    }),
    /denied/,
  );
  assert.equal(service.store.senderLinks(channel.id).revoked, undefined);
});

test("route input is frozen before top-level user code and steward presentation derives from source", async () => {
  await assert.rejects(
    evaluateRoute(
      'args.sender.actorId="spoof"; function route(e){ return {key:[e.sender.actorId]}; }',
      event,
    ),
  );
  const { stewardRoute, stewardReference } = await import(
    "../../plugins/im/src/templates"
  );
  const { encodeConversationRef } = await import(
    "../../packages/appserver-protocol/src/collaboration"
  );
  const reference = encodeConversationRef({
    serverId: "core-server",
    threadId: "thread",
  });
  assert.equal(stewardReference(stewardRoute(reference)), reference);
  assert.equal(
    stewardReference(stewardRoute(reference) + "\n// edited policy"),
    null,
  );
});

test("public workbench Host is explicitly mapped to the core Server; HTTP writes require human origin authority", async (t) => {
  const { Readable } = await import("node:stream");
  const actor = {
    actorId: "human",
    generation: 1,
    credentialId: null,
    expiresAt: Date.now() + 60000,
  };
  let authenticated: any = actor;
  const service = await ImChannelService.open([], {
    dataDirectory: await root(t),
    actors: {
      get: () => ({ kind: "human", enabled: true, generation: 1 }),
      isCurrent: () => true,
    },
    collaboration: {
      execution: { serverId: "core-server", hostId: "native-host" },
    },
    getAppHost: () => null,
    workbenchHostId: "public-host",
    actorAccess: { authenticate: () => authenticated },
  });
  t.after(() => service.close());
  const list = await service.operation(actor, { action: "list" });
  assert.equal(list.serverId, "core-server");
  assert.equal(list.workbenchHostId, "public-host");
  service.execution.validate = async (_actor: any, ref: any) => {
    assert.equal(ref.serverId, "core-server");
  };
  const sources = await service.operation(actor, {
    action: "sources",
    hostId: "public-host",
    threadId: "thread",
  });
  assert.ok(sources.reference.includes("core-server"));
  await assert.rejects(
    service.operation(actor, {
      action: "sources",
      hostId: "native-host",
      threadId: "thread",
    }),
    /unsupported_host/,
  );
  const request = async (origin: boolean, headers: Record<string, string> = {}) => {
    let status = 0,
      value: any;
    const req: any = Readable.from([
      Buffer.from(JSON.stringify({ action: "list" })),
    ]);
    Object.assign(req, {
      url: "/__opencraft_im",
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
    });
    await service.handle(
      req,
      {
        writeHead: (s: number) => {
          status = s;
        },
        end: (s: string) => {
          value = JSON.parse(s);
        },
      },
      () => origin,
    );
    return { status, value };
  };
  assert.equal((await request(false)).status, 403);
  assert.equal((await request(true)).status, 200);
  // Actual domain deployment: no provider origin override and no loopback proof.
  assert.equal((await request(false, {host: "join.example", origin: "https://join.example"})).status, 200);
  assert.equal((await request(false, {host: "join.example", origin: "http://join.example"})).status, 200);
  assert.equal((await request(false, {host: "join.example", origin: "https://evil.example", "x-forwarded-host": "evil.example"})).status, 403);
  assert.equal((await request(false, {host: "join.example", origin: "null"})).status, 403);
  authenticated = { ...actor, credentialId: "session-agent" };
  assert.equal((await request(true)).status, 401);
  authenticated = null;
  assert.equal((await request(true)).status, 401);
});


test("recovery reads every admitted message of the ready channel beyond other-channel backlog", async (t) => {
  const store = new SwitchboardStore(join(await root(t), "im.sqlite"));
  t.after(() => store.close());
  for (let i = 0; i < 601; i++) {
    const channel = i < 501 ? "offline" : "ready";
    store.accept({id: `backlog-${i}`, channel_id: channel, fingerprint: String(i), actor_id: "human", source: "{}", text: "hello", route_revision: 1, decision: "{}", reply_address: "{}"});
    store.patch(`backlog-${i}`, {state: "submitted", request_id: `request-${i}`});
  }
  assert.equal(store.recoverable("ready").length, 100);
  assert.equal(store.recoverable("offline").length, 501);
  assert.ok(store.recoverable("ready").every(message => message.channel_id === "ready"));
});

test('channel client preserves admission error codes and classifies non-JSON proxy failures', async () => {
  const {ImClient, ImHttpError} = await import('../../plugins/im/src/client');
  for (const [status, code] of [[401,'authentication_required'],[403,'actor_access_denied'],[503,'im_unavailable']] as const) {
    const client = new ImClient(async () => new Response(JSON.stringify({error:code}), {status}));
    await assert.rejects(client.request({action:'list'}), error => error instanceof ImHttpError && error.code===code && error.status===status);
  }
  const invalid=new ImClient(async () => new Response('<html>upstream unavailable</html>',{status:502}));
  await assert.rejects(invalid.request({action:'list'}), error => error instanceof ImHttpError && error.code==='invalid_server_response' && error.status===502);
});
