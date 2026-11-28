import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { AssertionSigner } from "@opencraft/identity-core/node";
import {
  MuxFrameType,
  MuxOutboundBatcher,
  MuxStreamFlowControl,
  decodeMuxFrame,
  encodeMuxFrame,
  formatMachineCredential,
  formatPairingUrl,
  parseMachineCredential,
  parsePairingUrl,
  solveHashcashPow,
  validateDirectRouteCandidate,
  verifyHashcashPow,
  type MuxFrame,
} from "@opencraft/relay-protocol";
import {
  connectRelayMux,
  discoverDirectRoutes,
  isTransientDeltaPayload,
  loadRelayConnection,
} from "@opencraft/plugin-relay-connect/server";
import { createRelayServer } from "@opencraft/relay-server";
import { issueRelayLicenseKey, verifyRelayLicenseKey } from "@opencraft/relay-server/cloud-crypto";
import { initializeSelfHostedRelayDirectory } from "@opencraft/relay-server/init";
import {
  IDENTITY_INDEX_MIGRATIONS,
  IdentityIndexStore,
  USER_RELAY_MIGRATIONS,
  UserRelayStore,
} from "@opencraft/relay-server/cloud-domain";
import type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from "@opencraft/sql";
import { applySqlMigrations, hashSqlMigrations } from "@opencraft/sql/migrations";

const sha256HexSync = (text: string): string => createHash("sha256").update(text).digest("hex");

