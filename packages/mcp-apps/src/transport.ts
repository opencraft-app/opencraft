import type {
  DuplexTransport,
  TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol/routing";
import type { McpAppsService } from "./server";
import { AppHistoryAccess } from "@opencraft/mcp-apps/history-access";
import {
  ownsServer,
  MCP_APPS_METHOD,
} from "@opencraft/appserver-protocol/mcp-apps";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function parseFrame(frame: string): Record<string, unknown> | null {
  try {
    return object(JSON.parse(frame));
  } catch {
    return null;
  }
}

/** One admitted logical client. It never accepts an identity in an RPC body. */
export class McpAppsRpcSession {
  private closed = false;
  private pending = new Set<string | number>();
  private inventory = new Map<string | number, unknown>();
  private history = new AppHistoryAccess();
  private initialize = new Set<string | number>();
  private readonly service: McpAppsService;
  private readonly emit: (frame: string) => void;
  constructor(service: McpAppsService, emit: (frame: string) => void) {
    this.service = service;
    this.emit = emit;
  }
  close() {
    this.closed = true;
    this.pending.clear();
    this.inventory.clear();
    this.initialize.clear();
    this.history.clear();
  }
  receive(frame: string, context: TransportSubmissionContext): boolean {
    const p = parseFrame(frame);
    if (!p) return false;
    if (typeof p.id !== "string" && typeof p.id !== "number") return false;
    const owner = context.resourceOwner;
    if (!owner) return false; // internal probes/legacy peers never acquire anonymous authority.
    const params =
      p.params && typeof p.params === "object" ? object(p.params) : {};
    this.history.requested(p.id, p.method, params);
    if (p.method === "initialize") {
      if (this.initialize.size < 16) this.initialize.add(p.id);
      return false;
    }
    if (p.method === "mcpServerStatus/list" && !params.cursor) {
      if (this.inventory.size < 128) this.inventory.set(p.id, params.threadId);
      return false;
    }
    if (
      p.method !== MCP_APPS_METHOD &&
      !(
        ["mcpServer/tool/call", "mcpServer/resource/read"].includes(
          String(p.method),
        ) && ownsServer(params.server)
      )
    )
      return false;
    const id = p.id,
      stamp = p[LOGICAL_CLIENT_FIELD];
    const reply = (result: unknown, error?: unknown) => {
      if (!this.closed)
        this.emit(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            ...(stamp ? { [LOGICAL_CLIENT_FIELD]: stamp } : {}),
            ...(error
              ? {
                  error: {
                    code: -32060,
                    message:
                      error instanceof Error
                        ? error.message
                        : "App request failed",
                  },
                }
              : { result }),
          }),
        );
    };
    if (this.closed || this.pending.size >= 16 || this.pending.has(id)) {
      reply(null, new Error("App request limit or duplicate request ID"));
      return true;
    }
    this.pending.add(id);
    const current = () => {
      if (this.closed) throw new Error("App owner disconnected");
      if (context.validUntil !== undefined && context.validUntil <= Date.now())
        throw new Error("App identity expired");
      owner.assertCurrent();
    };
    void Promise.resolve()
      .then(() => {
        current();
        return this.service.handle(owner.id, String(p.method), params, current, () => this.history.references(params.threadId));
      })
      .then(
        (value) => reply(value),
        (e) => reply(null, e),
      )
      .finally(() => this.pending.delete(id));
    return true;
  }
  project(frame: string, context: TransportSubmissionContext): string {
    const p = parseFrame(frame);
    if (!p) return frame;
    if (!this.closed && context.resourceOwner) {
      try { context.resourceOwner.assertCurrent(); this.history.observed(p); } catch { this.history.clear(); }
    }
    const inventoryThread = typeof p.id === "string" || typeof p.id === "number" ? this.inventory.get(p.id) : undefined;
    if (
      (typeof p.id === "string" || typeof p.id === "number") &&
      this.initialize.delete(p.id) &&
      p.result &&
      !this.closed &&
      context.resourceOwner
    ) {
      const r = object(p.result),
        cap = r.capabilities ? object(r.capabilities) : {},
        extensions = cap.extensions ? object(cap.extensions) : {};
      return JSON.stringify({
        ...p,
        result: {
          ...r,
          capabilities: {
            ...cap,
            extensions: {
              ...extensions,
              "opencraft/mcp-app-builder": { version: 1 },
            },
          },
        },
      });
    }
    if (
      (typeof p.id !== "string" && typeof p.id !== "number") ||
      !this.inventory.delete(p.id) ||
      !context.resourceOwner ||
      this.closed
    )
      return frame;
    try {
      context.resourceOwner.assertCurrent();
      const r =
        p.result && typeof p.result === "object" ? object(p.result) : null;
      const unsupported =
        p.error &&
        typeof p.error === "object" &&
        (/Method not supported by OpenCraft DSH host: mcpServerStatus\/list/.test(
          String(object(p.error).message),
        ) ||
          object(p.error).code === -32601);
      if (!r && !unsupported) return frame;
      const { error: _error, ...rest } = p;
      return JSON.stringify({
        ...rest,
        result: {
          ...(r ?? {}),
          data: [
            ...(Array.isArray(r?.data) ? r.data : []),
            ...this.service.inventory(context.resourceOwner.id, this.history.references(inventoryThread)),
          ],
          nextCursor: r?.nextCursor ?? null,
        },
      });
    } catch {
      return frame;
    }
  }
}

