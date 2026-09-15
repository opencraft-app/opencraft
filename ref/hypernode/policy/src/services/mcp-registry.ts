import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerConnection,
  AppServerParams,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  McpRegistryPort,
  McpResourceRegistration,
  McpServerRegistration,
  McpToolCallResult,
  McpToolInvocation,
  McpToolRegistration,
  PendingMcpToolCall,
} from "../types/mcp.ts";
import { deferredAppServerResponse } from "./appserver.ts";

const CURSOR_PREFIX = "hypernode-mcp:";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const DEFAULT_TOOL_TIMEOUT_MS = 20_000;
const POLL_DELAY_MS = 20;

type Dependencies = "appServer";

interface PendingCall {
  connection: AppServerConnection;
  call: PendingMcpToolCall;
  deadlineMs: number;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

function startupReadyParams(server: McpServerRegistration): Record<string, unknown> {
  return {
    name: server.name,
    status: "ready",
    threadId: null,
    error: null,
    failureReason: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProperty(value: unknown, key: string): string | null {
  const candidate = isRecord(value) ? value[key] : undefined;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

function descriptor(tool: McpToolRegistration): Record<string, unknown> {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    ...(tool.icons === undefined ? {} : { icons: tool.icons }),
    ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
  };
}

function resourceDescriptor(resource: McpResourceRegistration): Record<string, unknown> {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.title === undefined ? {} : { title: resource.title }),
    ...(resource.description === undefined ? {} : { description: resource.description }),
    ...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
    ...(resource.annotations === undefined ? {} : { annotations: resource.annotations }),
    ...(resource.icons === undefined ? {} : { icons: resource.icons }),
  };
}

function pendingToolCall(value: unknown): value is PendingMcpToolCall {
  return isRecord(value) && value["kind"] === "pending" && typeof value["poll"] === "function";
}

function pageOffset(cursor: unknown): number {
  if (cursor == null) return 0;
  if (typeof cursor !== "string" || !cursor.startsWith(CURSOR_PREFIX)) {
    throw rpcError(-32602, "invalid MCP inventory cursor");
  }
  const offset = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw rpcError(-32602, "invalid MCP inventory cursor");
  }
  return offset;
}

function pageSize(limit: unknown): number {
  if (limit == null) return DEFAULT_PAGE_SIZE;
  const value = Number(limit);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw rpcError(-32602, "invalid MCP inventory page size");
  }
  return Math.min(MAX_PAGE_SIZE, value);
}

export class McpRegistry {
  readonly servers = new Map<string, McpServerRegistration>();

  registerServer(server: McpServerRegistration): () => boolean {
    this.validateServer(server);
    if (this.servers.has(server.name)) throw new Error(`duplicate MCP server: ${server.name}`);
    this.servers.set(server.name, server);
    return () => this.servers.get(server.name) === server && this.servers.delete(server.name);
  }

  replaceServer(server: McpServerRegistration): () => boolean {
    this.validateServer(server);
    const previous = this.servers.get(server.name);
    this.servers.set(server.name, server);
    return () => {
      if (this.servers.get(server.name) !== server) return false;
      if (previous === undefined) this.servers.delete(server.name);
      else this.servers.set(server.name, previous);
      return true;
    };
  }

  removeServer(name: string): boolean {
    return this.servers.delete(name);
  }

  private validateServer(server: McpServerRegistration): void {
    if (!server.name || !server.version) throw new TypeError("MCP server name and version are required");
    const toolNames = new Set<string>();
    for (const tool of server.tools) {
      if (!tool.name || toolNames.has(tool.name)) {
        throw new Error(`duplicate or empty MCP tool in ${server.name}: ${tool.name}`);
      }
      toolNames.add(tool.name);
    }
    const resourceUris = new Set<string>();
    for (const resource of server.resources) {
      if (!resource.uri || resourceUris.has(resource.uri)) {
        throw new Error(`duplicate or empty MCP resource in ${server.name}: ${resource.uri}`);
      }
      resourceUris.add(resource.uri);
    }
  }

