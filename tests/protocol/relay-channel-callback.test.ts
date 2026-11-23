import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { HubNetwork } from "../../packages/hub-network/src/node";
import { openLocalHubNetwork } from "../../packages/hub-network/src/store-file.js";
import { parseRelayConfiguration, startRelayApplication } from "../../apps/relay-server/src/application";
import {
  channelCallbackHeaders,
  createChannelCallbackIngress,
  parseChannelCallbacks,
  type OpenChannelHubStream,
} from "../../apps/relay-server/src/channel-callback";
import type { RelayIngress } from "../../apps/relay-server/src/server";

const hubId = (seed: string) => "hub-" + seed.repeat(40);
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
async function waitFor(check: () => boolean) {
  const until = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > until) throw new Error("Hub condition timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}
function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "POST",
        agent: false,
        headers: { host: "relay.test", ...options.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      },
    );
    req.once("error", reject);
    req.end(options.body);
  });
}

test("channel callback configuration is explicit, bounded and never claims core paths", () => {
  const valid = { path: "/callbacks/chat", provider: "chat_app", hubId: hubId("a"), origin: "https://gateway.example" };
  assert.deepEqual(parseChannelCallbacks([valid]), [{ ...valid, timeoutMs: 10_000 }]);
  assert.equal(parseChannelCallbacks([{ ...valid, timeoutMs: 4500 }])[0]!.timeoutMs, 4500);
  for (const bad of [
    [],
    {},
    [{ ...valid, path: "relative" }],
    [{ ...valid, path: "/__opencraft_relay/live" }],
    [{ ...valid, path: "/__opencraft_hub/join" }],
    [{ ...valid, path: "/__opencraft_im/channel-callback/x" }],
    [{ ...valid, path: "/a b" }],
    [{ ...valid, path: "//double" }],
    [{ ...valid, path: "/x?query" }],
    [valid, valid],
    [{ ...valid, provider: "Upper" }],
    [{ ...valid, provider: "../x" }],
    [{ ...valid, hubId: "short" }],
    [{ ...valid, origin: "https://gateway.example/path" }],
    [{ ...valid, timeoutMs: 10 }],
    [{ ...valid, extra: true }],
  ])
    assert.throws(() => parseChannelCallbacks(bad), JSON.stringify(bad));
  const base = { schemaVersion: 1, host: "127.0.0.1", port: 18090, routes: [] };
  assert.throws(() => parseRelayConfiguration({ ...base, channelCallbacks: [valid] }), /require a Relay Hub network/);
  parseRelayConfiguration({
    ...base,
    channelCallbacks: [valid],
    hubNetwork: { stateFile: "/private/hub.json", operatorCredentialFile: "/private/operator.json" },
  });
});

test("forwarded headers drop relay, browser, forwarding and enterprise identity material", () => {
  assert.deepEqual(
    channelCallbackHeaders({
      "content-type": "application/json",
      "x-provider-signature": "sig",
      "user-agent": "provider",
      host: "relay.test",
      cookie: "a=b",
      authorization: "Bearer x",
      "x-forwarded-for": "192.0.2.1",
      forwarded: "for=192.0.2.1",
      "x-real-ip": "192.0.2.1",
      "x-opencraft-relay-assertion": "forged",
      staffid: "1",
      timestamp: "1",
      signature: "forged",
      connection: "close, x-hop",
      "x-hop": "1",
      "transfer-encoding": "chunked",
      "content-length": "3",
      origin: "https://browser.example",
    }),
    { "content-type": "application/json", "x-provider-signature": "sig", "user-agent": "provider" },
  );
});

