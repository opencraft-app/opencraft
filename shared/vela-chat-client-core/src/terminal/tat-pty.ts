import type {TerminalSession} from "../platform/api.js";

export interface Base64Codec {
  decode(value: string): Uint8Array;
  encode(value: Uint8Array): string;
}

export type TextSocketEvent =
  | {type: "open"}
  | {data: string; type: "message"}
  | {message?: string; type: "error"}
  | {code?: number; reason?: string; type: "close"};

export interface TextSocket {
  close(): void;
  send(data: string): void;
  subscribe(listener: (event: TextSocketEvent) => void): () => void;
}

export interface TextSocketFactory {
  open(url: string): TextSocket;
}

export interface TerminalCallbacks {
  onClose?(reason: "local" | "remote" | "error"): void;
  onError?(error: Error): void;
  onOutput(data: Uint8Array): void;
}

export interface TerminalConnection {
  close(): void;
  resize(cols: number, rows: number): void;
  write(data: Uint8Array): void;
}

export interface TatPtyTerminalOptions {
  base64: Base64Codec;
  randomId(): string;
  sockets: TextSocketFactory;
  timers?: TerminalTimers;
}

export interface TerminalTimers {
  clearTimeout(handle: unknown): void;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

interface WireFrame {
  Data?: Record<string, unknown>;
  Type?: unknown;
}

// TatPtyTerminal 实现可被 Node、浏览器和 Expo adapter 复用的文本帧状态机。
export class TatPtyTerminal {
  private readonly base64: Base64Codec;
  private readonly randomId: () => string;
  private readonly sockets: TextSocketFactory;
  private readonly timers: TerminalTimers;

  public constructor(options: TatPtyTerminalOptions) {
    this.base64 = options.base64;
    this.randomId = options.randomId;
    this.sockets = options.sockets;
    this.timers = options.timers ?? defaultTimers;
  }

  public open(
    session: TerminalSession,
    callbacks: TerminalCallbacks,
  ): Promise<TerminalConnection> {
    const channelId = this.randomId();
    if (!channelId.trim()) {
      return Promise.reject(new Error("终端 Channel ID 无效"));
    }
    const socket = this.sockets.open(session.webSocketUrl);
    let opened = false;
    let ready = false;
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let openTimer: unknown;
    let probeTimer: unknown;
    let readyTimer: unknown;
    let unsubscribe: (() => void) | undefined;

    const send = (type: string, data: Record<string, unknown> = {}) => {
      if (closed || !opened) {
        throw new Error("终端连接尚未建立");
      }
      socket.send(JSON.stringify({
        Data: {
          ChannelId: channelId,
          SessionId: session.sessionId,
          ...data,
        },
        Type: type,
      }));
    };

    const stopHeartbeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };

    const stopDeadlines = () => {
      if (openTimer !== undefined) {
        this.timers.clearTimeout(openTimer);
        openTimer = undefined;
      }
      if (readyTimer !== undefined) {
        this.timers.clearTimeout(readyTimer);
        readyTimer = undefined;
      }
      if (probeTimer !== undefined) {
        this.timers.clearTimeout(probeTimer);
        probeTimer = undefined;
      }
    };

    const finish = (
      reason: "local" | "remote" | "error",
      sendStop: boolean,
    ) => {
      if (closed) return;
      if (sendStop && opened) {
        try {
          send("PtyStop");
        } catch {
          // 关闭路径只做 best effort。
        }
      }
      closed = true;
      stopDeadlines();
      stopHeartbeat();
      unsubscribe?.();
      socket.close();
      callbacks.onClose?.(reason);
    };

    const connection: TerminalConnection = {
      close() {
        finish("local", true);
      },
      resize(cols, rows) {
        assertDimension(cols, "cols");
        assertDimension(rows, "rows");
        send("PtyResize", {Cols: cols, Rows: rows});
      },
      write: (data) => {
        if (!(data instanceof Uint8Array) || data.byteLength === 0) return;
        send("PtyInput", {Input: this.base64.encode(data)});
        if (probeTimer !== undefined) {
          this.timers.clearTimeout(probeTimer);
        }
        // The managed macOS TAT Agent removes the channel when its PTY
        // reader reaches EOF, but emits no terminal frame. A debounced probe
        // turns the ensuing "Channel not found" into a prompt remote EOF.
        probeTimer = this.timers.setTimeout(() => {
          probeTimer = undefined;
          if (closed || !ready) return;
          try {
            send("PtyPing");
          } catch {
            finish("error", false);
          }
        }, 1_000);
      },
    };

