import assert from "node:assert/strict";
import test from "node:test";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { connectRelay } from "../../plugins/relay-connect/src/server.js";
import { createRelayServer } from "../../apps/relay-server/src/server.js";
import { startRelayApplication } from "../../apps/relay-server/src/application.js";
import { AssertionSigner } from "../../packages/identity-core/src/node.js";
import {
  CONTROL_PATH,
  DATA_PATH,
  STREAM_HEADER,
  RELAY_PROTOCOL,
  DRAIN_HEADER,
  DRAIN_CAPABILITY,
} from "../../packages/relay-protocol/src/index.js";
import { relayDuplex, bridgeRelayDuplex } from "../../packages/relay-protocol/src/node.js";
import { createConnection } from "node:net";

const token = () => randomBytes(32).toString("base64url");
const port = (server: Server | ReturnType<typeof createTcpServer>) => (server.address() as AddressInfo).port;
const base = (server: Server) => `http://127.0.0.1:${port(server)}`;
async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}
function get(url: string, headers: Record<string, string> = {}, received?: () => void) {
  return new Promise<{ status: number; body: Buffer; headers: IncomingHttpHeaders }>((resolve, reject) => {
    request(url, { agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => {
        chunks.push(c);
        received?.();
      });
      res.on("error", reject);
      res.once("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks), headers: res.headers }));
    })
      .on("error", reject)
      .end();
  });
}

for (const negotiated of [false, true])
  test(
    `connector with ${negotiated ? "stream-preserving" : "legacy"} relay: reconnect, data lifetime and policy rejection`,
    { timeout: 10000 },
    async (t) => {
      const targets = new Set<Socket>();
      const target = createTcpServer((socket) => {
        targets.add(socket);
        socket.once("close", () => targets.delete(socket));
        socket.pipe(socket);
      });
      await listen(target);
      const server = createServer(),
        wss = new WebSocketServer({ noServer: true });
      if (negotiated)
        wss.on("headers", (headers, req) => {
          if (req.url === CONTROL_PATH) headers.push(`${DRAIN_HEADER}: ${DRAIN_CAPABILITY}`);
        });
      const controls: WebSocket[] = [],
        data = new Map<string, WebSocket>();
      server.on("upgrade", (req, socket, head) =>
        wss.handleUpgrade(req, socket, head, (ws) => {
          if (req.url === CONTROL_PATH) controls.push(ws);
          else {
            const id = String(req.headers[STREAM_HEADER]);
            data.set(id, ws);
            ws.once("close", () => data.delete(id));
          }
        }),
      );
      await listen(server);
      const client = connectRelay({
        relay: base(server),
        credential: token(),
        targetPort: port(target),
        allowLoopbackInsecure: true,
      });
      t.after(() => {
        client.close();
        for (const ws of wss.clients) ws.terminate();
        for (const socket of targets) socket.destroy();
        server.closeAllConnections();
        server.close();
        target.close();
        wss.close();
      });
      await until(() => controls.length === 1 && client.connected());
      const id = randomUUID();
      controls[0]!.send(JSON.stringify({ type: "open", id, token: token() }));
      await until(() => data.has(id) && targets.size === 1);
      const original = data.get(id)!;
      controls[0]!.terminate();
      await until(() => controls.length === 2 && client.connected());
      if (negotiated) {
        const reply = once(original, "message");
        original.send("after control reconnect");
        assert.equal(String((await reply)[0]), "after control reconnect");
        controls[1]!.close(1008, "Policy revoked");
      }
      await until(() => data.size === 0 && targets.size === 0);
    },
  );