test("a provider callback crosses a real Hub stream to the owning gateway receiver", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-channel-callback-"));
  const pair = generateKeyPairSync("ed25519");
  const authority = {
    issuer: "callback-test",
    publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    providers: ["fixture"],
  };
  const relayHub = await openLocalHubNetwork(join(dir, "relay.json"), { authority }),
    gatewayHub = await openLocalHubNetwork(join(dir, "gateway.json"), { authority });
  const received: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let hold: Promise<void> | undefined;
  const gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (hold) await hold;
      res.writeHead(req.url?.includes("reject") ? 401 : 200, {
        "content-type": "text/plain; charset=utf-8",
        "set-cookie": "gateway=secret",
        "x-internal": "gateway",
      });
      res.end("success");
    });
  });
  const hubIngress = createServer();
  hubIngress.on("upgrade", (req, socket, head) => {
    if (!relayHub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  const owned: { ingress?: RelayIngress } = {};
  const relay = createServer((req, res) => {
    if (!owned.ingress?.(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  t.after(async () => {
    await owned.ingress?.close?.();
    await close(relay);
    relayHub.close();
    gatewayHub.close();
    await close(hubIngress);
    await close(gateway);
    await rm(dir, { recursive: true, force: true });
  });
  const hubPort = await listen(hubIngress),
    gatewayPort = await listen(gateway);
  relayHub.start(hubPort);
  gatewayHub.start(gatewayPort);
  const command = (node: HubNetwork, input: Record<string, unknown>) =>
    node.apply({ revision: node.store.state.revision, ...input }, "fixture");
  await command(relayHub, {
    action: "configure",
    name: "Relay",
    endpoint: `http://127.0.0.1:${hubPort}`,
    origin: "",
    accepting: true,
    forwarding: true,
  });
  await command(gatewayHub, {
    action: "configure",
    name: "Gateway",
    endpoint: `http://127.0.0.1:${gatewayPort}`,
    origin: "http://gateway.test",
    accepting: true,
    forwarding: true,
  });
  const invitation = (
    (await command(relayHub, { action: "invite", origins: ["http://gateway.test"], allowTransit: false })) as {
      invitation: string;
    }
  ).invitation;
  await command(gatewayHub, { action: "connect", invitation, trustIdentity: true });
  await waitFor(() => relayHub.routes().some((route) => route.service.hubId === gatewayHub.store.id));
  const target = { hubId: gatewayHub.store.id, origin: "http://gateway.test" };
  // The same route check the Relay application applies before opening a Hub stream.
  const openHubStream: OpenChannelHubStream = async (wanted, signal) => {
    if (
      !relayHub.routes().some((route) => route.service.hubId === wanted.hubId && route.service.origin === wanted.origin)
    )
      throw new Error("unavailable");
    return relayHub.open(wanted.hubId, undefined, signal);
  };
  owned.ingress = createChannelCallbackIngress(
    parseChannelCallbacks([
      { path: "/callbacks/chat", provider: "chat", ...target, timeoutMs: 1500 },
      { path: "/callbacks/missing", provider: "chat", hubId: hubId("b"), origin: "http://gateway.test" },
    ]),
    openHubStream,
  );
  const relayPort = await listen(relay);

  const body = Buffer.from("<xml>signed payload</xml>");
  const result = await call(relayPort, "/callbacks/chat?msg_signature=abc&nonce=1", {
    body,
    headers: {
      "content-type": "application/xml",
      "x-provider-signature": "sig",
      cookie: "session=private",
      authorization: "Bearer private",
      "x-forwarded-for": "192.0.2.1",
      staffid: "forged",
      "x-opencraft-relay-assertion": "forged",
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body, "success");
  assert.equal(result.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.headers["x-internal"], undefined);
  const delivered = received.at(-1)!;
  assert.equal(delivered.method, "POST");
  assert.equal(delivered.url, "/__opencraft_im/channel-callback/chat?msg_signature=abc&nonce=1");
  assert.equal(delivered.body, body.toString());
  assert.equal(delivered.headers.host, "gateway.test");
  assert.equal(delivered.headers["content-type"], "application/xml");
  assert.equal(delivered.headers["x-provider-signature"], "sig");
  for (const header of ["cookie", "authorization", "x-forwarded-for", "staffid", "x-opencraft-relay-assertion"])
    assert.equal(delivered.headers[header], undefined, header);

  assert.equal(
    (await call(relayPort, "/callbacks/chat?reject=1", { body: "x" })).status,
    401,
    "gateway status is relayed",
  );
  assert.equal((await call(relayPort, "/callbacks/chat", { method: "GET" })).status, 405);
  assert.equal(
    (await call(relayPort, "/callbacks/chat/extra", { body: "x" })).status,
    404,
    "only the exact path is claimed",
  );
  assert.equal(
    (await call(relayPort, "/callbacks/missing", { body: "x" })).status,
    503,
    "an unrouted Hub fails closed",
  );
  assert.equal((await call(relayPort, "/callbacks/chat", { body: Buffer.alloc(1024 * 1024 + 1) })).status, 413);
  const count = received.length;
  let release!: () => void;
  hold = new Promise((resolve) => {
    release = resolve;
  });
  assert.equal(
    (await call(relayPort, "/callbacks/chat", { body: "slow" })).status,
    503,
    "the exchange budget bounds a slow gateway",
  );
  release();
  hold = undefined;
  assert.equal(received.length, count + 1);
});

test("the Relay application wires channel callbacks behind extension hooks and fails closed without a route", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-channel-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = join(dir, "operator.json");
  await writeFile(operator, JSON.stringify({ credential: randomBytes(32).toString("base64url") }), { mode: 0o600 });
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  const seen: string[] = [];
  const app = await startRelayApplication(
    {
      schemaVersion: 1,
      host: "127.0.0.1",
      port,
      routes: [],
      hubNetwork: { stateFile: join(dir, "hub.json"), operatorCredentialFile: operator },
      channelCallbacks: [
        { path: "/callbacks/chat", provider: "chat", hubId: hubId("c"), origin: "https://gateway.example" },
      ],
    },
    {
      requestHandlers: [
        (req: IncomingMessage, _res: ServerResponse) => {
          seen.push(req.url ?? "");
          return false;
        },
      ],
    },
  );
  t.after(() => app.close());
  assert.equal((await call(port, "/callbacks/chat", { body: "x" })).status, 503);
  assert.equal((await call(port, "/callbacks/chat", { method: "PUT", body: "x" })).status, 405);
  assert.deepEqual(seen, ["/callbacks/chat", "/callbacks/chat"]);
});
