import {
  buildPromptContent,
  type PromptAttachment,
  type PromptDisplayAttachment,
  type UploadedAttachment,
} from "./protocol";
import type { ConfigOption } from "./protocol";
export { stripDataURLPrefix } from "./protocol";

export type Role = "user" | "agent" | "system";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  sender: string;
  time: string;
  content: string;
  streaming?: boolean;
  toolCalls?: ToolCall[];
  attachments?: PromptDisplayAttachment[];
  thought?: string;
  timelineBlocks?: MessageTimelineBlock[];
}

export interface ToolCall {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  kind?: string;
  input?: unknown;
  output?: unknown;
  content?: string;
  error?: string;
}

export type MessageTimelineBlock =
  | { id: string; type: "content"; text: string }
  | { id: string; type: "thought"; text: string }
  | {
      id: string;
      type: "attachments";
      attachments: PromptDisplayAttachment[];
    }
  | { id: string; type: "tools"; toolCalls: ToolCall[] };

export interface AgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: {
    list?: unknown;
    resume?: unknown;
    close?: unknown;
    delete?: unknown;
  };
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  _meta?: {
    cloudagent?: {
      methods?: unknown[];
      field_style?: string;
    };
  };
}

export interface SessionState {
  conversationId: string;
  sessionId: string;
  configOptions: ConfigOption[];
  restoreSource: "new" | "load" | "resume";
  readOnly?: boolean;
  readOnlyReason?: string;
}

export interface CloudAgentSessionStatus {
  sessionId: string;
  state?: string;
  closed?: boolean;
  readOnly?: boolean;
  readOnlyReason?: string;
  cwd?: string;
  model?: string;
  currentResponseId?: string;
  promptInFlight?: boolean;
  runtimeGeneration?: number;
  sessionProxyID?: string;
  envdProxyDomain?: string;
  cleanupPending?: boolean;
  lastRuntimeError?: string;
  sandbox?: {
    backend?: string;
    sandboxTemplateId?: string;
    runtimeId?: string;
    outerSandboxId?: string;
    outerSandboxDomain?: string;
    innerSandboxId?: string;
    daemonAddr?: string;
    remoteBinary?: string;
    hasOuterEnvdAccessToken?: boolean;
    hasOuterTrafficToken?: boolean;
  };
}

export interface ListedSession {
  sessionId: string;
  cwd?: string;
  title?: string;
  updatedAt?: string;
  state?: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  additionalDirectories?: string[];
}

export interface UsageState {
  used: number;
  size: number;
  cost?: number;
}

export interface PermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface PermissionRequest {
  requestId: string | number;
  conversationId: string;
  sessionId: string;
  title: string;
  options: PermissionOption[];
}

export interface SendPromptOptions {
  optimistic?: boolean;
}

export interface AcpClientEvents {
  onStatus(status: "connecting" | "connected" | "disconnected" | "error"): void;
  onReady(capabilities: AgentCapabilities): void;
  onMessage(message: ChatMessage): void;
  onSession(state: SessionState): void;
  onSessionList(sessions: ListedSession[]): void;
  onControlOptions(conversationId: string, configOptions: ConfigOption[]): void;
  onError(error: {
    code: string;
    kind: string;
    message?: string;
    conversationId?: string;
  }): void;
  onTrace(direction: "send" | "recv", message: unknown): void;
  onAvailableCommands?(conversationId: string, commands: unknown[]): void;
  onUsage?(conversationId: string, usage: UsageState): void;
  onPermissionRequest?(request: PermissionRequest): void;
  onTurn?(
    conversationId: string,
    state: "started" | "completed" | "failed",
  ): void;
  onSessionClosed?(conversationId: string, sessionId: string): void;
  onSessionDeleted?(conversationId: string, sessionId: string): void;
  onReplayDone?(conversationId: string): void;
  onSessionStatus?(
    conversationId: string,
    status: CloudAgentSessionStatus,
  ): void;
}

type RequestContext =
  | { type: "initialize" }
  | { type: "session/list" }
  | { type: "session/new"; conversationId: string }
  | {
      type:
        | "session/load"
        | "session/resume"
        | "session/close"
        | "session/delete";
      conversationId: string;
      sessionId: string;
    }
  | {
      type: "session/prompt";
      conversationId: string;
      runtimeGeneration: number;
    }
  | { type: "control"; conversationId: string; path: string }
  | {
      type: "cloudagent/session/status";
      conversationId: string;
      sessionId: string;
    };

export interface AcpClientOptions {
  gatewayURL?: string;
  fileUploadURL?: string;
}

export const DEFAULT_GATEWAY_IDENTITY_HEADERS = {
  "X-Tenant-ID": "tenant-live",
  "X-Project-ID": "project-live",
};

type AcpTransportMode = "app" | "raw";

interface LocationLike {
  protocol: string;
  host: string;
  search?: string;
}

export function resolveAcpWebSocketURL(
  override?: string,
  locationLike?: LocationLike,
) {
  const loc =
    locationLike ??
    (typeof window !== "undefined"
      ? window.location
      : { protocol: "http:", host: "127.0.0.1", search: "" });
  const fallbackProtocol = loc.protocol === "https:" ? "wss:" : "ws:";
  const fallbackURL = fallbackProtocol + "//" + loc.host + "/ws";
  const searchValue =
    new URLSearchParams(loc.search ?? "").get("acp_url")?.trim() ?? "";
  const raw = override?.trim() || searchValue;
  if (!raw) return fallbackURL;
  try {
    const parsed = new URL(raw, loc.protocol + "//" + loc.host);
    if (parsed.protocol === "http:") parsed.protocol = "ws:";
    else if (parsed.protocol === "https:") parsed.protocol = "wss:";
    else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:")
      return fallbackURL;
    if (parsed.pathname === "" || parsed.pathname === "/")
      parsed.pathname = "/acp";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return fallbackURL;
  }
}

export function resolveAcpTransportMode(gatewayURL: string): AcpTransportMode {
  try {
    return new URL(gatewayURL).pathname.endsWith("/acp") ? "raw" : "app";
  } catch {
    return gatewayURL.endsWith("/acp") ? "raw" : "app";
  }
}

