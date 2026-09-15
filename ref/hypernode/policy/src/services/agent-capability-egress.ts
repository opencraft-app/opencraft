import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AgentCapabilityBinding,
  AgentCapabilityEgressPort,
  AgentCapabilityRequest,
  AgentCapabilityResult,
} from "../types/agent-capability.ts";
import type { AppServerConnection, JsonRpcRequest } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadSearchResult } from "../types/administrator.ts";
import { MCP_APP_AGENT_BODY } from "./mcp-app-builder.ts";
import {
  supportsVelaBrowserCapability,
  VELA_BROWSER_CAPABILITY_BINDINGS,
} from "./vela-web-preview-capability.ts";

const SEARCH_CAPABILITY = "conversation.search";
const MCP_APP_BUILDER_CAPABILITY = "mcp-app.manage";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type Dependencies = "appServer" | "mcpAppBuilder" | "threadManager" | "threadSearch" | "userDirectory";

interface PendingClientToolCall {
  readonly id: string;
  readonly callKey: string;
  readonly connection: AppServerConnection;
  readonly threadId: string;
  readonly callId: string;
  readonly resolve: (result: AgentCapabilityResult) => void;
  readonly reject: (error: Error) => void;
}

function callKey(threadId: string, callId: string): string {
  return JSON.stringify([threadId, callId]);
}

function responseText(value: unknown): AgentCapabilityResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Vela returned an invalid dynamic tool response");
  }
  const response = value as Record<string, unknown>;
  const contentItems = Array.isArray(response["contentItems"])
    ? response["contentItems"]
    : [];
  const text = contentItems.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    if (item["type"] === "inputText" && typeof item["text"] === "string") {
      return [item["text"]];
    }
    if (item["type"] === "inputImage" && typeof item["imageUrl"] === "string") {
      return [`<browser-image url=${JSON.stringify(item["imageUrl"])} />`];
    }
    if (item["type"] === "inputAudio" && typeof item["audioUrl"] === "string") {
      return [`<browser-audio url=${JSON.stringify(item["audioUrl"])} />`];
    }
    return [];
  }).join("\n");
  if (response["success"] !== true) {
    throw new Error(text || "Vela browser capability failed");
  }
  return { text: text || "Vela browser capability completed without textual output." };
}

const MCP_APP_BUILDER_BINDING: AgentCapabilityBinding = Object.freeze({
  capabilityId: MCP_APP_BUILDER_CAPABILITY,
  skill: Object.freeze({
    name: "build-mcp-app",
    description: "Build or modify a complete Hypernode MCP App from one natural-language request.",
    instructions: MCP_APP_AGENT_BODY,
  }),
  tool: Object.freeze({
    name: "manage_mcp_app",
    description: "Validate, publish, inspect, unpublish, delete, or roll back a hot-reloadable Hypernode MCP App. Do not create a standalone MCP project in the workspace.",
    parameters: Object.freeze({
      action: Object.freeze({
        type: "string",
        required: true,
        description: "One of list, get, validate, publish, rollback, unpublish, or delete.",
      }),
      spec_json: Object.freeze({
        type: "string",
        description: "Complete serialized MCP App spec for validate or publish.",
      }),
      app_id: Object.freeze({
        type: "string",
        description: "App ID for get, rollback, unpublish, or delete.",
      }),
      revision: Object.freeze({
        type: "number",
        description: "Immutable release number for rollback.",
      }),
    }),
  }),
});

const SEARCH_BINDING: AgentCapabilityBinding = Object.freeze({
  capabilityId: SEARCH_CAPABILITY,
  skill: Object.freeze({
    name: "search-conversations",
    description: "Search all durable HyperNode conversations except the current management conversation.",
    instructions: [
      "Use the `search_conversations` tool when the administrator asks about another task, conversation, decision, message, or historical activity.",
      "The service searches the authoritative SQLite FTS index over canonical conversation history.",
      "The current management conversation is always excluded by the server to prevent recursive self-search.",
      "Do not attempt to open the HyperNode SQLite database directly and do not invent results that the tool did not return.",
    ].join("\n\n"),
  }),
  tool: Object.freeze({
    name: "search_conversations",
    description: "Search durable HyperNode conversation history. The current management conversation is excluded automatically.",
    parameters: Object.freeze({
      query: Object.freeze({
        type: "string",
        required: true,
        description: "Words, phrase, task title, decision, or message text to search for.",
      }),
      limit: Object.freeze({
        type: "number",
        description: "Maximum results to return. Defaults to 10 and is capped at 50.",
      }),
    }),
  }),
});

