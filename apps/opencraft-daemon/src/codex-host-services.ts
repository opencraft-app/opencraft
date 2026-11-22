import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type {
  DuplexTransport,
  TransportStatus,
  TransportSubmissionContext,
} from "@opencraft/appserver-client/transport";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import { TasksFault, TasksService } from "@opencraft/plugin-tasks/server";
import {
  CodexAccountOperationError,
  classifyAccountFailure,
  configuredModelGatewayPath,
  logAccountFailure,
  ModelGatewayStore,
} from "@opencraft/account-pool-host";
import {
  codexPermissionMode,
  OPENCRAFT_PERMISSION_MODES_CAPABILITY,
  OPENCRAFT_PERMISSION_MODES_EXTENSION,
  OPENCRAFT_THREAD_PINS_CAPABILITY,
  OPENCRAFT_THREAD_PINS_EXTENSION,
  projectPermissionProfileCatalog,
  type OpenCraftPermissionProfile,
} from "@opencraft/appserver-protocol";
import { CodexThreadPins } from "./codex-thread-pins.js";
import { CodexThreadTitles } from "./codex-thread-titles.js";
import {
  CODEX_MAINTENANCE_CAPABILITY,
  CODEX_MAINTENANCE_EXTENSION,
  CODEX_MAINTENANCE_READ,
  type CodexMaintenanceSnapshot,
} from "./codex-maintenance.js";

type Value = Record<string, unknown>;
const object = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Value) : {};

/** A Codex Host duty that is not scoped to one Thread, answered before Thread routing. */
export interface CodexHostService {
  handles(method: string): boolean;
  /** Answer clients that have not initialized yet; default false. */
  readonly beforeInitialize?: boolean;
  request(method: string, params: unknown, context: TransportSubmissionContext): unknown;
  /** Initialize capability extensions this service contributes. */
  capabilities?(): Value;
  storage?(): readonly { name: string; outcome: DatabaseOutcome }[];
  /** A client request about to go to Thread routing (not the Host's own requests). */
  beforeRoute?(method: string, params: Value): void;
  /** A request Thread routing answered successfully, by the client's (public) identities. */
  observe?(method: string, params: Value, result: unknown): void;
  /** A notification on its way to clients. */
  notification?(method: string, params: Value): void;
  close(): void | Promise<void>;
}

/** What a service may do towards clients, and through Thread routing as the Host itself. */
export interface CodexHostServiceClients {
  broadcast(method: string, params: Value): void;
  /**
   * A request through Thread routing as the Host's own client, e.g. to continue
   * a Thread. It is routed exactly like a client's (bridge, admission, queue).
   */
  request(method: string, params: Value, timeoutMs?: number): Promise<unknown>;
}

/** The Host's own client identity on Thread routing. */
export const CODEX_HOST_CLIENT = "opencraft-host-services";

/**
 * The Codex Host's front: duties that belong to the Host rather than to any
 * one Thread (tasks first; accounts, schedules and others follow) are answered
 * here, and everything else goes to Thread routing unchanged. Thread routing
 * may be the provider bridge, the legacy Codex Host, or both.
 */
export class CodexHostServices implements DuplexTransport, CodexHostServiceClients {
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly clients = new Set<string>();
  private readonly initializing = new Set<string>();
  /** Routed requests some service observes, until their answer passes. */
  private readonly observed = new Map<string, { method: string; params: Value }>();
  private readonly services: CodexHostService[];
  private closing?: Promise<void>;

  private sequence = 0;
  private readonly internal = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private internalReady?: Promise<void>;
  private readonly stopEvents?: () => void;

  /**
   * `events`, when given, is the source of Thread events for services (every
   * Thread, whether or not a client watches it); otherwise services see the
   * notifications on their way to clients.
   */
  constructor(
    private readonly routing: DuplexTransport,
    services: (clients: CodexHostServiceClients) => CodexHostService[],
    events?: (listener: (method: string, params: Value) => void) => () => void,
  ) {
    this.services = services(this);
    routing.subscribeMessage((frame) => this.receive(frame));
    this.stopEvents = events?.((method, params) => this.notifyServices(method, params));
  }
  private notifyServices(method: string, params: Value): void {
    for (const service of this.services) {
      try {
        service.notification?.(method, params);
      } catch {
        /* an observer never changes the notification */
      }
    }
  }