function isRawJSONRPCMessage(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

export class AcpClient {
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private nextId = 1;
  private requestContexts = new Map<string, RequestContext>();
  private sessions = new Map<string, string>();
  private liveSessions = new Map<string, string>();
  private sessionToConversation = new Map<string, string>();
  private pendingAgentMessageId = new Map<string, string>();
  private pendingThoughtMessageId = new Map<string, string>();
  private pendingToolFirstMessageId = new Map<string, string>();
  private messageIdAliases = new Map<string, string>();
  private pendingUserEcho = new Map<string, string>();
  private toolMessageIds = new Map<string, string>();
  private toolTimelineBlockIds = new Map<string, string>();
  private activeStreamingMessageIds = new Map<string, string>();
  private runtimeGenerations = new Map<string, number>();
  private turnGenerations = new Map<string, number>();
  private activeTimelineBlock = new Map<
    string,
    { messageId: string; type: "content" | "thought" | "tools"; id: string }
  >();
  private toolStates = new Map<string, ToolCall>();
  private capabilities: AgentCapabilities = {};
  private transportMode: AcpTransportMode = "app";
  private disposed = false;

  constructor(
    private readonly events: AcpClientEvents,
    private readonly options: AcpClientOptions = {},
  ) {}

  connect() {
    this.disposed = false;
    const gatewayURL = resolveAcpWebSocketURL(this.options.gatewayURL);
    this.transportMode = resolveAcpTransportMode(gatewayURL);
    const ws = new WebSocket(gatewayURL);
    const generation = ++this.connectionGeneration;
    const isCurrentConnection = () =>
      this.ws === ws && this.connectionGeneration === generation;
    this.ws = ws;
    this.events.onStatus("connecting");
    ws.onopen = () => {
      if (!isCurrentConnection()) return;
      this.events.onStatus("connected");
      this.initialize();
    };
    ws.onclose = () => {
      if (!isCurrentConnection()) return;
      this.handleTransportLoss("disconnected");
    };
    ws.onerror = () => {
      if (!isCurrentConnection()) return;
      this.handleTransportLoss("error");
    };
    ws.onmessage = (event) => {
      if (!isCurrentConnection()) return;
      this.handleEnvelope(event.data);
    };
  }

  disconnect() {
    this.disposed = true;
    const ws = this.ws;
    this.ws = null;
    this.connectionGeneration++;
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.close();
  }

  createSession(
    conversationId: string,
    cwd = "/",
    mcpServers: unknown[] = [],
    sessionParams?: Record<string, unknown>,
  ) {
    this.sendRequest({ type: "session/new", conversationId }, "session/new", {
      cwd,
      mcpServers,
      ...(sessionParams ?? {}),
    });
  }

  resumeSession(
    conversationId: string,
    sessionId: string,
    cwd = "/",
    mcpServers?: unknown[],
    additionalDirectories?: string[],
  ) {
    this.bindSession(conversationId, sessionId);
    const params: Record<string, unknown> = { sessionId, cwd };
    if (mcpServers) params.mcpServers = mcpServers;
    if (additionalDirectories)
      params.additionalDirectories = additionalDirectories;
    this.sendRequest(
      { type: "session/resume", conversationId, sessionId },
      "session/resume",
      params,
    );
  }

  loadSession(
    conversationId: string,
    sessionId: string,
    cwd = "/",
    mcpServers: unknown[],
    additionalDirectories?: string[],
  ) {
    this.bindSession(conversationId, sessionId);
    const params: Record<string, unknown> = { sessionId, cwd, mcpServers };
    if (additionalDirectories)
      params.additionalDirectories = additionalDirectories;
    this.sendRequest(
      { type: "session/load", conversationId, sessionId },
      "session/load",
      params,
    );
  }

  listSessions(cwd?: string) {
    const params = cwd ? { cwd } : {};
    this.sendRequest({ type: "session/list" }, "session/list", params);
  }

  setActiveSession(conversationId: string, sessionId: string) {
    this.bindSession(conversationId, sessionId);
    this.liveSessions.set(conversationId, sessionId);
  }

  bindSession(conversationId: string, sessionId: string) {
    this.sessions.set(conversationId, sessionId);
    this.sessionToConversation.set(sessionId, conversationId);
  }

  hasActiveSession(conversationId: string, sessionId?: string) {
    const activeSessionId = this.liveSessions.get(conversationId);
    return sessionId ? activeSessionId === sessionId : Boolean(activeSessionId);
  }

  sendPrompt(
    conversationId: string,
    text: string,
    files: PromptAttachment[],
    options: SendPromptOptions = {},
  ) {
    if (files.some((file) => file.file && !file.uploaded)) {
      void this.sendPromptAsync(conversationId, text, files, options);
      return;
    }
    this.sendPreparedPrompt(conversationId, text, files, options);
  }

  private async sendPromptAsync(
    conversationId: string,
    text: string,
    files: PromptAttachment[],
    options: SendPromptOptions,
  ) {
    let preparedFiles: PromptAttachment[];
    try {
      preparedFiles = await this.uploadPromptAttachments(files);
    } catch (error) {
      this.events.onError({
        code: "unsupported",
        kind: "attachment_upload_failed",
        message:
          error instanceof Error ? error.message : "Attachment upload failed",
        conversationId,
      });
      return;
    }
    this.sendPreparedPrompt(conversationId, text, preparedFiles, options);
  }

  private sendPreparedPrompt(
    conversationId: string,
    text: string,
    files: PromptAttachment[],
    options: SendPromptOptions,
  ) {
    const sessionId = this.liveSessions.get(conversationId);
    if (!sessionId) {
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message: "No live ACP session",
        conversationId,
      });
      return;
    }
    const built = buildPromptContent({
      text,
      files,
      capabilities: this.capabilities.promptCapabilities ?? {},
    });
    if (!built.ok) {
      this.events.onError({
        code: built.error?.code ?? "unsupported",
        kind: built.error?.kind ?? "attachment_type_unavailable",
        message: built.error?.message,
        conversationId,
      });
      return;
    }
    this.clearAssistantTurnState(conversationId);
    const runtimeGeneration = this.bumpRuntimeGeneration(conversationId);
    const textForEcho = text.trim();
    if (textForEcho) this.pendingUserEcho.set(conversationId, textForEcho);
    this.events.onTurn?.(conversationId, "started");
    if (options.optimistic !== false) {
      this.events.onMessage({
        id: crypto.randomUUID(),
        conversationId,
        role: "user",
        sender: "meo",
        time: timeLabel(),
        content: text,
        attachments: built.displayAttachments,
      });
    }
    this.sendRequest(
      { type: "session/prompt", conversationId, runtimeGeneration },
      "session/prompt",
      { sessionId, prompt: built.prompt },
    );
  }

  cancel(conversationId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      this.sendNotification("session/cancel", { sessionId });
    }
  }

  closeSession(conversationId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return false;
    this.settleStreamingMessage(conversationId);
    this.bumpRuntimeGeneration(conversationId);
    this.sendRequest(
      { type: "session/close", conversationId, sessionId },
      "session/close",
      { sessionId },
    );
    return true;
  }

  deleteSession(conversationId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return false;
    this.settleStreamingMessage(conversationId);
    this.bumpRuntimeGeneration(conversationId);
    this.sendRequest(
      { type: "session/delete", conversationId, sessionId },
      "session/delete",
      { sessionId },
    );
    return true;
  }

  resetConversationRuntime(conversationId: string) {
    this.bumpRuntimeGeneration(conversationId);
    this.clearConversationRuntime(conversationId);
  }

  resolvePermission(request: PermissionRequest, optionId: string) {
    this.send({
      jsonrpc: "2.0",
      id: request.requestId,
      result: { outcome: { outcome: "selected", optionId } },
    });
  }

  cancelPermission(request: PermissionRequest) {
    this.send({
      jsonrpc: "2.0",
      id: request.requestId,
      result: { outcome: { outcome: "cancelled" } },
    });
  }

  setConfigOption(conversationId: string, configId: string, value: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return;
    this.sendRequest(
      { type: "control", conversationId, path: "session/set_config_option" },
      "session/set_config_option",
      {
        sessionId,
        configId,
        value,
      },
    );
  }

  setModelFallback(conversationId: string, modelId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return;
    this.sendRequest(
      { type: "control", conversationId, path: "session/set_model" },
      "session/set_model",
      { sessionId, modelId },
    );
  }

  setModeFallback(conversationId: string, modeId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return;
    this.sendRequest(
      { type: "control", conversationId, path: "session/set_mode" },
      "session/set_mode",
      { sessionId, modeId },
    );
  }

  supportsImages() {
    return this.capabilities.promptCapabilities?.image === true;
  }

  requestSessionStatus(conversationId: string, sessionId: string) {
    if (!sessionId) return false;
    this.sendRequest(
      { type: "cloudagent/session/status", conversationId, sessionId },
      "_cloudagent.session.status",
      { session_id: sessionId },
    );
    return true;
  }

  private initialize() {
    this.sendRequest({ type: "initialize" }, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "mychat-acp-web", version: "0.1.0" },
      clientCapabilities: {},
    });
  }

  private sendRequest(
    context: RequestContext,
    method: string,
    params: unknown,
  ) {
    const id = this.nextId++;
    this.requestContexts.set(String(id), context);
    if (this.send({ jsonrpc: "2.0", id, method, params })) return;
    this.requestContexts.delete(String(id));
    if (this.disposed) return;
    this.handleRequestSendFailure(context);
  }

  private sendNotification(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      if (this.transportMode === "raw") {
        this.events.onTrace("send", message);
        this.ws.send(JSON.stringify(message));
      } else {
        this.ws.send(JSON.stringify({ type: "acp", message }));
      }
      return true;
    } catch {
      return false;
    }
  }

  private handleRequestSendFailure(context: RequestContext) {
    const message = "Gateway is not connected";
    if (context.type === "session/list") {
      this.events.onError({
        code: "restore_failed",
        kind: "session_list_unavailable",
        message,
      });
      return;
    }
    if (context.type === "session/new") {
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (
      context.type === "session/load" ||
      context.type === "session/resume" ||
      context.type === "session/close" ||
      context.type === "session/delete"
    ) {
      if (
        context.type === "session/load" ||
        context.type === "session/resume"
      ) {
        this.clearSessionBinding(context.conversationId, context.sessionId);
      }
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (context.type === "session/prompt") {
      this.pendingUserEcho.delete(context.conversationId);
      if (this.isCurrentRuntime(context)) {
        this.clearConversationRuntime(context.conversationId);
        this.events.onTurn?.(context.conversationId, "failed");
      }
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (context.type === "control") {
      this.events.onError({
        code: "unsupported",
        kind: "control_path_unavailable",
        message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (context.type === "cloudagent/session/status") {
      return;
    }
    this.events.onError({
      code: "restore_failed",
      kind: "resume_rejected",
      message,
    });
  }

  private handleTransportLoss(status: "disconnected" | "error") {
    const promptConversationIds = new Set<string>();
    for (const context of this.requestContexts.values()) {
      if (context.type === "session/prompt")
        promptConversationIds.add(context.conversationId);
    }
    const streamingConversationIds = [...this.activeStreamingMessageIds.keys()];
    this.requestContexts.clear();
    streamingConversationIds.forEach((conversationId) =>
      this.settleStreamingMessage(conversationId),
    );
    promptConversationIds.forEach((conversationId) =>
      this.bumpRuntimeGeneration(conversationId),
    );
    this.pendingAgentMessageId.clear();
    this.pendingThoughtMessageId.clear();
    this.pendingToolFirstMessageId.clear();
    this.messageIdAliases.clear();
    this.pendingUserEcho.clear();
    this.activeStreamingMessageIds.clear();
    this.activeTimelineBlock.clear();
    this.toolMessageIds.clear();
    this.toolTimelineBlockIds.clear();
    this.toolStates.clear();
    this.sessions.clear();
    this.liveSessions.clear();
    this.sessionToConversation.clear();
    promptConversationIds.forEach((conversationId) =>
      this.events.onTurn?.(conversationId, "failed"),
    );
    this.events.onStatus(status);
  }

  private handleEnvelope(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message:
          error instanceof Error
            ? `Invalid gateway envelope: ${error.message}`
            : "Invalid gateway envelope",
      });
      return;
    }
    if (isRawJSONRPCMessage(parsed)) {
      this.events.onTrace("recv", parsed);
      this.handleAcp(parsed);
      return;
    }
    const envelope = parsed as {
      type?: string;
      direction?: "send" | "recv";
      message?: unknown;
      error?: { code: string; kind: string; message?: string };
    };
    if (envelope.type === "error" && envelope.error) {
      this.events.onError(envelope.error);
      return;
    }
    if (envelope.type !== "acp" || !envelope.message) return;
    if (envelope.direction)
      this.events.onTrace(envelope.direction, envelope.message);
    if (envelope.direction === "recv")
      this.handleAcp(envelope.message as Record<string, unknown>);
  }

  private handleAcp(message: Record<string, unknown>) {
    if (message.method === "session/update") {
      const params = message.params as
        | { sessionId?: string; update?: Record<string, unknown> }
        | undefined;
      const conversationId = params?.sessionId
        ? this.sessionToConversation.get(params.sessionId)
        : undefined;
      if (conversationId) this.handleUpdate(conversationId, params?.update);
      return;
    }
    const id =
      typeof message.id === "number" || typeof message.id === "string"
        ? String(message.id)
        : "";
    if (message.method === "session/request_permission" && id) {
      this.handlePermissionRequest(message);
      return;
    }
    const context = this.requestContexts.get(id);
    if (id) this.requestContexts.delete(id);
    if (message.error) {
      this.handleRPCError(context, message.error);
      return;
    }
    if (context?.type === "session/prompt") {
      if (this.isCurrentRuntime(context)) {
        this.clearConversationRuntime(context.conversationId);
        this.events.onTurn?.(context.conversationId, "completed");
      }
    }
    const result =
      "result" in message &&
      message.result &&
      typeof message.result === "object"
        ? (message.result as Record<string, unknown>)
        : {};
    if (context?.type === "initialize") {
      this.capabilities = (result.agentCapabilities ?? {}) as AgentCapabilities;
      this.events.onReady(this.capabilities);
      return;
    }
    if (context?.type === "session/list") {
      const sessions = Array.isArray(result.sessions)
        ? result.sessions.flatMap(readListedSession)
        : [];
      this.events.onSessionList(sessions);
      return;
    }
    if (
      context?.type === "session/new" &&
      typeof result.sessionId === "string"
    ) {
      const conversationId = context.conversationId;
      this.setActiveSession(conversationId, result.sessionId);
      const configOptions = Array.isArray(result.configOptions)
        ? (result.configOptions as ConfigOption[])
        : [];
      this.events.onSession({
        conversationId,
        sessionId: result.sessionId,
        configOptions,
        restoreSource: "new",
      });
      return;
    }
    if (
      context &&
      (context.type === "session/load" || context.type === "session/resume")
    ) {
      const configOptions = Array.isArray(result.configOptions)
        ? (result.configOptions as ConfigOption[])
        : [];
      if (context.type === "session/resume")
        this.setActiveSession(context.conversationId, context.sessionId);
      else this.bindSession(context.conversationId, context.sessionId);
      this.events.onSession({
        conversationId: context.conversationId,
        sessionId: context.sessionId,
        configOptions,
        restoreSource: context.type === "session/load" ? "load" : "resume",
        readOnly:
          typeof result.readOnly === "boolean"
            ? result.readOnly
            : typeof result.read_only === "boolean"
              ? result.read_only
              : undefined,
        readOnlyReason:
          typeof result.readOnlyReason === "string"
            ? result.readOnlyReason
            : typeof result.read_only_reason === "string"
              ? result.read_only_reason
            : undefined,
      });
      return;
    }
    if (context?.type === "session/close") {
      this.clearLiveSession(context.conversationId, context.sessionId);
      this.events.onSessionClosed?.(context.conversationId, context.sessionId);
      return;
    }
    if (context?.type === "session/delete") {
      this.clearSessionBinding(context.conversationId, context.sessionId);
      this.clearConversationRuntime(context.conversationId);
      this.events.onSessionDeleted?.(context.conversationId, context.sessionId);
      return;
    }
    if (context?.type === "control" && Array.isArray(result.configOptions)) {
      this.events.onControlOptions(
        context.conversationId,
        result.configOptions as ConfigOption[],
      );
      return;
    }
    if (context?.type === "cloudagent/session/status") {
      const status = readCloudAgentSessionStatus(result, context.sessionId);
      if (status) this.events.onSessionStatus?.(context.conversationId, status);
    }
  }

  private handleRPCError(context: RequestContext | undefined, error: unknown) {
    const rpcError = error as { message?: string; data?: Record<string, unknown> };
    if (context?.type === "cloudagent/session/status") {
      return;
    }
    if (context?.type === "control") {
      this.events.onError({
        code: "unsupported",
        kind: "control_path_unavailable",
        message: rpcError.message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (
      context?.type === "session/resume" ||
      context?.type === "session/load" ||
      context?.type === "session/close" ||
      context?.type === "session/delete"
    ) {
      if (
        context.type === "session/resume" ||
        context.type === "session/load" ||
        context.type === "session/delete"
      ) {
        this.clearSessionBinding(context.conversationId, context.sessionId);
      }
      this.events.onError({
        code: "restore_failed",
        kind: "resume_rejected",
        message: rpcError.message,
        conversationId: context.conversationId,
      });
      return;
    }
    if (context?.type === "session/list") {
      this.events.onError({
        code: "restore_failed",
        kind: "session_list_unavailable",
        message: rpcError.message,
      });
      return;
    }
    if (context?.type === "session/prompt") {
      this.pendingUserEcho.delete(context.conversationId);
      if (this.isCurrentRuntime(context)) {
        this.clearConversationRuntime(context.conversationId);
        this.events.onTurn?.(context.conversationId, "failed");
      }
      if (
        rpcError.data?.error_code === "session_read_only" ||
        rpcError.data?.read_only_reason
      ) {
        this.clearLiveSession(context.conversationId);
        this.events.onError({
          code: "restore_failed",
          kind: "session_read_only",
          message:
            readString(rpcError.data.read_only_reason) ??
            rpcError.message ??
            "session is read-only",
          conversationId: context.conversationId,
        });
        return;
      }
      this.events.onError({
        code: "provider_rejected",
        kind: "provider_error",
        message: rpcError.message,
        conversationId: context.conversationId,
      });
      return;
    }
    this.events.onError({
      code: "restore_failed",
      kind: "resume_rejected",
      message: rpcError.message,
    });
  }

  private handlePermissionRequest(message: Record<string, unknown>) {
    const params = message.params as
      | {
          sessionId?: string;
          options?: unknown[];
          toolCall?: Record<string, unknown>;
        }
      | undefined;
    const sessionId = params?.sessionId;
    const requestId = message.id;
    if (
      !sessionId ||
      !(typeof requestId === "number" || typeof requestId === "string")
    )
      return;
    const conversationId = this.sessionToConversation.get(sessionId);
    if (!conversationId) {
      this.send({
        jsonrpc: "2.0",
        id: requestId,
        result: { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    const options = Array.isArray(params.options)
      ? params.options.flatMap(readPermissionOption)
      : [];
    const title =
      readString(params.toolCall?.title) ??
      readString(params.toolCall?.name) ??
      readString(params.toolCall?.kind) ??
      "Tool permission";
    this.events.onPermissionRequest?.({
      requestId,
      conversationId,
      sessionId,
      title,
      options,
    });
  }

  private handleUpdate(
    conversationId: string,
    update?: Record<string, unknown>,
  ) {
    if (!update) return;
    if (update.sessionUpdate === "replay_done") {
      this.events.onReplayDone?.(conversationId);
      return;
    }
    if (
      update.sessionUpdate === "config_option_update" &&
      Array.isArray(update.configOptions)
    ) {
      this.events.onControlOptions(
        conversationId,
        update.configOptions as ConfigOption[],
      );
    }
    if (
      update.sessionUpdate === "available_commands_update" &&
      Array.isArray(update.availableCommands)
    ) {
      this.events.onAvailableCommands?.(
        conversationId,
        update.availableCommands,
      );
    }
    if (update.sessionUpdate === "usage_update") {
      const used = typeof update.used === "number" ? update.used : undefined;
      const size = typeof update.size === "number" ? update.size : undefined;
      if (typeof used === "number" && typeof size === "number") {
        this.events.onUsage?.(conversationId, {
          used,
          size,
          cost: typeof update.cost === "number" ? update.cost : undefined,
        });
      }
    }
    if (update.sessionUpdate === "user_message_chunk") {
      const content = update.content as { text?: string } | undefined;
      const text = content?.text ?? "";
      if (text) {
        const consumedUserEcho = this.consumePendingUserEcho(
          conversationId,
          text,
        );
        this.clearAssistantTurnState(conversationId);
        if (consumedUserEcho) return;
        this.bumpTurnGeneration(conversationId);
        this.events.onMessage({
          id:
            this.resolveWireMessageId(conversationId, readChunkMessageId(update)) ??
            crypto.randomUUID(),
          conversationId,
          role: "user",
          sender: "meo",
          time: timeLabel(),
          content: text,
        });
      }
    }
    if (
      update.sessionUpdate === "attachment" ||
      update.sessionUpdate === "artifact"
    ) {
      const attachments = readSessionUpdateAttachments(update);
      if (!attachments.length) return;
      const kind = readString(update.kind);
      const role = kind === "artifact" || update.sessionUpdate === "artifact"
        ? "agent"
        : "user";
      const wireMessageId = readChunkMessageId(update);
      const messageId =
        this.resolveWireMessageId(conversationId, wireMessageId) ??
        this.pendingAgentMessageId.get(conversationId) ??
        crypto.randomUUID();
      if (role === "agent") {
        this.pendingAgentMessageId.set(conversationId, messageId);
      }
      const blockId =
        readString(update.blockId) ??
        readString(update.block_id) ??
        `${messageId}:attachments`;
      this.events.onMessage({
        id: messageId,
        conversationId,
        role,
        sender: role === "agent" ? "主AGENTS" : "meo",
        time: timeLabel(),
        content: "",
        attachments,
        timelineBlocks: [
          {
            id: blockId,
            type: "attachments",
            attachments,
          },
        ],
      });
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { text?: string } | undefined;
      const text = content?.text ?? "";
      const wireMessageId = readChunkMessageId(update);
      const existingId =
        this.resolveAssistantMessageId(conversationId, wireMessageId) ??
        this.pendingAgentMessageId.get(conversationId);
      if (!existingId) {
        const id = crypto.randomUUID();
        this.pendingAgentMessageId.set(conversationId, id);
        this.activateStreamingMessage(conversationId, id);
        this.events.onMessage({
          id,
          conversationId,
          role: "agent",
          sender: "主AGENTS",
          time: timeLabel(),
          content: text,
          streaming: true,
          timelineBlocks: [
            {
              id: this.resolveTimelineBlockId(conversationId, id, "content"),
              type: "content",
              text,
            },
          ],
        });
      } else {
        this.pendingAgentMessageId.set(conversationId, existingId);
        this.activateStreamingMessage(conversationId, existingId);
        this.events.onMessage({
          id: existingId,
          conversationId,
          role: "agent",
          sender: "主AGENTS",
          time: timeLabel(),
          content: text,
          streaming: true,
          timelineBlocks: [
            {
              id: this.resolveTimelineBlockId(
                conversationId,
                existingId,
                "content",
              ),
              type: "content",
              text,
            },
          ],
        });
      }
    }
    if (update.sessionUpdate === "agent_thought_chunk") {
      const content = update.content as { text?: string } | undefined;
      const text = content?.text ?? "";
      if (!text) return;
      const wireMessageId = readChunkMessageId(update);
      const existingId =
        this.resolveAssistantMessageId(conversationId, wireMessageId) ??
        this.pendingThoughtMessageId.get(conversationId) ??
        this.pendingAgentMessageId.get(conversationId);
      if (!existingId) {
        const id = crypto.randomUUID();
        this.pendingThoughtMessageId.set(conversationId, id);
        this.pendingAgentMessageId.set(conversationId, id);
        this.activateStreamingMessage(conversationId, id);
        this.events.onMessage({
          id,
          conversationId,
          role: "agent",
          sender: "主AGENTS",
          time: timeLabel(),
          content: "",
          streaming: true,
          thought: text,
          timelineBlocks: [
            {
              id: this.resolveTimelineBlockId(conversationId, id, "thought"),
              type: "thought",
              text,
            },
          ],
        });
      } else {
        this.pendingThoughtMessageId.set(conversationId, existingId);
        this.pendingAgentMessageId.set(conversationId, existingId);
        this.activateStreamingMessage(conversationId, existingId);
        this.events.onMessage({
          id: existingId,
          conversationId,
          role: "agent",
          sender: "主AGENTS",
          time: timeLabel(),
          content: "",
          streaming: true,
          thought: text,
          timelineBlocks: [
            {
              id: this.resolveTimelineBlockId(
                conversationId,
                existingId,
                "thought",
              ),
              type: "thought",
              text,
            },
          ],
        });
      }
    }
    if (
      update.sessionUpdate === "tool_call_update" ||
      update.sessionUpdate === "tool_call"
    ) {
      const tool = readToolCall(update);
      const stateKey = `${conversationId}:${tool.id}`;
      const previous = this.toolStates.get(stateKey);
      const nextTool: ToolCall = {
        id: tool.id,
        name: tool.name ?? previous?.name ?? tool.id,
        status: tool.status ?? previous?.status ?? "running",
      };
      const kind = tool.kind ?? previous?.kind;
      const input = tool.input ?? previous?.input;
      const output = tool.output ?? previous?.output;
      const content = tool.content ?? previous?.content;
      const error = tool.error ?? previous?.error;
      if (kind) nextTool.kind = kind;
      if (input !== undefined) nextTool.input = input;
      if (output !== undefined) nextTool.output = output;
      if (content) nextTool.content = content;
      if (error) nextTool.error = error;
      this.toolStates.set(stateKey, nextTool);
      const existingTurnMessageId =
        this.pendingAgentMessageId.get(conversationId) ??
        this.pendingThoughtMessageId.get(conversationId);
      let messageId =
        this.toolMessageIds.get(stateKey) ?? existingTurnMessageId;
      if (!messageId) {
        messageId = crypto.randomUUID();
        this.pendingToolFirstMessageId.set(conversationId, messageId);
      }
      this.toolMessageIds.set(stateKey, messageId);
      const timelineBlockId =
        this.toolTimelineBlockIds.get(stateKey) ??
        this.resolveTimelineBlockId(conversationId, messageId, "tools");
      this.toolTimelineBlockIds.set(stateKey, timelineBlockId);
      this.pendingAgentMessageId.set(conversationId, messageId);
      this.pendingThoughtMessageId.set(conversationId, messageId);
      this.activateStreamingMessage(conversationId, messageId);
      this.events.onMessage({
        id: messageId,
        conversationId,
        role: "agent",
        sender: "主AGENTS",
        time: timeLabel(),
        content: "",
        streaming: true,
        toolCalls: [nextTool],
        timelineBlocks: [
          {
            id: timelineBlockId,
            type: "tools",
            toolCalls: [nextTool],
          },
        ],
      });
    }
  }

  private clearSessionBinding(conversationId: string, sessionId?: string) {
    const boundSessionId = this.sessions.get(conversationId);
    if (boundSessionId && (!sessionId || boundSessionId === sessionId)) {
      this.sessions.delete(conversationId);
      this.sessionToConversation.delete(boundSessionId);
    }
    const liveSessionId = this.liveSessions.get(conversationId);
    if (liveSessionId && (!sessionId || liveSessionId === sessionId)) {
      this.liveSessions.delete(conversationId);
    }
  }

  private clearLiveSession(conversationId: string, sessionId?: string) {
    const liveSessionId = this.liveSessions.get(conversationId);
    if (liveSessionId && (!sessionId || liveSessionId === sessionId)) {
      this.liveSessions.delete(conversationId);
    }
  }

  private activateStreamingMessage(conversationId: string, messageId: string) {
    this.activeStreamingMessageIds.set(conversationId, messageId);
  }

  private settleStreamingMessage(conversationId: string) {
    const messageId = this.activeStreamingMessageIds.get(conversationId);
    if (!messageId) return;
    this.activeStreamingMessageIds.delete(conversationId);
    this.events.onMessage({
      id: messageId,
      conversationId,
      role: "agent",
      sender: "主AGENTS",
      time: timeLabel(),
      content: "",
      streaming: false,
    });
  }

  private bumpRuntimeGeneration(conversationId: string) {
    const next = (this.runtimeGenerations.get(conversationId) ?? 0) + 1;
    this.runtimeGenerations.set(conversationId, next);
    return next;
  }

  private isCurrentRuntime(context: Extract<RequestContext, { type: "session/prompt" }>) {
    return (
      this.runtimeGenerations.get(context.conversationId) ===
      context.runtimeGeneration
    );
  }

  private clearConversationRuntime(conversationId: string) {
    this.clearAssistantTurnState(conversationId);
    this.pendingUserEcho.delete(conversationId);
    this.turnGenerations.delete(conversationId);
  }

  private clearAssistantTurnState(conversationId: string) {
    this.settleStreamingMessage(conversationId);
    this.pendingAgentMessageId.delete(conversationId);
    this.pendingThoughtMessageId.delete(conversationId);
    this.pendingToolFirstMessageId.delete(conversationId);
    this.activeTimelineBlock.delete(conversationId);
    this.deleteMapEntriesForConversation(this.messageIdAliases, conversationId);
    this.deleteMapEntriesForConversation(this.toolMessageIds, conversationId);
    this.deleteMapEntriesForConversation(
      this.toolTimelineBlockIds,
      conversationId,
    );
    this.deleteMapEntriesForConversation(this.toolStates, conversationId);
  }

  private deleteMapEntriesForConversation<T>(
    map: Map<string, T>,
    conversationId: string,
  ) {
    const prefix = `${conversationId}:`;
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key);
    }
  }

  private consumePendingUserEcho(conversationId: string, text: string) {
    const remaining = this.pendingUserEcho.get(conversationId);
    if (!remaining) return false;
    // ACP has no replay-complete marker; this is live-echo suppression, not a replay classifier.
    if (remaining === text) {
      this.pendingUserEcho.delete(conversationId);
      return true;
    }
    if (remaining.startsWith(text)) {
      const next = remaining.slice(text.length);
      if (next) this.pendingUserEcho.set(conversationId, next);
      else this.pendingUserEcho.delete(conversationId);
      return true;
    }
    this.pendingUserEcho.delete(conversationId);
    return false;
  }

  private resolveAssistantMessageId(
    conversationId: string,
    wireMessageId: string | undefined,
  ) {
    if (!wireMessageId) return undefined;
    const aliasKey = this.resolveWireMessageId(conversationId, wireMessageId);
    if (!aliasKey) return undefined;
    const aliased = this.messageIdAliases.get(aliasKey);
    if (aliased) return aliased;
    const toolFirstMessageId =
      this.pendingToolFirstMessageId.get(conversationId);
    if (!toolFirstMessageId) return aliasKey;
    this.messageIdAliases.set(aliasKey, toolFirstMessageId);
    this.pendingToolFirstMessageId.delete(conversationId);
    return toolFirstMessageId;
  }

  private resolveWireMessageId(conversationId: string, wireMessageId?: string) {
    if (!wireMessageId) return undefined;
    const generation = this.runtimeGenerations.get(conversationId) ?? 0;
    const turnGeneration = this.turnGenerations.get(conversationId) ?? 0;
    return `${conversationId}:${generation}:${turnGeneration}:${wireMessageId}`;
  }

  private bumpTurnGeneration(conversationId: string) {
    const next = (this.turnGenerations.get(conversationId) ?? 0) + 1;
    this.turnGenerations.set(conversationId, next);
    return next;
  }

  private resolveTimelineBlockId(
    conversationId: string,
    messageId: string,
    type: "content" | "thought" | "tools",
  ) {
    const active = this.activeTimelineBlock.get(conversationId);
    if (active?.messageId === messageId && active.type === type) {
      return active.id;
    }
    const id = crypto.randomUUID();
    this.activeTimelineBlock.set(conversationId, { messageId, type, id });
    return id;
  }

  private async uploadPromptAttachments(files: PromptAttachment[]) {
    const uploaded: PromptAttachment[] = [];
    for (const file of files) {
      if (file.uploaded || !file.file) {
        uploaded.push(file);
        continue;
      }
      const result = await this.uploadAttachment(file);
      uploaded.push({ ...file, uploaded: result });
    }
    return uploaded;
  }

  private async uploadAttachment(file: PromptAttachment): Promise<UploadedAttachment> {
    if (!file.file) throw new Error(`Missing file bytes for ${file.name}`);
    const endpoint = resolveAcpHTTPURL(
      this.options.fileUploadURL ?? "/v1/files",
      this.options.gatewayURL,
    );
    const form = new FormData();
    form.append("purpose", "assistants");
    form.append("file", file.file, file.name);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: DEFAULT_GATEWAY_IDENTITY_HEADERS,
      body: form,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Upload failed for ${file.name}: HTTP ${response.status}${body ? ` ${body}` : ""}`,
      );
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const fileId = readString(raw.id) ?? readString(raw.file_id);
    if (!fileId) throw new Error(`Upload response missing file id for ${file.name}`);
    const mimeType =
      readString(raw.content_type) ??
      readString(raw.contentType) ??
      file.type ??
      "application/octet-stream";
    const size =
      typeof raw.bytes === "number"
        ? raw.bytes
        : typeof raw.size === "number"
          ? raw.size
          : file.size;
    return {
      fileId,
      name: readString(raw.filename) ?? readString(raw.name) ?? file.name,
      mimeType,
      size,
      downloadUrl:
        readString(raw.download_url) ??
        readString(raw.downloadUrl) ??
        resolveAcpHTTPURL(`/v1/files/${encodeURIComponent(fileId)}/content`, this.options.gatewayURL),
      relativePath: file.relativePath,
    };
  }
}

export function resolveAcpHTTPURL(pathOrURL: string, gatewayOverride?: string) {
  const base = resolveAcpHTTPBaseURL(gatewayOverride);
  return new URL(pathOrURL, base).toString();
}

export function resolveEnvdProxyHTTPBaseURL(
  status: Pick<
    CloudAgentSessionStatus,
    "sessionProxyID" | "envdProxyDomain"
  > | undefined,
  gatewayOverride?: string,
) {
  const proxyID = status?.sessionProxyID?.trim();
  const domain = status?.envdProxyDomain?.trim().replace(/^\.+|\.+$/g, "");
  if (!proxyID || !domain) return undefined;
  const wsURL = resolveAcpWebSocketURL(gatewayOverride);
  const parsed = new URL(wsURL);
  const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  return `${protocol}//49983-${proxyID}.${domain}/`;
}

export function resolveEnvdFileURL(
  status: Pick<
    CloudAgentSessionStatus,
    "sessionProxyID" | "envdProxyDomain"
  > | undefined,
  workspacePath: string,
  gatewayOverride?: string,
) {
  const base = resolveEnvdProxyHTTPBaseURL(status, gatewayOverride);
  const path = workspacePath.trim();
  if (!base || !path) return undefined;
  const url = new URL("/files", base);
  url.searchParams.set("path", path);
  return url.toString();
}

function resolveAcpHTTPBaseURL(gatewayOverride?: string) {
  const wsURL = resolveAcpWebSocketURL(gatewayOverride);
  const parsed = new URL(wsURL);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function mergeChatMessage(
  existing: ChatMessage,
  incoming: ChatMessage,
): ChatMessage {
  return {
    ...existing,
    time: incoming.time || existing.time,
    content: incoming.content
      ? existing.content + incoming.content
      : existing.content,
    toolCalls: incoming.toolCalls
      ? mergeToolCalls(existing.toolCalls, incoming.toolCalls)
      : existing.toolCalls,
    attachments: incoming.attachments
      ? mergeAttachments(existing.attachments ?? [], incoming.attachments)
      : existing.attachments,
    thought: incoming.thought
      ? `${existing.thought ?? ""}${incoming.thought}`
      : existing.thought,
    timelineBlocks: incoming.timelineBlocks
      ? mergeTimelineBlocks(existing.timelineBlocks, incoming.timelineBlocks)
      : existing.timelineBlocks,
    streaming:
      incoming.streaming !== undefined ? incoming.streaming : existing.streaming,
  };
}

export function isSameChatMessageTarget(
  left: Pick<ChatMessage, "conversationId" | "id">,
  right: Pick<ChatMessage, "conversationId" | "id">,
) {
  return left.conversationId === right.conversationId && left.id === right.id;
}

function mergeTimelineBlocks(
  existing: MessageTimelineBlock[] | undefined,
  incoming: MessageTimelineBlock[],
) {
  const merged = [...(existing ?? [])];
  for (const block of incoming) {
    const index = merged.findIndex((item) => item.id === block.id);
    if (index === -1) {
      merged.push(block);
      continue;
    }
    const current = merged[index];
    if (current.type === "content" && block.type === "content") {
      merged[index] = { ...current, text: current.text + block.text };
    } else if (current.type === "thought" && block.type === "thought") {
      merged[index] = { ...current, text: current.text + block.text };
    } else if (current.type === "tools" && block.type === "tools") {
      merged[index] = {
        ...current,
        toolCalls: mergeToolCalls(current.toolCalls, block.toolCalls),
      };
    } else if (
      current.type === "attachments" &&
      block.type === "attachments"
    ) {
      merged[index] = {
        ...current,
        attachments: mergeAttachments(current.attachments, block.attachments),
      };
    } else {
      merged[index] = block;
    }
  }
  return merged;
}

function mergeAttachments(
  existing: PromptDisplayAttachment[],
  incoming: PromptDisplayAttachment[],
) {
  const merged = [...existing];
  for (const attachment of incoming) {
    const index = merged.findIndex((item) => item.id === attachment.id);
    if (index === -1) {
      merged.push(attachment);
    } else {
      merged[index] = { ...merged[index], ...attachment };
    }
  }
  return merged;
}

function readSessionUpdateAttachments(update: Record<string, unknown>) {
  if (!Array.isArray(update.attachments)) return [];
  return update.attachments.flatMap(readSessionUpdateAttachment);
}

function readSessionUpdateAttachment(value: unknown): PromptDisplayAttachment[] {
  if (!value || typeof value !== "object") return [];
  const attachment = value as Record<string, unknown>;
  const id =
    readString(attachment.id) ??
    readString(attachment.fileId) ??
    readString(attachment.file_id);
  const name =
    readString(attachment.name) ??
    readString(attachment.filename) ??
    readString(attachment.fileName);
  if (!id || !name) return [];
  const type =
    readString(attachment.mimeType) ??
    readString(attachment.mime_type) ??
    readString(attachment.type) ??
    "application/octet-stream";
  const size =
    typeof attachment.size === "number"
      ? attachment.size
      : typeof attachment.bytes === "number"
        ? attachment.bytes
        : 0;
  const url =
    readString(attachment.url) ??
    readString(attachment.downloadUrl) ??
    readString(attachment.download_url);
  return [
    {
      id,
      fileId: id,
      name,
      type,
      size,
      url,
      downloadUrl: url,
      relativePath:
        readString(attachment.relativePath) ??
        readString(attachment.relative_path) ??
        readString(attachment.workspacePath) ??
        readString(attachment.workspace_path),
    },
  ];
}

function mergeToolCalls(
  existing: ToolCall[] | undefined,
  incoming: ToolCall[],
) {
  const merged = [...(existing ?? [])];
  for (const tool of incoming) {
    const index = merged.findIndex((item) => item.id === tool.id);
    if (index === -1) {
      merged.push(tool);
      continue;
    }
    const current = merged[index];
    merged[index] = {
      ...current,
      ...tool,
      name: tool.name || current.name,
      kind: tool.kind || current.kind,
      input: tool.input ?? current.input,
      output: tool.output ?? current.output,
      content: tool.content ?? current.content,
      error: tool.error ?? current.error,
    };
  }
  return merged;
}

function readToolCall(update: Record<string, unknown>): {
  id: string;
  name?: string;
  status?: ToolCall["status"];
  kind?: string;
  input?: unknown;
  output?: unknown;
  content?: string;
  error?: string;
} {
  const nested =
    update.toolCall && typeof update.toolCall === "object"
      ? (update.toolCall as Record<string, unknown>)
      : undefined;
  const id =
    readString(update.toolCallId) ??
    readString(update.id) ??
    readString(nested?.toolCallId) ??
    readString(nested?.id) ??
    crypto.randomUUID();
  return {
    id,
    name:
      readString(update.title) ??
      readString(update.name) ??
      readString(nested?.title) ??
      readString(nested?.name),
    status: normalizeToolStatus(
      readString(update.status) ?? readString(nested?.status),
    ),
    kind: readString(update.kind) ?? readString(nested?.kind),
    input: update.rawInput ?? nested?.rawInput,
    output: update.rawOutput ?? nested?.rawOutput,
    content: readToolContent(update.content ?? nested?.content),
    error: readString(update.error) ?? readString(nested?.error),
  };
}

function readToolContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return readString(record.content) ?? readString(record.text) ?? "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeToolStatus(
  status: string | undefined,
): ToolCall["status"] | undefined {
  if (
    !status ||
    status === "pending" ||
    status === "in_progress" ||
    status === "running"
  )
    return status ? "running" : undefined;
  if (status === "completed" || status === "done") return "done";
  if (status === "failed" || status === "error") return "error";
  return undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readCloudAgentSessionStatus(
  result: Record<string, unknown>,
  fallbackSessionId: string,
): CloudAgentSessionStatus | undefined {
  const sessionId = readString(result.session_id) ?? fallbackSessionId;
  if (!sessionId) return undefined;
  const sandbox =
    result.sandbox && typeof result.sandbox === "object"
      ? (result.sandbox as Record<string, unknown>)
      : undefined;
  return {
    sessionId,
    state: readString(result.state),
    closed: readBoolean(result.closed),
    readOnly: readBoolean(result.read_only),
    readOnlyReason: readString(result.read_only_reason),
    cwd: readString(result.cwd),
    model: readString(result.model),
    currentResponseId: readString(result.current_response_id),
    promptInFlight: readBoolean(result.prompt_in_flight),
    runtimeGeneration: readNumber(result.runtime_generation),
    sessionProxyID: readString(result.session_proxy_id),
    envdProxyDomain: readString(result.envd_proxy_domain),
    cleanupPending: readBoolean(result.cleanup_pending),
    lastRuntimeError: readString(result.last_runtime_error),
    sandbox: sandbox
      ? {
          backend: readString(sandbox.backend),
          sandboxTemplateId: readString(sandbox.sandbox_template_id),
          runtimeId: readString(sandbox.runtime_id),
          outerSandboxId: readString(sandbox.outer_sandbox_id),
          outerSandboxDomain: readString(sandbox.outer_sandbox_domain),
          innerSandboxId: readString(sandbox.inner_sandbox_id),
          daemonAddr: readString(sandbox.daemon_addr),
          remoteBinary: readString(sandbox.remote_binary),
          hasOuterEnvdAccessToken: readBoolean(
            sandbox.has_outer_envd_access_token,
          ),
          hasOuterTrafficToken: readBoolean(sandbox.has_outer_traffic_token),
        }
      : undefined,
  };
}

function readChunkMessageId(update: Record<string, unknown>) {
  return readString(update.messageId) ?? readString(update.message_id);
}

function readPermissionOption(value: unknown): PermissionOption[] {
  if (!value || typeof value !== "object") return [];
  const option = value as Record<string, unknown>;
  const optionId = readString(option.optionId) ?? readString(option.option_id);
  const kind = readString(option.kind);
  const name = readString(option.name);
  if (!optionId || !kind || !name) return [];
  return [{ optionId, kind, name }];
}

function readListedSession(value: unknown): ListedSession[] {
  if (!value || typeof value !== "object") return [];
  const session = value as Partial<ListedSession> & Record<string, unknown>;
  if (typeof session.sessionId !== "string") return [];
  return [
    {
      sessionId: session.sessionId,
      cwd: typeof session.cwd === "string" ? session.cwd : undefined,
      title: typeof session.title === "string" ? session.title : undefined,
      updatedAt:
        typeof session.updatedAt === "string" ? session.updatedAt : undefined,
      state: typeof session.state === "string" ? session.state : undefined,
      readOnly:
        typeof session.readOnly === "boolean"
          ? session.readOnly
          : typeof session.read_only === "boolean"
            ? session.read_only
            : undefined,
      readOnlyReason:
        typeof session.readOnlyReason === "string"
          ? session.readOnlyReason
          : typeof session.read_only_reason === "string"
            ? session.read_only_reason
          : undefined,
      additionalDirectories: Array.isArray(session.additionalDirectories)
        ? session.additionalDirectories.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    },
  ];
}

export function timeLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}
