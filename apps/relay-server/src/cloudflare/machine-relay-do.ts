// Per-machine Durable Object (`machine:<machineId>`).
//
// Million-scale design invariants:
// 1. 100% WebSocket Hibernation on BOTH sides (`host` mux.v2 socket AND `client`
//    WebSockets): no in-memory client-socket map is required. Stream routing uses
//    Hibernatable tags (`stream:<streamId>`, `grant:<grantId>`) and socket
//    attachments (`serializeAttachment`), so idle machines and open idle browser
//    tabs incur $0 compute duration charges.
// 2. Zero-wakeup edge heartbeats via `ctx.setWebSocketAutoResponse(RELAY_MUX_PING, RELAY_MUX_PONG)`.
// 3. Anti-billing-spike audience signaling (`AUDIENCE_STATE`): notifies the Host
//    whenever active viewer count transitions to/from 0 so unattended background
//    loops suppress transient streaming deltas.
// 4. Instant revocation: revoking a `ShareGrant` or the machine closes matching
//    Hibernatable sockets immediately by tag and sends `CLOSE` to the Host.
import {
  MAX_MUX_PAYLOAD,
  MAX_MUX_STREAMS,
  MuxFrameType,
  RELAY_MUX_PING,
  RELAY_MUX_PONG,
  RELAY_MUX_PROTOCOL,
  decodeMuxFrame,
  deterministicUuidFromHex,
  encodeMuxFrame,
  relayPathAllowed,
  type MuxAccessScope,
  type MuxFrame,
} from "@opencraft/relay-protocol";
import { durableObjectStateDocumentStore } from "@opencraft/storage-cloudflare/state";
import {
  INTERNAL_CALLER_HEADER,
  INTERNAL_CALLER_VALUE,
  type CloudRelayDOState,
  type CloudRelayEnv,
  type HibernatableSocket,
  type HibernatableSocketRuntime,
} from "./bindings.js";
import { constantTimeEqual, randomApprovalCode, sha256Hex } from "./crypto.js";
import { MachineRelayAuthority, type MachineGrantProjection } from "./domain.js";

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;

interface HostSocketAttachment {
  readonly kind: "host";
  readonly generation: number;
}

interface ClientSocketAttachment {
  readonly kind: "client";
  readonly streamId: number;
  readonly hostGeneration: number;
  readonly actorId: string;
  readonly grantId?: string;
  readonly deviceThumbprint?: string;
  readonly scope: MuxAccessScope;
}

type SocketAttachment = HostSocketAttachment | ClientSocketAttachment;

interface PendingHttpStream {
  readonly hostGeneration: number;
  status: number | null;
  headers: readonly (readonly [string, string])[];
  chunks: Uint8Array[];
  bytes: number;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(response: Response): void;
}

const SENDABLE_CLOSE = (code: number) =>
  code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function sendBinary(ws: WebSocket, bytes: Uint8Array): void {
  ws.send(bytes as Uint8Array<ArrayBuffer>);
}