  request(method: string, params: Value, timeoutMs = 30_000): Promise<unknown> {
    const send = (id: string, frame: Value) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.internal.delete(id);
          reject(new Error(`Host request ${method} timed out`));
        }, timeoutMs);
        timer.unref?.();
        this.internal.set(id, { resolve, reject, timer });
        const raw = JSON.stringify({ jsonrpc: "2.0", ...frame, id, [LOGICAL_CLIENT_FIELD]: CODEX_HOST_CLIENT });
        void (
          this.routing.sendWithContext ? this.routing.sendWithContext(raw, { sender: null }) : this.routing.send(raw)
        ).catch((error) => {
          const pending = this.internal.get(id);
          if (!pending) return;
          this.internal.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        });
      });
    // The Host's client initializes once, like any client, before its first request.
    this.internalReady ??= send(`host:${++this.sequence}`, {
      method: "initialize",
      params: { clientInfo: { name: CODEX_HOST_CLIENT, version: "1" }, capabilities: { experimentalApi: true } },
    }).then(
      () => undefined,
      (error) => {
        this.internalReady = undefined;
        throw error;
      },
    );
    return this.internalReady.then(() => send(`host:${++this.sequence}`, { method, params }));
  }

  get status(): TransportStatus {
    return this.routing.status;
  }
  subscribeStatus(listener: (status: TransportStatus) => void) {
    return this.routing.subscribeStatus(listener);
  }
  subscribeMessage(listener: (frame: string) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  captureMessageScope() {
    return this.routing.captureMessageScope?.() ?? (() => true);
  }
  connect(signal?: AbortSignal) {
    return this.routing.connect(signal);
  }
  storage(): readonly { name: string; outcome: DatabaseOutcome }[] {
    return this.services.flatMap((service) => service.storage?.() ?? []);
  }

  broadcast(method: string, params: Value): void {
    for (const client of this.clients) this.emit({ method, params }, client);
  }
  private emit(frame: Value, client?: string): void {
    const value = JSON.stringify({ jsonrpc: "2.0", ...frame, ...(client ? { [LOGICAL_CLIENT_FIELD]: client } : {}) });
    for (const listener of this.listeners) listener(value);
  }
  private receive(raw: string): void {
    let frame: Value;
    try {
      frame = JSON.parse(raw);
    } catch {
      for (const listener of this.listeners) listener(raw);
      return;
    }
    // The Host's own client: answers settle its requests; nothing of it reaches clients.
    if (frame[LOGICAL_CLIENT_FIELD] === CODEX_HOST_CLIENT) {
      const pending = typeof frame.id === "string" ? this.internal.get(frame.id) : undefined;
      if (pending && frame.method === undefined) {
        this.internal.delete(frame.id as string);
        clearTimeout(pending.timer);
        if (frame.error) {
          const error = object(frame.error);
          pending.reject(Object.assign(new Error(String(error.message ?? "Host request failed")), error));
        } else pending.resolve(frame.result);
      }
      return;
    }
    const key = JSON.stringify([frame[LOGICAL_CLIENT_FIELD] ?? null, frame.id ?? null]);
    const request = frame.id !== undefined && frame.method === undefined ? this.observed.get(key) : undefined;
    if (request) {
      this.observed.delete(key);
      if ("result" in frame)
        for (const service of this.services) {
          try {
            service.observe?.(request.method, request.params, frame.result);
          } catch {
            /* an observer never changes the answer */
          }
        }
    }
    if (!this.stopEvents && typeof frame.method === "string" && frame.id === undefined)
      this.notifyServices(frame.method, object(frame.params));
    // Contribute this Host's capabilities to the routed initialize result.
    if (this.initializing.delete(key) && frame.result && typeof frame.result === "object") {
      const result = object(frame.result),
        capabilities = object(result.capabilities);
      const extensions = Object.assign(
        {},
        object(capabilities.extensions),
        ...this.services.map((service) => service.capabilities?.() ?? {}),
      );
      frame = { ...frame, result: { ...result, capabilities: { ...capabilities, extensions } } };
      for (const listener of this.listeners) listener(JSON.stringify(frame));
      return;
    }
    for (const listener of this.listeners) listener(raw);
  }

  send(frame: string, signal?: AbortSignal) {
    return this.sendWithContext(frame, { sender: null }, signal);
  }
  async sendWithContext(raw: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void> {
    const frame = object(JSON.parse(raw)),
      method = typeof frame.method === "string" ? frame.method : "";
    const client = typeof frame[LOGICAL_CLIENT_FIELD] === "string" ? (frame[LOGICAL_CLIENT_FIELD] as string) : "";
    if (method === "initialize" && client) {
      this.clients.add(client);
      if (frame.id !== undefined) this.initializing.add(JSON.stringify([client, frame.id]));
    }
    if (method === "runtime/client/disconnect" && client) this.clients.delete(client);
    const service = method ? this.services.find((candidate) => candidate.handles(method)) : undefined;
    if (!service && method)
      for (const candidate of this.services) {
        try {
          candidate.beforeRoute?.(method, object(frame.params));
        } catch {
          /* an observer never changes routing */
        }
      }
    if (!service && method && frame.id !== undefined && this.services.some((candidate) => candidate.observe)) {
      if (this.observed.size >= 4096) this.observed.delete(this.observed.keys().next().value!);
      this.observed.set(JSON.stringify([client || null, frame.id]), { method, params: object(frame.params) });
    }
    if (!service)
      return this.routing.sendWithContext
        ? this.routing.sendWithContext(raw, context, signal)
        : this.routing.send(raw, signal);
    if (frame.id === undefined) return;
    // As the local Codex Host did: Host services answer only initialized clients.
    if (!service.beforeInitialize && !this.clients.has(client)) {
      this.emit({ id: frame.id, error: { code: -32600, message: "Client is not initialized" } }, client || undefined);
      return;
    }
    try {
      this.emit(
        { id: frame.id, result: (await service.request(method, frame.params, context)) ?? null },
        client || undefined,
      );
    } catch (cause) {
      const error = cause as Error & { code?: unknown; data?: unknown };
      this.emit(
        {
          id: frame.id,
          error: {
            code: typeof error.code === "number" ? error.code : -32000,
            message: error.message || "Host service request failed",
            ...(error.data !== undefined ? { data: error.data } : {}),
          },
        },
        client || undefined,
      );
    }
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.stopEvents?.();
      for (const pending of this.internal.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex Host is closing"));
      }
      this.internal.clear();
      try {
        await this.routing.close();
      } finally {
        await Promise.allSettled(this.services.map((service) => service.close()));
      }
    })());
  }
}