    return new Promise<TerminalConnection>((resolve, reject) => {
      const fail = (message: string) => {
        if (closed) return;
        const error = new Error(message);
        callbacks.onError?.(error);
        finish("error", false);
        if (!ready) reject(error);
      };

      openTimer = this.timers.setTimeout(
        () => fail("终端 WebSocket 连接超时"),
        10_000,
      );

      unsubscribe = socket.subscribe((event) => {
        if (closed) return;
        if (event.type === "open") {
          opened = true;
          if (openTimer !== undefined) {
            this.timers.clearTimeout(openTimer);
            openTimer = undefined;
          }
          readyTimer = this.timers.setTimeout(
            () => fail("终端启动超时"),
            10_000,
          );
          socket.send(JSON.stringify({
            Data: {
              AppId: session.authentication.appId,
              InstanceId: session.authentication.instanceId,
              SessionId: session.sessionId,
              Uin: session.authentication.uin,
            },
            Type: "SessionAuth",
          }));
          send("PtyStart", {
            Cols: session.terminal.cols,
            MaxIdleTime: session.terminal.maxIdleSeconds,
            Rows: session.terminal.rows,
          });
          return;
        }
        if (event.type === "error") {
          fail("终端连接失败");
          return;
        }
        if (event.type === "close") {
          finish("remote", false);
          if (!ready) reject(new Error("终端连接已关闭"));
          return;
        }
        let frame: WireFrame;
        try {
          const value: unknown = JSON.parse(event.data);
          if (!isRecord(value)) return;
          frame = value;
        } catch {
          fail("终端返回了非法帧");
          return;
        }
        if (
          !isRecord(frame.Data) ||
          frame.Data.SessionId !== session.sessionId ||
          frame.Data.ChannelId !== channelId
        ) {
          return;
        }
        switch (frame.Type) {
          case "PtyReady":
            if (ready) return;
            ready = true;
            if (readyTimer !== undefined) {
              this.timers.clearTimeout(readyTimer);
              readyTimer = undefined;
            }
            heartbeat = setInterval(() => {
              try {
                send("PtyPing");
              } catch {
                finish("error", false);
              }
            }, heartbeatMilliseconds(session.terminal.maxIdleSeconds));
            resolve(connection);
            return;
          case "PtyOutput": {
            if (!ready || typeof frame.Data.Output !== "string") return;
            try {
              callbacks.onOutput(this.base64.decode(frame.Data.Output));
            } catch {
              fail("终端输出编码无效");
            }
            return;
          }
          case "PtyError":
            // Tencent TAT uses PtyError{Reason:"logout"} for a shell that
            // exited normally. It is an EOF signal, not a transport failure.
            if (normalRemoteExit(frame.Data, ready)) {
              finish("remote", false);
              return;
            }
            fail("终端会话失败");
            return;
          case "PtyStop":
            finish("remote", false);
            return;
          case "PtyPing":
            send("PtyPong");
            return;
          case "PtyPong":
          default:
            return;
        }
      });
    });
  }
}

const defaultTimers: TerminalTimers = {
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setTimeout(callback, milliseconds) {
    return setTimeout(callback, milliseconds);
  },
};

function assertDimension(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new Error(`终端 ${name} 无效`);
  }
}

function heartbeatMilliseconds(maxIdleSeconds: number): number {
  const seconds = Math.max(5, Math.min(30, Math.floor(maxIdleSeconds / 3)));
  return seconds * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalRemoteExit(
  data: Record<string, unknown>,
  ready: boolean,
): boolean {
  if (!ready || typeof data.Reason !== "string") return false;
  const reason = data.Reason.trim().toLocaleLowerCase();
  return reason === "logout" || reason === "channel not found";
}
