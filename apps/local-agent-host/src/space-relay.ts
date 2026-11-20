import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { ServerSpacesRuntime } from "@opencraft/access-control/server-spaces";
import type { ServerSpaceDirectory, ServerSpaceMember } from "@opencraft/appserver-protocol/server-spaces";
import type { ActorContext } from "@opencraft/identity-core/actors";
import { CONTROL_PATH, RELAY_PROTOCOL } from "@opencraft/relay-protocol";

export const RELAY_SPACE_INVITE_PREFIX = "ocinv1_";
const ENROLL_PATH = "/__opencraft_machines/enroll";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function safeEqualHex(leftHex: string, rightHex: string): boolean {
  if (leftHex.length !== rightHex.length || leftHex.length % 2 !== 0) return false;
  return timingSafeEqual(Buffer.from(leftHex, "hex"), Buffer.from(rightHex, "hex"));
}
function bearerToken(req: IncomingMessage): string {
  return /^Bearer ([A-Za-z0-9_-]{32,64})$/u.exec(req.headers.authorization ?? "")?.[1] ?? "";
}
async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
function sendHttpJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}
async function readBoundedJson(req: IncomingMessage, maxBytes = 8192): Promise<Record<string, unknown>> {
  let text = "";
  let total = 0;
  for await (const chunk of req) {
    total += Buffer.byteLength(chunk);
    if (total > maxBytes) throw new Error("Request body too large");
    text += String(chunk);
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON body");
  return parsed as Record<string, unknown>;
}

export interface DecodedRelaySpaceInvite {
  readonly origin: string;
  readonly code: string;
  readonly ca?: string;
}

export function isRelaySpaceInvite(code: unknown): code is string {
  return typeof code === "string" && code.trim().startsWith(RELAY_SPACE_INVITE_PREFIX);
}

export function encodeRelaySpaceInvite(input: DecodedRelaySpaceInvite): string {
  const payload: Record<string, unknown> = { v: 1, o: input.origin, c: input.code };
  if (input.ca) payload.ca = input.ca;
  return RELAY_SPACE_INVITE_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeRelaySpaceInvite(raw: string, options: { allowLoopbackInsecure?: boolean } = {}): DecodedRelaySpaceInvite {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(RELAY_SPACE_INVITE_PREFIX) || trimmed.length > 98304) {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(RELAY_SPACE_INVITE_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  if (!parsed || parsed.v !== 1 || typeof parsed.o !== "string" || typeof parsed.c !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(parsed.c)) {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  let url: URL;
  try { url = new URL(parsed.o); } catch {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const isLoopbackHttp = options.allowLoopbackInsecure === true && url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost");
  const isPublicHttps = url.protocol === "https:" && host !== "localhost" && !host.endsWith(".localhost")
    && host !== "0.0.0.0" && host !== "[::]" && host !== "[::1]" && !/^127\./u.test(host);
  if (url.origin !== parsed.o || url.username || url.password || (!isPublicHttps && !isLoopbackHttp)) {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  if (parsed.ca !== undefined && (typeof parsed.ca !== "string" || parsed.ca.length > 65536 || !parsed.ca.includes("-----BEGIN CERTIFICATE-----"))) {
    throw Object.assign(new Error("Invalid invitation"), { rpcCode: -32004, reason: "invitation" });
  }
  return { origin: url.origin, code: parsed.c, ...(typeof parsed.ca === "string" ? { ca: parsed.ca } : {}) };
}

interface StoredGuestRecord {
  id: string;
  subject: string;
  actorId: string;
  displayName: string;
  spaceId: string;
  credentialHash: string;
  createdAt: number;
}

export interface AttachedGuestSession {
  readonly guestId: string;
  readonly actorContext: ActorContext;
  readonly spaceId: string;
}

/** Inviter-side Relay admission & revocable guest sessions for Server Spaces. */
export class HostedSpaceRelay {
  private readonly filePath: string;
  private readonly wsServer = new WebSocketServer({ noServer: true, maxPayload: 1_048_576, perMessageDeflate: false });
  private readonly liveSockets = new Map<string, WebSocket>();
  private readonly actorContexts = new Map<string, ActorContext>();
  private guests: StoredGuestRecord[] = [];
  private closed = false;
  private unsubscribeSpaces?: () => void;
  private writeChain = Promise.resolve();

  constructor(
    private readonly collaborationDir: string,
    private readonly spaces: ServerSpacesRuntime,
  ) {
    this.filePath = join(collaborationDir, "space-relay-guests.json");
  }

  async ready(): Promise<void> {
    await mkdir(this.collaborationDir, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as { schemaVersion?: number; guests?: StoredGuestRecord[] };
      if (raw?.schemaVersion === 1 && Array.isArray(raw.guests)) {
        this.guests = raw.guests.filter(g => typeof g.id === "string" && typeof g.subject === "string" && typeof g.actorId === "string" && typeof g.spaceId === "string" && typeof g.credentialHash === "string");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const guest of [...this.guests]) {
      if (!this.spaces.hasMember(guest.actorId, guest.spaceId)) {
        this.guests = this.guests.filter(item => item.id !== guest.id);
        continue;
      }
      try {
        const ctx = await this.spaces.resolveGuestActor({ subject: guest.subject, displayName: guest.displayName });
        this.actorContexts.set(guest.id, ctx);
      } catch {
        this.guests = this.guests.filter(item => item.id !== guest.id);
      }
    }
    this.unsubscribeSpaces = this.spaces.subscribe(() => {
      void this.reconcileRevocations();
    });
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.guests);
    this.writeChain = this.writeChain.catch(() => {}).then(() => writePrivateJsonAtomic(this.filePath, { schemaVersion: 1, guests: snapshot }));
    return this.writeChain;
  }

  private async reconcileRevocations(): Promise<void> {
    let changed = false;
    for (const guest of [...this.guests]) {
      if (!this.spaces.hasMember(guest.actorId, guest.spaceId)) {
        this.guests = this.guests.filter(item => item.id !== guest.id);
        this.actorContexts.delete(guest.id);
        const ws = this.liveSockets.get(guest.id);
        if (ws) {
          this.liveSockets.delete(guest.id);
          ws.close(1008, "Space membership revoked");
        }
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  async tryHandleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "POST" || url.pathname !== ENROLL_PATH || url.searchParams.get("kind") !== "space-invite") return false;
    if (this.closed) { sendHttpJson(res, 503, { error: "unavailable" }); return true; }
    try {
      const body = await readBoundedJson(req);
      if (body.kind !== "space-invite" || typeof body.code !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.code)) {
        sendHttpJson(res, 403, { error: "invitation_invalid" });
        return true;
      }
      const displayName = typeof body.displayName === "string" && body.displayName.trim()
        ? body.displayName.trim().slice(0, 80).replace(/[\x00-\x1f\x7f]/gu, "")
        : "Invited member";
      const guestId = randomUUID();
      const subject = randomUUID();
      const redeemed = await this.spaces.redeemGuestInvite({ code: body.code, subject, displayName: displayName || "Invited member" });
      const credential = randomBytes(32).toString("base64url");
      const record: StoredGuestRecord = {
        id: guestId,
        subject,
        actorId: redeemed.actorContext.actorId,
        displayName: displayName || "Invited member",
        spaceId: redeemed.spaceId,
        credentialHash: sha256(credential),
        createdAt: Date.now(),
      };
      this.guests.push(record);
      this.actorContexts.set(guestId, redeemed.actorContext);
      await this.persist();
      sendHttpJson(res, 200, {
        id: guestId,
        spaceId: redeemed.spaceId,
        spaceName: redeemed.spaceName,
        credential,
      });
    } catch {
      sendHttpJson(res, 403, { error: "invitation_unavailable" });
    }
    return true;
  }

  tryHandleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    onAttach: (ws: WebSocket, session: AttachedGuestSession) => void,
  ): boolean {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== CONTROL_PATH) return false;
    const token = bearerToken(req);
    if (!token) return false;
    const tokenDigest = sha256(token);
    const guest = this.guests.find(item => safeEqualHex(item.credentialHash, tokenDigest));
    if (!guest) return false;
    const reject = () => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    if (this.closed || req.headers.origin || req.headers["sec-websocket-protocol"] !== RELAY_PROTOCOL) {
      reject();
      return true;
    }
    const actorContext = this.actorContexts.get(guest.id);
    if (!actorContext || !this.spaces.hasMember(guest.actorId, guest.spaceId)) {
      reject();
      return true;
    }
    this.wsServer.handleUpgrade(req, socket, head, ws => {
      const previous = this.liveSockets.get(guest.id);
      if (previous) previous.terminate();
      this.liveSockets.set(guest.id, ws);
      let lastPong = Date.now();
      ws.on("pong", () => { lastPong = Date.now(); });
      ws.on("error", () => {});
      const heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPong > 45_000) ws.terminate();
        else ws.ping();
      }, 15_000);
      heartbeat.unref();
      ws.once("close", () => {
        clearInterval(heartbeat);
        if (this.liveSockets.get(guest.id) === ws) this.liveSockets.delete(guest.id);
      });
      onAttach(ws, { guestId: guest.id, actorContext, spaceId: guest.spaceId });
    });
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeSpaces?.();
    for (const ws of this.liveSockets.values()) ws.close(1001, "Host shutting down");
    this.liveSockets.clear();
    this.wsServer.close();
    await this.writeChain;
  }
}

interface JoinedSpaceEntry {
  id: string;
  remoteSpaceId: string;
  name: string;
  origin: string;
  credential: string;
  ca?: string;
  joinedAt: number;
}

interface LiveJoinedConnection {
  entry: JoinedSpaceEntry;
  ws?: WebSocket;
  ready: boolean;
  readyWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  pendingRpc: Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  attempts: number;
  stopped: boolean;
  memberCount: number;
  remoteThreadIds: Set<string>;
}

export function isRemoteJoinedSpaceId(spaceId: unknown): spaceId is string {
  return typeof spaceId === "string" && /^rspace:[a-f0-9]{12}$/u.test(spaceId);
}

export function parseRemoteSpaceThreadId(threadId: unknown): { entryId: string; remoteThreadId: string } | null {
  if (typeof threadId !== "string") return null;
  const match = /^rspace_([a-f0-9]{12})_(.+)$/u.exec(threadId);
  if (!match || !match[2]) return null;
  return { entryId: match[1]!, remoteThreadId: match[2]! };
}

function prefixThreadId(entryId: string, remoteId: string): string {
  return remoteId.startsWith(`rspace_${entryId}_`) ? remoteId : `rspace_${entryId}_${remoteId}`;
}

function rewriteInboundPayload(entryId: string, value: any): any {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => rewriteInboundPayload(entryId, item));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "threadId" && typeof v === "string" && v) {
      out[k] = prefixThreadId(entryId, v);
    } else if (k === "thread" && v && typeof v === "object" && !Array.isArray(v) && typeof (v as any).id === "string") {
      out[k] = { ...rewriteInboundPayload(entryId, v), id: prefixThreadId(entryId, (v as any).id) };
    } else if (k === "data" && Array.isArray(v)) {
      out[k] = v.map(row => row && typeof row === "object" && typeof row.id === "string" && ("createdAt" in row || "preview" in row || "cwd" in row)
        ? { ...rewriteInboundPayload(entryId, row), id: prefixThreadId(entryId, row.id) }
        : rewriteInboundPayload(entryId, row));
    } else {
      out[k] = rewriteInboundPayload(entryId, v);
    }
  }
  return out;
}