/** Tasks: a Host-wide store, independent of any Thread or engine. */
export function codexTasksService(
  path: string,
  clients: CodexHostServiceClients,
  opened: () => void = () => {},
): CodexHostService {
  const tasks = new TasksService(path, () => clients.broadcast("opencraft/tasks/changed", {}));
  return {
    handles: (method) => method.startsWith("opencraft/tasks/"),
    request: (method, params) => {
      try {
        const known = tasks.outcome;
        const result = tasks.handle(method, params);
        if (!known && tasks.outcome) opened();
        return result;
      } catch (error) {
        throw Object.assign(new Error(error instanceof TasksFault ? error.message : "Tasks storage unavailable"), {
          code: error instanceof TasksFault ? error.code : -32050,
        });
      }
    },
    storage: () => (tasks.outcome ? [{ name: "tasks", outcome: tasks.outcome }] : []),
    close: () => tasks.close(),
  };
}

/**
 * Accounts of a Core-backed Codex Host: Core owns the pool, credentials and
 * refresh; this only relays the account RPC, as the local Host did.
 */
export function codexAccountsService(control: {
  accountRequest(method: string, params: Record<string, unknown>): Promise<unknown>;
}): CodexHostService {
  return {
    handles: (method) => method.startsWith("opencraft/codex/accounts/"),
    beforeInitialize: true,
    request: async (method, params) => {
      try {
        if (method.startsWith("opencraft/codex/accounts/personal/"))
          throw new Error("Personal subscriptions require the authenticated settings endpoint");
        return await control.accountRequest(method, object(params));
      } catch (error) {
        const failure =
          error instanceof CodexAccountOperationError ? error : classifyAccountFailure(error, "operation");
        logAccountFailure(failure, { operation: method });
        throw Object.assign(new Error(failure.message), {
          code: -32020,
          data: { codexAccountFailure: failure.diagnostic },
        });
      }
    },
    close: () => {},
  };
}

