import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startRelayApplication, type RelayComposition } from "../../apps/relay-server/src/application";
import { reservedRelayPath } from "../../apps/relay-server/src/server";

const token = () => randomBytes(32).toString("base64url");
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
async function transit(t: test.TestContext, composition: RelayComposition) {
  const dir = await mkdtemp(join(tmpdir(), "relay-hooks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = join(dir, "operator.json");
  await writeFile(operator, JSON.stringify({ credential: token() }), { mode: 0o600 });
  const port = await freePort();
  const app = await startRelayApplication(
    {
      schemaVersion: 1,
      host: "127.0.0.1",
      port,
      routes: [],
      hubNetwork: { stateFile: join(dir, "hub.json"), operatorCredentialFile: operator },
    },
    composition,
  );
  t.after(() => app.close());
  return { app, port };
}
function get(port: number, path = "/", headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, agent: false, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.once("error", reject);
    req.end();
  });
}
async function rawUpgrade(port: number, path: string) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: relay.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
  );
  const [chunk] = (await once(socket, "data")) as [Buffer];
  return { socket, head: chunk.toString("latin1") };
}

test("reserved core paths are recognized independently of query and suffix", () => {
  for (const path of [
    "/__opencraft_relay/health",
    "/__opencraft_relay",
    "/__opencraft_hub/join?x=1",
    "/__opencraft_hub/operator",
  ])
    assert.equal(reservedRelayPath(path), true, path);
  for (const path of ["/", "/__opencraft_relayx", "/servers", "/__opencraft_im/channel-callback/x", undefined])
    assert.equal(reservedRelayPath(path), false, String(path));
});

test("request handlers run in order before core routing, fall through on false and fail closed on errors", async (t) => {
  const calls: string[] = [];
  const { port } = await transit(t, {
    requestHandlers: [
      (req) => {
        calls.push("first:" + req.url);
        return false;
      },
      async (req, res) => {
        calls.push("second:" + req.url);
        if (req.url === "/asset") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("extension");
          return true;
        }
        if (req.url === "/throws") throw new Error("synthetic");
        if (req.url === "/rejects") {
          res.writeHead(202);
          res.write("partial");
          throw new Error("synthetic after headers");
        }
        return false;
      },
      (_req, res) => {
        calls.push("third");
        res.writeHead(204);
        res.end();
        return true;
      },
    ],
  });
  const handled = await get(port, "/asset");
  assert.equal(handled.status, 200);
  assert.equal(handled.body, "extension");
  assert.deepEqual(calls.splice(0), ["first:/asset", "second:/asset"], "first true stops dispatch");
  assert.equal((await get(port, "/throws")).status, 503);
  assert.deepEqual(calls.splice(0), ["first:/throws", "second:/throws"], "a throwing handler never falls through");
  await assert.rejects(get(port, "/rejects"), "a failure after headers destroys the response");
  calls.length = 0;
  assert.equal((await get(port, "/other")).status, 204);
  assert.deepEqual(calls.splice(0), ["first:/other", "second:/other", "third"]);
  for (const path of ["/__opencraft_relay/live", "/__opencraft_relay/health"])
    assert.equal((await get(port, path)).status, 200);
  assert.equal((await get(port, "/__opencraft_hub/operator")).status, 403, "core operator admission is never shadowed");
  assert.deepEqual(calls, [], "reserved core paths bypass extensions");
});

test("a handler that declines leaves core routing intact", async (t) => {
  const { port } = await transit(t, { requestHandlers: [() => false] });
  assert.equal((await get(port, "/")).status, 403, "core transit relay still denies unknown hosts");
});

test("upgrade handlers own accepted sockets until shutdown and reserved upgrades bypass them", async (t) => {
  const seen: string[] = [];
  let owned: Socket | undefined;
  const { app, port } = await transit(t, {
    upgradeHandlers: [
      async (req, socket) => {
        seen.push(req.url ?? "");
        if (req.url === "/throws") throw new Error("synthetic");
        if (req.url !== "/tunnel") return false;
        owned = socket as Socket;
        socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
        return true;
      },
    ],
  });
  const accepted = await rawUpgrade(port, "/tunnel");
  assert.match(accepted.head, /^HTTP\/1\.1 101/u);
  const thrown = connect(port, "127.0.0.1");
  await once(thrown, "connect");
  thrown.write("GET /throws HTTP/1.1\r\nHost: relay.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  await once(thrown, "close");
  const declined = await rawUpgrade(port, "/other");
  assert.match(declined.head, /^HTTP\/1\.1 403/u, "declined upgrades reach core admission");
  declined.socket.destroy();
  const reserved = await rawUpgrade(port, "/__opencraft_relay/control");
  assert.match(reserved.head, /^HTTP\/1\.1 401/u);
  reserved.socket.destroy();
  assert.deepEqual(seen, ["/tunnel", "/throws", "/other"]);
  const closed = once(accepted.socket, "close");
  await app.close();
  await closed;
  assert.equal(owned?.destroyed, true, "close destroys extension-owned upgrades");
});

test("accepted extension requests and upgrades hold drain open and nothing runs after close", async (t) => {
  let calls = 0,
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app, port } = await transit(t, {
    requestHandlers: [
      async (_req, res) => {
        calls++;
        await held;
        res.writeHead(200);
        res.end("late");
        return true;
      },
    ],
  });
  const response = get(port, "/slow");
  while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
  let drained = false;
  const draining = app.drainAndClose({ propagationMs: 0, timeoutMs: 5000 }).then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(drained, false, "an in-flight extension request is an active request");
  release();
  assert.equal((await response).body, "late");
  await draining;
  await assert.rejects(get(port, "/slow"));
  assert.equal(calls, 1);
});

test("invalid handler lists are rejected before listening and roll back", async (t) => {
  const port = await freePort(),
    dir = await mkdtemp(join(tmpdir(), "relay-hooks-invalid-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = join(dir, "operator.json");
  await writeFile(operator, JSON.stringify({ credential: token() }), { mode: 0o600 });
  await assert.rejects(
    startRelayApplication(
      {
        schemaVersion: 1,
        host: "127.0.0.1",
        port,
        routes: [],
        hubNetwork: { stateFile: join(dir, "hub.json"), operatorCredentialFile: operator },
      },
      { requestHandlers: ["not a function" as never] },
    ),
    /Invalid relay extension handlers/,
  );
  await assert.rejects(get(port));
});
