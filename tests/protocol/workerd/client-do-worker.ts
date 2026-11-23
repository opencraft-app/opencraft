// Client DO prototype (docs/architecture/platform/gateway-split.md §3.1, "Client DO 原型结果").
//
// Three parts, bundled with esbuild and driven through Miniflare by
// tests/protocol/client-do-workerd.test.ts. Test-only: no deployment assembly.
//
// - Edge Worker (default export): verifies a test client token (HMAC) and
//   forwards the `/apphost` WebSocket upgrade to the ClientDO named by the
//   authenticated client-instance id. Identity reaches the DO only through
//   headers the edge sets after verification; incoming copies are discarded.
// - ClientDO: one per authenticated client instance, not per socket. Accepts
//   sockets with the Hibernatable WebSockets API and keeps everything that must
//   survive hibernation or eviction in DO storage: the access session, the
//   subscription set and, per Thread, the acknowledged and delivered cursors.
//   It keeps no copy of event payloads; replay reads the WorkspaceHost log.
// - WorkspaceHostDO (fake, one per workspace): owns an append-only event log
//   per Thread with monotonically increasing sequence numbers and the set of
//   subscribed client instances, and fans each appended event out to them by RPC.
import { DurableObject } from "cloudflare:workers";
import { isAcknowledgement, RESUME_PROTOCOL_VERSION } from "@opencraft/app-host-resume";

interface Namespace<T> {
  idFromName(name: string): unknown;
  get(id: unknown): T;
}
interface Env {
  readonly CLIENT: Namespace<ClientDO & { fetch(request: Request): Promise<Response> }>;
  readonly WORKSPACE: Namespace<WorkspaceHostDO>;
  /** Test signing key for client tokens (a real edge verifies the IC-issued access session). */
  readonly TOKEN_SECRET: string;
  /** How long a client instance survives without any attached socket. */
  readonly DETACH_MS?: number;
}

// ---- wire vocabulary ---------------------------------------------------------

export type ThreadKey = `${string}/${string}`;
const threadKey = (workspaceId: string, threadId: string): ThreadKey => `${workspaceId}/${threadId}`;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export interface ThreadEvent {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly seq: number;
  readonly event: unknown;
}

/** Client → ClientDO frames. Parsed strictly: the socket is untrusted. */
type ClientFrame =
  | { type: "client/hello"; v: typeof RESUME_PROTOCOL_VERSION; cursors: Record<string, number> }
  | { type: "thread/subscribe"; workspaceId: string; threadId: string; after: number }
  | { type: "thread/unsubscribe"; workspaceId: string; threadId: string }
  | { type: "event/ack"; workspaceId: string; threadId: string; seq: number }
  | { type: "client/logout" };

function parseClientFrame(text: string): ClientFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const thread =
    typeof record.workspaceId === "string" &&
    ID.test(record.workspaceId) &&
    typeof record.threadId === "string" &&
    ID.test(record.threadId);
  switch (record.type) {
    case "client/hello": {
      if (
        record.v !== RESUME_PROTOCOL_VERSION ||
        !record.cursors ||
        typeof record.cursors !== "object" ||
        Array.isArray(record.cursors)
      )
        return null;
      const cursors = record.cursors as Record<string, unknown>;
      for (const [key, seq] of Object.entries(cursors)) {
        const [workspaceId, threadId, extra] = key.split("/");
        if (
          extra !== undefined ||
          !workspaceId ||
          !threadId ||
          !ID.test(workspaceId) ||
          !ID.test(threadId) ||
          !isAcknowledgement(seq)
        )
          return null;
      }
      return { type: "client/hello", v: RESUME_PROTOCOL_VERSION, cursors: cursors as Record<string, number> };
    }
    case "thread/subscribe": {
      const after = record.after ?? 0;
      return thread && isAcknowledgement(after)
        ? {
            type: "thread/subscribe",
            workspaceId: record.workspaceId as string,
            threadId: record.threadId as string,
            after,
          }
        : null;
    }
    case "thread/unsubscribe":
      return thread
        ? { type: "thread/unsubscribe", workspaceId: record.workspaceId as string, threadId: record.threadId as string }
        : null;
    case "event/ack":
      return thread && isAcknowledgement(record.seq)
        ? {
            type: "event/ack",
            workspaceId: record.workspaceId as string,
            threadId: record.threadId as string,
            seq: record.seq,
          }
        : null;
    case "client/logout":
      return { type: "client/logout" };
    default:
      return null;
  }
}