function sqliteTestAdapter(db: DatabaseSync): SqlDatabase {
  let depth = 0;
  return {
    get inTransaction() {
      return depth > 0;
    },
    exec(sql: string) {
      db.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = db.prepare(sql);
      return {
        get(...params: SqlValue[]) {
          return stmt.get(...params) as SqlRow | undefined;
        },
        all(...params: SqlValue[]) {
          return stmt.all(...params) as SqlRow[];
        },
        iterate(...params: SqlValue[]) {
          return stmt.iterate(...params) as IterableIterator<SqlRow>;
        },
        run(...params: SqlValue[]) {
          const res = stmt.run(...params);
          return { changes: res.changes };
        },
      };
    },
    transaction<T>(fn: () => T): T {
      const sp = `sp_${depth}`;
      db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
        return result;
      } catch (err) {
        depth -= 1;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}; RELEASE SAVEPOINT ${sp}`);
        throw err;
      }
    },
  };
}

test("mux.v2 codec encodes and decodes all 10 frame types and rejects malformed inputs", () => {
  const frames: MuxFrame[] = [
    {
      type: MuxFrameType.OPEN_WS,
      streamId: 1,
      init: {
        path: "/ws?client=mobile",
        subprotocol: "appserver.v1",
        actorId: "actor_123",
        deviceThumbprint: "thumb_abc",
        scope: { role: "owner", allowExecution: true, grantEpoch: 2 },
      },
    },
    {
      type: MuxFrameType.OPEN_HTTP,
      streamId: 2,
      fin: false,
      init: {
        method: "POST",
        path: "/api/threads",
        headers: [["content-type", "application/json"]],
        actorId: "actor_123",
        grantId: "grant_9",
        scope: { role: "collaborator", allowExecution: false, grantEpoch: 1, threadIds: ["thr_1"] },
      },
    },
    {
      type: MuxFrameType.HTTP_RESPONSE,
      streamId: 2,
      fin: true,
      init: { status: 201, headers: [["content-type", "application/json"]] },
    },
    {
      type: MuxFrameType.DATA_TEXT,
      streamId: 1,
      fin: false,
      transientDelta: true,
      text: '{"method":"item/agentMessage/delta","params":{"delta":"hello"}}',
    },
    {
      type: MuxFrameType.DATA_BINARY,
      streamId: 2,
      fin: true,
      data: new Uint8Array([1, 2, 3, 4, 255]),
    },
    {
      type: MuxFrameType.DATA_BATCH,
      streamId: 1,
      transientDelta: true,
      messages: ["msg-one", "msg-two", "你好世界"],
    },
    {
      type: MuxFrameType.WINDOW_UPDATE,
      streamId: 1,
      increment: 65_536,
    },
    {
      type: MuxFrameType.CLOSE,
      streamId: 1,
      code: 1000,
      reason: "Normal closure",
    },
    {
      type: MuxFrameType.ROUTE_ADVERTISE,
      candidates: [
        { kind: "tailscale", origin: "https://macbook.tailnet.ts.net", priority: 10 },
        { kind: "lan", origin: "http://192.168.1.42:4200", priority: 20 },
      ],
    },
    {
      type: MuxFrameType.AUDIENCE_STATE,
      activeWatchers: 0,
    },
  ];

  for (const frame of frames) {
    const wire = encodeMuxFrame(frame);
    const decoded = decodeMuxFrame(wire);
    assert.deepEqual(decoded, frame);
  }

  assert.throws(() => decodeMuxFrame(new Uint8Array([1, 2, 3])), /Truncated mux frame/u);
  assert.throws(
    () =>
      validateDirectRouteCandidate({
        kind: "lan",
        origin: "http://8.8.8.8:4200",
        priority: 10,
      }),
    /private network address/u,
  );
});

test("self-addressing ocm credentials and fragment-protected pairing URLs roundtrip cleanly", () => {
  const machineId = "550e8400-e29b-41d4-a716-446655440000";
  const secret = "a".repeat(43);
  const cred = formatMachineCredential(machineId, secret);
  assert.deepEqual(parseMachineCredential(cred), { machineId, secret });
  assert.equal(parseMachineCredential("ocm_invalid"), null);

  const code = "550e8400-e29b-41d4-a716-446655440000_secretPairToken123456";
  const deepLink = formatPairingUrl(
    { relayOrigin: "https://relay.opencraft.dev", machineId, code, approvalRequired: true },
    "opencraft",
  );
  assert.ok(deepLink.includes("#code="), "secret code must stay inside URL fragment");
  assert.ok(!deepLink.split("#")[0]!.includes(code), "query string must not leak pairing code");
  assert.deepEqual(parsePairingUrl(deepLink), {
    relayOrigin: "https://relay.opencraft.dev",
    machineId,
    code,
    approvalRequired: true,
  });

  const webLink = formatPairingUrl({ relayOrigin: "https://relay.opencraft.dev", machineId, code }, "https");
  assert.deepEqual(parsePairingUrl(webLink), {
    relayOrigin: "https://relay.opencraft.dev",
    machineId,
    code,
  });
});

test("MuxStreamFlowControl enforces per-stream send window and replenishes via WINDOW_UPDATE", () => {
  const emitted: MuxFrame[] = [];
  const flow = new MuxStreamFlowControl(7, (f) => emitted.push(f), { initialWindow: 10, maxBufferedBytes: 64 });

  flow.sendBinary(new Uint8Array(25), { fin: true });
  // Only 10 bytes may leave until window credits arrive
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.type, MuxFrameType.DATA_BINARY);
  if (emitted[0]?.type === MuxFrameType.DATA_BINARY) {
    assert.equal(emitted[0].data.byteLength, 10);
    assert.equal(emitted[0].fin, false);
  }
  assert.equal(flow.sendWindow, 0);
  assert.equal(flow.bufferedBytes, 15);

  flow.onWindowUpdate(20);
  assert.equal(emitted.length, 2);
  if (emitted[1]?.type === MuxFrameType.DATA_BINARY) {
    assert.equal(emitted[1].data.byteLength, 15);
    assert.equal(emitted[1].fin, true);
  }
  assert.equal(flow.bufferedBytes, 0);

  // Inbound consumption triggers automatic WINDOW_UPDATE at >= 50% window
  flow.onInboundConsumed(5);
  assert.equal(emitted.length, 3);
  assert.deepEqual(emitted[2], { type: MuxFrameType.WINDOW_UPDATE, streamId: 7, increment: 5 });
});

test("MuxOutboundBatcher coalesces bursts into DATA_BATCH and suppresses deltas at zero watchers", async () => {
  const wireFrames: MuxFrame[] = [];
  const batcher = new MuxOutboundBatcher((raw) => wireFrames.push(decodeMuxFrame(raw)), 25);

  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: true,
    text: '{"method":"turn/delta","params":{"t":"a"}}',
  });
  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: true,
    text: '{"method":"turn/delta","params":{"t":"b"}}',
  });
  assert.equal(wireFrames.length, 0);

  await new Promise((r) => setTimeout(r, 45));
  assert.equal(wireFrames.length, 1);
  assert.equal(wireFrames[0]?.type, MuxFrameType.DATA_BATCH);
  if (wireFrames[0]?.type === MuxFrameType.DATA_BATCH) {
    assert.equal(wireFrames[0].messages.length, 2);
  }

  // Non-transient RPC reply flushes synchronously (0ms wait) AND carries queued deltas in FIFO order!
  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: true,
    text: '{"method":"turn/delta","params":{"t":"tail"}}',
  });
  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: false,
    text: '{"jsonrpc":"2.0","id":77,"result":{"immediate":true}}',
  });
  assert.equal(wireFrames.length, 2, "non-transient frame must flush synchronously with 0ms wait");
  assert.equal(wireFrames[1]?.type, MuxFrameType.DATA_BATCH);
  if (wireFrames[1]?.type === MuxFrameType.DATA_BATCH) {
    assert.equal(wireFrames[1].messages.length, 2);
    assert.match(wireFrames[1].messages[0]!, /"tail"/u);
    assert.match(wireFrames[1].messages[1]!, /"immediate":true/u);
  }

  // Zero active watchers: transient deltas are dropped, non-transient RPC replies still flush immediately!
  batcher.setActiveWatchers(0);
  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: true,
    text: '{"method":"turn/delta","params":{"t":"dropped"}}',
  });
  batcher.send({
    type: MuxFrameType.DATA_TEXT,
    streamId: 3,
    fin: false,
    transientDelta: false,
    text: '{"jsonrpc":"2.0","id":1,"result":{"done":true}}',
  });
  assert.equal(wireFrames.length, 3);
  assert.equal(wireFrames[2]?.type, MuxFrameType.DATA_TEXT);
  if (wireFrames[2]?.type === MuxFrameType.DATA_TEXT) {
    assert.match(wireFrames[2].text, /"done":true/u);
  }

  assert.equal(isTransientDeltaPayload('{"method":"item/agentMessage/delta","params":{}}'), true);
  assert.equal(isTransientDeltaPayload('{"jsonrpc":"2.0","id":9,"result":{"delta":"not-transient"}}'), false);
  batcher.dispose();
});

test("discoverDirectRoutes extracts Tailscale HTTPS/CGNAT and RFC1918 LAN routes sorted by priority", async () => {
  const routes = await discoverDirectRoutes({
    localPort: 4200,
    localProtocol: "http",
    execTailscaleStatusJson: async () => ({
      BackendState: "Running",
      CertDomains: ["devbox.tail99.ts.net."],
      Self: { Online: true, TailscaleIPs: ["100.88.1.9", "fd7a:115c:a1e0::1"] },
    }),
    networkInterfacesImpl: () =>
      ({
        lo0: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        en0: [
          {
            address: "192.168.50.12",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "192.168.50.12/24",
          },
          {
            address: "8.8.4.4",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "aa:bb:cc:dd:ee:ff",
            internal: false,
            cidr: "8.8.4.4/24",
          },
        ],
      }) as ReturnType<typeof import("node:os").networkInterfaces>,
  });

  assert.deepEqual(routes, [
    { kind: "tailscale", origin: "https://devbox.tail99.ts.net", priority: 10 },
    { kind: "tailscale", origin: "http://100.88.1.9:4200", priority: 15 },
    { kind: "lan", origin: "http://192.168.50.12:4200", priority: 20 },
  ]);
});

test("SQLite v1 -> v2 migration upgrades preserve existing data, enforce rate limits/licenses, and reject tampered checksums", async () => {
  const rawDb = new DatabaseSync(":memory:");
  try {
    const sql = sqliteTestAdapter(rawDb);
    // 1. Seed a v1-only IdentityIndex database (matching initial production deployment)
    applySqlMigrations(sql, hashSqlMigrations(IDENTITY_INDEX_MIGRATIONS.slice(0, 1), sha256HexSync));
    sql
      .prepare(
        "INSERT INTO identity_bindings(binding_hash, provider, actor_id, password_phc, version, created_at, updated_at) VALUES(?,?,?,?,1,?,?)",
      )
      .run("a".repeat(64), "local", "actor_alice", "$pbkdf2-sha256$i=100000$salt$hash", 1_000, 1_000);

    // 2. Open v2 IdentityIndexStore -> migrates cleanly to v2 while preserving v1 rows!
    const upgradedIndex = IdentityIndexStore.open(sql, sha256HexSync);
    assert.equal(upgradedIndex.read("a".repeat(64))?.actorId, "actor_alice");
    const rl1 = upgradedIndex.consumeRateLimit({ bucketKey: "enroll:ip1", limit: 2, windowMs: 60_000, now: 2_000 });
    const rl2 = upgradedIndex.consumeRateLimit({ bucketKey: "enroll:ip1", limit: 2, windowMs: 60_000, now: 2_100 });
    const rl3 = upgradedIndex.consumeRateLimit({ bucketKey: "enroll:ip1", limit: 2, windowMs: 60_000, now: 2_200 });
    assert.equal(rl1.allowed, true);
    assert.equal(rl2.allowed, true);
    assert.equal(rl3.allowed, false);
    assert.deepEqual(
      upgradedIndex.claimLicense({ licenseId: "lic_1", actorId: "actor_alice", tier: "pro", now: 2_000 }),
      { ok: true },
    );
    assert.deepEqual(
      upgradedIndex.claimLicense({ licenseId: "lic_1", actorId: "actor_stranger", tier: "pro", now: 2_100 }),
      { ok: false, error: "license_already_claimed" },
    );

    // 3. Tamper stored migration checksum -> must refuse to open
    rawDb.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    assert.throws(() => IdentityIndexStore.open(sql, sha256HexSync), /Unsupported database migration history/u);
  } finally {
    rawDb.close();
  }

  const userRawDb = new DatabaseSync(":memory:");
  try {
    const sql = sqliteTestAdapter(userRawDb);
    // 1. Seed a v1-only UserRelay database with an enrolled machine
    applySqlMigrations(sql, hashSqlMigrations(USER_RELAY_MIGRATIONS.slice(0, 1), sha256HexSync));
    const machineId = "550e8400-e29b-41d4-a716-446655440099";
    sql
      .prepare(
        "INSERT INTO user_profile(actor_id, display_name, session_epoch, machine_limit, created_at) VALUES(?,?,1,3,?)",
      )
      .run("actor_550e8400-e29b-41d4-a716-446655440001", "Alice", 1_000);
    sql
      .prepare(
        "INSERT INTO enrolled_machines(machine_id, display_name, secret_hash, approval_required, created_at, revoked_at) VALUES(?,?,?,0,?,NULL)",
      )
      .run(machineId, "Alice Mac", "b".repeat(64), 1_000);

    // 2. Open v2 UserRelayStore -> preserves profile + enrolled machine and defaults planTier='free'
    const users = UserRelayStore.open(sql, sha256HexSync);
    assert.equal(users.listMachines().length, 1);
    assert.equal(users.readProfile(2_000)?.planTier, "free");
    const proProfile = users.activateLicense({
      licenseId: "lic_pro_1",
      tier: "pro",
      machineLimit: 25,
      maxBlobBytes: 512 * 1024 * 1024,
      expiresAt: 100_000,
      now: 2_000,
    });
    assert.equal(proProfile.planTier, "pro");
    assert.equal(proProfile.machineLimit, 25);
    // Expired license automatically reverts to free limits without losing enrolled machines
    assert.equal(users.readProfile(200_000)?.planTier, "free");

    userRawDb.prepare("UPDATE schema_migrations SET checksum = 'bad' WHERE version = 2").run();
    assert.throws(() => UserRelayStore.open(sql, sha256HexSync), /Unsupported database migration history/u);
  } finally {
    userRawDb.close();
  }

  // Hashcash PoW + Signed `ocl1_` License Key roundtrip
  const nonce = await solveHashcashPow("test-challenge-token", 10);
  assert.equal(await verifyHashcashPow("test-challenge-token", nonce, 10), true);
  assert.equal(await verifyHashcashPow("test-challenge-token", "wrong!", 10), false);

  const licenseSecret = "0".repeat(32);
  const licenseKey = await issueRelayLicenseKey(licenseSecret, {
    lid: "lic_test_2026_001",
    tier: "pro",
    machineLimit: 20,
    maxBlobBytes: 1024 * 1024 * 1024,
    exp: Date.now() + 86_400_000,
  });
  assert.match(licenseKey, /^ocl1\./u);
  const verifiedLic = await verifyRelayLicenseKey(licenseSecret, licenseKey);
  assert.equal(verifiedLic?.tier, "pro");
  assert.equal(verifiedLic?.machineLimit, 20);
});

test("initializeSelfHostedRelayDirectory bootstraps 0600 files and Node relay forwards HTTP + WS over mux.v2", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "oc-relay-init-"));
  try {
    const initialized = await initializeSelfHostedRelayDirectory(join(tempDir, "etc-relay"), {
      origin: "http://127.0.0.1:18787",
      port: 18787,
      targetPort: 14200,
    });
    const fileMode = (await stat(initialized.relayConfigPath)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    const loadedConn = await loadRelayConnection(initialized.connectionConfigPath);
    assert.equal(loadedConn.options.credential, initialized.routeCredential);

    // Spin up a local target HTTP + WS server and self-hosted createRelayServer, connected via mux.v2!
    const targetHttp = createHttpServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    const targetWss = new WebSocketServer({ server: targetHttp });
    targetWss.on("connection", (ws) => {
      ws.on("message", (msg) => ws.send(`echo:${msg.toString()}`));
    });
    await new Promise<void>((r) => targetHttp.listen(0, "127.0.0.1", r));
    const targetPort = (targetHttp.address() as { port: number }).port;

    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    void publicKey;

    const probe = createHttpServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const relayPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const relayOrigin = `http://127.0.0.1:${relayPort}`;
    const credential = initialized.routeCredential;
    const relay = createRelayServer([
      {
        instanceId: "workstation-1",
        origin: relayOrigin,
        credential,
        signer: new AssertionSigner({ issuer: "test", instanceId: "workstation-1", origin: relayOrigin }, privateKey),
        identityProvider: {
          authenticate: () => ({
            provider: "local",
            subject: "user-1",
            displayName: "User One",
            authenticatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
          }),
        },
      },
    ]);
    await new Promise<void>((r) => relay.server.listen(relayPort, "127.0.0.1", r));

    const muxConn = connectRelayMux({
      relay: relayOrigin,
      credential,
      allowLoopbackInsecure: true,
      targetPort,
    });

    try {
      const deadline = Date.now() + 5_000;
      while (!relay.connected("workstation-1") && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(relay.connected("workstation-1"), true);

      // Forward HTTP over single mux.v2 socket
      const httpRes = await fetch(`${relayOrigin}/api/ping`);
      assert.equal(httpRes.status, 200);
      assert.deepEqual(await httpRes.json(), { ok: true, path: "/api/ping" });

      // Forward WebSocket upgrade over single mux.v2 socket
      const clientWs = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
      const echoed = await new Promise<string>((resolve, reject) => {
        clientWs.once("open", () => clientWs.send("mux-hello"));
        clientWs.once("message", (data) => resolve(data.toString()));
        clientWs.once("error", reject);
      });
      assert.equal(echoed, "echo:mux-hello");
      clientWs.close();
    } finally {
      muxConn.close();
      await relay.close();
      targetWss.close();
      await new Promise<void>((r) => targetHttp.close(() => r()));
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
