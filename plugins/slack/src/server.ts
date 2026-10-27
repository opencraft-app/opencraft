import WebSocket from "ws";
import type { ImMessage } from "@opencraft/plugin-im/server";

type State = "connecting" | "ready" | "disconnected" | "closed";
export interface SlackOptions {
  readonly botToken: string;
  readonly appToken: string;
  readonly workspaceId: string;
  readonly botUserId: string;
  readonly receive: (message: ImMessage) => Promise<void>;
  readonly onState?: (state: State) => void;
  readonly onError?: (code: "connection" | "message" | "protocol") => void;
}
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
export async function slackApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher("https://slack.com/api/" + method, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Slack API unavailable");
  const decoded = record(await response.json());
  if (decoded?.ok !== true) throw new Error("Slack request rejected");
  return decoded;
}
/** Socket ACK confirms protocol receipt only; IM admission and delivery retain their own facts. */
export class SlackPlugin {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private phase: State = "disconnected";
  private attempts = 0;
  constructor(
    readonly options: SlackOptions,
    private readonly api: typeof slackApi = slackApi,
    private readonly connect: (url: string) => WebSocket = (url) =>
      new WebSocket(url, {
        maxPayload: 1_048_576,
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
      }),
  ) {}
  get state() {
    return this.phase;
  }
  private setState(state: State) {
    this.phase = state;
    this.options.onState?.(state);
  }
  start() {
    if (!this.stopped && !this.socket && this.phase !== "connecting")
      void this.open();
  }
  private async open() {
    if (this.stopped) return;
    this.setState("connecting");
    try {
      const result = await this.api(
        this.options.appToken,
        "apps.connections.open",
        {},
      );
      if (this.stopped) return;
      if (
        typeof result.url !== "string" ||
        new URL(result.url).protocol !== "wss:"
      )
        throw new Error("Invalid Slack socket");
      const socket = this.connect(result.url);
      this.socket = socket;
      socket.on("open", () => {
        if (this.stopped || this.socket !== socket) return socket.terminate();
        this.attempts = 0;
        this.setState("ready");
      });
      socket.on("error", () => {
        this.options.onError?.("connection");
        socket.terminate();
      });
      socket.on("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!this.stopped) {
          this.setState("disconnected");
          this.retry();
        }
      });
      socket.on("message", (bytes) => {
        if (this.stopped || this.socket !== socket) return;
        let frame: Record<string, unknown>;
        try {
          frame = record(JSON.parse(bytes.toString()))!;
          if (!frame) throw Error();
        } catch {
          this.options.onError?.("protocol");
          return;
        }
        if (typeof frame.envelope_id === "string")
          socket.send(
            JSON.stringify({ envelope_id: frame.envelope_id }),
            () => {},
          );
        if (frame.type === "disconnect") {
          socket.close();
          return;
        }
        if (frame.type !== "events_api") return;
        const payload = record(frame.payload),
          event = record(payload?.event);
        if (
          payload?.team_id !== this.options.workspaceId ||
          typeof payload.event_id !== "string" ||
          !event ||
          event.bot_id ||
          event.subtype ||
          typeof event.user !== "string" ||
          event.user === this.options.botUserId
        )
          return;
        const direct = event.type === "message" && event.channel_type === "im";
        if (!direct && event.type !== "app_mention") return;
        if (
          typeof event.channel !== "string" ||
          typeof event.ts !== "string" ||
          typeof event.text !== "string"
        )
          return;
        const text = event.text.replace(
          new RegExp(
            "^\\s*<@" +
              this.options.botUserId.replace(/[^A-Z0-9]/g, "") +
              ">\\s*",
          ),
          "",
        );
        const thread = direct
          ? undefined
          : typeof event.thread_ts === "string"
            ? event.thread_ts
            : event.ts;
        const address = {
          provider: "slack",
          workspaceId: this.options.workspaceId,
          chatId: event.channel,
          threadId: thread ?? null,
          expiresAt: Date.now() + 86_400_000,
        };
        const message: ImMessage = {
          id: payload.event_id,
          source: {
            chatId: event.channel,
            chatType: direct ? "direct" : "group",
            senderId: event.user,
            ...(thread ? { threadId: thread } : {}),
          },
          text,
          replyAddress: address,
          reply: (answer) => this.deliver(address, answer),
        };
        void this.options
          .receive(message)
          .catch(() => this.options.onError?.("message"));
      });
    } catch {
      if (!this.stopped) {
        this.options.onError?.("connection");
        this.setState("disconnected");
        this.retry();
      }
    }
  }
  private retry() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.open();
      },
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)),
    );
    this.timer.unref();
  }
  async deliver(address: Record<string, unknown>, answer: string) {
    if (
      this.stopped ||
      address.provider !== "slack" ||
      address.workspaceId !== this.options.workspaceId ||
      typeof address.chatId !== "string" ||
      typeof address.expiresAt !== "number" ||
      address.expiresAt <= Date.now() ||
      !answer.trim() ||
      Buffer.byteLength(answer) > 20_000
    )
      throw new Error("Slack reply unavailable");
    await this.api(this.options.botToken, "chat.postMessage", {
      channel: address.chatId,
      text: answer,
      ...(typeof address.threadId === "string"
        ? { thread_ts: address.threadId }
        : {}),
      reply_broadcast: false,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.terminate();
    this.socket = null;
    this.setState("closed");
  }
}
