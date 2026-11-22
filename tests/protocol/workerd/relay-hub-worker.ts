// RelayHub prototype (docs/architecture/platform/cloudflare-deployment.md §2,
// "RelayHub 原型结果"). Test-only: bundled with esbuild and driven through
// Miniflare by tests/protocol/relay-hub-workerd.test.ts; no deployment assembly.
//
// - Edge Worker (default export): authenticates the outbound Headless control
//   link by its enrollment credential, routes data dials by the routing tag the
//   owning RelayHubDO minted into the stream id, and routes client WebSockets by
//   the installation's host. It forwards only headers it set itself.
// - RelayHubDO: one per installation and the single owner of that
//   installation's control link, stream reservations and stream budget. This
//   replaces the Node relay's Redis `connection:<id>` / `pending:<id>` leases
//   and inter-node forwarding: every request for the installation reaches the
//   same object, so there is nothing to elect and nothing to forward.
//
// Wire contract is the existing `opencraft-relay.v1`: the DO sends
// `{type:"open",id,token}` on the control link, the Headless dials
// DATA_PATH with STREAM_HEADER=id and `Bearer <token>`. Stream ids stay
// UUID-shaped (`^[0-9a-f-]{36}$`, accepted by `parseOpen`).
import { DurableObject } from "cloudflare:workers";
import { CONTROL_PATH, DATA_PATH, MAX_RELAY_STREAMS, RELAY_PROTOCOL, STREAM_HEADER, relayPathAllowed } from "@opencraft/relay-protocol";

/** Same reservation deadline as the Node relay (`localChannel`, Redis `pending:` PX 10000). */
const RESERVATION_MS = 10_000;
/** Same per-message bound as the Node relay's data WebSocketServer `maxPayload`. */
const MAX_DATA_MESSAGE = 65_536;

interface Namespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
interface Env {
  readonly RELAY: Namespace;
  /** JSON `{ [installationId]: { credential, host } }`; production reads the InstallationCore registry. */
  readonly INSTALLATIONS: string;
  /** Edge-only key for stream-id routing tags. */
  readonly ROUTE_KEY: string;
  /** Test-only override of RESERVATION_MS. */
  readonly RESERVATION_MS?: number;
}

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
function equal(a: string, b: string): boolean {
  const left = encoder.encode(a), right = encoder.encode(b);
  return left.byteLength === right.byteLength && (crypto.subtle as unknown as { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean }).timingSafeEqual(left, right);
}
const status = (code: number, error: string) => new Response(JSON.stringify({ error }), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const upgrading = (request: Request) => request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === "websocket";
const bearer = (request: Request) => /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get("authorization") ?? "")?.[1];

// ---- edge --------------------------------------------------------------------

interface Registry { byHost: Map<string, string>; byTag: Map<string, string>; credentials: [string, string][]; tags: Map<string, string>; }
let registry: { source: string; value: Promise<Registry> } | undefined;

/** 64-bit routing tag: the first 16 hex digits of every stream id the owning DO mints. */
async function routeTag(key: string, installationId: string): Promise<string> {
  const hmac = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", hmac, encoder.encode(installationId))).slice(0, 16);
}
function loadRegistry(env: Env): Promise<Registry> {
  if (registry?.source === env.INSTALLATIONS) return registry.value;
  const value = (async () => {
    const parsed = JSON.parse(env.INSTALLATIONS) as Record<string, { credential: string; host: string }>;
    const result: Registry = { byHost: new Map(), byTag: new Map(), credentials: [], tags: new Map() };
    for (const [id, entry] of Object.entries(parsed)) {
      const tag = await routeTag(env.ROUTE_KEY, id);
      result.byHost.set(entry.host, id); result.byTag.set(tag, id); result.tags.set(id, tag);
      result.credentials.push([id, entry.credential]);
    }
    return result;
  })();
  registry = { source: env.INSTALLATIONS, value };
  return value;
}