export class MachineRelayDO {
  readonly #authority: MachineRelayAuthority;
  readonly #httpStreams = new Map<number, PendingHttpStream>();
  #nextStreamId: number | null = null;
  readonly #stats = {
    hostConnects: 0,
    wsStreamsOpened: 0,
    httpStreamsOpened: 0,
    batchesUnpacked: 0,
    protocolViolations: 0,
  };

  constructor(
    private readonly ctx: CloudRelayDOState,
    private readonly env: CloudRelayEnv,
  ) {
    this.#authority = new MachineRelayAuthority(
      durableObjectStateDocumentStore(this.ctx.storage, { prefix: "relay/" }),
    );
    const runtime = globalThis as HibernatableSocketRuntime;
    if (typeof runtime.WebSocketRequestResponsePair === "function") {
      this.ctx.setWebSocketAutoResponse(new runtime.WebSocketRequestResponsePair(RELAY_MUX_PING, RELAY_MUX_PONG));
    }
  }

  get #httpTimeoutMs(): number {
    const raw = Number(this.env.OPENCRAFT_RELAY_HTTP_TIMEOUT_MS ?? DEFAULT_HTTP_TIMEOUT_MS);
    return Number.isSafeInteger(raw) && raw >= 100 ? raw : DEFAULT_HTTP_TIMEOUT_MS;
  }

  #attachment(ws: HibernatableSocket): SocketAttachment | null {
    try {
      const value = ws.deserializeAttachment() as SocketAttachment | null;
      return value && typeof value === "object" && (value.kind === "host" || value.kind === "client") ? value : null;
    } catch {
      return null;
    }
  }

  #liveHost(): { readonly ws: HibernatableSocket; readonly generation: number } | null {
    let best: { ws: HibernatableSocket; generation: number } | null = null;
    for (const ws of this.ctx.getWebSockets("host")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const att = this.#attachment(ws);
      if (att?.kind === "host" && (!best || att.generation > best.generation)) {
        best = { ws, generation: att.generation };
      }
    }
    return best;
  }

  #activeClientSockets(generation?: number): HibernatableSocket[] {
    return this.ctx.getWebSockets("client").filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      if (generation === undefined) return true;
      const att = this.#attachment(ws);
      return att?.kind === "client" && att.hostGeneration === generation;
    });
  }

  #notifyAudienceCount(
    host: { readonly ws: HibernatableSocket; readonly generation: number } | null = this.#liveHost(),
  ): void {
    if (!host || host.ws.readyState !== WebSocket.OPEN) return;
    const viewers = this.#activeClientSockets(host.generation).length + this.#httpStreams.size;
    try {
      sendBinary(
        host.ws,
        encodeMuxFrame({ type: MuxFrameType.AUDIENCE_STATE, activeWatchers: Math.min(65_535, viewers) }),
      );
    } catch {
      /* Closing socket will clean up in webSocketClose. */
    }
  }

  #safeClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(SENDABLE_CLOSE(code) ? code : 1011, reason.slice(0, 120));
    } catch {
      /* Already closed. */
    }
  }

  /**
   * Zero-disk-IO stream allocator: recovers the high-water `streamId` from
   * hibernated client WebSocket attachments on cold wake-up (`0` storage reads,
   * `0` storage writes, `0ms` DO output-gate replication stall).
   */
  #allocateStreamId(): number {
    if (this.#nextStreamId === null) {
      let maxActive = 0;
      for (const ws of this.ctx.getWebSockets("client")) {
        const att = this.#attachment(ws);
        if (att?.kind === "client" && att.streamId > maxActive) {
          maxActive = att.streamId;
        }
      }
      this.#nextStreamId = maxActive;
    }
    const next = this.#nextStreamId >= 0x7fff_fffe ? 1 : this.#nextStreamId + 1;
    this.#nextStreamId = next;
    return next;
  }

  #retireGeneration(maxGeneration: number, code: number, reason: string): void {
    for (const ws of this.ctx.getWebSockets("client")) {
      const att = this.#attachment(ws);
      if (att?.kind === "client" && att.hostGeneration <= maxGeneration) {
        this.#safeClose(ws, code, reason);
      }
    }
    for (const [streamId, pending] of this.#httpStreams) {
      if (pending.hostGeneration <= maxGeneration) {
        clearTimeout(pending.timer);
        this.#httpStreams.delete(streamId);
        pending.resolve(json(503, { error: "machine_reconnected" }));
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get(INTERNAL_CALLER_HEADER) !== INTERNAL_CALLER_VALUE) {
      return json(403, { error: "forbidden" });
    }
    const url = new URL(request.url);
    const now = Date.now();

    // ---- Internal control-plane mutations from UserRelayDO / Edge Worker ----
    if (url.pathname === "/internal/configure" && request.method === "POST") {
      const body = (await request.json()) as {
        machineId: string;
        displayName: string;
        ownerActorId: string;
        secretHash: string;
        approvalRequired: boolean;
        maxBlobBytes?: number;
        ownerDeviceThumbprint?: string;
      };
      try {
        const doc = await this.#authority.configure(body);
        if (body.ownerDeviceThumbprint) {
          await this.#authority.registerDeviceOrQueueApproval({
            thumbprint: body.ownerDeviceThumbprint,
            label: "Owner Workstation",
            forceApprove: true,
            ownerBootstrap: true,
            shortCode: randomApprovalCode(),
            now,
          });
        }
        return json(200, { ok: true, generation: doc.generation });
      } catch (err) {
        return json(409, { error: err instanceof Error ? err.message : "conflict" });
      }
    }

    if (url.pathname === "/internal/set-max-blob-bytes" && request.method === "POST") {
      const { maxBlobBytes } = (await request.json()) as { maxBlobBytes: number };
      await this.#authority.setMaxBlobBytes(maxBlobBytes);
      return json(200, { ok: true });
    }

    if (url.pathname === "/internal/revoke-machine" && request.method === "POST") {
      await this.#authority.revokeMachine();
      for (const ws of this.ctx.getWebSockets("host")) this.#safeClose(ws, 4003, "Machine enrollment revoked");
      for (const ws of this.ctx.getWebSockets("client")) this.#safeClose(ws, 4003, "Machine enrollment revoked");
      for (const [id, pending] of this.#httpStreams) {
        clearTimeout(pending.timer);
        this.#httpStreams.delete(id);
        pending.resolve(json(403, { error: "machine_revoked" }));
      }
      return json(200, { ok: true });
    }

    if (url.pathname === "/internal/upsert-grant" && request.method === "POST") {
      const grant = (await request.json()) as MachineGrantProjection;
      await this.#authority.upsertGrant(grant);
      return json(200, { ok: true });
    }

    if (url.pathname === "/internal/revoke-grant" && request.method === "POST") {
      const { grantId } = (await request.json()) as { grantId: string };
      await this.#authority.revokeGrant(grantId);
      const host = this.#liveHost();
      for (const ws of this.ctx.getWebSockets(`grant:${grantId}`)) {
        const att = this.#attachment(ws);
        this.#safeClose(ws, 4003, "Share grant revoked");
        if (att?.kind === "client" && host && host.generation === att.hostGeneration) {
          try {
            sendBinary(
              host.ws,
              encodeMuxFrame({ type: MuxFrameType.CLOSE, streamId: att.streamId, code: 4003, reason: "Grant revoked" }),
            );
          } catch {}
        }
      }
      this.#notifyAudienceCount(host);
      return json(200, { ok: true });
    }

    if (url.pathname === "/internal/register-device" && request.method === "POST") {
      const body = (await request.json()) as {
        thumbprint: string;
        label?: string;
        forceApprove?: boolean;
        clearRevocation?: boolean;
      };
      const outcome = await this.#authority.registerDeviceOrQueueApproval({
        thumbprint: body.thumbprint,
        label: body.label ?? "Paired Device",
        forceApprove: body.forceApprove === true,
        clearRevocation: body.clearRevocation === true,
        shortCode: randomApprovalCode(),
        now,
      });
      if (outcome.status === "revoked") return json(403, { error: "device_revoked" });
      return json(outcome.status === "approved" ? 200 : 202, outcome);
    }

    if (url.pathname === "/internal/approve-device" && request.method === "POST") {
      const body = (await request.json()) as { actorId: string; shortCode: string };
      const doc = await this.#authority.read();
      if (!doc || doc.revoked || doc.ownerActorId !== body.actorId) return json(403, { error: "access_denied" });
      const approved = await this.#authority.approvePendingDevice(body.shortCode, now);
      if (!approved) return json(404, { error: "approval_code_not_found" });
      return json(200, { ok: true, thumbprint: approved.thumbprint, device: approved });
    }

    if (url.pathname === "/internal/revoke-device" && request.method === "POST") {
      const body = (await request.json()) as { actorId?: unknown; thumbprint?: unknown };
      if (typeof body.actorId !== "string" || typeof body.thumbprint !== "string" || !body.thumbprint.trim()) {
        return json(400, { error: "invalid_revoke_device_request" });
      }
      const doc = await this.#authority.read();
      if (!doc || doc.revoked || doc.ownerActorId !== body.actorId) return json(403, { error: "access_denied" });
      if (doc.ownerDeviceThumbprint && body.thumbprint === doc.ownerDeviceThumbprint) {
        return json(400, { error: "cannot_revoke_owner_workstation" });
      }
      const removed = await this.#authority.revokeDevice(body.thumbprint, now);
      const host = this.#liveHost();
      for (const ws of this.ctx.getWebSockets("client")) {
        const att = this.#attachment(ws);
        if (att?.kind === "client" && att.deviceThumbprint === body.thumbprint) {
          this.#safeClose(ws, 4003, "Device access revoked");
          if (host && host.generation === att.hostGeneration) {
            try {
              sendBinary(
                host.ws,
                encodeMuxFrame({
                  type: MuxFrameType.CLOSE,
                  streamId: att.streamId,
                  code: 4003,
                  reason: "Device revoked",
                }),
              );
            } catch {}
          }
        }
      }
      this.#notifyAudienceCount(host);
      return json(200, { ok: true, removed });
    }

    if (url.pathname === "/internal/inspect" && request.method === "GET") {
      const doc = await this.#authority.read();
      const host = this.#liveHost();
      const activeSockets = this.#activeClientSockets(host?.generation);
      const streamsByDevice = new Map<string, number>();
      for (const ws of activeSockets) {
        const att = this.#attachment(ws);
        if (att?.kind === "client" && att.deviceThumbprint) {
          streamsByDevice.set(att.deviceThumbprint, (streamsByDevice.get(att.deviceThumbprint) ?? 0) + 1);
        }
      }
      const approvedDevices = doc
        ? Object.values(doc.approvedDevices)
            .filter(
              (d) =>
                d.thumbprint !== doc.ownerDeviceThumbprint &&
                !(doc.revokedDevices && doc.revokedDevices[d.thumbprint]) &&
                d.label !== "Owner Workstation",
            )
            .map((d) => ({
              thumbprint: d.thumbprint,
              label: d.label,
              approvedAt: d.approvedAt,
              activeStreams: streamsByDevice.get(d.thumbprint) ?? 0,
            }))
            .sort(
              (a, b) => (b.activeStreams > 0 ? 1 : 0) - (a.activeStreams > 0 ? 1 : 0) || b.approvedAt - a.approvedAt,
            )
        : [];
      return json(200, {
        online: host !== null,
        ownerActorId: doc?.ownerActorId ?? null,
        ownerDeviceThumbprint: doc?.ownerDeviceThumbprint ?? null,
        displayName: doc?.displayName ?? "",
        generation: host?.generation ?? doc?.generation ?? null,
        activeWsStreams: activeSockets.length,
        activeHttpStreams: this.#httpStreams.size,
        directRoutesCount: doc?.directRoutes.length ?? 0,
        pendingApprovals: doc ? Object.values(doc.pendingApprovals).filter((p) => p.expiresAt > now) : [],
        approvedDevices,
        ...this.#stats,
      });
    }

    if (url.pathname === "/internal/transfer-owner" && request.method === "POST") {
      const body = (await request.json()) as {
        newOwnerActorId?: unknown;
        ownerDeviceThumbprint?: unknown;
        displayName?: unknown;
        approvedBrowserThumbprint?: unknown;
        approvedBrowserLabel?: unknown;
      };
      if (typeof body.newOwnerActorId !== "string" || typeof body.ownerDeviceThumbprint !== "string") {
        return json(400, { error: "invalid_transfer_request" });
      }
      const doc = await this.#authority.read();
      if (!doc || doc.revoked) return json(404, { error: "machine_unavailable" });
      const expectedSovereignActor = `actor_${deterministicUuidFromHex(body.ownerDeviceThumbprint)}`;
      const matchesRecordedThumbprint =
        doc.ownerDeviceThumbprint === body.ownerDeviceThumbprint || doc.ownerActorId === expectedSovereignActor;
      if (!matchesRecordedThumbprint) {
        return json(403, { error: "invalid_machine_owner_proof" });
      }
      const transferred = await this.#authority.transferOwner({
        newOwnerActorId: body.newOwnerActorId,
        ownerDeviceThumbprint: body.ownerDeviceThumbprint,
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
        ...(typeof body.approvedBrowserThumbprint === "string"
          ? { approvedBrowserThumbprint: body.approvedBrowserThumbprint }
          : {}),
        ...(typeof body.approvedBrowserLabel === "string" ? { approvedBrowserLabel: body.approvedBrowserLabel } : {}),
        now,
      });
      return json(200, {
        ok: true,
        prevOwnerActorId: transferred.prevOwnerActorId,
        secretHash: transferred.doc.secretHash,
        approvalRequired: transferred.doc.approvalRequired,
        displayName: transferred.doc.displayName,
      });
    }

    if (url.pathname === "/internal/authorize-routes" && request.method === "POST") {
      const caller = (await request.json()) as { actorId: string; deviceThumbprint?: string; grantId?: string };
      const doc = await this.#authority.read();
      const auth = this.#authority.authorizeAccess(doc, caller, now);
      if (!auth.allowed) return json(auth.status, { error: auth.error });
      const host = this.#liveHost();
      return json(200, {
        online: host !== null,
        machineId: doc!.machineId,
        displayName: doc!.displayName,
        role: auth.scope.role,
        scope: auth.scope,
        directRoutes: auth.directRoutes,
        maxBlobBytes: doc!.maxBlobBytes ?? 16 * 1024 * 1024,
        offlineCatalogSummary: host === null ? doc!.offlineCatalogSummary : null,
      });
    }

    // ---- Host mux.v2 outbound connection upgrade ----
    if (url.pathname === "/internal/host-mux") {
      const secret = request.headers.get("x-opencraft-machine-secret") ?? "";
      const doc = await this.#authority.read();
      if (!doc || doc.revoked || !secret || !constantTimeEqual(await sha256Hex(secret), doc.secretHash)) {
        return json(401, { error: "invalid_machine_credential" });
      }
      const generation = await this.#authority.nextGeneration();
      this.#nextStreamId = 0;
      for (const prev of this.ctx.getWebSockets("host")) {
        this.#safeClose(prev, 1012, "Host control superseded");
      }
      this.#retireGeneration(generation - 1, 1012, "Host reconnected");
      const { WebSocketPair } = globalThis as HibernatableSocketRuntime;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["host"]);
      pair[1].serializeAttachment({ kind: "host", generation } satisfies HostSocketAttachment);
      this.#stats.hostConnects++;
      try {
        sendBinary(pair[1], encodeMuxFrame({ type: MuxFrameType.AUDIENCE_STATE, activeWatchers: 0 }));
      } catch {}
      const init: ResponseInit & { webSocket: WebSocket } = {
        status: 101,
        webSocket: pair[0],
        headers: { "sec-websocket-protocol": RELAY_MUX_PROTOCOL },
      };
      return new Response(null, init);
    }

    // ---- Client WebSocket or HTTP forward to Host ----
    if (url.pathname === "/internal/client-forward") {
      const actorId = request.headers.get("x-opencraft-actor-id") ?? "";
      const deviceThumbprint = request.headers.get("x-opencraft-device-thumbprint") ?? undefined;
      const grantId = request.headers.get("x-opencraft-grant-id") ?? undefined;
      const targetPath = request.headers.get("x-opencraft-target-path") ?? "/";
      const targetMethod = request.headers.get("x-opencraft-target-method") ?? request.method;
      if (!actorId || !relayPathAllowed(targetPath)) return json(403, { error: "access_denied" });

      const doc = await this.#authority.read();
      const auth = this.#authority.authorizeAccess(doc, { actorId, deviceThumbprint, grantId }, now);
      if (!auth.allowed) return json(auth.status, { error: auth.error });

      const host = this.#liveHost();
      if (!host) {
        return json(503, {
          error: "machine_offline",
          machineId: doc!.machineId,
          displayName: doc!.displayName,
          offlineCatalogSummary: doc!.offlineCatalogSummary,
        });
      }

      const activeTotal = this.#activeClientSockets(host.generation).length + this.#httpStreams.size;
      if (activeTotal >= MAX_MUX_STREAMS) {
        return json(503, { error: "machine_stream_budget_exhausted" });
      }

      const streamId = this.#allocateStreamId();
      const isUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";

      if (isUpgrade) {
        const subprotocol = request.headers.get("sec-websocket-protocol") ?? undefined;
        const { WebSocketPair } = globalThis as HibernatableSocketRuntime;
        const pair = new WebSocketPair();
        const tags = ["client", `stream:${streamId}`, ...(grantId ? [`grant:${grantId}`] : [])];
        this.ctx.acceptWebSocket(pair[1], tags);
        pair[1].serializeAttachment({
          kind: "client",
          streamId,
          hostGeneration: host.generation,
          actorId,
          ...(grantId ? { grantId } : {}),
          ...(deviceThumbprint ? { deviceThumbprint } : {}),
          scope: auth.scope,
        } satisfies ClientSocketAttachment);
        this.#stats.wsStreamsOpened++;
        sendBinary(
          host.ws,
          encodeMuxFrame({
            type: MuxFrameType.OPEN_WS,
            streamId,
            init: {
              path: targetPath,
              ...(subprotocol ? { subprotocol } : {}),
              actorId,
              ...(grantId ? { grantId } : {}),
              ...(deviceThumbprint ? { deviceThumbprint } : {}),
              scope: auth.scope,
            },
          }),
        );
        this.#notifyAudienceCount(host);
        const init: ResponseInit & { webSocket: WebSocket } = {
          status: 101,
          webSocket: pair[0],
          ...(subprotocol ? { headers: { "sec-websocket-protocol": subprotocol } } : {}),
        };
        return new Response(null, init);
      }

      // Ordinary HTTP request multiplexed over the single Hibernatable Host socket.
      const bodyBytes =
        targetMethod === "GET" || targetMethod === "HEAD"
          ? new Uint8Array(0)
          : new Uint8Array(await request.arrayBuffer());
      if (bodyBytes.byteLength > MAX_HTTP_REQUEST_BODY_BYTES) {
        return json(413, { error: "request_body_too_large" });
      }

      const forwardHeaders: [string, string][] = [];
      for (const [k, v] of request.headers.entries()) {
        if (k.startsWith("x-opencraft-") || k === "cookie" || k === "authorization" || k === "host") continue;
        forwardHeaders.push([k, v]);
      }

      this.#stats.httpStreamsOpened++;
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          this.#httpStreams.delete(streamId);
          try {
            sendBinary(
              host.ws,
              encodeMuxFrame({ type: MuxFrameType.CLOSE, streamId, code: 1001, reason: "HTTP timeout" }),
            );
          } catch {}
          this.#notifyAudienceCount();
          resolve(json(504, { error: "machine_http_timeout" }));
        }, this.#httpTimeoutMs);
        this.#httpStreams.set(streamId, {
          hostGeneration: host.generation,
          status: null,
          headers: [],
          chunks: [],
          bytes: 0,
          timer,
          resolve,
        });
        this.#notifyAudienceCount(host);
        sendBinary(
          host.ws,
          encodeMuxFrame({
            type: MuxFrameType.OPEN_HTTP,
            streamId,
            fin: bodyBytes.byteLength === 0,
            init: {
              method: targetMethod,
              path: targetPath,
              headers: forwardHeaders,
              actorId,
              ...(grantId ? { grantId } : {}),
              scope: auth.scope,
            },
          }),
        );
        for (let offset = 0; offset < bodyBytes.byteLength; offset += MAX_MUX_PAYLOAD) {
          const end = Math.min(offset + MAX_MUX_PAYLOAD, bodyBytes.byteLength);
          sendBinary(
            host.ws,
            encodeMuxFrame({
              type: MuxFrameType.DATA_BINARY,
              streamId,
              fin: end === bodyBytes.byteLength,
              data: bodyBytes.subarray(offset, end),
            }),
          );
        }
      });
    }

    return json(404, { error: "not_found" });
  }

  async webSocketMessage(ws: HibernatableSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = this.#attachment(ws);
    if (!att) {
      this.#safeClose(ws, 1008, "Missing socket attachment");
      return;
    }

    if (att.kind === "host") {
      await this.#handleHostFrame(ws, att, raw);
      return;
    }

    await this.#handleClientMessage(ws, att, raw);
  }

  async #handleHostFrame(ws: HibernatableSocket, att: HostSocketAttachment, raw: string | ArrayBuffer): Promise<void> {
    const currentHost = this.#liveHost();
    if (!currentHost || currentHost.generation !== att.generation) {
      this.#safeClose(ws, 1012, "Stale host generation");
      return;
    }
    if (typeof raw === "string") {
      this.#stats.protocolViolations++;
      this.#safeClose(ws, 1008, "Mux requires binary frames");
      this.#retireGeneration(att.generation, 1008, "Host protocol violation");
      return;
    }
    let frame: MuxFrame;
    try {
      frame = decodeMuxFrame(raw);
    } catch {
      this.#stats.protocolViolations++;
      this.#safeClose(ws, 1008, "Malformed mux frame");
      this.#retireGeneration(att.generation, 1008, "Host protocol violation");
      return;
    }

    switch (frame.type) {
      case MuxFrameType.ROUTE_ADVERTISE:
        await this.#authority.updateDirectRoutes(frame.candidates);
        return;

      case MuxFrameType.HTTP_RESPONSE: {
        const pending = this.#httpStreams.get(frame.streamId);
        if (!pending || pending.hostGeneration !== att.generation) return;
        pending.status = frame.init.status;
        pending.headers = frame.init.headers;
        if (frame.fin) this.#finishHttpStream(frame.streamId, pending);
        return;
      }

      case MuxFrameType.DATA_TEXT: {
        const pendingHttp = this.#httpStreams.get(frame.streamId);
        if (pendingHttp && pendingHttp.hostGeneration === att.generation) {
          const encoded = new TextEncoder().encode(frame.text);
          if (pendingHttp.bytes + encoded.byteLength > MAX_HTTP_RESPONSE_BODY_BYTES) {
            clearTimeout(pendingHttp.timer);
            this.#httpStreams.delete(frame.streamId);
            pendingHttp.resolve(json(502, { error: "response_too_large" }));
            return;
          }
          pendingHttp.chunks.push(encoded);
          pendingHttp.bytes += encoded.byteLength;
          if (frame.fin) this.#finishHttpStream(frame.streamId, pendingHttp);
          return;
        }
        const target = this.#findClientSocket(frame.streamId, att.generation);
        if (target) {
          try {
            target.send(frame.text);
          } catch {
            this.#safeClose(target, 1011, "Client send failed");
          }
        }
        return;
      }

      case MuxFrameType.DATA_BATCH: {
        this.#stats.batchesUnpacked++;
        const target = this.#findClientSocket(frame.streamId, att.generation);
        if (!target) return;
        for (const msg of frame.messages) {
          try {
            target.send(msg);
          } catch {
            this.#safeClose(target, 1011, "Client send failed");
            break;
          }
        }
        return;
      }

      case MuxFrameType.DATA_BINARY: {
        const pendingHttp = this.#httpStreams.get(frame.streamId);
        if (pendingHttp && pendingHttp.hostGeneration === att.generation) {
          if (pendingHttp.bytes + frame.data.byteLength > MAX_HTTP_RESPONSE_BODY_BYTES) {
            clearTimeout(pendingHttp.timer);
            this.#httpStreams.delete(frame.streamId);
            pendingHttp.resolve(json(502, { error: "response_too_large" }));
            return;
          }
          pendingHttp.chunks.push(frame.data);
          pendingHttp.bytes += frame.data.byteLength;
          if (frame.fin) this.#finishHttpStream(frame.streamId, pendingHttp);
          return;
        }
        const target = this.#findClientSocket(frame.streamId, att.generation);
        if (target) {
          try {
            sendBinary(target, frame.data);
          } catch {
            this.#safeClose(target, 1011, "Client send failed");
          }
        }
        return;
      }

      case MuxFrameType.CLOSE: {
        const pendingHttp = this.#httpStreams.get(frame.streamId);
        if (pendingHttp && pendingHttp.hostGeneration === att.generation) {
          clearTimeout(pendingHttp.timer);
          this.#httpStreams.delete(frame.streamId);
          this.#notifyAudienceCount();
          pendingHttp.resolve(json(502, { error: "upstream_closed", reason: frame.reason }));
          return;
        }
        const target = this.#findClientSocket(frame.streamId, att.generation);
        if (target) this.#safeClose(target, frame.code || 1000, frame.reason);
        return;
      }

      case MuxFrameType.WINDOW_UPDATE:
        // Credit acknowledgment from Host; client messages remain bounded per frame.
        return;

      default:
        this.#stats.protocolViolations++;
        this.#safeClose(ws, 1008, "Unexpected client-only frame from host");
        this.#retireGeneration(att.generation, 1008, "Host protocol violation");
    }
  }

  async #handleClientMessage(
    ws: HibernatableSocket,
    att: ClientSocketAttachment,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    const cached = this.#authority.peekCached();
    const doc = cached !== undefined ? cached : await this.#authority.read();
    const auth = this.#authority.authorizeAccess(
      doc,
      { actorId: att.actorId, deviceThumbprint: att.deviceThumbprint, grantId: att.grantId },
      Date.now(),
    );
    if (!auth.allowed) {
      this.#safeClose(ws, 4003, auth.error);
      const host = this.#liveHost();
      if (host && host.generation === att.hostGeneration) {
        try {
          sendBinary(
            host.ws,
            encodeMuxFrame({ type: MuxFrameType.CLOSE, streamId: att.streamId, code: 4003, reason: auth.error }),
          );
        } catch {}
      }
      return;
    }

    const host = this.#liveHost();
    if (!host || host.generation !== att.hostGeneration) {
      this.#safeClose(ws, 1012, "Host disconnected");
      return;
    }

    if (typeof raw === "string") {
      if (new TextEncoder().encode(raw).byteLength > MAX_MUX_PAYLOAD) {
        this.#safeClose(ws, 1009, "Message exceeds mux frame limit");
        return;
      }
      sendBinary(
        host.ws,
        encodeMuxFrame({
          type: MuxFrameType.DATA_TEXT,
          streamId: att.streamId,
          fin: false,
          transientDelta: false,
          text: raw,
        }),
      );
      return;
    }

    const bytes = new Uint8Array(raw);
    if (bytes.byteLength > MAX_MUX_PAYLOAD) {
      this.#safeClose(ws, 1009, "Message exceeds mux frame limit");
      return;
    }
    sendBinary(
      host.ws,
      encodeMuxFrame({
        type: MuxFrameType.DATA_BINARY,
        streamId: att.streamId,
        fin: false,
        data: bytes,
      }),
    );
  }

  #findClientSocket(streamId: number, generation: number): HibernatableSocket | null {
    for (const candidate of this.ctx.getWebSockets(`stream:${streamId}`)) {
      if (candidate.readyState !== WebSocket.OPEN) continue;
      const att = this.#attachment(candidate);
      if (att?.kind === "client" && att.hostGeneration === generation) return candidate;
    }
    return null;
  }

  #finishHttpStream(streamId: number, pending: PendingHttpStream): void {
    clearTimeout(pending.timer);
    this.#httpStreams.delete(streamId);
    this.#notifyAudienceCount();
    const responseHeaders = new Headers();
    for (const [k, v] of pending.headers) {
      if (k === "transfer-encoding" || k === "content-length" || k === "connection") continue;
      responseHeaders.append(k, v);
    }
    const body = concatBytes(pending.chunks, pending.bytes);
    pending.resolve(
      new Response(pending.status === 204 || pending.status === 304 ? null : (body as BodyInit), {
        status: pending.status ?? 200,
        headers: responseHeaders,
      }),
    );
  }

  async webSocketClose(ws: HibernatableSocket, code: number, reason: string): Promise<void> {
    const att = this.#attachment(ws);
    this.#safeClose(ws, code, reason);
    if (!att) return;
    if (att.kind === "host") {
      if (!this.#liveHost()) this.#retireGeneration(att.generation, 1012, "Host disconnected");
      return;
    }
    const host = this.#liveHost();
    if (host && host.generation === att.hostGeneration) {
      try {
        sendBinary(
          host.ws,
          encodeMuxFrame({
            type: MuxFrameType.CLOSE,
            streamId: att.streamId,
            code: SENDABLE_CLOSE(code) ? code : 1000,
            reason,
          }),
        );
      } catch {}
      this.#notifyAudienceCount(host);
    }
  }

  async webSocketError(ws: HibernatableSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "WebSocket error");
  }
}