function rewriteOutboundParams(entryId: string, params: any): any {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const copy: Record<string, any> = { ...params };
  if (typeof copy.threadId === "string") {
    const parsed = parseRemoteSpaceThreadId(copy.threadId);
    if (parsed && parsed.entryId === entryId) copy.threadId = parsed.remoteThreadId;
  }
  return copy;
}

async function postJsonHttpsOrLoopback(
  targetUrl: string,
  payload: unknown,
  ca?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(targetUrl);
  const serialized = Buffer.from(JSON.stringify(payload), "utf8");
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requester(
      url,
      {
        method: "POST",
        ...(ca ? { ca } : {}),
        timeout: 15_000,
        headers: {
          "content-type": "application/json",
          "content-length": String(serialized.byteLength),
        },
      },
      res => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", chunk => {
          raw += chunk;
          if (raw.length > 32_768) req.destroy(new Error("Response too large"));
        });
        res.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 502, body: parsed && typeof parsed === "object" ? parsed : {} });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Enrollment request timeout")));
    req.on("error", reject);
    req.end(serialized);
  });
}

/** Invitee-side Relay client managing joined remote Server Spaces. */
export class JoinedSpaceRelay {
  private readonly filePath: string;
  private entries: JoinedSpaceEntry[] = [];
  private readonly connections = new Map<string, LiveJoinedConnection>();
  private closed = false;
  private writeChain = Promise.resolve();

