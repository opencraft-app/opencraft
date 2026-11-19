import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { RelayRedis, type RelayRedisConfiguration } from "../../apps/relay-server/src/redis.js";
import { RedisRelayCluster } from "../../apps/relay-server/src/cluster.js";
import { createRelayServer } from "../../apps/relay-server/src/server.js";
import { HubNetwork } from "../../packages/hub-network/src/node.js";
import { AssertionProvider, AssertionSigner } from "../../packages/identity-core/src/node.js";
import { connectRelay } from "../../plugins/relay-connect/src/server.js";
import { MemoryRelaySessionStore } from "../../apps/relay-server/src/session-store.js";
import { MemoryHubStore } from "../../packages/hub-network/src/store.js";

const secret = () => randomBytes(32).toString("base64url");
const address = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}
async function until(check: () => Promise<boolean>, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (!(await check().catch(() => false))) {
    if (Date.now() >= deadline) throw new Error("Cluster did not recover");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
async function get(base: string, path: string, headers: Record<string, string> = {}, method = "GET", body?: Buffer) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const req = request(base + path, { method, headers: { host: "entry.test", ...headers } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.setTimeout(12_000, () => req.destroy(new Error("Request timed out")));
      req.on("error", reject);
      req.end(body);
    },
  );
}
test("authentication storage bounds live records and consumes once under concurrent readers", async () => {
  const store = new MemoryRelaySessionStore(),
    expiry = Date.now() + 10000;
  assert.equal(await store.put("tickets", "a", { state: "a" }, expiry, 1), true);
  assert.equal(await store.put("tickets", "b", {}, expiry, 1), false);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.take("tickets", "a")));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.put("tickets", "b", {}, Date.now() - 1, 1), false);
});
test("shared Hub changes refuse synchronous acknowledgement and fail closed when durable commit fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hub-durability-"));
  try {
    const seed = new HubNetwork(join(directory, "seed.json")),
      state = structuredClone(seed.store.state);
    seed.close();
    const node = new HubNetwork(new MemoryHubStore(state), {
      localService: false,
      persist: async () => {
        throw new Error("unavailable");
      },
    });
    assert.throws(() => node.command({ action: "inspect" }, "test"), /durableCommand/u);
    const input = {
      revision: state.revision,
      action: "configure",
      name: "Changed",
      endpoint: "https://relay.test",
      origin: "",
      accepting: true,
      forwarding: true,
    };
    await assert.rejects(node.durableCommand(input, "test"), /unavailable/u);
    await assert.rejects(node.durableCommand(input, "test"), /closed/u);
    node.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test(
  "five real Redis replicas share login, consume tickets once, route HTTP/WS across owners, and recover without changing Hub identity",
  {
    skip: !process.env.OPENCRAFT_REDIS_TEST_FILE,
    timeout: 90_000,
  },
  async (t) => {
    const input = JSON.parse(await readFile(process.env.OPENCRAFT_REDIS_TEST_FILE!, "utf8"));
    const namespace = "integration-" + randomUUID();
    const configuration: RelayRedisConfiguration = {
      host: input.host,
      port: input.port,
      password: input.password,
      mode: input.mode ?? "cluster",
      namespace,
      credential: secret(),
      internalPort: 19000 + Math.floor(Math.random() * 10000),
    };
    const directory = await mkdtemp(join(tmpdir(), "relay-cluster-test-"));
    const stateFile = join(directory, "hub.json");
    const pair = generateKeyPairSync("ed25519"),
      privateKey = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const authority = { issuer: "cluster-test", publicKey, providers: ["test"] };
    const initial = new HubNetwork(stateFile, { authority, localService: false });
    initial.command(
      {
        revision: initial.store.state.revision,
        action: "configure",
        name: "Cluster test",
        endpoint: "https://entry.test",
        origin: "",
        accepting: true,
        forwarding: true,
      },
      "test",
    );
    const hubId = initial.snapshot().hubId;
    initial.close();
    const scope = { issuer: authority.issuer, instanceId: "target", origin: "https://entry.test" };
    const credential = secret(),
      principal = { provider: "test", subject: "user", displayName: "Test User", expiresAt: Date.now() + 120_000 };
    const verified = new AssertionProvider(scope, publicKey);
    const asset = randomBytes(514_023);
    const target = createServer((req, res) => {
      if (!verified.authenticate(req)) {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.url === "/__opencraft_access/session") {
        res.end(JSON.stringify({ role: "member" }));
        return;
      }
      if (req.url === "/stream") {
        res.write("first");
        setTimeout(() => res.end("second"), 100);
        return;
      }
      if (req.url === "/asset.css") {
        res.writeHead(200, { "content-type": "text/css", "content-length": asset.length });
        res.end(asset);
        return;
      }
      if (req.method === "POST") {
        req.pipe(res);
        return;
      }
      res.end("target-response");
    });
    const targetWs = new WebSocketServer({ noServer: true });
    target.on("upgrade", (req, socket, head) => {
      if (!verified.authenticate(req)) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      targetWs.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
    });
    await listen(target);
    const replicas: {
      redis: RelayRedis;
      cluster: RedisRelayCluster;
      app: ReturnType<typeof createRelayServer>;
      base: string;
      alive: boolean;
    }[] = [];
    const monitor = await RelayRedis.connect(configuration);
    let connector: ReturnType<typeof connectRelay> | undefined;
    let peer: HubNetwork | undefined, peerServer: Server | undefined;
    const loadBalancer = createServer();
    let cursor = 0;
    const drainingReplicas = new Set<string>();
    const tunnels = new Set<import("node:stream").Duplex>();
    loadBalancer.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      const live = replicas.filter((r) => r.alive && !drainingReplicas.has(r.cluster.nodeId)),
        replica = live[cursor++ % live.length];
      if (!replica) {
        socket.destroy();
        return;
      }
      const upstream = request(replica.base + req.url, { headers: req.headers });
      upstream.on("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
      upstream.once("response", (response) => {
        response.resume();
        socket.destroy();
      });
      upstream.once("upgrade", (response, tunnel, initial) => {
        tunnels.add(tunnel);
        tunnel.once("close", () => {
          tunnels.delete(tunnel);
          socket.destroy();
        });
        tunnel.on("error", () => socket.destroy());
        socket.once("close", () => tunnel.destroy());
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")}\r\n\r\n`,
        );
        if (initial.length) socket.write(initial);
        if (head.length) tunnel.write(head);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
      });
      upstream.end();
    });
    await listen(loadBalancer);
    t.after(async () => {
      connector?.close();
      peer?.close();
      for (const socket of tunnels) socket.destroy();
      await Promise.allSettled(
        replicas.map(async (r) => {
          r.alive = false;
          await Promise.all([r.cluster.close(), r.app.close()]);
        }),
      );
      await Promise.all([
        new Promise<void>((resolve) => loadBalancer.close(() => resolve())),
        new Promise<void>((resolve) => {
          target.close(() => resolve());
          target.closeAllConnections();
        }),
      ]);
      targetWs.close();
      if (peerServer)
        await new Promise<void>((resolve) => {
          peerServer!.close(() => resolve());
          peerServer!.closeAllConnections();
        });
      try {
        const keys = ["configuration", "hub-state", "hub-routes", "hub-owner", "connection:target"];
        for (const kind of ["starts", "tickets", "sessions"]) {
          const ids = await monitor.client.zrange(monitor.key("auth-index:" + kind), 0, -1);
          keys.push("auth-index:" + kind, ...ids.map((id) => "auth:" + kind + ":" + id));
        }
        await monitor.client.del(...keys.map((key) => monitor.key(key)));
      } finally {
        monitor.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
    for (let i = 0; i < 5; i++) {
      const redis = await RelayRedis.connect(configuration);
      const cluster = new RedisRelayCluster(redis, {
        nodeId: "replica-" + i,
        advertiseHost: "127.0.0." + (i + 2),
        publicPort: 18090,
        stateFile,
        authority,
        configurationHash: "test-v1",
      });
      const app = createRelayServer(
        [
          {
            ...scope,
            credential,
            signer: new AssertionSigner(scope, privateKey),
            identityProvider: { authenticate: () => null },
          },
        ],
        {
          cluster,
          hub: cluster.hub,
          serverSelection: true,
          networkRoute: (service) => ({
            instanceId: service.hubId,
            hubId: service.hubId,
            origin: service.origin,
            credential: "",
            identityProvider: { authenticate: () => null },
            signer: new AssertionSigner(
              { issuer: authority.issuer, instanceId: service.hubId, origin: service.origin },
              privateKey,
            ),
          }),
          authentication: {
            origin: scope.origin,
            provider: { authenticate: (req) => (req.headers["x-test-auth"] === "yes" ? principal : null) },
          },
        },
      );
      await cluster.start();
      await listen(app.server);
      replicas.push({ redis, cluster, app, base: address(app.server), alive: true });
    }
    for (const replica of replicas) assert.equal((await get(replica.base, "/__opencraft_relay/health")).status, 200);
    const wrongRedis = await RelayRedis.connect(configuration);
    const wrong = new RedisRelayCluster(wrongRedis, {
      nodeId: "wrong-config",
      advertiseHost: "127.0.0.7",
      publicPort: 18090,
      stateFile,
      authority,
      configurationHash: "different",
    });
    wrong.bind({
      channel: async () => {
        throw new Error("unused");
      },
      upgrade: () => {},
    });
    await assert.rejects(wrong.start(), /configuration differs/u);
    assert.equal(
      (await get(replicas[0]!.base, "/__opencraft_hub/operator", { "x-opencraft-relay-cluster-auth": "forged" }))
        .status,
      403,
    );
    connector = connectRelay({
      relay: address(loadBalancer),
      credential,
      targetPort: (target.address() as AddressInfo).port,
      allowLoopbackInsecure: true,
    });
    await until(async () => replicas.some((r) => r.app.connected("target")));
    const start = await get(replicas[0]!.base, "/", { accept: "text/html" });
    assert.equal(start.status, 303);
    const login = new URL(String(start.headers.location));
    const challenge = start.headers["set-cookie"]![0]!.split(";")[0]!;
    const authenticated = await get(replicas[1]!.base, login.pathname + login.search, { "x-test-auth": "yes" });
    assert.equal(authenticated.status, 303);
    const callback = new URL(String(authenticated.headers.location));
    const exchanges = await Promise.all(
      [2, 3].map((i) => get(replicas[i]!.base, callback.pathname + callback.search, { cookie: challenge })),
    );
    assert.deepEqual(exchanges.map((x) => x.status).sort(), [303, 403], "ticket consumed once across replicas");
    const session = exchanges
      .find((x) => x.status === 303)!
      .headers["set-cookie"]!.find((x) => x.startsWith("__Host-opencraft-relay-session="))!
      .split(";")[0]!;
    for (const replica of replicas) {
      const response = await get(replica.base, "/echo", { cookie: session });
      assert.equal(response.status, 200);
      assert.equal(response.body.toString(), "target-response");
    }
    await Promise.all(
      replicas.flatMap((replica) =>
        Array.from({ length: 4 }, async () => {
          const response = await get(replica.base, "/asset.css", { cookie: session });
          assert.equal(response.status, 200);
          assert.deepEqual(response.body, asset, "every replica preserves the complete response tail");
        }),
      ),
    );
    const upload = randomBytes(1_048_576);
    assert.deepEqual((await get(replicas[4]!.base, "/upload", { cookie: session }, "POST", upload)).body, upload);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        replicas[3]!.base + "/stream",
        { headers: { host: "entry.test", cookie: session } },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
            if (data === "first") assert.equal(response.complete, false);
          });
          response.once("end", () => {
            assert.equal(data, "firstsecond");
            resolve();
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    const ws = new WebSocket(replicas[2]!.base.replace("http:", "ws:") + "/socket", {
      headers: { host: "entry.test", origin: scope.origin, cookie: session },
    });
    await once(ws, "open");
    const echoed = once(ws, "message");
    ws.send(upload);
    assert.deepEqual((await echoed)[0], upload);
    const oldRoute = JSON.parse((await monitor.read("connection:target"))!);
    const drainingOwner = replicas.find((r) => r.cluster.nodeId === oldRoute.node)!;
    drainingReplicas.add(oldRoute.node);
    drainingOwner.app.beginDrain();
    await until(async () => {
      drainingOwner.app.handoffControls();
      return !drainingOwner.app.connected("target");
    });
    await until(async () => {
      const value = await monitor.read("connection:target");
      return !!value && JSON.parse(value).node !== oldRoute.node;
    });
    // Exercise renewal races as well as the immediate control-close callback.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const afterHandoff = once(ws, "message");
    ws.send("old stream after new owner");
    assert.equal(String((await afterHandoff)[0]), "old stream after new owner");
    assert.equal((await get(drainingOwner.base, "/__opencraft_relay/health")).status, 503);
    ws.terminate();
    await replicas[0]!.cluster.prepare();
    let hubSnapshot = replicas[0]!.cluster.hub.snapshot();
    await replicas[1]!.cluster.hub.command(
      {
        revision: hubSnapshot.revision,
        action: "configure",
        name: "Cluster test",
        endpoint: address(loadBalancer),
        origin: "",
        accepting: true,
        forwarding: true,
      },
      "test",
    );
    await replicas[0]!.cluster.prepare();
    hubSnapshot = replicas[0]!.cluster.hub.snapshot();
    const invitation = await replicas[2]!.cluster.hub.command(
      { revision: hubSnapshot.revision, action: "invite", origins: ["https://team.test"], allowTransit: false },
      "test",
    );
    assert.ok("invitation" in invitation && invitation.invitation);
    const invitationId = JSON.parse(Buffer.from(invitation.invitation!, "base64url").toString()).payload.id;
    peer = new HubNetwork(join(directory, "peer.json"));
    peer.command(
      {
        revision: peer.store.state.revision,
        action: "connect",
        invitation: invitation.invitation,
        trustIdentity: true,
        publishOrigin: "https://team.test",
      },
      "test",
    );
    peerServer = createServer((req, res) => {
      if (!peer!.authenticate(req)) {
        res.writeHead(401);
        res.end();
      } else res.end("shared-hub-target");
    });
    await listen(peerServer);
    peer.start((peerServer.address() as AddressInfo).port);
    const peerPath = "/servers/" + peer.snapshot().hubId + "/hub-echo";
    await until(async () => (await get(replicas[4]!.base, peerPath, { cookie: session })).status === 200);
    for (const r of replicas)
      assert.equal((await get(r.base, peerPath, { cookie: session })).body.toString(), "shared-hub-target");
    const before = await monitor.read("hub-owner");
    const leaderId = JSON.parse(before!).node;
    const leader = replicas.find((r) => r.cluster.nodeId === leaderId)!;
    leader.alive = false;
    await Promise.all([leader.cluster.close(), leader.app.close()]);
    await until(async () => {
      for (const r of replicas.filter((r) => r.alive)) {
        await r.cluster.prepare();
        if (r.cluster.hub.snapshot().hubId !== hubId) return false;
      }
      return true;
    });
    assert.notEqual(await monitor.read("hub-owner"), before);
    await monitor.release("hub-owner", before!);
    assert.ok(await monitor.read("hub-owner"), "late old owner cannot clear its successor");
    await until(async () => {
      for (const r of replicas.filter((r) => r.alive)) {
        if (
          (await get(r.base, "/echo", { cookie: session })).status !== 200 ||
          (await get(r.base, peerPath, { cookie: session })).status !== 200
        )
          return false;
      }
      return true;
    });
    for (const r of replicas.filter((r) => r.alive))
      assert.equal((await get(r.base, "/echo", { cookie: session })).status, 200, "session survives owner failover");
    const live = replicas.filter((r) => r.alive);
    const snapshot = live[0]!.cluster.hub.snapshot();
    const change = await live[1]!.cluster.hub.command(
      {
        revision: snapshot.revision,
        action: "configure",
        name: "Persisted name",
        endpoint: snapshot.endpoint,
        origin: "",
        accepting: true,
        forwarding: true,
      },
      "test",
    );
    assert.equal(change.snapshot.name, "Persisted name");
    assert.equal(JSON.parse((await monitor.read("hub-state"))!).name, "Persisted name");
    await live[0]!.cluster.prepare();
    const revoked = await live[0]!.cluster.hub.command(
      { revision: live[0]!.cluster.hub.snapshot().revision, action: "revoke", id: invitationId },
      "test",
    );
    assert.equal(revoked.snapshot.invitations.length, 0);
    for (const r of live)
      assert.equal(
        (await get(r.base, peerPath, { cookie: session })).status,
        404,
        "revoked Hub route disappears on every replica",
      );
    const retained = new WebSocket(live[0]!.base.replace("http:", "ws:") + "/socket", {
      headers: { host: "entry.test", origin: scope.origin, cookie: session },
    });
    retained.on("error", () => {});
    await once(retained, "open");
    t.after(() => retained.terminate());
    const retainingRoute = JSON.parse((await monitor.read("connection:target"))!);
    const retainingOwner = live.find((r) => r.cluster.nodeId === retainingRoute.node)!;
    drainingReplicas.add(retainingRoute.node);
    await until(async () => {
      retainingOwner.app.handoffControls();
      return !retainingOwner.app.connected("target");
    });
    const retainedEcho = once(retained, "message");
    retained.send("retained before dependency loss");
    assert.equal(String((await retainedEcho)[0]), "retained before dependency loss");
    const retainedClosed = once(retained, "close");
    assert.equal(
      (await get(live[0]!.base, "/__opencraft_relay/logout", { cookie: session, origin: scope.origin }, "POST")).status,
      204,
    );
    for (const r of live) assert.equal((await get(r.base, "/echo", { cookie: session })).status, 401);
    for (const r of live) r.redis.client.disconnect();
    for (const r of live) {
      assert.equal(
        (await get(r.base, "/echo", { cookie: session })).status,
        503,
        "Redis loss never falls back to private per-process sessions",
      );
      assert.equal(
        (await get(r.base, "/__opencraft_relay/live")).status,
        200,
        "dependency outage must not trigger a liveness restart storm",
      );
    }
    await retainedClosed;
    assert.equal(
      retained.readyState,
      WebSocket.CLOSED,
      "Redis failure retires detached streams as well as active routes",
    );
  },
);