function normalizedQuery(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizedLimit(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(numeric)));
}

function renderResults(query: string, results: ThreadSearchResult[]): string {
  if (results.length === 0) return `没有找到包含“${query}”的其他会话。`;
  const lines = [`其他会话全文搜索：${query}`, ""];
  for (const result of results) {
    const compact = result.content.replace(/\s+/g, " ").trim();
    const excerpt = compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
    const state = result.archived ? " · 已归档" : "";
    lines.push(`- **${result.threadName}**${state} · ${result.role}`);
    lines.push(`  ${excerpt}`);
    lines.push(
      `  Thread: \`${result.threadId}\`` +
      (result.turnId ? ` · Turn: \`${result.turnId}\`` : ""),
    );
  }
  return lines.join("\n");
}

/**
 * Narrow authority boundary between replaceable Agent engines and HyperNode.
 *
 * Engines receive declarative Skill/Tool bindings, never a database handle.
 * Every invocation is authorized again against the principal owning the
 * active Turn because a Runtime may outlive the connection that created it.
 */
export class AgentCapabilityEgressService extends Service implements AgentCapabilityEgressPort {
  static inject = [
    "appServer",
    "mcpAppBuilder",
    "threadManager",
    "threadSearch",
    "userDirectory",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "agentCapabilityEgress");
    this.pendingClientToolCalls = new Map();
    this.pendingClientToolCallsByCall = new Map();
    this.clientToolSequence = 0;
    ctx.effect(() => ctx.appServer.intercept((message, connection) =>
      this.handleClientToolResponse(message, connection)));
    ctx.effect(() => ctx.appServer.onClose((connection) => {
      for (const pending of [...this.pendingClientToolCalls.values()]) {
        if (pending.connection === connection) {
          this.rejectClientToolCall(pending, "Vela browser client disconnected");
        }
      }
    }));
    ctx.effect(() => () => {
      for (const pending of [...this.pendingClientToolCalls.values()]) {
        this.rejectClientToolCall(pending, "Agent capability egress disposed");
      }
    });
  }

  private readonly pendingClientToolCalls: Map<string, PendingClientToolCall>;
  private readonly pendingClientToolCallsByCall: Map<string, PendingClientToolCall>;
  private clientToolSequence: number;

  bindingsForThread(
    threadId: string,
    connection: AppServerConnection | null = null,
  ): AgentCapabilityBinding[] {
    const local = this.ctx.threadManager.isRoot(threadId)
      ? [SEARCH_BINDING, MCP_APP_BUILDER_BINDING]
      : [MCP_APP_BUILDER_BINDING];
    return supportsVelaBrowserCapability(connection)
      ? [...local, ...VELA_BROWSER_CAPABILITY_BINDINGS]
      : local;
  }

  execute(
    request: AgentCapabilityRequest,
  ): AgentCapabilityResult | Promise<AgentCapabilityResult> {
    const clientBinding = VELA_BROWSER_CAPABILITY_BINDINGS.find(
      (binding) => binding.capabilityId === request.capabilityId,
    );
    if (clientBinding?.clientTool !== undefined) {
      return this.executeClientTool(request, clientBinding);
    }
    if (request.capabilityId === MCP_APP_BUILDER_CAPABILITY) {
      const principal = request.principalId
        ? this.ctx.userDirectory.find(request.principalId)
        : null;
      if (!principal) {
        throw new Error("only a registered HyperNode user may publish MCP Apps");
      }
      return this.ctx.mcpAppBuilder.executeAgent(request.arguments, principal.id);
    }
    if (request.capabilityId !== SEARCH_CAPABILITY) {
      throw new Error(`unsupported Agent capability: ${request.capabilityId}`);
    }
    if (!this.ctx.threadManager.isRoot(request.threadId)) {
      throw new Error("conversation search is available only in the HyperNode management conversation");
    }
    const principal = request.principalId
      ? this.ctx.userDirectory.find(request.principalId)
      : null;
    if (!principal) {
      throw new Error("only a registered HyperNode user may search global conversation history");
    }
    if (!this.ctx.threadSearch.available) {
      throw new Error("the conversation search index is unavailable");
    }
    const query = normalizedQuery(request.arguments["query"]);
    if (!query) throw new Error("conversation search requires a non-empty query");
    const results = this.ctx.threadSearch.search(query, {
      limit: normalizedLimit(request.arguments["limit"]),
      // This value is deliberately not accepted from the model.  It is the
      // authoritative outer Thread executing the tool.
      excludeThreadId: request.threadId,
    });
    return { text: renderResults(query, results) };
  }

  cancel(threadId: string, callId: string, reason = "Agent capability call cancelled"): boolean {
    const pending = this.pendingClientToolCallsByCall.get(callKey(threadId, callId));
    if (pending === undefined) return false;
    this.ctx.appServer.send(pending.connection, {
      method: "serverRequest/resolved",
      params: { requestId: pending.id },
    });
    this.rejectClientToolCall(pending, reason);
    return true;
  }

  private executeClientTool(
    request: AgentCapabilityRequest,
    binding: AgentCapabilityBinding,
  ): Promise<AgentCapabilityResult> {
    if (!supportsVelaBrowserCapability(request.connection)) {
      return Promise.reject(new Error(
        "The active Vela client does not advertise vela/browser-use capability version 1",
      ));
    }
    const clientTool = binding.clientTool;
    if (clientTool === undefined) {
      return Promise.reject(new Error(`Agent capability ${binding.capabilityId} has no client tool`));
    }
    const key = callKey(request.threadId, request.callId);
    if (this.pendingClientToolCallsByCall.has(key)) {
      return Promise.reject(new Error(`duplicate Agent capability call ${request.callId}`));
    }
    const id = `dsh-browser-${++this.clientToolSequence}`;
    return new Promise<AgentCapabilityResult>((resolve, reject) => {
      const pending: PendingClientToolCall = {
        id,
        callKey: key,
        connection: request.connection,
        threadId: request.threadId,
        callId: request.callId,
        resolve,
        reject,
      };
      this.pendingClientToolCalls.set(id, pending);
      this.pendingClientToolCallsByCall.set(key, pending);
      this.ctx.appServer.send(request.connection, {
        id,
        method: "item/tool/call",
        params: {
          threadId: request.threadId,
          turnId: request.turnId,
          callId: request.callId,
          namespace: clientTool.namespace,
          tool: clientTool.tool,
          arguments: request.arguments,
        },
      });
      this.ctx.appServer.defer(
        request.connection,
        clientTool.timeoutMs ?? 15_000,
        () => {
          const current = this.pendingClientToolCalls.get(id);
          if (current !== pending) return;
          this.ctx.appServer.send(request.connection, {
            method: "serverRequest/resolved",
            params: { requestId: id },
          });
          this.rejectClientToolCall(
            pending,
            `${binding.tool.name} timed out after ${clientTool.timeoutMs ?? 15_000}ms`,
          );
        },
      );
    });
  }

  private handleClientToolResponse(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): boolean {
    if (message === null || message.method !== undefined || message.id == null) return false;
    const id = String(message.id);
    const pending = this.pendingClientToolCalls.get(id);
    if (pending === undefined) return false;
    // A response ID is capability authority. Never allow another live client
    // to settle a browser call that belongs to the Turn owner.
    if (pending.connection !== connection) return true;
    this.removeClientToolCall(pending);
    const responseResult = Reflect.get(message, "result") as unknown;
    const responseError = Reflect.get(message, "error") as unknown;
    if (responseError !== undefined) {
      const errorMessage = responseError !== null && typeof responseError === "object"
        ? Reflect.get(responseError, "message")
        : null;
      pending.reject(new Error(
        typeof errorMessage === "string"
          ? errorMessage
          : "Vela browser capability returned a JSON-RPC error",
      ));
      return true;
    }
    try {
      pending.resolve(responseText(responseResult));
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  private rejectClientToolCall(pending: PendingClientToolCall, message: string): void {
    this.removeClientToolCall(pending);
    pending.reject(new Error(message));
  }

  private removeClientToolCall(pending: PendingClientToolCall): void {
    if (this.pendingClientToolCalls.get(pending.id) === pending) {
      this.pendingClientToolCalls.delete(pending.id);
    }
    if (this.pendingClientToolCallsByCall.get(pending.callKey) === pending) {
      this.pendingClientToolCallsByCall.delete(pending.callKey);
    }
  }
}
