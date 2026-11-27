import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOST_PROTOCOL_VERSION, LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AppHostServer } from "@opencraft/app-host-server";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { DaemonRelayEnrollmentService } from "@opencraft/opencraft-daemon/relay-enrollment";
import type { MuxSocketLike } from "@opencraft/plugin-relay-connect/mux";
import { RELAY_MUX_PING, RELAY_MUX_PONG, parsePairingUrl, solveHashcashPow } from "@opencraft/relay-protocol";
import { issueRelayLicenseKey } from "@opencraft/relay-server/cloud-crypto";
import {
  sleep,
  until as runtimeUntil,
  type TestWebSocket,
  type WorkerInstance,
  type WorkerRuntime,
  type WorkerScenario,
  type WorkerSpec,
} from "../../cloudflare/worker-runtime.ts";

async function waitFor(
  runtime: Pick<WorkerRuntime, "patience">,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const ok = await runtimeUntil(runtime, predicate, Boolean, timeoutMs);
  assert.equal(ok, true, `Timed out waiting for: ${label}`);
}

const SIGNING_KEY = "0".repeat(64);

export const CLOUD_RELAY_SPEC: WorkerSpec = {
  id: "cloud-relay",
  entry: resolve(fileURLToPath(import.meta.url), "../../../../apps/relay-server/src/cloudflare/worker.ts"),
  durableObjects: {
    IDENTITY_INDEX: "IdentityIndexDO",
    USER_RELAY: "UserRelayDO",
    MACHINE_RELAY: "MachineRelayDO",
  },
  r2Buckets: ["RELAY_BLOBS"],
};

function defaultVars(extra: Record<string, string> = {}) {
  return (origin: string) => ({
    OPENCRAFT_RELAY_SIGNING_KEY: SIGNING_KEY,
    OPENCRAFT_RELAY_ORIGIN: origin,
    ...extra,
  });
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function generateEd25519DeviceProofFactory() {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKeyB64 = toBase64Url(rawPub);

  const signDpop = async (method: string, rawUrl: string): Promise<string> => {
    const timestamp = Date.now();
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
    const signingInput = new TextEncoder().encode(
      `opencraft-dpop.v1\n${method.toUpperCase()}\n${rawUrl}\n${timestamp}\n${nonce}`,
    );
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, signingInput));
    const envelope = JSON.stringify({
      publicKey: publicKeyB64,
      method: method.toUpperCase(),
      url: rawUrl,
      timestamp,
      nonce,
      signature: toBase64Url(sig),
    });
    return toBase64Url(new TextEncoder().encode(envelope));
  };

  return { publicKeyB64, signDpop };
}

/**
 * Bridges `connectRelayMux` over Miniflare's in-process `instance.upgrade(...)`
 * so the real Node `DaemonRelayEnrollmentService` talks directly to the `workerd`
 * Edge Worker and Hibernatable `MachineRelayDO`.
 */
function createMiniflareMuxSocketFactory(instance: WorkerInstance) {
  return (wsUrl: string, subprotocol: string, headers: Record<string, string>): MuxSocketLike => {
    const httpUrl = wsUrl.replace(/^ws:/u, "http:").replace(/^wss:/u, "https:");
    let state = 0;
    let inner: TestWebSocket | undefined;
    const openHandlers: (() => void)[] = [];
    const msgHandlers: ((data: string | Uint8Array) => void)[] = [];
    const closeHandlers: ((code: number, reason: string) => void)[] = [];
    const errorHandlers: ((err: unknown) => void)[] = [];

    void instance
      .upgrade(httpUrl, {
        ...headers,
        "sec-websocket-protocol": subprotocol,
      })
      .then(
        (res) => {
          if (res.status !== 101 || !res.socket) {
            state = 3;
            for (const fn of errorHandlers) fn(new Error(`Upgrade rejected (${res.status})`));
            for (const fn of closeHandlers) fn(1008, res.text ?? "Rejected");
            return;
          }
          if (state === 3) {
            res.socket.close(1000, "Already closed");
            return;
          }
          inner = res.socket;
          state = 1;
          inner.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") {
              for (const fn of msgHandlers) fn(ev.data);
            } else {
              const bytes = new Uint8Array(ev.data);
              for (const fn of msgHandlers) fn(bytes);
            }
          });
          inner.addEventListener("close", (ev) => {
            state = 3;
            for (const fn of closeHandlers) fn(ev.code, ev.reason);
          });
          for (const fn of openHandlers) fn();
        },
        (err) => {
          state = 3;
          for (const fn of errorHandlers) fn(err);
          for (const fn of closeHandlers) fn(1006, "Upgrade error");
        },
      );

    return {
      get readyState() {
        return state;
      },
      send(data) {
        inner?.send(data);
      },
      close(code = 1000, reason = "") {
        state = 3;
        inner?.close(code, reason);
      },
      terminate() {
        state = 3;
        inner?.close(1000, "Terminated");
      },
      onOpen(fn) {
        if (state === 1) fn();
        else openHandlers.push(fn);
      },
      onMessage(fn) {
        msgHandlers.push(fn);
      },
      onClose(fn) {
        closeHandlers.push(fn);
      },
      onError(fn) {
        errorHandlers.push(fn);
      },
    };
  };
}

