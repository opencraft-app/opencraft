// Live public-network end-to-end verification and latency benchmark against a
// deployed OpenCraft Hosted Cloud Relay (defaults to `https://relay.opencraft.app`).
//
// Exercises 100% real TLS sockets (`ws` + `fetch`), real `DaemonRelayEnrollmentService`
// + `AppHostServer`, `opencraft://pair` + Ed25519 DPoP + 6-char short-code approval,
// edge `setWebSocketAutoResponse` ping/pong, 20 multiplexed AppHost JSON-RPC round-trips,
// `DATA_BATCH` coalescing, R2 256 KiB blob upload/download, and clean unenrollment.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { APP_HOST_PROTOCOL_VERSION, LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { AppHostServer } from "@opencraft/app-host-server";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { DaemonRelayEnrollmentService } from "@opencraft/opencraft-daemon/relay-enrollment";
import { RELAY_MUX_PING, RELAY_MUX_PONG, parsePairingUrl } from "@opencraft/relay-protocol";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function waitUntil(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

async function createEd25519DpopSigner() {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKeyB64 = toBase64Url(rawPub);
  const sign = async (method: string, url: string): Promise<string> => {
    const timestamp = Date.now();
    const nonce = randomBytes(18).toString("base64url");
    const msg = new TextEncoder().encode(`opencraft-dpop.v1\n${method.toUpperCase()}\n${url}\n${timestamp}\n${nonce}`);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, msg));
    return toBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          publicKey: publicKeyB64,
          method: method.toUpperCase(),
          url,
          timestamp,
          nonce,
          signature: toBase64Url(sig),
        }),
      ),
    );
  };
  return { publicKeyB64, sign };
}

function createEchoAppHost() {
  const msgListeners = new Set<(frame: string) => void>();
  const statusListeners = new Set<(s: TransportStatus) => void>();
  let status: TransportStatus = { state: "idle" };
  const publish = (next: TransportStatus) => {
    status = next;
    for (const fn of statusListeners) fn(next);
  };
  const appHost = new AppHostServer({
    logicalClientRouting: true,
    physicalHostLifetime: "server",
    createTransport(): DuplexTransport {
      return {
        get status() {
          return status;
        },
        async connect() {
          publish({ state: "open" });
        },
        async send(frame: string) {
          const parsed = JSON.parse(frame) as Record<string, unknown>;
          if (parsed.id !== undefined) {
            const reply = JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { ok: true, method: parsed.method },
              ...(parsed[LOGICAL_CLIENT_FIELD] ? { [LOGICAL_CLIENT_FIELD]: parsed[LOGICAL_CLIENT_FIELD] } : {}),
            });
            for (const fn of msgListeners) fn(reply);
          }
        },
        subscribeMessage(fn) {
          msgListeners.add(fn);
          return () => msgListeners.delete(fn);
        },
        subscribeStatus(fn) {
          statusListeners.add(fn);
          return () => statusListeners.delete(fn);
        },
        async close() {
          publish({ state: "closed" });
          msgListeners.clear();
          statusListeners.clear();
        },
      };
    },
  });
  return {
    appHost,
    emitDelta(delta: string) {
      const f = JSON.stringify({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta } });
      for (const fn of msgListeners) fn(f);
    },
    close: () => appHost.close(),
  };
}

const originArgIdx = process.argv.indexOf("--origin");
const origin = (originArgIdx >= 0 ? process.argv[originArgIdx + 1] : undefined) ?? "https://relay.opencraft.app";

const dataDir = await mkdtemp(join(tmpdir(), "oc-live-smoke-"));
const { appHost, emitDelta, close: closeAppHost } = createEchoAppHost();
const machineId = randomUUID();
const enrollment = new DaemonRelayEnrollmentService({
  dataDirectory: dataDir,
  appHost,
  machineIdentity: { machineId, name: "Live Smoke Mac", platform: "darwin" },
  batchWindowMs: 25,
});

