import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { jsonResponse } from "@opencraft/http-exchange";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { parsePrincipal } from "@opencraft/identity-core";
import { encodeConversationRef } from "@opencraft/appserver-protocol/collaboration";
import { createA2aPlugin, parseA2aConfiguration } from "@opencraft/plugin-a2a/server";
import { createA2aRelayIngress, parseA2aRelayTarget } from "@opencraft/plugin-a2a/relay";
import { ActorStore } from "../../packages/access-control/src/actors.js";
import { ServerSpacesLedger } from "../../packages/access-control/src/server-spaces-ledger.js";
import { OrchestrationRuntimeWorker } from "../../packages/access-control/src/orchestration-runtime-store.js";
import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";
import {
  externalConversationPort,
  openServiceIngress,
  validateServiceIngress,
} from "../../apps/headless-server/src/service-ingress.mjs";
import { assembleEdge } from "../../apps/headless-server/src/assembly/edge.mjs";

const origin = "https://agent.example.com";
const ref = { serverId: "server:synthetic:codex", threadId: "dedicated-agent" };
const message = (id = "message-one", text = "Hello", blocking = false) => ({
  configuration: { blocking },
  message: { kind: "message", role: "user", messageId: id, parts: [{ kind: "text", text }] },
});
function exchange(port: number, path: string, body?: string | Buffer, headers: IncomingHttpHeaders | string[] = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json(): any }>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers },
      (incoming) => {
        const read = async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
          const text = Buffer.concat(chunks).toString();
          return { status: incoming.statusCode!, headers: incoming.headers, text, json: () => JSON.parse(text) };
        };
        void read().then(resolve, reject);
      },
    );
    req.once("error", reject);
    req.end(body);
  });
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-a2a-"));
  const database = await openServerDatabase(directory);
  const actors = new ActorStore(database);
  let worker = new OrchestrationRuntimeWorker(database.location!);
  let cleanupHttp = async () => {};
  t.after(async () => {
    try {
      await cleanupHttp();
    } finally {
      await worker.close();
      actors.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const owner = actors.resolveHuman(
    parsePrincipal({ provider: "local", subject: "owner", displayName: "Owner", expiresAt: Date.now() + 60_000 })!,
  )!;
  const session = actors.createSession("Synthetic external caller", owner.actorId);
  const other = actors.createSession("Other caller", owner.actorId);
  const credential = actors.issueCredential(session.id, Date.now() + 60_000, owner.actorId);
  const otherCredential = actors.issueCredential(other.id, Date.now() + 60_000, owner.actorId);
  const reference = encodeConversationRef(ref);
  actors.registerResourceAuthority((value) => value === reference);
  const spaces = new ServerSpacesLedger(database.database);
  spaces.bootstrap(owner.actorId);
  spaces.assign(owner, ref.serverId, ref.threadId, "myself");
  const membership = (enabled: boolean) =>
    spaces.command(
      owner,
      enabled
        ? { action: "addBot", spaceId: "myself", actorId: session.id }
        : { action: "remove", spaceId: "myself", actorId: session.id },
    );
  membership(true);
  for (const action of ["conversation.read", "message.send", "execution.queue"])
    actors.setGrant(session.id, reference, action, true, owner.actorId);
  let completion:
    | {
        version: 1;
        turnId: string;
        status: "completed" | "failed" | "interrupted" | "unknown";
        text: string;
        truncated?: boolean;
      }
    | undefined;
  let duringNative = () => {};
  const ports = {
    conversation: externalConversationPort(
      { externalConversation: (input: any) => worker.externalConversation(input) },
      {
        hostForServer: () => "local-codex",
        async receipt() {
          duringNative();
          return { targetTurnId: "native-turn", completion };
        },
      },
    ),
  };
  const config = parseA2aConfiguration({
    origin,
    actorId: session.id,
    conversation: reference,
    name: "Synthetic agent",
  });
  const plugin = createA2aPlugin(config, ports, { waitMs: 15, pollMs: 1 });
  const gateway = await createWorkbenchWebServer({
    root: directory,
    appServerTarget: null,
    serviceIngress: plugin,
    accessService: { admissionStatus: () => 401 },
  } as Parameters<typeof createWorkbenchWebServer>[0]);
  const address = await gateway.listen({ host: "127.0.0.1", port: 0 });
  cleanupHttp = async () => {
    await plugin.close();
    await gateway.close();
  };
  let streams = 0;
  const target = parseA2aRelayTarget({
    origin,
    gatewayOrigin: "https://gateway.example.com",
    hubId: "hub-" + "a".repeat(40),
  });
  const ingress = createA2aRelayIngress(target, async (actual) => {
    streams++;
    assert.deepEqual(actual, { hubId: target.hubId, origin: target.gatewayOrigin });
    return connect(address.port, "127.0.0.1");
  });
  const relay = createServer((req, res) => {
    if (!ingress(req, res)) res.writeHead(401).end();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayAddress = relay.address();
  assert.ok(relayAddress && typeof relayAddress !== "string");
  cleanupHttp = async () => {
    await ingress.close?.();
    relay.closeAllConnections();
    await new Promise<void>((resolve, reject) => relay.close((error) => (error ? reject(error) : resolve())));
    await plugin.close();
    await gateway.close();
  };
  const call = (method: string, params: unknown, token = credential.token) =>
    exchange(relayAddress.port, "/api/a2a", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), {
      host: "agent.example.com",
      authorization: "Bearer " + token,
      "content-type": "application/json",
    });
  return {
    actors,
    owner,
    session,
    credential,
    otherCredential,
    reference,
    database,
    config,
    ports,
    plugin,
    membership,
    call,
    port: relayAddress.port,
    streams: () => streams,
    complete: async (id: string, text = "Exact reply") => {
      await worker.updateExecution({
        id,
        state: "submitted",
        queueId: "queue-one",
        turnId: "native-turn",
        reason: null,
        now: Date.now(),
      });
      completion = { version: 1, turnId: "native-turn", status: "completed", text };
    },
    setCompletion: (value: typeof completion) => {
      completion = value;
    },
    duringNative: (run: () => void) => {
      duringNative = run;
    },
    restart: async () => {
      await worker.close();
      worker = new OrchestrationRuntimeWorker(database.location!);
      await worker.start();
    },
  };
}

test("A2A discovery and durable dispatch use the Relay, Gateway and authorization Worker", async (t) => {
  const f = await fixture(t);
  const card = await exchange(f.port, "/.well-known/agent-card.json", undefined, { host: "agent.example.com" });
  assert.equal(card.status, 200);
  assert.equal(card.json().url, origin + "/api/a2a");
  assert.equal(card.json().protocolVersion, "0.3.0");
  assert.equal(card.json().securitySchemes.bearer.scheme, "bearer");
  assert.ok(!card.text.includes(f.session.id) && !card.text.includes(ref.threadId));
  assert.equal((await exchange(f.port, "/", undefined, { host: "agent.example.com" })).status, 401);
  assert.equal(
    (await exchange(f.port, "/.well-known/agent-card.json", undefined, { host: "another.example.com" })).status,
    401,
  );
  const before = f.streams();
  assert.equal((await f.call("message/send", message(), "invalid")).status, 401);
  assert.equal(f.streams(), before, "invalid bearer syntax never opens a Hub stream");
  assert.equal((await f.call("message/send", message(), f.otherCredential.token)).status, 401);
  const sent = (await f.call("message/send", message())).json().result;
  assert.equal(sent.status.state, "submitted");
  const replays = await Promise.all(Array.from({ length: 4 }, () => f.call("message/send", message())));
  assert.ok(replays.every((value) => value.json().result.id === sent.id));
  assert.equal((await f.call("message/send", message("message-one", "Changed"))).json().error.code, -32602);
  await f.restart();
  assert.equal((await f.call("message/send", message())).json().result.id, sent.id);
  assert.equal(
    (
      await f.ports.conversation({
        actorId: f.session.id,
        bearer: f.credential.token,
        ref,
        namespace: "other-channel",
        operation: { kind: "status", id: sent.id },
      })
    ).kind,
    "missing",
  );
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS n FROM actor_execution_requests").get()!.n, 1);
  assert.equal((await f.call("tasks/get", { id: "00000000-0000-0000-0000-000000000001" })).json().error.code, -32001);
  assert.equal((await f.call("tasks/cancel", { id: sent.id })).json().error.code, -32002);
  await f.complete(sent.id);
  const completed = (await f.call("tasks/get", { id: sent.id })).json().result;
  assert.equal(completed.status.state, "completed");
  assert.deepEqual(completed.artifacts[0].parts, [{ kind: "text", text: "Exact reply" }]);
  f.membership(false);
  assert.equal((await f.call("tasks/get", { id: sent.id })).status, 403);
  f.membership(true);
  f.actors.setGrant(f.session.id, f.reference, "message.send", false, f.owner.actorId);
  assert.equal((await f.call("tasks/get", { id: sent.id })).status, 403);
  f.actors.setGrant(f.session.id, f.reference, "message.send", true, f.owner.actorId);
  f.actors.revokeCredential(f.credential.credentialId, f.owner.actorId);
  assert.equal((await f.call("tasks/get", { id: sent.id })).status, 401);
});

test("completion is exact-Turn evidence and is fenced by current permissions after native observation", async (t) => {
  const f = await fixture(t);
  const sent = (await f.call("message/send", message())).json().result;
  await f.complete(sent.id);
  f.setCompletion({ version: 1, turnId: "another-turn", status: "completed", text: "Other task's private reply" });
  const pending = await f.call("tasks/get", { id: sent.id });
  assert.equal(pending.json().result.status.state, "working");
  assert.ok(!pending.text.includes("private reply"));
  f.setCompletion({ version: 1, turnId: "native-turn", status: "completed", text: "Bounded reply", truncated: true });
  assert.equal((await f.call("tasks/get", { id: sent.id })).json().result.artifacts[0].metadata.truncated, true);
  f.duringNative(() => f.membership(false));
  const refused = await f.call("tasks/get", { id: sent.id });
  assert.equal(refused.status, 403);
  assert.ok(!refused.text.includes("Bounded reply"));
});

test("blocking waits preserve the task identity and input validation never queues unsupported content", async (t) => {
  const f = await fixture(t);
  const blocked = await f.call("message/send", message("blocking", "Long request", true));
  assert.equal(blocked.json().error.code, -32010);
  const id = blocked.json().error.data.taskId;
  await f.complete(id);
  assert.equal((await f.call("tasks/get", { id })).json().result.status.state, "completed");
  const unsupported = message("unsupported");
  (unsupported.message.parts[0] as any).kind = "file";
  assert.equal((await f.call("message/send", unsupported)).json().error.code, -32005);
  assert.equal(
    (await f.call("message/send", { ...message("push"), configuration: { pushNotificationConfig: {} } })).json().error
      .code,
    -32003,
  );
  assert.equal((await f.call("message/stream", message())).json().error.code, -32601);
  assert.equal(
    (
      await f.call("message/send", { ...message("context"), message: { ...message().message, contextId: "unrelated" } })
    ).json().error.code,
    -32602,
  );
  assert.equal(f.database.database.prepare("SELECT COUNT(*) AS n FROM actor_execution_requests").get()!.n, 1);
  const malformed = await exchange(f.port, "/api/a2a", "{", {
    host: "agent.example.com",
    authorization: "Bearer " + f.credential.token,
    "content-type": "application/json",
  });
  assert.equal(malformed.json().error.code, -32700);
  const oversized = await exchange(f.port, "/api/a2a", " ".repeat(65_537), {
    host: "agent.example.com",
    authorization: "Bearer " + f.credential.token,
    "content-type": "application/json",
  });
  assert.equal(oversized.status, 413);
  const duplicate = await exchange(f.port, "/api/a2a", "{}", [
    "Host",
    "agent.example.com",
    "Authorization",
    "Bearer " + f.credential.token,
    "Authorization",
    "Bearer " + f.otherCredential.token,
    "Content-Type",
    "application/json",
  ]);
  assert.equal(duplicate.status, 401);
});

test("service ingress is opt-in and its lifecycle is owned by the edge", async () => {
  assert.throws(
    () => validateServiceIngress({ paths: new Set(["/__opencraft_actors"]), handle() {} }),
    /Invalid service ingress/,
  );
  const edge = assembleEdge();
  await edge.closeServiceIngress();
  let closed = 0;
  const ingress = {
    paths: new Set(["/api/a2a"]),
    handle() {},
    close() {
      closed++;
    },
  };
  await edge.startServiceIngress(async () => validateServiceIngress(ingress));
  await edge.closeServiceIngress();
  assert.equal(closed, 1);
  await assert.rejects(
    openServiceIngress(async () => ({ ...ingress, paths: new Set(["/rpc"]) }), {}),
    /Invalid service ingress/,
  );
  assert.equal(closed, 2, "invalid activation closes resources before startup fails");
});

test("Relay forwards only the configured service paths and credential headers", async (t) => {
  let received: IncomingHttpHeaders | undefined;
  const gateway = createServer((req, res) => {
    received = req.headers;
    req.resume();
    res.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "private=discard",
      location: "https://other.example.com",
    });
    res.end('{"ok":true}');
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const gatewayAddress = gateway.address();
  assert.ok(gatewayAddress && typeof gatewayAddress !== "string");
  let streams = 0;
  const ingress = createA2aRelayIngress(
    parseA2aRelayTarget({ origin, gatewayOrigin: "https://gateway.example.com", hubId: "hub-" + "b".repeat(40) }),
    async (target) => {
      assert.equal(target.origin, "https://gateway.example.com");
      streams++;
      return connect(gatewayAddress.port, "127.0.0.1");
    },
  );
  const relay = createServer((req, res) => {
    if (!ingress(req, res)) res.writeHead(404).end();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    await ingress.close?.();
    for (const server of [relay, gateway]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const result = await exchange(address.port, "/api/a2a", "{}", {
    host: "agent.example.com",
    authorization: "Bearer oc_actor_synthetic",
    cookie: "browser=private",
    origin: "https://untrusted.example.com",
    "x-forwarded-user": "forged",
    "content-type": "application/json",
  });
  assert.equal(result.status, 200);
  assert.equal(received?.host, "gateway.example.com");
  assert.equal(received?.authorization, "Bearer oc_actor_synthetic");
  assert.equal(received?.cookie, undefined);
  assert.equal(received?.origin, undefined);
  assert.equal(received?.["x-forwarded-user"], undefined);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers.location, undefined);
  assert.equal(
    (await exchange(address.port, "/api/a2a?target=other", "{}", { host: "agent.example.com" })).status,
    404,
  );
  assert.equal((await exchange(address.port, "/api/other", "{}", { host: "agent.example.com" })).status, 404);
  assert.equal(streams, 1);
});

test("Headless composition mounts the ingress and closes it before identity owners", async (t) => {
  const { startHeadlessServer } = await import("../../apps/headless-server/src/headless-server.mjs");
  const directory = await mkdtemp(join(tmpdir(), "opencraft-a2a-composition-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.html"), "<!doctype html><title>Fixture</title>");
  await writeFile(
    join(directory, "version.json"),
    JSON.stringify({ schemaVersion: 1, buildId: "fixture", headlessServer: true, headlessHostId: "opencraft-server" }),
  );
  const events: string[] = [];
  const app = await startHeadlessServer(
    {
      webRoot: directory,
      dataDirectory: join(directory, "data"),
      port: 0,
      startAgentHost: async () => ({ websocketUrl: "ws://127.0.0.1:9/rpc", close: async () => {} }),
    },
    {
      createIdentity: async () => ({
        providers: [{ authenticate: () => null }],
        close: () => {
          events.push("identity");
        },
      }),
      createServiceIngress: ({ conversation }: { conversation: unknown }) => {
        assert.equal(typeof conversation, "function");
        return {
          paths: new Set(["/api/a2a"]),
          handle: async () => jsonResponse(200, { mounted: true }, []),
          close() {
            events.push("ingress");
          },
        };
      },
    },
  );
  t.after(() => app.close());
  assert.deepEqual(await (await fetch(app.url + "/api/a2a")).json(), { mounted: true });
  await app.close();
  assert.ok(events.indexOf("ingress") >= 0 && events.indexOf("ingress") < events.indexOf("identity"));
  assert.equal(events.filter((event) => event === "ingress").length, 1);
});