// ---- test token (stands in for the IC access session) -------------------------

interface AccessSession {
  readonly clientInstanceId: string;
  readonly actorId: string;
  readonly expiresAt: number;
}

const encoder = new TextEncoder();
const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}
async function verifyToken(secret: string, token: string, now: number): Promise<AccessSession | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [clientInstanceId, actorId, expires, signature] = parts as [string, string, string, string];
  if (!ID.test(clientInstanceId) || !ID.test(actorId) || !/^\d{1,15}$/u.test(expires)) return null;
  const expected = await hmac(secret, `${clientInstanceId}.${actorId}.${expires}`);
  if (expected.length !== signature.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  const expiresAt = Number(expires);
  return difference === 0 && expiresAt > now ? { clientInstanceId, actorId, expiresAt } : null;
}

// ---- edge Worker ---------------------------------------------------------------

const IDENTITY_HEADERS = ["x-oc-client", "x-oc-actor", "x-oc-expires"] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__test/token") {
      // Test-only issuer; a deployment receives sessions from InstallationCore.
      const { clientInstanceId, actorId, expiresAt } = (await request.json()) as AccessSession;
      return new Response(
        `${clientInstanceId}.${actorId}.${expiresAt}.${await hmac(env.TOKEN_SECRET, `${clientInstanceId}.${actorId}.${expiresAt}`)}`,
      );
    }
    if (url.pathname === "/__test/workspace") {
      // Test-only driver for the fake WorkspaceHost (a real WH appends from execution).
      const { workspaceId, method, args } = (await request.json()) as {
        workspaceId: string;
        method: "append" | "stats" | "subscribers";
        args: unknown[];
      };
      const host = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;
      return Response.json(await host[method]!(...args));
    }
    if (url.pathname === "/__test/client") {
      const { clientInstanceId, method } = (await request.json()) as {
        clientInstanceId: string;
        method: "inspect" | "abort";
      };
      const client = env.CLIENT.get(env.CLIENT.idFromName(clientInstanceId));
      if (method === "abort") {
        await client.abortForTest().catch(() => undefined);
        return Response.json({ ok: true });
      }
      return Response.json(await client.inspect());
    }
    if (url.pathname !== "/apphost") return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    const bearer = request.headers.get("Authorization")?.match(/^Bearer (.+)$/u)?.[1];
    const session = bearer ? await verifyToken(env.TOKEN_SECRET, bearer, Date.now()) : null;
    if (!session) return new Response("Unauthorized", { status: 401 });
    const headers = new Headers(request.headers);
    headers.delete("Authorization");
    for (const name of IDENTITY_HEADERS) headers.delete(name);
    headers.set("x-oc-client", session.clientInstanceId);
    headers.set("x-oc-actor", session.actorId);
    headers.set("x-oc-expires", String(session.expiresAt));
    const client = env.CLIENT.get(env.CLIENT.idFromName(session.clientInstanceId));
    return client.fetch(new Request(request.url, { headers }));
  },
};

// ---- ClientDO ------------------------------------------------------------------

/** Per Thread: acked ≤ delivered ≤ WorkspaceHost head. Payloads stay in the WorkspaceHost log. */
interface Subscription {
  readonly workspaceId: string;
  readonly threadId: string;
  acked: number;
  delivered: number;
}
interface Attachment {
  readonly generation: number;
  ready: boolean;
}
type DeliverOutcome = "forwarded" | "detached" | "duplicate" | "unsubscribed";