/** Gateway-owned decoration of a local Host; remote SSH Hosts keep their own authority. */
export class McpAppsTransport implements DuplexTransport {
  private clients = new Map<
    string,
    { session: McpAppsRpcSession; context: TransportSubmissionContext }
  >();
  private messages = new Set<(frame: string) => void>();
  private stop: () => void;
  private readonly inner: DuplexTransport;
  private readonly service: McpAppsService;
  constructor(inner: DuplexTransport, service: McpAppsService) {
    this.inner = inner;
    this.service = service;
    this.stop = inner.subscribeMessage((frame) => {
      let projected = frame;
      try {
        const raw = object(JSON.parse(frame)),
          key = String(raw[LOGICAL_CLIENT_FIELD] ?? ""),
          client = this.clients.get(key);
        projected = client
          ? client.session.project(frame, client.context)
          : frame;
      } catch {
        /* Leave malformed frames to the existing protocol owner. */
      }
      for (const listener of this.messages) listener(projected);
    });
  }
  get status() {
    return this.inner.status;
  }
  connect(signal?: AbortSignal) {
    return this.inner.connect(signal);
  }
  send(frame: string, signal?: AbortSignal) {
    return this.sendWithContext(frame, { sender: null }, signal);
  }
  async sendWithContext(
    frame: string,
    context: TransportSubmissionContext,
    signal?: AbortSignal,
  ) {
    const raw = parseFrame(frame),
      key = String(raw?.[LOGICAL_CLIENT_FIELD] ?? "");
    let client = this.clients.get(key);
    if (raw?.method === "runtime/client/disconnect") {
      client?.session.close();
      this.clients.delete(key);
    } else if (raw && context.resourceOwner) {
      if (!client) {
        client = {
          context,
          session: new McpAppsRpcSession(this.service, (value) => {
            for (const l of this.messages) l(value);
          }),
        };
        this.clients.set(key, client);
      }
      if (client.context.resourceOwner?.id !== context.resourceOwner.id)
        throw new Error("App connection identity changed");
      if (client.session.receive(frame, context)) return;
    }
    if (this.inner.sendWithContext)
      await this.inner.sendWithContext(frame, context, signal);
    else await this.inner.send(frame, signal);
  }
  subscribeMessage(l: (frame: string) => void) {
    this.messages.add(l);
    return () => {
      this.messages.delete(l);
    };
  }
  subscribeStatus(l: Parameters<DuplexTransport["subscribeStatus"]>[0]) {
    return this.inner.subscribeStatus(l);
  }
  async close() {
    for (const c of this.clients.values()) c.session.close();
    this.clients.clear();
    this.stop();
    this.messages.clear();
    await this.inner.close();
  }
}
