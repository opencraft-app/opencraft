import { Service, type Inject } from "@deepseek-ai/cordis";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  McpServerRegistration,
  McpToolCallResult,
  PendingMcpToolCall,
} from "../types/mcp.ts";
import type {
  WeComBotConfiguration,
  WeComBotPort,
  WeComBotStatus,
  WeComInboundMessage,
  WeComMessageListener,
  WeComOutboundSend,
  WeComOutboundSendResult,
} from "../types/wecom-bot.ts";

const WE_COM_WS_URL = "wss://openws.work.weixin.qq.com";
const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_MISSED_HEARTBEATS = 2;
const REPLY_ACK_TIMEOUT_MS = 5_000;
const MAX_REPLY_QUEUE = 500;
const MAX_RECONNECT_DELAY_MS = 30_000;
const ACTIVE_SEND_TIMEOUT_MS = 15_000;
const MAX_ACTIVE_MESSAGE_CHARACTERS = 18_000;

export const WE_COM_MCP_SERVER_NAME = "hypernode-wecom";

interface StoredBot extends WeComBotConfiguration {
  secret: string;
}

interface ReplyFrame {
  body: Record<string, unknown>;
}

interface OutboundSendState {
  requestId: string;
  chatId: string;
  state: "pending" | "delivered" | "failed" | "cancelled";
  deliveredAtMs: number | null;
  error: string | null;
}

interface BotRuntime {
  config: StoredBot;
  socketId: string | null;
  phase: WeComBotStatus["phase"];
  authenticatedAtMs: number | null;
  lastMessageAtMs: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  reconnectAtMs: number;
  lastHeartbeatAtMs: number;
  missedHeartbeats: number;
  replyQueues: Map<string, ReplyFrame[]>;
  replySentAtMs: Map<string, number>;
  outboundSends: Map<string, OutboundSendState>;
  lastTargetId: string | null;
}

