import { Service, type Inject } from "@deepseek-ai/cordis";
import type {
  AppServerIdentity,
  JsonRpcError,
  JsonRpcId,
  JsonRpcResponse,
} from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { HostUserRecord } from "../types/host-policy.ts";
import type {
  CodeReviewBotPort,
  CodeReviewBotStatus,
  WeComInboundMessage,
} from "../types/wecom-bot.ts";
import { VirtualWebSocket } from "../runtime/virtual-websocket.ts";

const BOT_KEY = "code-review";
const MODEL = "ep-gbat3laa";
const WORKSPACE = "/workspace/projects";
const MAX_REPLY_CHARACTERS = 18_000;

type RpcCallback = (response: JsonRpcResponse) => void;

interface PendingReview {
  message: WeComInboundMessage;
  streamId: string;
  clientMessageId: string;
  turnId: string | null;
  text: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rpcErrorMessage(error: JsonRpcError | undefined): string {
  return error?.message || "unknown app-server error";
}

/** Minimal in-memory AppServer client. It never exposes a network listener. */
class InternalAppServerSocket extends VirtualWebSocket {
  readonly sent: unknown[] = [];
  onSend: ((value: unknown) => void) | null = null;

  override send(value: unknown): void {
    this.sent.push(value);
    this.onSend?.(value);
  }
}

type Dependencies = "appServer" | "storage" | "threadTitle" | "userDirectory" | "wecomBot";

/** Binds the generic WeCom transport to one durable GLM code-review conversation. */
export class CodeReviewBotService extends Service implements CodeReviewBotPort {
  static inject = [
    "appServer",
    "storage",
    "threadTitle",
    "userDirectory",
    "wecomBot",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;
  private readonly socket = new InternalAppServerSocket();
  private readonly callbacks = new Map<JsonRpcId, RpcCallback>();
  private readonly queue: PendingReview[] = [];
  private requestSequence = 0;
  private initialized = false;
  private initializing = false;
  private threadOpening = false;
  private threadId: string | null = null;
  private active: PendingReview | null = null;
  private lastError: string | null = null;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "codeReviewBot");
    this.ensureSchema();
    this.socket.onSend = (value) => this.receiveAppServer(value);
    ctx.effect(() => ctx.wecomBot.onMessage((message) => this.receiveWeCom(message)));
    ctx.effect(() => ctx.appServer.register("hypernode/wecomBot/status", () => ({
      bots: ctx.wecomBot.statuses(),
    })));
    ctx.effect(() => ctx.appServer.register("hypernode/codeReviewBot/status", () => this.status()));
    ctx.effect(() => () => this.socket.dispatch("close", new Uint8Array()));
  }

  status(): CodeReviewBotStatus {
    return {
      botKey: BOT_KEY,
      model: MODEL,
      threadId: this.threadId ?? this.ctx.wecomBot.configuration(BOT_KEY)?.threadId ?? null,
      pendingMessages: this.queue.length,
      activeTurnId: this.active?.turnId ?? null,
      lastError: this.lastError,
    };
  }

  tick(): void {
    if (!this.initialized && !this.initializing) this.initialize();
    if (this.initialized) {
      this.socket.dispatch("poll");
      const config = this.ctx.wecomBot.configuration(BOT_KEY);
      if (!this.threadId && !this.threadOpening && config?.enabled) {
        this.ensureThread(config.threadId);
      }
    }
  }

  private initialize(): void {
    const config = this.ctx.wecomBot.configuration(BOT_KEY);
    if (!config?.enabled || config.handler !== "code-review") return;
    const root = this.rootUser();
    if (!root) {
      this.lastError = "root HyperNode identity is unavailable";
      return;
    }
    this.initializing = true;
    this.ctx.appServer.attach(this.socket, {
      connectionId: "internal:wecom:code-review",
      sessionId: "internal:wecom:code-review",
      identity: root as AppServerIdentity,
    });
    this.request("initialize", {
      clientInfo: { name: "hypernode-code-review-bot", title: "CodeReviewBot", version: "1" },
      capabilities: { experimentalApi: true, "hypernode.sync.v1": true },
    }, (response) => {
      if (response.error) {
        this.initializing = false;
        this.lastError = rpcErrorMessage(response.error);
        return;
      }
      this.initialized = true;
      this.initializing = false;
    });
  }