function createFakeEchoAppHost(): {
  appHost: AppHostServer;
  emitHostDelta: (delta: string) => void;
  close: () => Promise<void>;
} {
  const messageListeners = new Set<(frame: string) => void>();
  const statusListeners = new Set<(status: TransportStatus) => void>();
  let currentStatus: TransportStatus = { state: "idle" };
  const publishStatus = (next: TransportStatus) => {
    currentStatus = next;
    for (const fn of statusListeners) fn(next);
  };

  const appHost = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport(hostId): DuplexTransport {
      if (hostId !== "local") throw new Error(`Unexpected hostId: ${hostId}`);
      return {
        get status() {
          return currentStatus;
        },
        async connect() {
          publishStatus({ state: "open" });
        },
        async send(frame: string) {
          const m = JSON.parse(frame) as Record<string, unknown>;
          if (m.id !== undefined) {
            const reply = JSON.stringify({
              jsonrpc: "2.0",
              id: m.id,
              result: { echoedMethod: m.method, params: m.params ?? null },
              ...(m[LOGICAL_CLIENT_FIELD] ? { [LOGICAL_CLIENT_FIELD]: m[LOGICAL_CLIENT_FIELD] } : {}),
            });
            queueMicrotask(() => {
              for (const fn of messageListeners) fn(reply);
            });
          }
        },
        subscribeMessage(listener: (frame: string) => void) {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        subscribeStatus(listener: (status: TransportStatus) => void) {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
        async close() {
          publishStatus({ state: "closed" });
          messageListeners.clear();
          statusListeners.clear();
        },
      };
    },
  });
  return {
    appHost,
    emitHostDelta(delta: string) {
      const frame = JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta } });
      for (const fn of messageListeners) fn(frame);
    },
    close: () => appHost.close(),
  };
}

