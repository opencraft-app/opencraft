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
  projectPermissionProfileCatalog,
  type OpenCraftPermissionProfile,
} from "@opencraft/appserver-protocol";
import { CodexThreadPins } from "./codex-thread-pins.js";

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
  close(): void | Promise<void>;
}

/** What a service may do towards clients. */
export interface CodexHostServiceClients {
  broadcast(method: string, params: Value): void;
}

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
  private readonly services: CodexHostService[];
  private closing?: Promise<void>;

  constructor(
    private readonly routing: DuplexTransport,
    services: (clients: CodexHostServiceClients) => CodexHostService[],
  ) {
    this.services = services(this);
    routing.subscribeMessage((frame) => this.receive(frame));
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
    const key = JSON.stringify([frame[LOGICAL_CLIENT_FIELD] ?? null, frame.id ?? null]);
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