/** Native requests a service may make; the Host's own reader connection to Core's AppServer. */
export interface CodexNativeRequests {
  request(method: string, params: Value): Promise<unknown>;
}
/** Public and native Thread identities, where Thread routing gives bridge Threads public IDs. */
export interface CodexThreadIdentities {
  toNative(threadId: string): string | undefined;
  toPublic(nativeId: string): string | undefined;
}
const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * Models and permission profiles, read from native Codex. A configured gateway
 * model is listed only to whom it may serve, as the local Host did.
 */
export function codexModelsService(
  native: CodexNativeRequests,
  viewer: (context: TransportSubmissionContext) => string | null = () => null,
): CodexHostService {
  return {
    handles: (method) => method === "model/list" || method === "permissionProfile/list",
    capabilities: () => ({ [OPENCRAFT_PERMISSION_MODES_EXTENSION]: OPENCRAFT_PERMISSION_MODES_CAPABILITY }),
    request: async (method, params, context) => {
      const result = object(await native.request(method, object(params)));
      if (method === "permissionProfile/list")
        return {
          ...result,
          data: Array.isArray(result.data)
            ? projectPermissionProfileCatalog(
                result.data.map((entry) => object(entry) as unknown as OpenCraftPermissionProfile),
                (profile) => codexPermissionMode(text(profile.id)),
              )
            : result.data,
        };
      const gatewayPath = configuredModelGatewayPath();
      if (!gatewayPath || !Array.isArray(result.data)) return result;
      const ledger = new ModelGatewayStore(gatewayPath);
      try {
        const actor = viewer(context);
        return {
          ...result,
          data: result.data.filter((item) => {
            const id = text(object(item).model) || text(object(item).id);
            if (!id.startsWith("configured/")) return true;
            try {
              return ledger.canUse(decodeURIComponent(id.slice("configured/".length).split("/")[0]!), actor);
            } catch {
              return false;
            }
          }),
        };
      } finally {
        ledger.close();
      }
    },
    close: () => {},
  };
}

/** Pinned Threads, kept in native Codex's reserved section; bridge Threads by their public ID. */
export function codexPinsService(
  native: CodexNativeRequests,
  clients: CodexHostServiceClients,
  identities?: CodexThreadIdentities,
): CodexHostService {
  const pins = new CodexThreadPins((method, params) => native.request(method, params));
  return {
    handles: (method) => method === "opencraft/thread-pins/list" || method === "opencraft/thread-pins/set",
    capabilities: () => ({ [OPENCRAFT_THREAD_PINS_EXTENSION]: OPENCRAFT_THREAD_PINS_CAPABILITY }),
    request: async (method, raw) => {
      const params = object(raw);
      try {
        if (method === "opencraft/thread-pins/list") {
          const listed = await pins.list();
          return identities
            ? {
                ...listed,
                data: listed.data.map((row) => {
                  const id = text(object(row).id),
                    visible = id ? identities.toPublic(id) : undefined;
                  return visible ? { ...row, id: visible } : row;
                }),
              }
            : listed;
        }
        if (typeof params.threadId !== "string" || typeof params.pinned !== "boolean")
          throw new Error("Invalid pin command");
        const result = await pins.set(identities?.toNative(params.threadId) ?? params.threadId, params.pinned);
        clients.broadcast("thread/pins/updated", { threadId: params.threadId });
        return result;
      } catch (error) {
        console.warn(
          "[codex-host-services]",
          JSON.stringify({ event: "thread-pins-failed", reason: error instanceof Error ? error.message : "unknown" }),
        );
        throw Object.assign(new Error("无法更新置顶会话，请刷新列表核对后重试"), { code: -32000 });
      }
    },
    close: () => {},
  };
}