  list(params: AppServerParams = {}, connection?: AppServerConnection): Record<string, unknown> {
    const offset = pageOffset(params["cursor"]);
    const limit = pageSize(params["limit"]);
    const detail = params["detail"] ?? "full";
    if (detail !== "full" && detail !== "toolsAndAuthOnly") {
      throw rpcError(-32602, "invalid MCP server status detail");
    }
    const servers = [...this.servers.values()].filter((server) => (
      connection === undefined || server.visible?.(connection) !== false
    )).sort((left, right) => (
      left.name.localeCompare(right.name)
    ));
    const page = servers.slice(offset, offset + limit);
    const data = page.map((server) => ({
      // The Desktop protocol has no "authentication inherited from the host
      // transport" state. HyperNode's MCP calls already run inside the
      // authenticated SSH app-server session, so expose that session as an
      // authenticated token transport instead of making the app look unusable.
      authStatus: "bearerToken",
      name: server.name,
      pluginId: server.pluginId ?? null,
      resourceTemplates: [],
      resources: detail === "full" ? server.resources.map(resourceDescriptor) : [],
      serverInfo: {
        name: server.name,
        version: server.version,
        title: server.title ?? null,
        description: server.description ?? null,
        websiteUrl: server.websiteUrl ?? null,
        icons: server.icons ?? null,
      },
      tools: Object.fromEntries(server.tools.map((tool) => [tool.name, descriptor(tool)])),
    }));
    const nextOffset = offset + page.length;
    return {
      data,
      nextCursor: nextOffset < servers.length ? `${CURSOR_PREFIX}${nextOffset}` : null,
    };
  }

  read(params: AppServerParams = {}, connection?: AppServerConnection): Record<string, unknown> {
    const serverName = stringProperty(params, "server");
    const uri = stringProperty(params, "uri");
    if (serverName === null || uri === null) {
      throw rpcError(-32602, "MCP resource read requires server and uri");
    }
    const server = this.servers.get(serverName);
    if (server === undefined) throw rpcError(-32602, `unknown MCP server: ${serverName}`);
    if (connection !== undefined && server.visible?.(connection) === false) {
      throw rpcError(-32602, `unknown MCP server: ${serverName}`);
    }
    const resource = server.resources.find((candidate) => candidate.uri === uri);
    if (resource === undefined) throw rpcError(-32602, `unknown MCP resource: ${uri}`);
    const value = resource.read();
    const content = typeof value === "string" ? { text: value } : value;
    return {
      contents: [{
        uri: resource.uri,
        mimeType: content.mimeType ?? resource.mimeType ?? null,
        text: content.text,
        ...(content._meta === undefined ? {} : { _meta: content._meta }),
      }],
    };
  }

  call(
    params: AppServerParams = {},
    connection: AppServerConnection,
  ): McpToolCallResult | PendingMcpToolCall {
    const serverName = stringProperty(params, "server");
    const toolName = stringProperty(params, "tool");
    const threadId = stringProperty(params, "threadId");
    if (serverName === null || toolName === null || threadId === null) {
      throw rpcError(-32602, "MCP tool call requires server, tool, and threadId");
    }
    const server = this.servers.get(serverName);
    if (server === undefined) throw rpcError(-32602, `unknown MCP server: ${serverName}`);
    if (server.visible?.(connection) === false) {
      throw rpcError(-32602, `unknown MCP server: ${serverName}`);
    }
    const tool = server.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw rpcError(-32602, `unknown MCP tool: ${toolName}`);
    return tool.call(params["arguments"] ?? {}, {
      connection,
      server: serverName,
      threadId,
      tool: toolName,
      meta: params["_meta"],
    });
  }
}