const SESSION = "session";
const GENERATION = "generation";
const DISCONNECTED_AT = "disconnectedAt";
const SUBSCRIPTION = "sub:";
const DEFAULT_DETACH_MS = 5 * 60_000;
const CLOSE_SUPERSEDED = 4000;
const CLOSE_RECLAIMED = 4001;

export class ClientDO extends DurableObject<Env> {
  /** In-flight serialization only; nothing here must survive hibernation. */
  #queue: Promise<unknown> = Promise.resolve();
  #counters = { deliverCalls: 0, pullCalls: 0, forwarded: 0 };

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task, task);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #workspace(workspaceId: string): WorkspaceHostDO {
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
  }

  async #session(): Promise<(AccessSession & { generation: number }) | null> {
    const session = await this.ctx.storage.get<AccessSession>(SESSION);
    if (!session) return null;
    return { ...session, generation: (await this.ctx.storage.get<number>(GENERATION)) ?? 0 };
  }

  async #subscriptions(): Promise<Map<string, Subscription>> {
    return (await this.ctx.storage.list<Subscription>({ prefix: SUBSCRIPTION })) as Map<string, Subscription>;
  }

  #openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  #readySockets(): WebSocket[] {
    return this.#openSockets().filter((socket) => (socket.deserializeAttachment() as Attachment | null)?.ready);
  }

  #send(socket: WebSocket, frame: unknown) {
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* closing; the cursor is unchanged so resume replays it */
    }
  }

  async #schedule(session: AccessSession) {
    const detachMs = Number(this.env.DETACH_MS ?? DEFAULT_DETACH_MS);
    const disconnectedAt = await this.ctx.storage.get<number>(DISCONNECTED_AT);
    const idleDeadline =
      this.#openSockets().length || disconnectedAt === undefined ? Infinity : disconnectedAt + detachMs;
    await this.ctx.storage.setAlarm(Math.min(session.expiresAt, idleDeadline));
  }

  override async fetch(request: Request): Promise<Response> {
    const clientInstanceId = request.headers.get("x-oc-client");
    const actorId = request.headers.get("x-oc-actor");
    const expiresAt = Number(request.headers.get("x-oc-expires"));
    if (!clientInstanceId || !actorId || !Number.isSafeInteger(expiresAt))
      return new Response("Forbidden", { status: 403 });
    return this.#serial(async () => {
      const stored = await this.ctx.storage.get<AccessSession>(SESSION);
      // The DO name is the client instance; a session for another actor never reuses its state.
      if (stored && (stored.clientInstanceId !== clientInstanceId || stored.actorId !== actorId))
        return new Response("Forbidden", { status: 403 });
      const session: AccessSession = {
        clientInstanceId,
        actorId,
        expiresAt: Math.max(expiresAt, stored?.expiresAt ?? 0),
      };
      const generation = ((await this.ctx.storage.get<number>(GENERATION)) ?? 0) + 1;
      // A new attachment supersedes older sockets of the same client instance.
      for (const socket of this.ctx.getWebSockets()) socket.close(CLOSE_SUPERSEDED, "superseded");
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ generation, ready: false } satisfies Attachment);
      await this.ctx.storage.put({ [SESSION]: session, [GENERATION]: generation });
      await this.ctx.storage.delete(DISCONNECTED_AT);
      await this.#schedule(session);
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const frame = typeof message === "string" ? parseClientFrame(message) : null;
    if (!frame) {
      this.#send(socket, { type: "error", reason: "invalid-frame" });
      return;
    }
    await this.#serial(async () => {
      const attachment = socket.deserializeAttachment() as Attachment;
      const session = await this.#session();
      if (!session || attachment.generation !== session.generation) {
        socket.close(CLOSE_SUPERSEDED, "superseded");
        return;
      }
      switch (frame.type) {
        case "client/hello":
          return this.#resume(socket, attachment, frame.cursors);
        case "thread/subscribe":
          return this.#subscribe(socket, frame.workspaceId, frame.threadId, frame.after);
        case "thread/unsubscribe":
          return this.#unsubscribe(socket, frame.workspaceId, frame.threadId);
        case "event/ack":
          return this.#acknowledge(socket, frame.workspaceId, frame.threadId, frame.seq);
        case "client/logout":
          return this.#reclaim("logout");
      }
    });
  }

  /**
   * Resume: the client states the last sequence it acknowledged per Thread.
   * A cursor is accepted only inside acked ≤ cursor ≤ delivered for a stored
   * subscription: lower is stale (an older copy of the client), higher was never
   * sent (forged). Missing events are read from the WorkspaceHost log, not from
   * a copy here, then the socket goes live.
   */
  async #resume(socket: WebSocket, attachment: Attachment, cursors: Record<string, number>) {
    const subscriptions = await this.#subscriptions();
    const byKey = new Map(
      [...subscriptions.values()].map((subscription) => [
        threadKey(subscription.workspaceId, subscription.threadId),
        subscription,
      ]),
    );
    const failures: { thread: string; reason: "unknown-subscription" | "stale" | "forged" }[] = [];
    for (const [key, cursor] of Object.entries(cursors)) {
      const subscription = byKey.get(key as ThreadKey);
      if (!subscription) failures.push({ thread: key, reason: "unknown-subscription" });
      else if (cursor < subscription.acked) failures.push({ thread: key, reason: "stale" });
      else if (cursor > subscription.delivered) failures.push({ thread: key, reason: "forged" });
    }
    if (failures.length) {
      // No state changes: the client resynchronizes (fresh subscribe) instead of trusting a bad cursor.
      this.#send(socket, { type: "resume/failed", failures });
      return;
    }
    for (const subscription of subscriptions.values()) {
      const cursor = cursors[threadKey(subscription.workspaceId, subscription.threadId)] ?? subscription.acked;
      subscription.acked = cursor;
      subscription.delivered = cursor;
      // Idempotent re-registration repairs a WorkspaceHost that lost the subscriber.
      await this.#workspace(subscription.workspaceId).subscribe(
        subscription.threadId,
        (await this.#session())!.clientInstanceId,
      );
      await this.#replay([socket], subscription);
    }
    attachment.ready = true;
    socket.serializeAttachment(attachment);
    this.#send(socket, {
      type: "client/ready",
      generation: attachment.generation,
      subscriptions: [...subscriptions.values()].map(({ workspaceId, threadId, acked, delivered }) => ({
        workspaceId,
        threadId,
        acked,
        delivered,
      })),
    });
  }

  async #replay(sockets: readonly WebSocket[], subscription: Subscription) {
    this.#counters.pullCalls++;
    const events = await this.#workspace(subscription.workspaceId).read(subscription.threadId, subscription.delivered);
    const thread = threadKey(subscription.workspaceId, subscription.threadId);
    if (events === null) {
      for (const socket of sockets)
        this.#send(socket, { type: "resume/failed", failures: [{ thread, reason: "gap" }] });
      return;
    }
    for (const event of events) {
      for (const socket of sockets) this.#send(socket, { type: "thread/event", ...event });
      this.#counters.forwarded++;
    }
    if (events.length) subscription.delivered = events.at(-1)!.seq;
    await this.ctx.storage.put(SUBSCRIPTION + threadKey(subscription.workspaceId, subscription.threadId), subscription);
  }

  async #subscribe(socket: WebSocket, workspaceId: string, threadId: string, after: number) {
    const session = (await this.#session())!;
    const key = SUBSCRIPTION + threadKey(workspaceId, threadId);
    // Thread access belongs to InstallationCore (ThreadAccessSession); the prototype admits any authenticated client.
    const head = await this.#workspace(workspaceId).subscribe(threadId, session.clientInstanceId);
    if (after > head) {
      this.#send(socket, { type: "error", reason: "forged", workspaceId, threadId });
      return;
    }
    const subscription: Subscription = { workspaceId, threadId, acked: after, delivered: after };
    await this.ctx.storage.put(key, subscription);
    this.#send(socket, { type: "thread/subscribed", workspaceId, threadId, head });
    await this.#replay([socket], subscription);
  }

  async #unsubscribe(socket: WebSocket, workspaceId: string, threadId: string) {
    const session = (await this.#session())!;
    await this.ctx.storage.delete(SUBSCRIPTION + threadKey(workspaceId, threadId));
    await this.#workspace(workspaceId).unsubscribe(threadId, session.clientInstanceId);
    this.#send(socket, { type: "thread/unsubscribed", workspaceId, threadId });
  }

  async #acknowledge(socket: WebSocket, workspaceId: string, threadId: string, seq: number) {
    const key = SUBSCRIPTION + threadKey(workspaceId, threadId);
    const subscription = await this.ctx.storage.get<Subscription>(key);
    if (!subscription || seq < subscription.acked || seq > subscription.delivered) {
      this.#send(socket, { type: "error", reason: "invalid-ack", workspaceId, threadId, seq });
      return;
    }
    subscription.acked = seq;
    await this.ctx.storage.put(key, subscription);
  }

  /**
   * RPC from a WorkspaceHost. Duplicates are dropped; a gap (an earlier
   * deliver lost or reordered) is filled from the log. With no ready socket the
   * cursor stays put, so the event is delivered on resume, not lost.
   */
  async deliver(event: ThreadEvent): Promise<DeliverOutcome> {
    this.#counters.deliverCalls++;
    return this.#serial(async () => {
      const key = SUBSCRIPTION + threadKey(event.workspaceId, event.threadId);
      const subscription = await this.ctx.storage.get<Subscription>(key);
      if (!subscription) return "unsubscribed";
      if (event.seq <= subscription.delivered) return "duplicate";
      const sockets = this.#readySockets();
      if (!sockets.length) return "detached";
      if (event.seq === subscription.delivered + 1) {
        for (const socket of sockets) this.#send(socket, { type: "thread/event", ...event });
        this.#counters.forwarded++;
        subscription.delivered = event.seq;
        await this.ctx.storage.put(key, subscription);
      } else {
        await this.#replay(sockets, subscription);
      }
      return "forwarded";
    });
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
    await this.#detached();
  }
  override async webSocketError(): Promise<void> {
    await this.#detached();
  }

  async #detached() {
    await this.#serial(async () => {
      const session = await this.#session();
      if (!session || this.#openSockets().length) return;
      await this.ctx.storage.put(DISCONNECTED_AT, Date.now());
      await this.#schedule(session);
    });
  }

  override async alarm(): Promise<void> {
    await this.#serial(async () => {
      const session = await this.#session();
      if (!session) return;
      const now = Date.now();
      const detachMs = Number(this.env.DETACH_MS ?? DEFAULT_DETACH_MS);
      const disconnectedAt = await this.ctx.storage.get<number>(DISCONNECTED_AT);
      if (session.expiresAt <= now) return this.#reclaim("expired");
      if (!this.#openSockets().length && disconnectedAt !== undefined && disconnectedAt + detachMs <= now)
        return this.#reclaim("detached");
      await this.#schedule(session);
    });
  }

  /** Remove the client instance: deregister from every WorkspaceHost, then drop all state. */
  async #reclaim(reason: "logout" | "expired" | "detached") {
    const session = await this.#session();
    for (const subscription of (await this.#subscriptions()).values())
      await this.#workspace(subscription.workspaceId).unsubscribe(subscription.threadId, session!.clientInstanceId);
    for (const socket of this.ctx.getWebSockets()) socket.close(CLOSE_RECLAIMED, reason);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Test-only inspection: storage view plus this instance's counters (reset by eviction). */
  async inspect() {
    const session = await this.#session();
    return {
      session,
      subscriptions: [...(await this.#subscriptions()).values()],
      sockets: this.#openSockets().length,
      alarm: await this.ctx.storage.getAlarm(),
      counters: this.#counters,
    };
  }

  /** Test-only: evict this instance; the next request builds a new one on the same storage. */
  async abortForTest() {
    this.ctx.abort("evicted for test");
  }
}

// ---- fake WorkspaceHostDO ---------------------------------------------------------

const HEAD = "head:";
const EVENT = "event:";
const SUBSCRIBERS = "subscribers:";
const eventKey = (threadId: string, seq: number) => `${EVENT}${threadId}:${String(seq).padStart(16, "0")}`;

export class WorkspaceHostDO extends DurableObject<Env> {
  #stats = { appends: 0, deliverRpcs: 0, outcomes: {} as Record<string, number> };

  async #subscribers(threadId: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(SUBSCRIBERS + threadId)) ?? [];
  }

  async subscribe(threadId: string, clientInstanceId: string): Promise<number> {
    const subscribers = await this.#subscribers(threadId);
    if (!subscribers.includes(clientInstanceId))
      await this.ctx.storage.put(SUBSCRIBERS + threadId, [...subscribers, clientInstanceId]);
    return (await this.ctx.storage.get<number>(HEAD + threadId)) ?? 0;
  }

  async unsubscribe(threadId: string, clientInstanceId: string): Promise<void> {
    const subscribers = await this.#subscribers(threadId);
    if (subscribers.includes(clientInstanceId))
      await this.ctx.storage.put(
        SUBSCRIBERS + threadId,
        subscribers.filter((id) => id !== clientInstanceId),
      );
  }

  async subscribers(threadId: string): Promise<string[]> {
    return this.#subscribers(threadId);
  }

  /** Events after `after`, in order; null when the log no longer holds them (never, in this prototype). */
  async read(threadId: string, after: number): Promise<ThreadEvent[] | null> {
    const head = (await this.ctx.storage.get<number>(HEAD + threadId)) ?? 0;
    if (after > head) return null;
    const events = await this.ctx.storage.list<ThreadEvent>({
      start: eventKey(threadId, after + 1),
      end: eventKey(threadId, head + 1),
    });
    return [...events.values()];
  }

  /**
   * Append, commit, then fan out one RPC per subscribed client instance. The
   * event is durable before any delivery, so a failed or detached delivery is
   * recovered by resume from this log.
   */
  async append(
    workspaceId: string,
    threadId: string,
    event: unknown,
  ): Promise<{ seq: number; outcomes: Record<string, DeliverOutcome | "failed"> }> {
    const seq = ((await this.ctx.storage.get<number>(HEAD + threadId)) ?? 0) + 1;
    const record: ThreadEvent = { workspaceId, threadId, seq, event };
    await this.ctx.storage.put({ [HEAD + threadId]: seq, [eventKey(threadId, seq)]: record });
    this.#stats.appends++;
    const subscribers = await this.#subscribers(threadId);
    const results = await Promise.allSettled(
      subscribers.map((clientInstanceId) => {
        this.#stats.deliverRpcs++;
        return this.env.CLIENT.get(this.env.CLIENT.idFromName(clientInstanceId)).deliver(record);
      }),
    );
    const outcomes: Record<string, DeliverOutcome | "failed"> = {};
    results.forEach((result, index) => {
      const outcome = result.status === "fulfilled" ? result.value : "failed";
      outcomes[subscribers[index]!] = outcome;
      this.#stats.outcomes[outcome] = (this.#stats.outcomes[outcome] ?? 0) + 1;
    });
    // A reclaimed client instance answers "unsubscribed"; prune it here as a second defence.
    const gone = subscribers.filter((id) => outcomes[id] === "unsubscribed");
    if (gone.length)
      await this.ctx.storage.put(
        SUBSCRIBERS + threadId,
        (await this.#subscribers(threadId)).filter((id) => !gone.includes(id)),
      );
    return { seq, outcomes };
  }

  async stats() {
    return this.#stats;
  }
}