function forward(env: Env, installationId: string, kind: "control" | "data" | "client" | "inspect", extra: Record<string, string> = {}, upgrade = true) {
  // Fresh headers only: nothing the client sent reaches the DO as authority.
  const headers = new Headers({ "x-relay-kind": kind, ...extra });
  if (upgrade) headers.set("upgrade", "websocket");
  return env.RELAY.get(env.RELAY.idFromName(installationId)).fetch(new Request("https://relay-hub.internal/", { headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const installations = await loadRegistry(env);
    if (url.pathname === "/__test/inspect") {
      const id = url.searchParams.get("installation") ?? "";
      return installations.tags.has(id) ? forward(env, id, "inspect", {}, false) : status(404, "unknown_installation");
    }
    if (url.pathname === CONTROL_PATH || url.pathname === DATA_PATH) {
      if (!upgrading(request) || request.headers.get("sec-websocket-protocol") !== RELAY_PROTOCOL || request.headers.has("origin")) return status(401, "authentication_required");
      const token = bearer(request);
      if (!token) return status(401, "authentication_required");
      if (url.pathname === CONTROL_PATH) {
        let owner: string | undefined;
        for (const [id, credential] of installations.credentials) if (equal(credential, token)) owner = id;
        if (!owner) return status(401, "authentication_required");
        return forward(env, owner, "control", { "x-relay-route-tag": installations.tags.get(owner)! });
      }
      const stream = request.headers.get(STREAM_HEADER) ?? "";
      if (!/^[0-9a-f-]{36}$/u.test(stream)) return status(401, "authentication_required");
      const owner = installations.byTag.get(stream.replaceAll("-", "").slice(0, 16));
      // The DO checks the reservation and token; the tag only selects the object.
      return owner ? forward(env, owner, "data", { "x-relay-stream": stream, "x-relay-token": token }) : status(401, "authentication_required");
    }
    const owner = installations.byHost.get(url.host);
    if (!owner) return status(404, "unknown_installation");
    if (!relayPathAllowed(url.pathname + url.search)) return status(403, "access_denied");
    // Prototype scope: browser identity/admission and HTTP-over-stream are not ported.
    if (!upgrading(request)) return status(501, "websocket_only_prototype");
    return forward(env, owner, "client", { "x-relay-path": url.pathname });
  },
};

// ---- RelayHubDO ---------------------------------------------------------------

interface ControlAttachment { kind: "control"; generation: number; routeTag: string; }
interface Reservation { token: string; generation: number; expiresAt: number; }
interface Stream { client: WebSocket; data: WebSocket; generation: number; }

const SENDABLE = (code: number) => code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
const byteLength = (message: string | ArrayBuffer) => typeof message === "string" ? encoder.encode(message).byteLength : message.byteLength;

/**
 * Socket model: the control link uses the Hibernatable WebSockets API, so an
 * installation whose Headless is connected but idle can hibernate; generation
 * and routing tag survive in the attachment. Data streams use ordinary
 * `accept()` sockets held in memory: an open stream pins the object, so the
 * in-memory stream table, reservations and waiters never outlive the instance
 * that owns them (an eviction drops these sockets too).
 */
export class RelayHubDO extends DurableObject<Env> {
  /** In memory only: a reservation lives exactly as long as the waiting client fetch, which pins this object. */
  readonly #reservations = new Map<string, Reservation>();
  readonly #waiters = new Map<string, (response: Response) => void>();
  readonly #streams = new Map<string, Stream>();
  readonly #stats = { opens: 0, rejectedInstance: 0, openTimeouts: 0, rejectedTokens: 0, controlViolations: 0, replacedControls: 0, controlCloses: 0 };

  get #reservationMs() { return Number(this.env.RESERVATION_MS ?? RESERVATION_MS); }

  #controls(): WebSocket[] {
    return (this.ctx as unknown as { getWebSockets(tag: string): WebSocket[] }).getWebSockets("control").filter(ws => ws.readyState === WebSocket.OPEN);
  }
  #attachment(ws: WebSocket): ControlAttachment { return (ws as unknown as { deserializeAttachment(): ControlAttachment }).deserializeAttachment(); }
  /** The live control link; after hibernation its generation and tag come back from the attachment. */
  #control(): { ws: WebSocket; generation: number; routeTag: string } | undefined {
    let best: { ws: WebSocket; generation: number; routeTag: string } | undefined;
    for (const ws of this.#controls()) {
      const a = this.#attachment(ws);
      if (!best || a.generation > best.generation) best = { ws, generation: a.generation, routeTag: a.routeTag };
    }
    return best;
  }
  #close(ws: WebSocket, code: number, reason: string) { try { ws.close(code, reason); } catch { /* already closing */ } }
  #reject(id: string, code: number, error: string) {
    this.#reservations.delete(id);
    const waiter = this.#waiters.get(id); this.#waiters.delete(id);
    waiter?.(status(code, error));
  }
  #end(id: string, code: number, reason: string) {
    const stream = this.#streams.get(id);
    if (!stream) return;
    this.#streams.delete(id);
    this.#close(stream.client, code, reason); this.#close(stream.data, code, reason);
  }
  /** Closes every stream and reservation up to one control generation (Node: `retire(connection)`). */
  #retire(generation: number, code: number, reason: string) {
    for (const [id, reservation] of this.#reservations) if (reservation.generation <= generation) this.#reject(id, 503, "relay_unavailable");
    for (const [id, stream] of this.#streams) if (stream.generation <= generation) this.#end(id, code, reason);
  }
  async #schedule(expiresAt: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }

  async fetch(request: Request): Promise<Response> {
    const kind = request.headers.get("x-relay-kind");
    if (kind === "control") return this.#connectControl(request.headers.get("x-relay-route-tag") ?? "");
    if (kind === "data") return this.#acceptData(request.headers.get("x-relay-stream") ?? "", request.headers.get("x-relay-token") ?? "");
    if (kind === "client") return this.#openClient();
    if (kind === "inspect") {
      const control = this.#control();
      return Response.json({ generation: control?.generation ?? null, controls: this.#controls().length, active: this.#streams.size,
        reservations: this.#reservations.size, reservationMs: this.#reservationMs,
        reservationDeadlines: [...this.#reservations.values()].map(r => r.expiresAt - Date.now()), limit: MAX_RELAY_STREAMS, alarm: await this.ctx.storage.getAlarm(), ...this.#stats });
    }
    return status(400, "invalid_request");
  }

  async #connectControl(routeTag: string): Promise<Response> {
    if (!/^[0-9a-f]{16}$/u.test(routeTag)) return status(400, "invalid_request");
    // A durable, monotonic generation fences streams of a replaced link even across restarts.
    const generation = ((await this.ctx.storage.get<number>("generation")) ?? 0) + 1;
    await this.ctx.storage.put("generation", generation);
    const previous = this.#controls();
    this.#stats.replacedControls += previous.length;
    for (const ws of previous) this.#close(ws, 1012, "Relay control replaced");
    this.#retire(generation - 1, 1012, "Relay control replaced");
    const pair = new WebSocketPair();
    (this.ctx as unknown as { acceptWebSocket(ws: WebSocket, tags: string[]): void }).acceptWebSocket(pair[1], ["control"]);
    (pair[1] as unknown as { serializeAttachment(value: ControlAttachment): void }).serializeAttachment({ kind: "control", generation, routeTag });
    // No DRAIN_HEADER echo: detached-stream preservation is not implemented here.
    return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": RELAY_PROTOCOL } });
  }

  async #openClient(): Promise<Response> {
    const control = this.#control();
    if (!control) return status(503, "relay_unavailable");
    // Active and connecting streams share one per-installation budget (MAX_RELAY_STREAMS).
    if (this.#streams.size + this.#reservations.size >= MAX_RELAY_STREAMS) { this.#stats.rejectedInstance++; return status(503, "relay_unavailable"); }
    const tag = control.routeTag + hex(crypto.getRandomValues(new Uint8Array(8)));
    const id = `${tag.slice(0, 8)}-${tag.slice(8, 12)}-${tag.slice(12, 16)}-${tag.slice(16, 20)}-${tag.slice(20, 32)}`;
    const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = Date.now() + this.#reservationMs;
    this.#reservations.set(id, { token, generation: control.generation, expiresAt });
    const response = new Promise<Response>(resolve => this.#waiters.set(id, resolve));
    await this.#schedule(expiresAt);
    if (!this.#reservations.has(id) || control.ws.readyState !== WebSocket.OPEN) { this.#reject(id, 503, "relay_unavailable"); return response; }
    this.#stats.opens++;
    control.ws.send(JSON.stringify({ type: "open", id, token }));
    return response;
  }

  #acceptData(id: string, token: string): Response {
    const reservation = this.#reservations.get(id);
    if (!reservation || !equal(reservation.token, token)) { this.#stats.rejectedTokens++; return status(401, "authentication_required"); }
    const waiter = this.#waiters.get(id);
    this.#reservations.delete(id); this.#waiters.delete(id);
    if (!waiter || reservation.expiresAt <= Date.now() || this.#control()?.generation !== reservation.generation) {
      waiter?.(status(503, "relay_unavailable")); return status(401, "authentication_required");
    }
    const data = new WebSocketPair(), client = new WebSocketPair();
    const stream: Stream = { client: client[1], data: data[1], generation: reservation.generation };
    this.#streams.set(id, stream);
    this.#bridge(id, stream, stream.client, stream.data); this.#bridge(id, stream, stream.data, stream.client);
    waiter(new Response(null, { status: 101, webSocket: client[0] }));
    return new Response(null, { status: 101, webSocket: data[0], headers: { "sec-websocket-protocol": RELAY_PROTOCOL } });
  }

  /** Byte relay between the client and Headless data sockets, bounded like the Node data `maxPayload`. */
  #bridge(id: string, stream: Stream, from: WebSocket, to: WebSocket) {
    from.accept();
    // compatibility_date 2026-07-30 defaults binaryType to "blob" (standard behavior); relay bytes stay ArrayBuffer.
    (from as unknown as { binaryType: string }).binaryType = "arraybuffer";
    from.addEventListener("message", event => {
      const message = (event as MessageEvent).data as string | ArrayBuffer;
      if (byteLength(message) > MAX_DATA_MESSAGE) { this.#end(id, 1009, "Relay message too large"); return; }
      if (this.#streams.get(id) !== stream) return;
      try { to.send(message); } catch { this.#end(id, 1011, "Relay peer gone"); }
    });
    from.addEventListener("close", event => {
      if (this.#streams.get(id) !== stream) return;
      const { code, reason } = event as CloseEvent;
      this.#end(id, SENDABLE(code) ? code : 1011, SENDABLE(code) ? reason : "Relay peer closed abnormally");
    });
    from.addEventListener("error", () => this.#end(id, 1011, "Relay socket error"));
  }

  async webSocketMessage(ws: WebSocket): Promise<void> {
    // The control link is server → Headless only; any inbound frame is a protocol violation.
    const a = this.#attachment(ws);
    this.#stats.controlViolations++;
    this.#close(ws, 1008, "Unexpected control message");
    this.#retire(a.generation, 1008, "Relay control violation");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = this.#attachment(ws);
    this.#stats.controlCloses++;
    this.#close(ws, SENDABLE(code) ? code : 1000, reason);
    // A replaced link's streams were already retired; the current link takes its streams with it.
    if (!this.#control()) this.#retire(a.generation, 1012, "Relay control closed");
  }

  async webSocketError(ws: WebSocket): Promise<void> { await this.webSocketClose(ws, 1011, "Relay socket error"); }

  async alarm(): Promise<void> {
    const now = Date.now();
    let next = Infinity;
    for (const [id, reservation] of this.#reservations) {
      if (reservation.expiresAt <= now) { this.#stats.openTimeouts++; this.#reject(id, 503, "relay_unavailable"); }
      else next = Math.min(next, reservation.expiresAt);
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }
}