  private rootUser(): HostUserRecord | null {
    return this.ctx.userDirectory.find("node:root") ??
      this.ctx.userDirectory.list().find((user) => user.username === "root") ?? null;
  }

  private ensureThread(existingThreadId: string | null): void {
    if (this.threadId) {
      this.pump();
      return;
    }
    if (existingThreadId) {
      this.threadOpening = true;
      this.request("thread/resume", { threadId: existingThreadId, cwd: WORKSPACE }, (response) => {
        const resumedThread = record(record(response.result)?.["thread"]);
        const resumedId = text(resumedThread?.["id"]);
        if (!response.error && resumedId) {
          this.threadOpening = false;
          this.threadId = resumedId;
          this.lastError = null;
          this.pump();
          return;
        }
        this.threadOpening = false;
        this.ctx.wecomBot.setThreadId(BOT_KEY, null);
        this.startThread();
      });
      return;
    }
    this.startThread();
  }

  private startThread(): void {
    if (this.threadOpening) return;
    this.threadOpening = true;
    this.request("thread/start", {
      cwd: WORKSPACE,
      model: MODEL,
      approvalPolicy: "never",
      sandbox: "read-only",
    }, (response) => {
      this.threadOpening = false;
      const thread = record(record(response.result)?.["thread"]);
      const threadId = text(thread?.["id"]);
      if (response.error || !threadId) {
        this.lastError = response.error
          ? rpcErrorMessage(response.error)
          : "thread/start omitted the thread id";
        this.failActiveOrQueued(this.lastError);
        return;
      }
      this.threadId = threadId;
      this.lastError = null;
      this.ctx.wecomBot.setThreadId(BOT_KEY, threadId);
      this.ctx.threadTitle.set(threadId, "CodeReviewBot · 企业微信", {
        actor: this.rootUser(),
        source: "system",
      });
      this.pump();
    });
  }

  private receiveWeCom(message: WeComInboundMessage): void {
    const config = this.ctx.wecomBot.configuration(message.botKey);
    if (message.botKey !== BOT_KEY || config?.handler !== "code-review") return;
    if (!this.claimMessage(message)) return;
    const review: PendingReview = {
      message,
      streamId: `review_${Date.now()}_${crypto.randomBytes(4)}`,
      clientMessageId: `wecom:${message.messageId}`,
      turnId: null,
      text: "",
    };
    this.ctx.wecomBot.replyStream(message, review.streamId, "已收到，正在进行代码审查…", false);
    this.queue.push(review);
    if (!this.initialized && !this.initializing) this.initialize();
    if (this.initialized) this.ensureThread(config.threadId);
  }

  private pump(): void {
    if (this.active || !this.threadId || this.queue.length === 0) return;
    const review = this.queue.shift()!;
    this.active = review;
    this.request("turn/start", {
      threadId: this.threadId,
      model: MODEL,
      clientUserMessageId: review.clientMessageId,
      input: [{ type: "text", text: this.reviewPrompt(review.message) }],
    }, (response) => {
      if (response.error) {
        const error = rpcErrorMessage(response.error);
        if (/thread not found|archived|destroyed/iu.test(error)) {
          this.queue.unshift(review);
          this.active = null;
          this.threadId = null;
          this.ctx.wecomBot.setThreadId(BOT_KEY, null);
          this.startThread();
          return;
        }
        this.finish(review, `代码审查启动失败：${error}`, true);
        return;
      }
      const turn = record(record(response.result)?.["turn"]);
      review.turnId = text(turn?.["id"]);
      if (!review.turnId) this.finish(review, "代码审查启动失败：turn/start 未返回 turnId", true);
    });
  }