try {
  // 1. Edge health & POP identification (`cf-ray`)
  const tHealth0 = performance.now();
  const healthRes = await fetch(`${origin}/__opencraft_relay/live`);
  const healthMs = performance.now() - tHealth0;
  assert.equal(healthRes.status, 200);
  const cfRay = healthRes.headers.get("cf-ray") ?? "unknown";
  const healthBody = (await healthRes.json()) as { ok: boolean; protocol: number; mode: string };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.protocol, 2);

  // 2. Zero-Signup Sovereign Enrollment (Ed25519 DPoP + Hashcash PoW + TLS `mux.v2`, zero email/password!)
  const tEnroll0 = performance.now();
  await enrollment.enrollSovereignMachine({ relayOrigin: origin });
  await waitUntil(() => enrollment.status().connected, 15_000, "live TLS mux.v2 connected");
  const sovereignEnrollAndConnectMs = performance.now() - tEnroll0;

  // 3. Pair mobile client with `opencraft://pair` + Ed25519 DPoP + 6-char short-code approval
  const invite = await enrollment.createPairingInvite({ approvalRequired: true });
  const parsedInvite = parsePairingUrl(invite.pairingUrl)!;
  const mobileDpop = await createEd25519DpopSigner();
  const redeemRes = await fetch(`${origin}/__opencraft_cloud/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      machineId,
      code: parsedInvite.code,
      devicePublicKey: mobileDpop.publicKeyB64,
      deviceLabel: "Live Smoke iPhone",
    }),
  });
  assert.equal(redeemRes.status, 202);
  const redeemed = (await redeemRes.json()) as { token: string; shortCode: string };
  await enrollment.approvePendingDevice(redeemed.shortCode);

  // 4. HTTP-over-mux check (`/m/<machineId>/health`)
  const healthUrl = `${origin}/m/${machineId}/health`;
  const tHttpMux0 = performance.now();
  const muxHttpRes = await fetch(healthUrl, {
    headers: {
      authorization: `Bearer ${redeemed.token}`,
      "x-opencraft-dpop": await mobileDpop.sign("GET", healthUrl),
    },
  });
  const httpOverMuxMs = performance.now() - tHttpMux0;
  assert.equal(muxHttpRes.status, 200);

  // 5. Real TLS client WebSocket (`wss://relay.opencraft.app/m/<machineId>/ws`)
  const wsHttpUrl = `${origin}/m/${machineId}/ws`;
  const wsUrl = wsHttpUrl.replace(/^https:/u, "wss:").replace(/^http:/u, "ws:");
  const dpopHeader = await mobileDpop.sign("GET", wsHttpUrl);

  const clientWs = new WebSocket(wsUrl, {
    headers: {
      authorization: `Bearer ${redeemed.token}`,
      "x-opencraft-dpop": dpopHeader,
    },
    perMessageDeflate: false,
  });

  await new Promise<void>((resolve, reject) => {
    clientWs.once("open", () => resolve());
    clientWs.once("error", reject);
  });

  const inbound: Record<string, unknown>[] = [];
  const rpcResolvers = new Map<number, () => void>();
  let pongAt = 0;

  clientWs.on("message", (raw) => {
    const text = raw.toString("utf8");
    if (text === RELAY_MUX_PONG) {
      pongAt = performance.now();
      return;
    }
    const msg = JSON.parse(text) as Record<string, unknown>;
    inbound.push(msg);
    if (msg.type === "host/frame" && typeof msg.frame === "string") {
      const rpc = JSON.parse(msg.frame) as { id?: number };
      if (typeof rpc.id === "number") rpcResolvers.get(rpc.id)?.();
    }
  });

  // 5a. Edge zero-wakeup `setWebSocketAutoResponse` ping RTT
  const tPing0 = performance.now();
  clientWs.send(RELAY_MUX_PING);
  await waitUntil(() => pongAt > 0, 10_000, "edge auto-response pong");
  const edgePingRttMs = pongAt - tPing0;

  // 5b. AppHost handshake + 20 sequential end-to-end multiplexed JSON-RPC round-trips
  clientWs.send(
    JSON.stringify({ type: "hello", protocolVersion: APP_HOST_PROTOCOL_VERSION, rendererId: "smoke-mobile" }),
  );
  await waitUntil(() => inbound.some((m) => m.type === "ready"), 10_000, "AppHost ready");
  clientWs.send(JSON.stringify({ type: "host/connect", requestId: "c1", hostId: "local", leaseId: "l1" }));
  await waitUntil(
    () => inbound.some((m) => m.type === "response" && m.requestId === "c1" && m.ok === true),
    10_000,
    "AppHost host/connect",
  );
  const connResp = inbound.find((m) => m.type === "response" && m.requestId === "c1") as {
    result: { generation: number };
  };

  const rtts: number[] = [];
  for (let i = 1; i <= 20; i += 1) {
    const t0 = performance.now();
    const done = new Promise<void>((resolve) => rpcResolvers.set(i, resolve));
    clientWs.send(
      JSON.stringify({
        type: "host/send",
        requestId: `s-${i}`,
        hostId: "local",
        leaseId: "l1",
        generation: connResp.result.generation,
        frame: JSON.stringify({ jsonrpc: "2.0", id: i, method: "thread/list" }),
      }),
    );
    await done;
    rtts.push(performance.now() - t0);
  }
  rtts.sort((a, b) => a - b);

  // 5c. Coalesced delta batch verification
  for (let i = 0; i < 5; i += 1) emitDelta(`tok-${i}`);
  await waitUntil(
    () =>
      inbound.filter(
        (m) => m.type === "host/frame" && typeof m.frame === "string" && m.frame.includes("item/agentMessage/delta"),
      ).length === 5,
    10_000,
    "5 coalesced deltas delivered",
  );
  clientWs.close(1000, "Smoke complete");
  await waitUntil(() => enrollment.status().activeWatchers === 0, 10_000, "activeWatchers returned to 0");

  // 6. R2 256 KiB blob streaming upload + download over live HTTPS
  const blobBytes = randomBytes(256 * 1024);
  const shaBuf = await crypto.subtle.digest("SHA-256", blobBytes);
  const sha256 = Buffer.from(shaBuf).toString("hex");
  const blobKey = `smoke/${machineId}/payload.bin`;

  const putTicketUrl = `${origin}/m/${machineId}/__blobs/ticket`;
  const putTicketRes = await fetch(putTicketUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${redeemed.token}`,
      "x-opencraft-dpop": await mobileDpop.sign("POST", putTicketUrl),
    },
    body: JSON.stringify({ blobKey, mode: "put", maxBytes: 512 * 1024, sha256 }),
  });
  assert.equal(putTicketRes.status, 200);
  const putTicket = (await putTicketRes.json()) as { url: string };

  const tUp0 = performance.now();
  const upRes = await fetch(putTicket.url, { method: "PUT", body: blobBytes });
  const r2UploadMs = performance.now() - tUp0;
  assert.equal(upRes.status, 201);

  const getTicketRes = await fetch(putTicketUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${redeemed.token}`,
      "x-opencraft-dpop": await mobileDpop.sign("POST", putTicketUrl),
    },
    body: JSON.stringify({ blobKey, mode: "get" }),
  });
  const getTicket = (await getTicketRes.json()) as { url: string };
  const tDown0 = performance.now();
  const downRes = await fetch(getTicket.url);
  const downloaded = Buffer.from(await downRes.arrayBuffer());
  const r2DownloadMs = performance.now() - tDown0;
  assert.equal(downRes.status, 200);
  assert.equal(downloaded.equals(blobBytes), true);

  // 7. Revoke smoke machine enrollment so no dangling machine remains active
  await enrollment.unenroll();

  console.log(
    JSON.stringify(
      {
        ok: true,
        origin,
        cfRay,
        metricsMs: {
          edgeHealthFirstHit: Math.round(healthMs),
          zeroSignupSovereignEnrollAndMuxTls: Math.round(sovereignEnrollAndConnectMs),
          httpOverMuxRtt: Math.round(httpOverMuxMs),
          edgeAutoResponsePingRtt: Math.round(edgePingRttMs),
          muxWsRpcRttP50: Math.round(quantile(rtts, 0.5)),
          muxWsRpcRttP95: Math.round(quantile(rtts, 0.95)),
          r2Upload256KiB: Math.round(r2UploadMs),
          r2Download256KiB: Math.round(r2DownloadMs),
        },
      },
      null,
      2,
    ),
  );
} finally {
  enrollment.close();
  await closeAppHost();
  await rm(dataDir, { recursive: true, force: true });
}