interface WireFrame {
  cmd?: string;
  headers?: { req_id?: string };
  body?: Record<string, unknown>;
  errcode?: number;
  errmsg?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function requestId(prefix: string): string {
  const suffix = typeof crypto.randomBytes === "function"
    ? crypto.randomBytes(4)
    : [...crypto.getRandomValues(new Uint8Array(4))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now()}_${suffix}`;
}

function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_RECONNECT_DELAY_MS);
}

export function weComMessageContent(body: Record<string, unknown>): string {
  const messageType = text(body["msgtype"]);
  if (messageType === "text") return text(record(body["text"])?.["content"]).trim();
  if (messageType === "voice") return text(record(body["voice"])?.["content"]).trim();
  if (messageType === "mixed") {
    const items = record(body["mixed"])?.["msg_item"];
    if (!Array.isArray(items)) return "";
    return items.map((item) => {
      const part = record(item);
      return part?.["msgtype"] === "text" ? text(record(part["text"])?.["content"]) : "";
    }).filter(Boolean).join("\n").trim();
  }
  return "";
}

function inboundMessage(botKey: string, frame: WireFrame): WeComInboundMessage | null {
  if (frame.cmd !== "aibot_msg_callback") return null;
  const body = record(frame.body);
  const requestId = text(frame.headers?.req_id);
  if (!body || !requestId) return null;
  const content = weComMessageContent(body);
  if (!content) return null;
  const from = record(body["from"]);
  return {
    botKey,
    requestId,
    messageId: text(body["msgid"]) || requestId,
    chatId: text(body["chatid"]) || null,
    chatType: text(body["chattype"]) || "single",
    senderUserId: text(from?.["userid"]) || "unknown",
    content,
    messageType: text(body["msgtype"]) || "unknown",
  };
}

type Dependencies = "mcpRegistry" | "storage";

/** Enterprise WeChat transport only: credentials, long-link lifecycle and wire protocol. */
export class WeComBotService extends Service implements WeComBotPort {
  static inject = ["mcpRegistry", "storage"] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly listeners = new Set<WeComMessageListener>();
  private readonly runtimes = new Map<string, BotRuntime>();
  private sequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "wecomBot");
    this.ensureSchema();
    for (const config of this.loadConfigurations()) this.runtimes.set(config.key, this.runtime(config));
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.mcpServer()));
    ctx.effect(() => () => this.close());
  }

  onMessage(listener: WeComMessageListener): () => boolean {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configuration(key: string): WeComBotConfiguration | null {
    const config = this.runtimes.get(key)?.config;
    return config ? this.publicConfiguration(config) : null;
  }

  setThreadId(key: string, threadId: string | null): void {
    const runtime = this.runtimes.get(key);
    if (!runtime) throw new Error(`unknown WeCom bot: ${key}`);
    runtime.config.threadId = threadId;
    if (this.ctx.storage.sql) {
      this.ctx.storage.sql.exec(
        "UPDATE do_wecom_bot_configs SET thread_id = ?, updated_at_ms = ? WHERE bot_key = ?",
        threadId,
        Date.now(),
        key,
      );
    }
  }

  statuses(): WeComBotStatus[] {
    return [...this.runtimes.values()].map((runtime) => ({
      key: runtime.config.key,
      botIdSuffix: runtime.config.botId.slice(-6),
      handler: runtime.config.handler,
      threadId: runtime.config.threadId,
      enabled: runtime.config.enabled,
      phase: runtime.phase,
      authenticatedAtMs: runtime.authenticatedAtMs,
      lastMessageAtMs: runtime.lastMessageAtMs,
      reconnectAttempts: runtime.reconnectAttempts,
      lastError: runtime.lastError,
    }));
  }

  replyStream(
    message: WeComInboundMessage,
    streamId: string,
    content: string,
    finish: boolean,
  ): boolean {
    const runtime = this.runtimes.get(message.botKey);
    if (!runtime || runtime.phase !== "ready") return false;
    const queue = runtime.replyQueues.get(message.requestId) ?? [];
    if (queue.length >= MAX_REPLY_QUEUE) return false;
    queue.push({ body: { msgtype: "stream", stream: { id: streamId, content, finish } } });
    runtime.replyQueues.set(message.requestId, queue);
    this.flushReply(runtime, message.requestId, Date.now());
    return true;
  }

  sendMarkdown(botKey: string, requestedChatId: string | null, content: string): WeComOutboundSend {
    const runtime = this.runtimes.get(botKey);
    if (!runtime) throw new Error(`unknown WeCom bot: ${botKey}`);
    if (runtime.phase !== "ready") throw new Error(`WeCom bot ${botKey} is not connected`);
    const chatId = requestedChatId?.trim() || runtime.lastTargetId;
    if (!chatId) throw new TypeError("chatId is required before this bot has received a message");
    const markdown = content.trim();
    if (!markdown) throw new TypeError("content must be a non-empty string");
    if (markdown.length > MAX_ACTIVE_MESSAGE_CHARACTERS) {
      throw new RangeError(`content exceeds ${MAX_ACTIVE_MESSAGE_CHARACTERS} characters`);
    }
    const reqId = requestId("aibot_send_msg");
    const state: OutboundSendState = {
      requestId: reqId,
      chatId,
      state: "pending",
      deliveredAtMs: null,
      error: null,
    };
    runtime.outboundSends.set(reqId, state);
    try {
      this.send(runtime, {
        cmd: "aibot_send_msg",
        headers: { req_id: reqId },
        body: { chatid: chatId, msgtype: "markdown", markdown: { content: markdown } },
      });
    } catch (error) {
      runtime.outboundSends.delete(reqId);
      throw error;
    }
    let settled = false;
    return {
      poll: (): WeComOutboundSendResult | null => {
        if (settled || state.state === "pending") return null;
        settled = true;
        runtime.outboundSends.delete(reqId);
        if (state.state === "failed") throw new Error(state.error || "WeCom rejected the message");
        if (state.state === "cancelled") throw new Error("WeCom message send was cancelled");
        return { requestId: reqId, chatId, deliveredAtMs: state.deliveredAtMs ?? Date.now() };
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        state.state = "cancelled";
        runtime.outboundSends.delete(reqId);
      },
    };
  }

  tick(): void {
    const now = Date.now();
    for (const runtime of this.runtimes.values()) {
      if (!runtime.config.enabled) {
        runtime.phase = "disabled";
        continue;
      }
      if (!runtime.socketId) {
        if (now >= runtime.reconnectAtMs) this.connect(runtime, now);
        continue;
      }
      this.drain(runtime, now);
      if (!runtime.socketId || runtime.phase !== "ready") continue;
      if (now - runtime.lastHeartbeatAtMs >= HEARTBEAT_INTERVAL_MS) {
        if (runtime.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
          this.disconnect(runtime, "heartbeat acknowledgements timed out", now);
          continue;
        }
        runtime.missedHeartbeats += 1;
        runtime.lastHeartbeatAtMs = now;
        this.send(runtime, { cmd: "ping", headers: { req_id: requestId("ping") } });
      }
      for (const [reqId, sentAt] of runtime.replySentAtMs) {
        if (now - sentAt < REPLY_ACK_TIMEOUT_MS) continue;
        runtime.replySentAtMs.delete(reqId);
        runtime.replyQueues.get(reqId)?.shift();
        this.flushReply(runtime, reqId, now);
      }
    }
  }

  private ensureSchema(): void {
    this.ctx.storage.sql?.exec(`
      CREATE TABLE IF NOT EXISTS do_wecom_bot_configs (
        bot_key TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL,
        secret TEXT NOT NULL,
        handler TEXT NOT NULL,
        thread_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  private loadConfigurations(): StoredBot[] {
    const rows = this.ctx.storage.sql?.exec(`
      SELECT bot_key, bot_id, secret, handler, thread_id, enabled
      FROM do_wecom_bot_configs ORDER BY bot_key
    `).toArray() ?? [];
    return rows.map((row) => ({
      key: text(row["bot_key"]),
      botId: text(row["bot_id"]),
      secret: text(row["secret"]),
      handler: text(row["handler"]) || "none",
      threadId: text(row["thread_id"]) || null,
      enabled: integer(row["enabled"]) !== 0,
    })).filter((config) => config.key && config.botId && config.secret);
  }

  private publicConfiguration(config: StoredBot): WeComBotConfiguration {
    return {
      key: config.key,
      botId: config.botId,
      handler: config.handler,
      threadId: config.threadId,
      enabled: config.enabled,
    };
  }

  private runtime(config: StoredBot): BotRuntime {
    return {
      config,
      socketId: null,
      phase: config.enabled ? "disconnected" : "disabled",
      authenticatedAtMs: null,
      lastMessageAtMs: null,
      lastError: null,
      reconnectAttempts: 0,
      reconnectAtMs: 0,
      lastHeartbeatAtMs: 0,
      missedHeartbeats: 0,
      replyQueues: new Map(),
      replySentAtMs: new Map(),
      outboundSends: new Map(),
      lastTargetId: null,
    };
  }

  private connect(runtime: BotRuntime, now: number): void {
    runtime.phase = "connecting";
    const socketId = `wecom:${runtime.config.key}:${++this.sequence}:${crypto.randomBytes(4)}`;
    try {
      hostNetwork.openWebSocket(socketId, WE_COM_WS_URL, {});
      runtime.socketId = socketId;
      runtime.phase = "authenticating";
      runtime.lastError = null;
      this.send(runtime, {
        cmd: "aibot_subscribe",
        headers: { req_id: requestId("aibot_subscribe") },
        body: { bot_id: runtime.config.botId, secret: runtime.config.secret },
      });
    } catch (error) {
      runtime.socketId = null;
      runtime.phase = "disconnected";
      runtime.lastError = error instanceof Error ? error.message : String(error);
      runtime.reconnectAttempts += 1;
      runtime.reconnectAtMs = now + reconnectDelay(runtime.reconnectAttempts);
    }
  }

  private drain(runtime: BotRuntime, now: number): void {
    if (!runtime.socketId) return;
    let drained: ReturnType<typeof hostNetwork.drainWebSocket>;
    try {
      drained = hostNetwork.drainWebSocket(runtime.socketId);
    } catch (error) {
      this.disconnect(runtime, error instanceof Error ? error.message : String(error), now);
      return;
    }
    for (const raw of drained.messages) {
      try {
        this.receive(runtime, JSON.parse(raw) as WireFrame, now);
      } catch {
        runtime.lastError = "received malformed WeCom WebSocket frame";
      }
    }
    if (drained.closed) this.disconnect(runtime, drained.error || "connection closed", now);
  }

  private receive(runtime: BotRuntime, frame: WireFrame, now: number): void {
    const reqId = text(frame.headers?.req_id);
    if (frame.cmd === "aibot_msg_callback") {
      const message = inboundMessage(runtime.config.key, frame);
      if (!message) return;
      runtime.lastMessageAtMs = now;
      runtime.lastTargetId = message.chatId || message.senderUserId;
      for (const listener of this.listeners) listener(message);
      return;
    }
    if (frame.cmd === "aibot_event_callback") return;
    if (reqId.startsWith("aibot_subscribe")) {
      if (frame.errcode !== 0) {
        this.disconnect(runtime, `authentication failed (${frame.errcode ?? "unknown"}): ${frame.errmsg ?? "unknown"}`, now);
        return;
      }
      runtime.phase = "ready";
      runtime.authenticatedAtMs = now;
      runtime.reconnectAttempts = 0;
      runtime.missedHeartbeats = 0;
      runtime.lastHeartbeatAtMs = now;
      return;
    }
    if (reqId.startsWith("ping")) {
      if (frame.errcode === 0) runtime.missedHeartbeats = 0;
      return;
    }
    const outbound = runtime.outboundSends.get(reqId);
    if (outbound) {
      if (frame.errcode !== undefined && frame.errcode !== 0) {
        outbound.state = "failed";
        outbound.error = `message rejected (${frame.errcode}): ${frame.errmsg ?? "unknown"}`;
        runtime.lastError = outbound.error;
      } else {
        outbound.state = "delivered";
        outbound.deliveredAtMs = now;
      }
      return;
    }
    if (runtime.replySentAtMs.has(reqId)) {
      runtime.replySentAtMs.delete(reqId);
      runtime.replyQueues.get(reqId)?.shift();
      if (frame.errcode !== 0) runtime.lastError = `reply rejected (${frame.errcode ?? "unknown"}): ${frame.errmsg ?? "unknown"}`;
      this.flushReply(runtime, reqId, now);
    }
  }

  private flushReply(runtime: BotRuntime, reqId: string, now: number): void {
    if (runtime.phase !== "ready" || runtime.replySentAtMs.has(reqId)) return;
    const queue = runtime.replyQueues.get(reqId);
    const next = queue?.[0];
    if (!next) {
      runtime.replyQueues.delete(reqId);
      return;
    }
    try {
      this.send(runtime, { cmd: "aibot_respond_msg", headers: { req_id: reqId }, body: next.body });
      runtime.replySentAtMs.set(reqId, now);
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private send(runtime: BotRuntime, frame: WireFrame): void {
    if (!runtime.socketId) throw new Error("WeCom WebSocket is not connected");
    hostNetwork.sendWebSocket(runtime.socketId, JSON.stringify(frame));
  }

  private disconnect(runtime: BotRuntime, reason: string, now: number): void {
    if (runtime.socketId) hostNetwork.closeWebSocket(runtime.socketId);
    runtime.socketId = null;
    runtime.phase = "disconnected";
    runtime.lastError = reason;
    runtime.reconnectAttempts += 1;
    runtime.reconnectAtMs = now + reconnectDelay(runtime.reconnectAttempts);
    runtime.missedHeartbeats = 0;
    runtime.replyQueues.clear();
    runtime.replySentAtMs.clear();
    for (const outbound of runtime.outboundSends.values()) {
      if (outbound.state !== "pending") continue;
      outbound.state = "failed";
      outbound.error = `WeCom connection closed before ACK: ${reason}`;
    }
  }

  private close(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.socketId) hostNetwork.closeWebSocket(runtime.socketId);
      runtime.socketId = null;
      runtime.phase = runtime.config.enabled ? "disconnected" : "disabled";
      for (const outbound of runtime.outboundSends.values()) {
        if (outbound.state !== "pending") continue;
        outbound.state = "failed";
        outbound.error = "WeCom transport stopped before ACK";
      }
    }
  }

  private mcpServer(): McpServerRegistration {
    return {
      name: WE_COM_MCP_SERVER_NAME,
      title: "企业微信消息",
      description: "从绑定的 CodeReviewBot 会话主动向企业微信用户或群聊发送消息。",
      version: "1.0.0",
      resources: [],
      tools: [{
        name: "send_message",
        title: "主动发送企业微信消息",
        description: "主动向企业微信用户或群聊推送 Markdown 消息；不依赖当前存在入站回调。chatId 可省略以发送给最近一次来信者。",
        inputSchema: {
          type: "object",
          properties: {
            chatId: {
              type: "string",
              description: "单聊填写 userid，群聊填写 chatid；省略时使用最近一次来信目标。",
            },
            content: { type: "string", minLength: 1, maxLength: MAX_ACTIVE_MESSAGE_CHARACTERS },
          },
          required: ["content"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        call: (argumentsValue, context): PendingMcpToolCall => {
          const argumentsRecord = record(argumentsValue);
          if (!argumentsRecord) throw new TypeError("arguments must be an object");
          const config = this.configuration("code-review");
          if (!config?.threadId || context.threadId !== config.threadId) {
            throw new Error("enterprise WeChat sending is only available in the bound CodeReviewBot thread");
          }
          const chatIdValue = argumentsRecord["chatId"];
          if (chatIdValue !== undefined && typeof chatIdValue !== "string") {
            throw new TypeError("chatId must be a string");
          }
          if (typeof argumentsRecord["content"] !== "string") {
            throw new TypeError("content must be a string");
          }
          const send = this.sendMarkdown(
            "code-review",
            typeof chatIdValue === "string" ? chatIdValue : null,
            argumentsRecord["content"],
          );
          return {
            kind: "pending",
            timeoutMs: ACTIVE_SEND_TIMEOUT_MS,
            cancel: () => send.cancel(),
            poll: (): McpToolCallResult | null => {
              const result = send.poll();
              if (!result) return null;
              return {
                content: [{ type: "text", text: `企业微信消息已发送至 ${result.chatId}` }],
                structuredContent: {
                  delivered: true,
                  chatId: result.chatId,
                  requestId: result.requestId,
                  deliveredAtMs: result.deliveredAtMs,
                },
              };
            },
          };
        },
      }],
    };
  }
}