  private reviewPrompt(message: WeComInboundMessage): string {
    return [
      "你是企业微信中的 CodeReviewBot。请审查用户提供的代码、diff、提交信息或技术方案。",
      "优先指出会造成错误、安全风险、数据损坏、并发问题或兼容性回归的具体问题；按严重程度排序，并给出可执行的修改建议。",
      "若材料不足，明确说明缺少什么，不要虚构仓库内容。回答使用中文，简洁但要包含依据。",
      `发送者：${message.senderUserId}；会话类型：${message.chatType}`,
      "",
      message.content,
    ].join("\n");
  }

  private receiveAppServer(value: unknown): void {
    const message = record(value);
    if (!message) return;
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const id = message["id"] as JsonRpcId;
      const callback = this.callbacks.get(id);
      if (callback) {
        this.callbacks.delete(id);
        callback(message as JsonRpcResponse);
      }
      return;
    }
    const method = text(message["method"]);
    const params = record(message["params"]);
    if (!method || !params || !this.active || params["threadId"] !== this.threadId) return;
    const eventTurnId = text(record(params["turn"])?.["id"]) || text(params["turnId"]);
    if (eventTurnId && this.active.turnId && eventTurnId !== this.active.turnId) return;
    if (method === "item/agentMessage/delta") {
      this.active.text += text(params["delta"]);
      return;
    }
    if (method === "item/completed") {
      const item = record(params["item"]);
      if (item?.["type"] === "agentMessage") this.active.text = text(item["text"]) || this.active.text;
      return;
    }
    if (method === "turn/completed") {
      const completed = record(params["turn"]);
      const items = Array.isArray(completed?.["items"]) ? completed?.["items"] : [];
      const finalText = items.map(record).filter((item) => item?.["type"] === "agentMessage")
        .map((item) => text(item?.["text"])).filter(Boolean).join("\n") || this.active.text;
      this.finish(this.active, finalText || "代码审查已结束，但模型没有返回文本。", false);
    }
  }

  private request(method: string, params: Record<string, unknown>, callback: RpcCallback): void {
    const id = `code-review:${++this.requestSequence}`;
    this.callbacks.set(id, callback);
    this.socket.dispatch("message", JSON.stringify({ id, method, params }));
  }

  private finish(review: PendingReview, value: string, failed: boolean): void {
    let content = value.trim();
    if (content.length > MAX_REPLY_CHARACTERS) {
      content = `${content.slice(0, MAX_REPLY_CHARACTERS)}\n\n（回复过长，已截断）`;
    }
    this.ctx.wecomBot.replyStream(review.message, review.streamId, content, true);
    this.markCompleted(review.message.messageId, failed ? "failed" : "completed", failed ? content : null);
    if (failed) this.lastError = content;
    if (this.active === review) this.active = null;
    this.pump();
  }

  private failActiveOrQueued(error: string): void {
    if (this.active) this.finish(this.active, `CodeReviewBot 暂时不可用：${error}`, true);
    for (const review of this.queue.splice(0)) {
      this.finish(review, `CodeReviewBot 暂时不可用：${error}`, true);
    }
  }

  private ensureSchema(): void {
    this.ctx.storage.sql?.exec(`
      CREATE TABLE IF NOT EXISTS do_wecom_bot_messages (
        bot_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        received_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        PRIMARY KEY (bot_key, message_id)
      )
    `);
  }

  private claimMessage(message: WeComInboundMessage): boolean {
    const sql = this.ctx.storage.sql;
    if (!sql) return true;
    const result = sql.exec(`
      INSERT OR IGNORE INTO do_wecom_bot_messages (
        bot_key, message_id, state, error, received_at_ms, completed_at_ms
      ) VALUES (?, ?, 'received', NULL, ?, NULL)
    `, message.botKey, message.messageId, Date.now());
    return result.rowsWritten > 0;
  }

  private markCompleted(messageId: string, state: string, error: string | null): void {
    this.ctx.storage.sql?.exec(`
      UPDATE do_wecom_bot_messages
      SET state = ?, error = ?, completed_at_ms = ?
      WHERE bot_key = ? AND message_id = ?
    `, state, error, Date.now(), BOT_KEY, messageId);
  }
}
