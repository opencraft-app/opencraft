import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AppHostServer } from "@opencraft/app-host-server";
import { applySqlMigrations, hashSqlMigrations } from "@opencraft/sql/migrations";
import type { SqlDatabase, SqlRow, SqlStatement } from "@opencraft/sql";
import { DaemonRelayEnrollmentService } from "../../apps/opencraft-daemon/src/relay-enrollment.js";
import {
  IDENTITY_INDEX_MIGRATIONS,
  IdentityIndexStore,
  USER_RELAY_MIGRATIONS,
  UserRelayStore,
} from "../../apps/relay-server/src/cloudflare/domain.js";
import { encodeQrMatrix, qrMatrixToSvgDataUri } from "../../apps/workbench-web/src/utils/qr-code.js";
import { formatPairingUrl, formatShareUrl, parsePairingUrl } from "@opencraft/relay-protocol";
import { CLOUD_RELAY_SPEC } from "../protocol/workerd/cloud-relay.scenarios.js";
import { testScenariosOnMiniflare } from "../cloudflare/node-test.js";

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");

function wrapNodeSqliteForTest(raw: DatabaseSync): SqlDatabase {
  let depth = 0;
  return {
    exec(sql: string) {
      raw.exec(sql);
    },
    prepare(sql: string): SqlStatement {
      const stmt = raw.prepare(sql);
      return {
        get(...params: unknown[]) {
          return stmt.get(...(params as never[])) as SqlRow | undefined;
        },
        all(...params: unknown[]) {
          return stmt.all(...(params as never[])) as SqlRow[];
        },
        run(...params: unknown[]) {
          const r = stmt.run(...(params as never[]));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
      };
    },
    transaction<T>(fn: () => T): T {
      const sp = `sp_${++depth}`;
      raw.exec(depth === 1 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      try {
        const out = fn();
        raw.exec(depth === 1 ? "COMMIT" : `RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (err) {
        raw.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${sp}`);
        if (depth > 1) raw.exec(`RELEASE SAVEPOINT ${sp}`);
        throw err;
      } finally {
        depth -= 1;
      }
    },
  };
}

function p1363ToDerSignature(p1363: Uint8Array): Uint8Array {
  const encodeInt = (raw32: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < raw32.length - 1 && raw32[start] === 0) start += 1;
    const trimmed = raw32.subarray(start);
    const needsZeroPad = (trimmed[0]! & 0x80) !== 0;
    const out = new Uint8Array(2 + (needsZeroPad ? 1 : 0) + trimmed.length);
    out[0] = 0x02;
    out[1] = trimmed.length + (needsZeroPad ? 1 : 0);
    if (needsZeroPad) out[2] = 0x00;
    out.set(trimmed, needsZeroPad ? 3 : 2);
    return out;
  };
  const rDer = encodeInt(p1363.subarray(0, 32));
  const sDer = encodeInt(p1363.subarray(32, 64));
  const total = rDer.length + sDer.length;
  const seq = new Uint8Array(2 + total);
  seq[0] = 0x30;
  seq[1] = total;
  seq.set(rDer, 2);
  seq.set(sDer, 2 + rDer.length);
  return seq;
}

function buildP256AttestationObject(rpId: string, credId: Uint8Array, x32: Uint8Array, y32: Uint8Array): Uint8Array {
  const rpIdHash = createHash("sha256").update(rpId).digest();
  // COSE_Key CBOR map(5): { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: bstr(32), -3: bstr(32) }
  const coseHeader = Uint8Array.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
  const coseMid = Uint8Array.from([0x22, 0x58, 0x20]);
  const coseKey = new Uint8Array(coseHeader.length + 32 + coseMid.length + 32);
  coseKey.set(coseHeader, 0);
  coseKey.set(x32, coseHeader.length);
  coseKey.set(coseMid, coseHeader.length + 32);
  coseKey.set(y32, coseHeader.length + 32 + coseMid.length);

  const authData = new Uint8Array(32 + 1 + 4 + 16 + 2 + credId.length + coseKey.length);
  authData.set(rpIdHash, 0);
  authData[32] = 0x01 | 0x04 | 0x08 | 0x10 | 0x40; // UP | UV | BE | BS | AT (iCloud synced passkey!)
  // signCount = 0 at bytes 33..36
  authData[53] = (credId.length >> 8) & 0xff;
  authData[54] = credId.length & 0xff;
  authData.set(credId, 55);
  authData.set(coseKey, 55 + credId.length);

  // CBOR map(3): { "fmt": "none", "attStmt": {}, "authData": bstr(authData) }
  const prefix = Uint8Array.from([
    0xa3,
    0x63,
    0x66,
    0x6d,
    0x74,
    0x64,
    0x6e,
    0x6f,
    0x6e,
    0x65, // "fmt": "none"
    0x67,
    0x61,
    0x74,
    0x74,
    0x53,
    0x74,
    0x6d,
    0x74,
    0xa0, // "attStmt": {}
    0x68,
    0x61,
    0x75,
    0x74,
    0x68,
    0x44,
    0x61,
    0x74,
    0x61, // "authData"
    ...(authData.length < 256
      ? [0x58, authData.length]
      : [0x59, (authData.length >> 8) & 0xff, authData.length & 0xff]),
  ]);
  const out = new Uint8Array(prefix.length + authData.length);
  out.set(prefix, 0);
  out.set(authData, prefix.length);
  return out;
}

test("encodeQrMatrix encodes separated my.opencraft.app pairing URLs and resolves back to relay.opencraft.app", () => {
  const pairingUrl = formatPairingUrl(
    {
      relayOrigin: "https://relay.opencraft.app",
      machineId: "11111111-1111-4111-8111-111111111111",
      code: "00000000-0000-4000-8000-000000000000_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      approvalRequired: true,
    },
    "https",
  );
  assert.ok(pairingUrl.startsWith("https://my.opencraft.app/pair?m=11111111-1111-4111-8111-111111111111"));
  const parsed = parsePairingUrl(pairingUrl);
  assert.equal(parsed?.relayOrigin, "https://relay.opencraft.app");
  assert.equal(
    formatShareUrl(
      "https://relay.opencraft.app",
      "00000000-0000-4000-8000-000000000000_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    ),
    "https://my.opencraft.app/s/00000000-0000-4000-8000-000000000000_AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  );
  const matrix = encodeQrMatrix(pairingUrl);
  assert.ok(matrix.length >= 41 && matrix.length <= 57);
  const svgUri = qrMatrixToSvgDataUri(matrix);
  assert.ok(svgUri.startsWith("data:image/svg+xml;utf8,"));
});

test("v2 -> v3 SQLite migrations preserve data and reject tampered checksums", () => {
  // 1. IdentityIndexStore v2 -> v3 upgrade preserves existing bindings & rejects checksum tamper
  const rawIdx = new DatabaseSync(":memory:");
  const idxDb = wrapNodeSqliteForTest(rawIdx);
  applySqlMigrations(idxDb, hashSqlMigrations(IDENTITY_INDEX_MIGRATIONS.slice(0, 2), sha256Hex));
  idxDb
    .prepare(
      "INSERT INTO identity_bindings(binding_hash, provider, actor_id, password_phc, version, created_at, updated_at) VALUES(?,?,?,?,1,100,100)",
    )
    .run("a".repeat(64), "local", "actor_11111111-1111-4111-8111-111111111111", null);

  const upgradedIdx = IdentityIndexStore.open(idxDb, sha256Hex);
  assert.equal(upgradedIdx.read("a".repeat(64))?.actorId, "actor_11111111-1111-4111-8111-111111111111");
  const regPk = upgradedIdx.registerPasskey({
    credentialId: "cred_abc123",
    actorId: "actor_11111111-1111-4111-8111-111111111111",
    algorithm: "ES256",
    publicKey: "pub_xyz",
    signCount: 0,
    label: "Mac Touch ID",
    now: 200,
  });
  assert.equal(regPk.ok, true);

  idxDb.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 2").run();
  assert.throws(() => IdentityIndexStore.open(idxDb, sha256Hex), /Unsupported database migration history/iu);
  rawIdx.close();

  // 2. UserRelayStore v2 -> v3 upgrade preserves machines & rejects checksum tamper
  const rawUser = new DatabaseSync(":memory:");
  const userDb = wrapNodeSqliteForTest(rawUser);
  applySqlMigrations(userDb, hashSqlMigrations(USER_RELAY_MIGRATIONS.slice(0, 2), sha256Hex));
  userDb
    .prepare(
      "INSERT INTO user_profile(actor_id, display_name, session_epoch, machine_limit, created_at, plan_tier, max_blob_bytes) VALUES('actor_11111111-1111-4111-8111-111111111111','Skip',1,3,100,'free',16777216)",
    )
    .run();
  userDb
    .prepare(
      "INSERT INTO enrolled_machines(machine_id, display_name, secret_hash, approval_required, created_at, revoked_at) VALUES(?,?,?,?,100,NULL)",
    )
    .run("22222222-2222-4222-8222-222222222222", "Mac Studio", "b".repeat(64), 0);

  const upgradedUser = UserRelayStore.open(userDb, sha256Hex);
  assert.equal(upgradedUser.listMachines().length, 1);
  upgradedUser.replaceMachineThreadIndex("22222222-2222-4222-8222-222222222222", [
    { threadId: "t1", title: "Refactor Valdi settings", status: "running", updatedAt: 500 },
  ]);
  assert.equal(upgradedUser.listThreadIndex().length, 1);
  assert.equal(upgradedUser.listThreadIndex()[0]?.title, "Refactor Valdi settings");

  userDb.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
  assert.throws(() => UserRelayStore.open(userDb, sha256Hex), /Unsupported database migration history/iu);
  rawUser.close();
});

testScenariosOnMiniflare("remote-access-p0p1-workerd", [
  {
    name: "Passkey Personal Hub (ES256 + signCount=0 iCloud sync) claims multiple sovereign machines with seamless daemon owner sync",
    async run({ runtime }) {
      const dirA = await mkdtemp(join(tmpdir(), "oc-hub-m1-"));
      const dirB = await mkdtemp(join(tmpdir(), "oc-hub-m2-"));
      const appHost = new AppHostServer({
        logicalClientRouting: true,
        physicalHostLifetime: "server",
        createTransport() {
          throw new Error("Unused in handshake test");
        },
      });

      const testRelayOrigin = "https://relay.opencraft.test";
      const worker = await runtime.start(CLOUD_RELAY_SPEC, {
        vars: {
          OPENCRAFT_RELAY_SIGNING_KEY: "test-signing-key-32-bytes-minimum-length-012345",
          OPENCRAFT_RELAY_ORIGIN: testRelayOrigin,
          OPENCRAFT_RELAY_POW_BITS: "4",
        },
      });

      const noopMux = () => ({
        readyState: 0,
        send() {},
        close() {},
        terminate() {},
        onOpen() {},
        onMessage() {},
        onClose() {},
        onError() {},
      });

      const daemonA = new DaemonRelayEnrollmentService({
        dataDirectory: dirA,
        appHost,
        machineIdentity: {
          machineId: "11111111-1111-4111-8111-111111111111",
          name: "Office-MacBook-Pro",
          platform: "macos",
        },
        allowLoopbackInsecure: true,
        fetchImpl: (input, init) => worker.fetch(input, init),
        createMuxSocket: noopMux,
      });
      const daemonB = new DaemonRelayEnrollmentService({
        dataDirectory: dirB,
        appHost,
        machineIdentity: {
          machineId: "22222222-2222-4222-8222-222222222222",
          name: "Home-Mac-Studio",
          platform: "macos",
        },
        allowLoopbackInsecure: true,
        fetchImpl: (input, init) => worker.fetch(input, init),
        createMuxSocket: noopMux,
      });

      try {
        // 1. Two independent desktops enroll zero-signup (different anonymous actorIds)
        const enrA = await daemonA.enrollSovereignMachine({ relayOrigin: testRelayOrigin });
        const enrB = await daemonB.enrollSovereignMachine({ relayOrigin: testRelayOrigin });
        assert.notEqual(enrA.actorId, enrB.actorId);

        // 2. Browser creates a Passkey Personal Hub (ES256 P-256)
        const regOptRes = await worker.fetch(`${testRelayOrigin}/__opencraft_cloud/passkey/register/options`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: testRelayOrigin },
          body: JSON.stringify({ labelHint: "Office-MacBook-Pro" }),
        });
        assert.equal(regOptRes.status, 200);
        const regOpts = (await regOptRes.json()) as {
          rpId: string;
          challenge: string;
          challengeTicket: string;
          user: { id: string; name: string };
        };
        assert.match(regOpts.user.name, /^OpenCraft · Office-MacBook-Pro/);

        const passkeyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
          "sign",
          "verify",
        ])) as CryptoKeyPair;
        const rawUncompressed = new Uint8Array(await crypto.subtle.exportKey("raw", passkeyPair.publicKey));
        const x32 = rawUncompressed.subarray(1, 33);
        const y32 = rawUncompressed.subarray(33, 65);
        const credIdBytes = crypto.getRandomValues(new Uint8Array(24));
        const credIdB64 = Buffer.from(credIdBytes).toString("base64url");
        const attObj = buildP256AttestationObject(regOpts.rpId, credIdBytes, x32, y32);
        const regClientData = Buffer.from(
          JSON.stringify({ type: "webauthn.create", challenge: regOpts.challenge, origin: testRelayOrigin }),
        ).toString("base64url");

        const browserDpopPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
          "sign",
          "verify",
        ])) as CryptoKeyPair;
        const browserPubB64 = Buffer.from(await crypto.subtle.exportKey("raw", browserDpopPair.publicKey)).toString(
          "base64url",
        );
        const signDpop = async (method: string, url: string) => {
          const ts = Date.now();
          const nonce = "testnonce1234567890";
          const input = new TextEncoder().encode(`opencraft-dpop.v1\n${method}\n${url}\n${ts}\n${nonce}`);
          const sig = Buffer.from(await crypto.subtle.sign("Ed25519", browserDpopPair.privateKey, input)).toString(
            "base64url",
          );
          return Buffer.from(
            JSON.stringify({ publicKey: browserPubB64, method, url, timestamp: ts, nonce, signature: sig }),
          ).toString("base64url");
        };

        const regVerifyRes = await worker.fetch(`${testRelayOrigin}/__opencraft_cloud/passkey/register/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: testRelayOrigin },
          body: JSON.stringify({
            challengeTicket: regOpts.challengeTicket,
            credentialId: credIdB64,
            clientDataJSON: regClientData,
            attestationObject: Buffer.from(attObj).toString("base64url"),
            devicePublicKey: browserPubB64,
            label: "Skip iCloud Keychain",
          }),
        });
        assert.equal(regVerifyRes.status, 201);
        const regVerified = (await regVerifyRes.json()) as { actorId: string; token: string };

        // 3. Verify Passkey login from a synced device reporting signCount = 0!
        const loginOptRes = await worker.fetch(`${testRelayOrigin}/__opencraft_cloud/passkey/login/options`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: testRelayOrigin },
          body: "{}",
        });
        const loginOpts = (await loginOptRes.json()) as { rpId: string; challenge: string; challengeTicket: string };
        const assertAuthData = new Uint8Array(37);
        assertAuthData.set(createHash("sha256").update(loginOpts.rpId).digest(), 0);
        assertAuthData[32] = 0x01 | 0x04 | 0x08 | 0x10; // UP | UV | BE | BS, signCount = 0
        const loginClientDataBytes = Buffer.from(
          JSON.stringify({ type: "webauthn.get", challenge: loginOpts.challenge, origin: testRelayOrigin }),
        );
        const loginClientHash = createHash("sha256").update(loginClientDataBytes).digest();
        const signedAssertionPayload = Buffer.concat([Buffer.from(assertAuthData), loginClientHash]);
        const rawP1363Sig = new Uint8Array(
          await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, passkeyPair.privateKey, signedAssertionPayload),
        );
        const derSig = p1363ToDerSignature(rawP1363Sig);

        const loginVerifyRes = await worker.fetch(`${testRelayOrigin}/__opencraft_cloud/passkey/login/verify`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: testRelayOrigin },
          body: JSON.stringify({
            challengeTicket: loginOpts.challengeTicket,
            credentialId: credIdB64,
            authenticatorData: Buffer.from(assertAuthData).toString("base64url"),
            clientDataJSON: loginClientDataBytes.toString("base64url"),
            signature: Buffer.from(derSig).toString("base64url"),
            devicePublicKey: browserPubB64,
          }),
        });
        assert.equal(loginVerifyRes.status, 200);
        const loggedIn = (await loginVerifyRes.json()) as { actorId: string; token: string };
        assert.equal(loggedIn.actorId, regVerified.actorId);

        // 4. Both Desktop A and Desktop B issue cryptographic claim URLs and get claimed into the single Personal Hub!
        for (const daemon of [daemonA, daemonB]) {
          const { claimUrl } = await daemon.createClaimUrl();
          const ticketB64 = decodeURIComponent(new URL(claimUrl).hash.replace(/^#ticket=/u, ""));
          const claimApiUrl = `${testRelayOrigin}/__opencraft_cloud/machines/claim`;
          const claimRes = await worker.fetch(claimApiUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${loggedIn.token}`,
              "x-opencraft-dpop": await signDpop("POST", claimApiUrl),
            },
            body: JSON.stringify({ ticket: ticketB64, browserLabel: "iPhone Safari" }),
          });
          assert.equal(claimRes.status, 200);
        }

        // 5. Desktop A reconciles its new ownerActorId seamlessly via inspectDetailedStatus & publishes lightweight thread index!
        const syncedStatusA = await daemonA.inspectDetailedStatus();
        assert.equal(syncedStatusA.hubClaimed, true);
        assert.equal(syncedStatusA.actorId, loggedIn.actorId);

        await daemonA.publishThreadIndex([
          { threadId: "th-1", title: "Ship Passkey Personal Hub", status: "running", updatedAt: Date.now() },
        ]);

        // 6. Browser fetches Personal Hub overview -> sees BOTH machines + lightweight thread index!
        const overviewUrl = `${testRelayOrigin}/__opencraft_cloud/hub/overview`;
        const overviewRes = await worker.fetch(overviewUrl, {
          method: "GET",
          headers: {
            authorization: `Bearer ${loggedIn.token}`,
            "x-opencraft-dpop": await signDpop("GET", overviewUrl),
          },
        });
        assert.equal(overviewRes.status, 200);
        const overview = (await overviewRes.json()) as {
          machines: ReadonlyArray<{ machineId: string; displayName: string }>;
          threadIndex: ReadonlyArray<{ machineId: string; title: string; status: string }>;
        };
        assert.equal(overview.machines.length, 2);
        assert.equal(overview.threadIndex.length, 1);
        assert.equal(overview.threadIndex[0]?.title, "Ship Passkey Personal Hub");
        assert.equal(overview.threadIndex[0]?.status, "running");
      } finally {
        daemonA.close();
        daemonB.close();
        await appHost.close();
        await runtime.stop(worker);
        await rm(dirA, { recursive: true, force: true });
        await rm(dirB, { recursive: true, force: true });
      }
    },
  },
]);