export const CLOUD_RELAY_SCENARIOS: readonly WorkerScenario[] = [
  {
    name: "neutral Worker bundle imports zero node:* modules and serves health endpoint",
    async run({ runtime }) {
      const { metafile } = await runtime.bundle(CLOUD_RELAY_SPEC);
      const nodeImports = Object.values(metafile.inputs).flatMap((input) =>
        input.imports.filter((imp) => imp.path.startsWith("node:")).map((imp) => imp.path),
      );
      assert.deepEqual(nodeImports, [], "Cloudflare Worker/DO bundle must remain 100% runtime-neutral");

      const worker = await runtime.start(CLOUD_RELAY_SPEC, { vars: defaultVars() });
      try {
        const res = await worker.fetch(`${worker.origin}/__opencraft_relay/live`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; protocol: number; mode: string };
        assert.equal(body.ok, true);
        assert.equal(body.protocol, 2);
      } finally {
        await runtime.stop(worker);
      }
    },
  },

  {
    name: "sharded registration, edge Argon2id login, machine quota, and DO SQLite persistence across restart",
    async run({ runtime }) {
      const persistKey = `cloud-relay-persist-${crypto.randomUUID()}`;
      let worker = await runtime.start(CLOUD_RELAY_SPEC, {
        persist: persistKey,
        vars: defaultVars({ OPENCRAFT_MAX_MACHINES_PER_USER: "2" }),
      });

      let token = "";
      let actorId = "";
      try {
        const reg = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "skip@opencraft.dev", password: "correct-horse-battery-staple" }),
        });
        assert.equal(reg.status, 201);
        const regBody = (await reg.json()) as { actorId: string; token: string };
        actorId = regBody.actorId;
        token = regBody.token;

        // Duplicate account rejected by IdentityIndexDO shard
        const dup = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "skip@opencraft.dev", password: "correct-horse-battery-staple" }),
        });
        assert.equal(dup.status, 409);

        // Wrong password rejected after constant-shape Argon2id check
        const badLogin = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "skip@opencraft.dev", password: "wrong-password-12345" }),
        });
        assert.equal(badLogin.status, 401);

        // Enroll 2 machines (quota = 2), 3rd machine hits 429 machine_limit_reached
        for (let i = 0; i < 2; i += 1) {
          const mRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/machines`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ displayName: `Mac-${i}`, platform: "darwin" }),
          });
          assert.equal(mRes.status, 201);
        }
        const overQuota = await worker.fetch(`${worker.origin}/__opencraft_cloud/machines`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ displayName: "Mac-Overflow", platform: "darwin" }),
        });
        assert.equal(overQuota.status, 429);
      } finally {
        await runtime.stop(worker);
      }

      // Restart workerd over the same persisted DO SQLite directory
      worker = await runtime.start(CLOUD_RELAY_SPEC, {
        persist: persistKey,
        vars: defaultVars({ OPENCRAFT_MAX_MACHINES_PER_USER: "2" }),
      });
      try {
        const login = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "skip@opencraft.dev", password: "correct-horse-battery-staple" }),
        });
        assert.equal(login.status, 200);
        const loginBody = (await login.json()) as { actorId: string; token: string };
        assert.equal(loginBody.actorId, actorId);

        const summary = await worker.fetch(`${worker.origin}/__opencraft_cloud/me`, {
          headers: { authorization: `Bearer ${loginBody.token}` },
        });
        assert.equal(summary.status, 200);
        const summaryBody = (await summary.json()) as { machines: unknown[] };
        assert.equal(summaryBody.machines.length, 2);
      } finally {
        await runtime.stop(worker);
      }
    },
  },

  {
    name: "DaemonRelayEnrollmentService + QR DPoP device pairing + short-code approval + mux.v2 streaming & hibernation ping",
    async run({ runtime }) {
      const worker = await runtime.start(CLOUD_RELAY_SPEC, { vars: defaultVars() });
      const dataDir = await mkdtemp(join(tmpdir(), "oc-daemon-relay-"));
      const { appHost, emitHostDelta, close: closeAppHost } = createFakeEchoAppHost();
      const machineId = crypto.randomUUID();
      const enrollment = new DaemonRelayEnrollmentService({
        dataDirectory: dataDir,
        appHost,
        machineIdentity: { machineId, name: "Skip's MacBook Pro", platform: "darwin" },
        allowLoopbackInsecure: true,
        batchWindowMs: 20,
        fetchImpl: (input, init) => worker.fetch(String(input), init),
        createMuxSocket: createMiniflareMuxSocketFactory(worker),
        routeDiscoveryOptions: {
          localPort: 4200,
          execTailscaleStatusJson: async () => ({
            BackendState: "Running",
            CertDomains: ["skip-mbp.tailnet.ts.net"],
            Self: { Online: true, TailscaleIPs: ["100.101.2.3"] },
          }),
          networkInterfacesImpl: () => ({}) as never,
        },
      });

      try {
        await enrollment.registerAccount({
          relayOrigin: worker.origin,
          username: "owner@opencraft.dev",
          password: "super-secret-owner-password",
        });
        const enrolled = await enrollment.enrollMachine();
        assert.equal(enrolled.machineId, machineId);

        await waitFor(runtime, () => enrollment.status().connected, 4_000, "daemon mux connected");

        // Issue an approval-required pairing invite (e.g. untrusted remote device)
        const invite = await enrollment.createPairingInvite({ approvalRequired: true });
        const parsedInvite = parsePairingUrl(invite.pairingUrl);
        assert.ok(parsedInvite);

        const mobileDevice = await generateEd25519DeviceProofFactory();
        const redeemRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/pair/redeem`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            machineId,
            code: parsedInvite.code,
            devicePublicKey: mobileDevice.publicKeyB64,
            deviceLabel: "Skip's iPhone",
          }),
        });
        // Pending 6-character desktop confirmation!
        assert.equal(redeemRes.status, 202);
        const redeemBody = (await redeemRes.json()) as {
          token: string;
          status: string;
          shortCode: string;
        };
        assert.equal(redeemBody.status, "pending_approval");
        assert.match(redeemBody.shortCode, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/u);

        // Before approval, mobile device cannot access `/m/:machineId/health`
        const healthUrl = `${worker.origin}/m/${machineId}/health`;
        const preApproveRes = await worker.fetch(healthUrl, {
          headers: {
            authorization: `Bearer ${redeemBody.token}`,
            "x-opencraft-dpop": await mobileDevice.signDpop("GET", healthUrl),
          },
        });
        assert.equal(preApproveRes.status, 403);

        // Missing DPoP proof on a `cnf`-bound token is rejected at the stateless Edge Worker!
        const missingDpop = await worker.fetch(healthUrl, {
          headers: { authorization: `Bearer ${redeemBody.token}` },
        });
        assert.equal(missingDpop.status, 401);

        // Desktop owner approves the 6-char short code
        await enrollment.approvePendingDevice(redeemBody.shortCode);

        // HTTP-over-mux now succeeds!
        const postApproveRes = await worker.fetch(healthUrl, {
          headers: {
            authorization: `Bearer ${redeemBody.token}`,
            "x-opencraft-dpop": await mobileDevice.signDpop("GET", healthUrl),
          },
        });
        assert.equal(postApproveRes.status, 200);
        const healthBody = (await postApproveRes.json()) as { ok: boolean; name: string };
        assert.equal(healthBody.ok, true);
        assert.equal(healthBody.name, "Skip's MacBook Pro");

        // Open real-time WebSocket from mobile device -> Edge -> MachineRelayDO -> mux.v2 -> Daemon AppHostServer!
        const wsUrl = `${worker.origin}/m/${machineId}/ws`;
        const mobileWsUpgrade = await worker.upgrade(wsUrl, {
          authorization: `Bearer ${redeemBody.token}`,
          "x-opencraft-dpop": await mobileDevice.signDpop("GET", wsUrl),
        });
        assert.equal(mobileWsUpgrade.status, 101);
        const mobileWs = mobileWsUpgrade.socket!;
        const received: Record<string, unknown>[] = [];
        mobileWs.addEventListener("message", (ev) => {
          if (typeof ev.data === "string" && ev.data !== RELAY_MUX_PONG) {
            received.push(JSON.parse(ev.data) as Record<string, unknown>);
          }
        });

        // Verify edge WebSocket auto-response (`RELAY_MUX_PING` -> `RELAY_MUX_PONG`)
        let gotPong = false;
        mobileWs.addEventListener("message", (ev) => {
          if (ev.data === RELAY_MUX_PONG) gotPong = true;
        });
        mobileWs.send(RELAY_MUX_PING);
        await waitFor(runtime, () => gotPong, 2_000, "edge auto-response pong");

        // Audience state reported 1 active watcher to Daemon
        await waitFor(runtime, () => enrollment.status().activeWatchers === 1, 2_000, "activeWatchers === 1");

        // Send AppHost hello + host/connect + host/send JSON-RPC request over the multiplexed stream
        mobileWs.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: APP_HOST_PROTOCOL_VERSION,
            rendererId: "mobile-client-1",
          }),
        );
        await waitFor(runtime, () => received.some((m) => m.type === "ready"), 2_000, "AppHost ready");

        mobileWs.send(
          JSON.stringify({
            type: "host/connect",
            requestId: "req-connect-1",
            hostId: "local",
            leaseId: "lease-mobile-1",
          }),
        );
        await waitFor(
          runtime,
          () => received.some((m) => m.type === "response" && m.requestId === "req-connect-1" && m.ok === true),
          2_000,
          "AppHost connected",
        );
        const connectResp = received.find((m) => m.type === "response" && m.requestId === "req-connect-1") as {
          result: { generation: number };
        };

        mobileWs.send(
          JSON.stringify({
            type: "host/send",
            requestId: "req-send-1",
            hostId: "local",
            leaseId: "lease-mobile-1",
            generation: connectResp.result.generation,
            frame: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "thread/list", params: { limit: 5 } }),
          }),
        );
        await waitFor(
          runtime,
          () =>
            received.some(
              (m) =>
                m.type === "host/frame" &&
                typeof m.frame === "string" &&
                (JSON.parse(m.frame) as { id?: number }).id === 42,
            ),
          3_000,
          "AppHost JSON-RPC response",
        );

        // Rapid burst of streaming deltas from Host coalesces via `DATA_BATCH` and unpacks cleanly at client!
        emitHostDelta("chunk-1 ");
        emitHostDelta("chunk-2 ");
        emitHostDelta("chunk-3");
        await waitFor(
          runtime,
          () =>
            received.filter(
              (m) =>
                m.type === "host/frame" &&
                typeof m.frame === "string" &&
                (JSON.parse(m.frame) as { method?: string }).method === "item/agentMessage/delta",
            ).length === 3,
          3_000,
          "all 3 batched deltas unpacked at client",
        );

        // Close mobile client -> `AUDIENCE_STATE(0)` pushed to Daemon so unattended deltas stop!
        mobileWs.close(1000, "Leaving");
        await waitFor(runtime, () => enrollment.status().activeWatchers === 0, 2_000, "activeWatchers === 0");
      } finally {
        enrollment.close();
        await closeAppHost();
        await rm(dataDir, { recursive: true, force: true });
        await runtime.stop(worker);
      }
    },
  },

  {
    name: "ROUTE_ADVERTISE privacy boundary (owner sees Tailscale/LAN, collaborator gets []) and instant ShareGrant revocation",
    async run({ runtime }) {
      const worker = await runtime.start(CLOUD_RELAY_SPEC, { vars: defaultVars() });
      const dataDir = await mkdtemp(join(tmpdir(), "oc-share-relay-"));
      const { appHost, close: closeAppHost } = createFakeEchoAppHost();
      const machineId = crypto.randomUUID();
      const enrollment = new DaemonRelayEnrollmentService({
        dataDirectory: dataDir,
        appHost,
        machineIdentity: { machineId, name: "Owner Workstation", platform: "linux" },
        allowLoopbackInsecure: true,
        fetchImpl: (input, init) => worker.fetch(String(input), init),
        createMuxSocket: createMiniflareMuxSocketFactory(worker),
        routeDiscoveryOptions: {
          localPort: 4200,
          execTailscaleStatusJson: async () => ({
            BackendState: "Running",
            CertDomains: ["owner-linux.tailnet.ts.net"],
            Self: { Online: true, TailscaleIPs: ["100.77.88.99"] },
          }),
          networkInterfacesImpl: () => ({}) as never,
        },
      });

      try {
        const ownerAuth = await enrollment.registerAccount({
          relayOrigin: worker.origin,
          username: "alice@opencraft.dev",
          password: "alice-password-123456",
        });
        await enrollment.enrollMachine();
        await waitFor(runtime, () => enrollment.status().connected, 4_000, "owner mux connected");

        // Owner queries `/m/:machineId/__routes` -> receives private Tailscale direct routes!
        const ownerRoutesRes = await worker.fetch(`${worker.origin}/m/${machineId}/__routes`, {
          headers: { authorization: `Bearer ${ownerAuth.token}` },
        });
        assert.equal(ownerRoutesRes.status, 200);
        const ownerRoutes = (await ownerRoutesRes.json()) as {
          role: string;
          directRoutes: { kind: string; origin: string }[];
        };
        assert.equal(ownerRoutes.role, "owner");
        assert.ok(ownerRoutes.directRoutes.some((r) => r.origin === "https://owner-linux.tailnet.ts.net"));

        // Register teammate Bob and claim a read-only `ShareGrant` (`allowExecution: false`)
        const bobReg = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "bob@opencraft.dev", password: "bob-password-123456" }),
        });
        const bobAuth = (await bobReg.json()) as { token: string };

        const share = await enrollment.createShare({ allowExecution: false });
        const claimRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/shares/claim`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${bobAuth.token}` },
          body: JSON.stringify({ shareToken: share.shareToken }),
        });
        assert.equal(claimRes.status, 200);

        // Collaborator queries `/m/:machineId/__routes?grant=<grantId>` -> private LAN/Tailscale IPs MUST NOT leak!
        const bobRoutesRes = await worker.fetch(
          `${worker.origin}/m/${machineId}/__routes?grant=${encodeURIComponent(share.grantId)}`,
          { headers: { authorization: `Bearer ${bobAuth.token}` } },
        );
        assert.equal(bobRoutesRes.status, 200);
        const bobRoutes = (await bobRoutesRes.json()) as { role: string; directRoutes: unknown[] };
        assert.equal(bobRoutes.role, "collaborator");
        assert.deepEqual(bobRoutes.directRoutes, []);

        // Collaborator connects WebSocket: read RPC works, mutating `turn/start` is blocked, and revocation kills socket!
        const bobWsUp = await worker.upgrade(
          `${worker.origin}/m/${machineId}/ws?grant=${encodeURIComponent(share.grantId)}`,
          { authorization: `Bearer ${bobAuth.token}` },
        );
        assert.equal(bobWsUp.status, 101);
        const bobWs = bobWsUp.socket!;
        const bobMessages: Record<string, unknown>[] = [];
        let bobClosedCode = 0;
        bobWs.addEventListener("message", (ev) => {
          if (typeof ev.data === "string") bobMessages.push(JSON.parse(ev.data) as Record<string, unknown>);
        });
        bobWs.addEventListener("close", (ev) => {
          bobClosedCode = ev.code;
        });

        bobWs.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: APP_HOST_PROTOCOL_VERSION,
            rendererId: "bob-collab-1",
          }),
        );
        await waitFor(runtime, () => bobMessages.some((m) => m.type === "ready"), 2_000, "bob ready");

        bobWs.send(
          JSON.stringify({
            type: "host/connect",
            requestId: "bob-conn-1",
            hostId: "local",
            leaseId: "lease-bob-1",
          }),
        );
        await waitFor(
          runtime,
          () => bobMessages.some((m) => m.type === "response" && m.requestId === "bob-conn-1" && m.ok === true),
          2_000,
          "bob connected",
        );

        // Collaborator attempts mutating `turn/start` -> rejected with EXECUTION_DENIED!
        bobWs.send(
          JSON.stringify({
            type: "host/send",
            requestId: "bob-mut-1",
            hostId: "local",
            leaseId: "lease-bob-1",
            generation: 1,
            frame: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "turn/start", params: {} }),
          }),
        );
        await waitFor(
          runtime,
          () =>
            bobMessages.some(
              (m) =>
                m.type === "response" &&
                m.requestId === "bob-mut-1" &&
                m.ok === false &&
                (m.error as { code?: string })?.code === "EXECUTION_DENIED",
            ),
          2_000,
          "read-only collaborator blocked from execution",
        );

        // Alice revokes share -> Bob's active WebSocket is terminated immediately with 4003!
        await enrollment.revokeShare(share.grantId);
        await waitFor(runtime, () => bobClosedCode === 4003, 2_000, "revoked share closes live WS with 4003");
      } finally {
        enrollment.close();
        await closeAppHost();
        await rm(dataDir, { recursive: true, force: true });
        await runtime.stop(worker);
      }
    },
  },

  {
    name: "Offload 3: R2 large blob streaming upload and download via stateless signed tickets",
    async run({ runtime }) {
      const worker = await runtime.start(CLOUD_RELAY_SPEC, { vars: defaultVars() });
      try {
        const reg = await worker.fetch(`${worker.origin}/__opencraft_cloud/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "blobs@opencraft.dev", password: "blobs-password-123456" }),
        });
        const { token } = (await reg.json()) as { token: string };

        const enroll = await worker.fetch(`${worker.origin}/__opencraft_cloud/machines`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ displayName: "Artifact Box", platform: "darwin" }),
        });
        const { machine } = (await enroll.json()) as { machine: { machineId: string } };

        // Create a 256 KiB binary payload and compute its SHA-256
        const payload = new Uint8Array(256 * 1024);
        for (let i = 0; i < payload.byteLength; i += 1) payload[i] = i & 0xff;
        const hashBuf = await crypto.subtle.digest("SHA-256", payload);
        const sha256 = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");

        // Request PUT ticket
        const putTicketRes = await worker.fetch(`${worker.origin}/m/${machine.machineId}/__blobs/ticket`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ blobKey: "threads/t1/screenshot.bin", mode: "put", maxBytes: 512 * 1024, sha256 }),
        });
        assert.equal(putTicketRes.status, 200);
        const putTicket = (await putTicketRes.json()) as { url: string };

        // Stream directly to Edge <-> R2 without touching MachineRelayDO!
        const uploadRes = await worker.fetch(putTicket.url, {
          method: "PUT",
          body: payload,
        });
        assert.equal(uploadRes.status, 201);
        const uploadMeta = (await uploadRes.json()) as { size: number; sha256: string };
        assert.equal(uploadMeta.size, payload.byteLength);
        assert.equal(uploadMeta.sha256, sha256);

        // Request GET ticket and verify downloaded bytes match byte-for-byte
        const getTicketRes = await worker.fetch(`${worker.origin}/m/${machine.machineId}/__blobs/ticket`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ blobKey: "threads/t1/screenshot.bin", mode: "get" }),
        });
        const getTicket = (await getTicketRes.json()) as { url: string };
        const downloadRes = await worker.fetch(getTicket.url);
        assert.equal(downloadRes.status, 200);
        const downloaded = new Uint8Array(await downloadRes.arrayBuffer());
        assert.equal(downloaded.byteLength, payload.byteLength);
        assert.deepEqual(downloaded.subarray(0, 64), payload.subarray(0, 64));

        await sleep(10);
      } finally {
        await runtime.stop(worker);
      }
    },
  },

  {
    name: "zero-signup sovereign enrollment + Hashcash PoW + IP rate limit + guest share claim + ocl1_ License Key",
    async run({ runtime }) {
      const worker = await runtime.start(CLOUD_RELAY_SPEC, {
        vars: defaultVars({
          OPENCRAFT_RELAY_POW_BITS: "8",
          OPENCRAFT_RELAY_IP_ENROLL_HOURLY_LIMIT: "3",
          OPENCRAFT_RELAY_FREE_MACHINE_LIMIT: "1",
        }),
      });
      const dataDir1 = await mkdtemp(join(tmpdir(), "oc-sov-1-"));
      const dataDir2 = await mkdtemp(join(tmpdir(), "oc-sov-2-"));
      const { appHost, close: closeAppHost } = createFakeEchoAppHost();

      const enroll1 = new DaemonRelayEnrollmentService({
        dataDirectory: dataDir1,
        appHost,
        machineIdentity: { machineId: crypto.randomUUID(), name: "Zero-Signup Mac", platform: "darwin" },
        allowLoopbackInsecure: true,
        fetchImpl: (input, init) => worker.fetch(String(input), init),
        createMuxSocket: createMiniflareMuxSocketFactory(worker),
      });
      const enroll2 = new DaemonRelayEnrollmentService({
        dataDirectory: dataDir2,
        appHost,
        machineIdentity: { machineId: crypto.randomUUID(), name: "Second Mac", platform: "darwin" },
        allowLoopbackInsecure: true,
        fetchImpl: (input, init) => worker.fetch(String(input), init),
        createMuxSocket: createMiniflareMuxSocketFactory(worker),
      });

      try {
        // 1. Missing PoW header is rejected with 428 before any DO write!
        const noPowRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/sovereign/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: "Bot" }),
        });
        assert.equal(noPowRes.status, 428);

        // 2. 1-click Zero-Signup Sovereign Enrollment (no email, no password!)
        const sov = await enroll1.enrollSovereignMachine({ relayOrigin: worker.origin });
        await waitFor(runtime, () => enroll1.status().connected, 4_000, "sovereign mux connected");
        assert.ok(sov.pairingInvite.httpsPairingUrl.includes("#code="));

        // 3. Zero-Signup Guest Collaborator Share Claim (`claim-guest` with PoW + guest Ed25519 key!)
        const share = await enroll1.createShare({ allowExecution: false });
        const guestDevice = await generateEd25519DeviceProofFactory();
        const powChalRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/pow/challenge?purpose=redeem`);
        const powChal = (await powChalRes.json()) as { challenge: string; bits: number };
        const powNonce = await solveHashcashPow(powChal.challenge, powChal.bits);

        const guestClaimRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/shares/claim-guest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencraft-pow": `${powChal.challenge}:${powNonce}`,
          },
          body: JSON.stringify({
            shareToken: share.shareToken,
            guestPublicKey: guestDevice.publicKeyB64,
          }),
        });
        assert.equal(guestClaimRes.status, 200);
        const guestClaim = (await guestClaimRes.json()) as { token: string };

        // Guest queries `/m/:machineId/health` over mux using DPoP without ever creating an account!
        const healthUrl = `${worker.origin}/m/${sov.machineId}/health?grant=${encodeURIComponent(share.grantId)}`;
        const guestHealth = await worker.fetch(healthUrl, {
          headers: {
            authorization: `Bearer ${guestClaim.token}`,
            "x-opencraft-dpop": await guestDevice.signDpop("GET", healthUrl),
          },
        });
        assert.equal(guestHealth.status, 200);

        // 4. Free tier blob limit (16 MiB) rejects a 64 MiB upload ticket; `ocl1_` Pro License Key unlocks 512 MiB!
        const ticketUrl = `${worker.origin}/m/${sov.machineId}/__blobs/ticket?grant=${encodeURIComponent(share.grantId)}`;
        const overFreeBlob = await worker.fetch(ticketUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${guestClaim.token}`,
            "x-opencraft-dpop": await guestDevice.signDpop("POST", ticketUrl),
          },
          body: JSON.stringify({ blobKey: "big.zip", mode: "put", maxBytes: 64 * 1024 * 1024 }),
        });
        assert.equal(overFreeBlob.status, 413);

        const licenseKey = await issueRelayLicenseKey(SIGNING_KEY, {
          lid: `lic_pro_${crypto.randomUUID().slice(0, 8)}`,
          tier: "pro",
          machineLimit: 10,
          maxBlobBytes: 512 * 1024 * 1024,
          exp: Date.now() + 86_400_000,
        });
        const activated = await enroll1.activateLicense(licenseKey);
        assert.equal(activated.tier, "pro");
        assert.equal(activated.machineLimit, 10);
        assert.equal(activated.maxBlobBytes, 512 * 1024 * 1024);

        const unlockedBlob = await worker.fetch(ticketUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${guestClaim.token}`,
            "x-opencraft-dpop": await guestDevice.signDpop("POST", ticketUrl),
          },
          body: JSON.stringify({ blobKey: "big.zip", mode: "put", maxBytes: 64 * 1024 * 1024 }),
        });
        assert.equal(unlockedBlob.status, 200);

        // 5. Second unrelated workstation attempting to reuse the same `ocl1_` key gets 409 `license_already_claimed`!
        await assert.rejects(
          () => enroll2.enrollSovereignMachine({ relayOrigin: worker.origin, licenseKey }),
          /license_already_claimed/u,
        );

        // 6. 3rd sovereign enroll attempt from the same IP hits `OPENCRAFT_RELAY_IP_ENROLL_HOURLY_LIMIT = 2` -> 429!
        const floodRes = await worker.fetch(`${worker.origin}/__opencraft_cloud/sovereign/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: "Flood-3" }),
        });
        assert.equal(floodRes.status, 429);
      } finally {
        enroll1.close();
        enroll2.close();
        await closeAppHost();
        await rm(dataDir1, { recursive: true, force: true });
        await rm(dataDir2, { recursive: true, force: true });
        await runtime.stop(worker);
      }
    },
  },
];