for (const negotiated of [false, true])
  test(
    `relay accepts ${negotiated ? "new" : "legacy"} connector and isolates reconnect generations`,
    { timeout: 10000 },
    async (t) => {
      const pair = generateKeyPairSync("ed25519"),
        credential = token();
      const principal = {
        provider: "fixture",
        subject: "person",
        displayName: "Person",
        expiresAt: Date.now() + 60000,
      };
      const relay = createRelayServer([
        {
          instanceId: "target",
          origin: "http://target.test",
          credential,
          signer: new AssertionSigner(
            { issuer: "test", instanceId: "target", origin: "http://target.test" },
            pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          ),
          identityProvider: { authenticate: () => principal },
        },
      ]);
      const backend = createServer((_req, res) => {
        res.write("first");
        finish = () => res.end("last");
      });
      let finish: (() => void) | undefined;
      await listen(backend);
      await listen(relay.server);
      const sockets = new Set<WebSocket>();
      let admitData = (open: () => void) => open();
      const openControl = async () => {
        const ws = new WebSocket(base(relay.server).replace("http:", "ws:") + CONTROL_PATH, RELAY_PROTOCOL, {
          headers: {
            authorization: `Bearer ${credential}`,
            ...(negotiated ? { [DRAIN_HEADER]: DRAIN_CAPABILITY } : {}),
          },
        });
        sockets.add(ws);
        ws.on("error", () => {});
        ws.on("message", (raw) => {
          const frame = JSON.parse(String(raw));
          assert.equal(frame.type, "open");
          admitData(() => {
            const data = new WebSocket(base(relay.server).replace("http:", "ws:") + DATA_PATH, RELAY_PROTOCOL, {
              headers: { authorization: `Bearer ${frame.token}`, [STREAM_HEADER]: frame.id },
            });
            sockets.add(data);
            data.on("error", () => {});
            data.once("open", () =>
              bridgeRelayDuplex(relayDuplex(data), createConnection({ host: "127.0.0.1", port: port(backend) })),
            );
            if (!negotiated) ws.once("close", () => data.terminate());
          });
        });
        await once(ws, "open");
        return ws;
      };
      t.after(async () => {
        for (const ws of sockets) ws.terminate();
        await relay.close();
        backend.closeAllConnections();
        backend.close();
      });
      const first = await openControl();
      await until(() => relay.connected("target"));
      let receivedHead = false;
      const response = get(base(relay.server) + "/slow", { host: "target.test" }, () => {
        receivedHead = true;
      });
      // Attach a rejection observer before deliberately dropping an old-protocol stream.
      const outcome = response.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await until(() => !!finish && receivedHead);
      first.terminate();
      await until(() => !relay.connected("target"));
      await openControl();
      await until(() => relay.connected("target"));
      finish!();
      const result = await outcome;
      if (negotiated) {
        assert.ok("value" in result);
        assert.equal(result.value.body.toString(), "firstlast");
      } else assert.ok("error" in result, "old wire semantics still close their own data");
      assert.equal(relay.connected("target"), true, "old close cannot erase new registration");
      if (negotiated) {
        let releaseData: (() => void) | undefined;
        admitData = (open) => {
          releaseData = open;
        };
        finish = undefined;
        const pendingResponse = get(base(relay.server) + "/pending", { host: "target.test" });
        await until(() => !!releaseData);
        relay.beginDrain();
        relay.stopAdmission();
        relay.handoffControls();
        assert.equal(relay.connected("target"), true, "pending acquisition holds the control");
        releaseData!();
        await until(() => !!finish);
        finish!();
        assert.equal(
          (await pendingResponse).body.toString(),
          "firstlast",
          "admitted data upgrade completes after public admission closes",
        );
      }
    },
  );

for (const stalled of [false, true])
  test(
    `application ${stalled ? "bounds a stalled request" : "drains complete HTTP"} while readiness fails and identity remains alive`,
    { timeout: 10000 },
    async (t) => {
      const pair = generateKeyPairSync("ed25519"),
        credential = token();
      const reserved = createServer();
      await listen(reserved);
      const relayPort = port(reserved);
      await new Promise<void>((r) => reserved.close(() => r()));
      let identityClosed = false,
        finish: (() => void) | undefined;
      const payload = randomBytes(514023);
      const backend = createServer((_req, res) => {
        res.writeHead(200, { "content-length": payload.length });
        res.write(payload.subarray(0, 1000));
        finish = () => res.end(payload.subarray(1000));
      });
      await listen(backend);
      const app = await startRelayApplication(
        {
          schemaVersion: 1,
          host: "127.0.0.1",
          port: relayPort,
          authentication: {
            issuer: "test",
            privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
            origin: "http://target.test",
            providers: ["fixture"],
          },
          routes: [{ instanceId: "target", origin: "http://target.test", credential }],
        },
        {
          createIdentity: async () => ({
            provider: {
              authenticate: () => ({
                provider: "fixture",
                subject: "person",
                displayName: "Person",
                expiresAt: Date.now() + 60000,
              }),
            },
            close: () => {
              identityClosed = true;
            },
          }),
        },
      );
      const client = connectRelay({
        relay: base(app.server),
        credential,
        targetPort: port(backend),
        allowLoopbackInsecure: true,
      });
      t.after(async () => {
        client.close();
        await app.close();
        backend.closeAllConnections();
        backend.close();
      });
      await until(() => client.connected());
      const start = await get(base(app.server) + "/slow", { host: "target.test", accept: "text/html" });
      assert.equal(start.status, 303);
      const login = new URL(start.headers.location!);
      const verified = await get(base(app.server) + login.pathname + login.search, { host: "target.test" });
      const callback = new URL(verified.headers.location!);
      const session = await get(base(app.server) + callback.pathname + callback.search, {
        host: "target.test",
        cookie: start.headers["set-cookie"]![0]!.split(";")[0]!,
      });
      const cookie = session.headers["set-cookie"]!.find((c) => c.startsWith("opencraft-relay-session="))!.split(
        ";",
      )[0]!;
      const response = get(base(app.server) + "/slow", { host: "target.test", cookie });
      const outcome = response.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await until(() => !!finish);
      const draining = app.drainAndClose({ propagationMs: 100, timeoutMs: 1000 });
      assert.equal(draining, app.drainAndClose());
      assert.equal((await get(base(app.server) + "/__opencraft_relay/health")).status, 503);
      assert.equal((await get(base(app.server) + "/__opencraft_relay/live")).status, 200);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal((await get(base(app.server) + "/new", { host: "target.test" })).status, 503);
      assert.equal(identityClosed, false);
      if (!stalled) finish!();
      const result = await outcome;
      if (stalled) assert.ok("error" in result);
      else {
        assert.ok("value" in result);
        assert.deepEqual(result.value.body, payload);
      }
      await draining;
      assert.equal(identityClosed, true);
    },
  );