/** A native connection that also delivers its own notifications (Host-private Threads). */
export interface CodexNativeConnection extends CodexNativeRequests {
  subscribeNotification(listener: (method: string, params: Value) => void): () => void;
}

/**
 * Generated titles for new conversations, as the local Host made them: after
 * the first turn of a new Thread, a Host-private ephemeral native Thread infers
 * a title, which is written by native identity unless someone named it first.
 */
export function codexTitlesService(
  native: CodexNativeConnection,
  clients: CodexHostServiceClients,
  identities?: CodexThreadIdentities,
): CodexHostService & { pendingCount(): number } {
  const toNative = (threadId: string) => identities?.toNative(threadId) ?? threadId;
  const order = new Map<string, Promise<unknown>>();
  const titles = new CodexThreadTitles({
    // The generator names Threads by public ID; native Codex knows them by native ID.
    request: (method, params) =>
      native.request(
        method,
        typeof params.threadId === "string" ? { ...params, threadId: toNative(params.threadId) } : params,
      ),
    serialize: (threadId, work) => {
      const next = (order.get(threadId) ?? Promise.resolve()).catch(() => undefined).then(work);
      order.set(threadId, next);
      void next.finally(() => order.get(threadId) === next && order.delete(threadId)).catch(() => undefined);
      return next;
    },
    changed: (threadId, name) => clients.broadcast("thread/name/updated", { threadId, threadName: name }),
    failed: () => console.warn("[codex-host-services]", JSON.stringify({ event: "thread-title-failed" })),
  });
  const stop = native.subscribeNotification((method, params) => void titles.notification(method, params));
  return {
    handles: () => false,
    request: () => null,
    pendingCount: () => titles.pendingCount,
    observe: (method, params, result) => {
      if (method === "thread/name/set" && typeof params.threadId === "string") titles.invalidate(params.threadId);
      titles.observeResult(method, params, result);
    },
    // Someone else named, archived or removed the Thread: no generated title any more.
    notification: (method, params) => void titles.notification(method, params),
    close: () => {
      stop();
      titles.close();
    },
  };
}

/** What the maintenance snapshot counts beyond the pause switch. */
export interface CodexMaintenanceSources {
  paused(): boolean;
  bridge?(): Promise<{
    pendingAdmissions: number;
    rejectedAdmissions: number;
    queued: number;
    unknown: number;
    pendingApprovals: number;
  }>;
  continuation?(): { capacityRetries: number; activeGoals: number };
  pendingTitles?(): number;
}

/** The operator's drain view (`opencraft/codex/maintenance/read`), as the local Host reported it. */
export function codexMaintenanceService(sources: CodexMaintenanceSources): CodexHostService {
  return {
    handles: (method) => method === CODEX_MAINTENANCE_READ,
    request: async () => {
      const bridge = await sources.bridge?.();
      const continuation = sources.continuation?.();
      return {
        paused: sources.paused(),
        rejectedAdmissions: bridge?.rejectedAdmissions ?? 0,
        pendingAdmissions: bridge?.pendingAdmissions ?? 0,
        queued: bridge?.queued ?? 0,
        unknown: bridge?.unknown ?? 0,
        activeGoals: continuation?.activeGoals ?? 0,
        pendingTitles: sources.pendingTitles?.() ?? 0,
        pendingApprovals: bridge?.pendingApprovals ?? 0,
        capacityRetries: continuation?.capacityRetries ?? 0,
      } satisfies CodexMaintenanceSnapshot;
    },
    capabilities: () => ({ [CODEX_MAINTENANCE_EXTENSION]: CODEX_MAINTENANCE_CAPABILITY }),
    close: () => {},
  };
}