export class McpRegistryService extends Service implements McpRegistryPort {
  static inject = ["appServer"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly registry = new McpRegistry();
  private readonly pending = new Set<PendingCall>();

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "mcpRegistry");
    ctx.effect(() => ctx.appServer.register(
      "mcpServerStatus/list",
      (params, connection) => this.registry.list(params, connection),
    ));
    ctx.effect(() => ctx.appServer.register(
      "mcpServer/resource/read",
      (params, connection) => this.registry.read(params, connection),
    ));
    ctx.effect(() => ctx.appServer.register(
      "mcpServer/tool/call",
      (params, connection) => {
        const result = this.registry.call(params, connection);
        if (!pendingToolCall(result)) return result;
        return deferredAppServerResponse(({ resolve, reject }) => {
          const timeoutMs = Number.isFinite(result.timeoutMs)
            ? Math.max(1, Number(result.timeoutMs))
            : DEFAULT_TOOL_TIMEOUT_MS;
          this.pending.add({
            connection,
            call: result,
            deadlineMs: Date.now() + timeoutMs,
            resolve,
            reject,
          });
          this.schedulePoll(0);
        });
      },
    ));
    ctx.effect(() => ctx.appServer.onInitialize((connection) => {
      for (const server of this.registry.servers.values()) {
        if (server.visible?.(connection) === false) continue;
        ctx.appServer.notifyAfter(
          connection,
          "mcpServer/startupStatus/updated",
          startupReadyParams(server),
        );
      }
    }));
    ctx.effect(() => ctx.appServer.onClose((connection) => this.cancelForConnection(connection)));
    ctx.effect(() => () => {
      for (const entry of [...this.pending]) this.finish(entry, null, new Error("MCP registry stopped"));
    });
  }

  registerServer(server: McpServerRegistration): () => boolean {
    const dispose = this.registry.registerServer(server);
    this.notifyReady(server);
    return dispose;
  }

  replaceServer(server: McpServerRegistration): () => boolean {
    const restore = this.registry.replaceServer(server);
    this.notifyReady(server);
    return restore;
  }

  removeServer(name: string): boolean {
    const server = this.registry.servers.get(name);
    if (!server || !this.registry.removeServer(name)) return false;
    for (const connection of this.ctx.appServer.connections) {
      if (!connection.initialized || server.visible?.(connection) === false) continue;
      this.ctx.appServer.send(connection, {
        method: "mcpServer/startupStatus/updated",
        params: {
          name: server.name,
          status: "cancelled",
          threadId: null,
          error: null,
          failureReason: null,
        },
      });
    }
    return true;
  }

  private notifyReady(server: McpServerRegistration): void {
    for (const connection of this.ctx.appServer.connections) {
      if (!connection.initialized || server.visible?.(connection) === false) continue;
      this.ctx.appServer.send(connection, {
        method: "mcpServer/startupStatus/updated",
        params: startupReadyParams(server),
      });
    }
  }

  callTool(
    invocation: McpToolInvocation,
    connection: AppServerConnection,
  ): McpToolCallResult | PendingMcpToolCall {
    return this.registry.call({
      server: invocation.server,
      tool: invocation.tool,
      threadId: invocation.threadId,
      arguments: invocation.arguments ?? {},
      _meta: invocation.meta,
    }, connection);
  }

  tick(): void {
    if (this.pending.size === 0) return;
    const now = Date.now();
    for (const entry of [...this.pending]) {
      if (now >= entry.deadlineMs) {
        this.finish(entry, null, rpcError(-32000, "MCP tool call timed out"));
        continue;
      }
      try {
        const result = entry.call.poll();
        if (result !== null) this.finish(entry, result, null);
      } catch (error) {
        this.finish(entry, null, error);
      }
    }
    if (this.pending.size > 0) this.schedulePoll(POLL_DELAY_MS);
  }

  private schedulePoll(delayMs: number): void {
    if (typeof globalThis.hostEvents?.wakeAfter === "function") {
      globalThis.hostEvents.wakeAfter(delayMs);
    } else {
      globalThis.hostEvents?.notify?.();
    }
  }

  private cancelForConnection(connection: AppServerConnection): void {
    for (const entry of [...this.pending]) {
      if (entry.connection !== connection) continue;
      this.pending.delete(entry);
      try {
        entry.call.cancel?.();
      } catch {}
    }
  }

  private finish(entry: PendingCall, result: McpToolCallResult | null, error: unknown): void {
    if (!this.pending.delete(entry)) return;
    try {
      entry.call.cancel?.();
    } catch {}
    if (error === null && result !== null) entry.resolve(result);
    else entry.reject(error ?? new Error("MCP tool call failed"));
  }
}