  constructor(
    private readonly collaborationDir: string,
    private readonly onNotification: (method: string, params: Record<string, unknown>) => void,
    private readonly onSpacesChanged: () => void,
    private readonly options: { allowLoopbackInsecure?: boolean; localDisplayName?: string } = {},
  ) {
    this.filePath = join(collaborationDir, "joined-remote-spaces.json");
  }

  async ready(): Promise<void> {
    await mkdir(this.collaborationDir, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(this.filePath, "utf8")) as { schemaVersion?: number; spaces?: JoinedSpaceEntry[] };
      if (raw?.schemaVersion === 1 && Array.isArray(raw.spaces)) {
        this.entries = raw.spaces.filter(s => /^[a-f0-9]{12}$/u.test(s.id) && typeof s.remoteSpaceId === "string" && typeof s.name === "string" && typeof s.origin === "string" && typeof s.credential === "string");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const entry of this.entries) {
      this.startConnection(entry);
    }
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.entries);
    this.writeChain = this.writeChain.catch(() => {}).then(() => writePrivateJsonAtomic(this.filePath, { schemaVersion: 1, spaces: snapshot }));
    return this.writeChain;
  }

  private startConnection(entry: JoinedSpaceEntry): LiveJoinedConnection {
    const existing = this.connections.get(entry.id);
    if (existing) return existing;
    const conn: LiveJoinedConnection = {
      entry,
      ready: false,
      readyWaiters: [],
      pendingRpc: new Map(),
      nextId: 1,
      attempts: 0,
      stopped: false,
      memberCount: 2,
      remoteThreadIds: new Set(),
    };
    this.connections.set(entry.id, conn);

    const connect = () => {
      if (this.closed || conn.stopped) return;
      const wsUrl = entry.origin.replace(/^http/u, "ws") + CONTROL_PATH;
      const ws = new WebSocket(wsUrl, RELAY_PROTOCOL, {
        ...(entry.ca ? { ca: entry.ca } : {}),
        headers: { authorization: `Bearer ${entry.credential}` },
        perMessageDeflate: false,
        maxPayload: 8 * 1024 * 1024,
        handshakeTimeout: 10_000,
      });
      conn.ws = ws;
      let lastPong = Date.now();
      ws.on("pong", () => { lastPong = Date.now(); });
      ws.on("error", () => {});
      ws.on("open", () => {
        if (conn.ws !== ws || conn.stopped) { ws.terminate(); return; }
        conn.attempts = 0;
        lastPong = Date.now();
        this.sendRawRpc(conn, "initialize", {
          clientInfo: { name: "opencraft-space-relay", version: "1.0.1" },
          capabilities: { extensions: { "opencraft/shared-interactions": { version: 1 }, "opencraft/server-spaces": { version: 1 } } },
        }).then(async () => {
          if (conn.ws !== ws || conn.stopped) return;
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
          conn.ready = true;
          for (const waiter of conn.readyWaiters.splice(0)) waiter.resolve();
          await this.refreshRemoteProjection(conn).catch(() => {});
        }).catch(err => {
          for (const waiter of conn.readyWaiters.splice(0)) waiter.reject(err instanceof Error ? err : new Error(String(err)));
          ws.terminate();
        });
      });

      ws.on("message", raw => {
        if (conn.ws !== ws) return;
        let msg: Record<string, any>;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (typeof msg.id === "number") {
          const pending = conn.pendingRpc.get(msg.id);
          if (!pending) return;
          conn.pendingRpc.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(Object.assign(new Error(msg.error.message ?? "Remote space error"), { rpcCode: msg.error.code ?? -32004 }));
          } else {
            pending.resolve(msg.result);
          }
          return;
        }
        if (typeof msg.method === "string") {
          if (msg.method === "opencraft/server-spaces/changed") {
            void this.refreshRemoteProjection(conn).catch(() => {});
            this.onSpacesChanged();
            return;
          }
          const rewritten = rewriteInboundPayload(entry.id, msg.params ?? {});
          if (typeof rewritten?.thread?.id === "string") {
            const parsed = parseRemoteSpaceThreadId(rewritten.thread.id);
            if (parsed) conn.remoteThreadIds.add(parsed.remoteThreadId);
          }
          this.onNotification(msg.method, rewritten);
        }
      });

      ws.once("close", code => {
        if (conn.ws === ws) conn.ws = undefined;
        conn.ready = false;
        for (const [, pending] of conn.pendingRpc) {
          clearTimeout(pending.timer);
          pending.reject(new Error("Remote space connection closed"));
        }
        conn.pendingRpc.clear();
        if (code === 1008) {
          for (const waiter of conn.readyWaiters.splice(0)) waiter.reject(new Error("Access revoked"));
        }
        if (!this.closed && !conn.stopped) {
          conn.attempts += 1;
          const delayMs = Math.min(30_000, 300 * 2 ** Math.min(conn.attempts, 6)) + Math.floor(Math.random() * 200);
          conn.reconnectTimer = setTimeout(connect, delayMs);
          conn.reconnectTimer.unref();
        }
      });
    };

    conn.heartbeat = setInterval(() => {
      if (conn.ws?.readyState === WebSocket.OPEN) conn.ws.ping();
    }, 15_000);
    conn.heartbeat.unref();
    connect();
    return conn;
  }

  private sendRawRpc(conn: LiveJoinedConnection, method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(Object.assign(new Error("Remote Server is currently offline"), { rpcCode: -32004 }));
    }
    const id = conn.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingRpc.delete(id);
        reject(Object.assign(new Error("Remote Server request timed out"), { rpcCode: -32004 }));
      }, timeoutMs);
      timer.unref();
      conn.pendingRpc.set(id, { resolve, reject, timer });
      conn.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private async ensureReady(conn: LiveJoinedConnection, timeoutMs = 8000): Promise<void> {
    if (conn.ready && conn.ws?.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("Remote Server is offline"), { rpcCode: -32004 })), timeoutMs);
      timer.unref();
      conn.readyWaiters.push({
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: err => { clearTimeout(timer); reject(err); },
      });
    });
  }

  private async refreshRemoteProjection(conn: LiveJoinedConnection): Promise<void> {
    const dir = await this.sendRawRpc(conn, "opencraft/server-spaces", { action: "list" }) as ServerSpaceDirectory;
    const remoteSpace = dir?.spaces?.find(s => s.id === conn.entry.remoteSpaceId) ?? dir?.spaces?.[0];
    if (remoteSpace) {
      conn.memberCount = remoteSpace.memberCount;
      if (remoteSpace.name && remoteSpace.name !== conn.entry.name) {
        conn.entry.name = remoteSpace.name;
        await this.persist();
      }
    }
    const nextIds = new Set<string>();
    for (const a of dir?.assignments ?? []) {
      if (a.spaceId === conn.entry.remoteSpaceId) nextIds.add(a.threadId);
    }
    const listed = await this.sendRawRpc(conn, "thread/list", { limit: 100 }).catch(() => ({ data: [] }));
    if (Array.isArray(listed?.data)) {
      for (const row of listed.data) if (typeof row?.id === "string") nextIds.add(row.id);
    }
    conn.remoteThreadIds = nextIds;
    this.onSpacesChanged();
  }

  async join(rawInvite: string, fallbackDisplayName?: string): Promise<{ spaceId: string }> {
    const decoded = decodeRelaySpaceInvite(rawInvite, { allowLoopbackInsecure: this.options.allowLoopbackInsecure });
    const displayName = (fallbackDisplayName || this.options.localDisplayName || hostname() || "Member").trim().slice(0, 80);
    const enrollUrl = `${decoded.origin}${ENROLL_PATH}?kind=space-invite`;
    const response = await postJsonHttpsOrLoopback(enrollUrl, {
      kind: "space-invite",
      code: decoded.code,
      displayName,
    }, decoded.ca);
    if (response.status !== 200 || typeof response.body.credential !== "string" || typeof response.body.spaceId !== "string") {
      throw Object.assign(new Error("Server action unavailable"), { rpcCode: -32004, reason: "invitation" });
    }
    const existing = this.entries.find(e => e.origin === decoded.origin && e.remoteSpaceId === response.body.spaceId);
    if (existing) {
      const oldConn = this.connections.get(existing.id);
      if (oldConn) {
        oldConn.stopped = true;
        clearTimeout(oldConn.reconnectTimer);
        clearInterval(oldConn.heartbeat);
        oldConn.ws?.terminate();
        this.connections.delete(existing.id);
      }
      existing.credential = response.body.credential;
      existing.name = typeof response.body.spaceName === "string" && response.body.spaceName.trim() ? response.body.spaceName.trim() : existing.name;
      if (decoded.ca) existing.ca = decoded.ca;
      await this.persist();
      const conn = this.startConnection(existing);
      await this.ensureReady(conn, 10_000).catch(() => {});
      return { spaceId: `rspace:${existing.id}` };
    }
    const shortId = randomBytes(6).toString("hex");
    const entry: JoinedSpaceEntry = {
      id: shortId,
      remoteSpaceId: String(response.body.spaceId),
      name: typeof response.body.spaceName === "string" && response.body.spaceName.trim() ? response.body.spaceName.trim() : "Shared Server",
      origin: decoded.origin,
      credential: String(response.body.credential),
      ...(decoded.ca ? { ca: decoded.ca } : {}),
      joinedAt: Date.now(),
    };
    this.entries.push(entry);
    await this.persist();
    const conn = this.startConnection(entry);
    await this.ensureReady(conn, 10_000).catch(() => {});
    this.onSpacesChanged();
    return { spaceId: `rspace:${entry.id}` };
  }

  mergeDirectory(base: ServerSpaceDirectory): ServerSpaceDirectory {
    if (this.entries.length === 0) return base;
    const extraSpaces = this.entries.map(entry => {
      const conn = this.connections.get(entry.id);
      return {
        id: `rspace:${entry.id}`,
        name: entry.name,
        role: "member" as const,
        memberCount: conn?.memberCount ?? 2,
      };
    });
    const extraAssignments = this.entries.flatMap(entry => {
      const conn = this.connections.get(entry.id);
      return [...(conn?.remoteThreadIds ?? [])].map(remoteThreadId => ({
        engineServerId: "local",
        threadId: prefixThreadId(entry.id, remoteThreadId),
        spaceId: `rspace:${entry.id}`,
      }));
    });
    return {
      ...base,
      spaces: [...base.spaces, ...extraSpaces],
      assignments: [...base.assignments, ...extraAssignments],
    };
  }

  hasSpace(spaceId: string): boolean {
    if (!isRemoteJoinedSpaceId(spaceId)) return false;
    const id = spaceId.slice("rspace:".length);
    return this.entries.some(e => e.id === id);
  }

  async members(spaceId: string): Promise<{ members: ServerSpaceMember[] }> {
    const id = spaceId.slice("rspace:".length);
    const conn = this.connections.get(id);
    if (!conn) throw Object.assign(new Error("Server action unavailable"), { rpcCode: -32004 });
    await this.ensureReady(conn);
    return await this.sendRawRpc(conn, "opencraft/server-spaces", { action: "members", spaceId: conn.entry.remoteSpaceId });
  }

  async forwardSpaceRequest(spaceId: string, method: string, params: unknown): Promise<any> {
    const id = spaceId.slice("rspace:".length);
    const conn = this.connections.get(id);
    if (!conn) throw Object.assign(new Error("Remote Server unavailable"), { rpcCode: -32004 });
    await this.ensureReady(conn);
    const rawResult = await this.sendRawRpc(conn, method, rewriteOutboundParams(id, params), 120_000);
    const rewritten = rewriteInboundPayload(id, rawResult);
    if (typeof rewritten?.thread?.id === "string") {
      const parsed = parseRemoteSpaceThreadId(rewritten.thread.id);
      if (parsed) {
        conn.remoteThreadIds.add(parsed.remoteThreadId);
        this.onSpacesChanged();
      }
    }
    return rewritten;
  }

  async forwardThreadRequest(localThreadId: string, method: string, params: unknown): Promise<any> {
    const parsed = parseRemoteSpaceThreadId(localThreadId);
    if (!parsed) throw Object.assign(new Error("Invalid remote thread"), { rpcCode: -32602 });
    return this.forwardSpaceRequest(`rspace:${parsed.entryId}`, method, params);
  }

  async listAllRemoteThreads(): Promise<unknown[]> {
    const groups = await Promise.all(this.entries.map(async entry => {
      const conn = this.connections.get(entry.id);
      if (!conn || !conn.ready || conn.ws?.readyState !== WebSocket.OPEN) return [];
      try {
        const res = await this.sendRawRpc(conn, "thread/list", { limit: 50 }, 8000);
        const rows = Array.isArray(res?.data) ? res.data : [];
        for (const row of rows) if (typeof row?.id === "string") conn.remoteThreadIds.add(row.id);
        return (rewriteInboundPayload(entry.id, { data: rows }) as { data: unknown[] }).data;
      } catch {
        return [];
      }
    }));
    return groups.flat();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const conn of this.connections.values()) {
      conn.stopped = true;
      clearTimeout(conn.reconnectTimer);
      clearInterval(conn.heartbeat);
      for (const [, p] of conn.pendingRpc) clearTimeout(p.timer);
      conn.pendingRpc.clear();
      conn.ws?.close(1001, "Client closing");
    }
    this.connections.clear();
    await this.writeChain;
  }
}
