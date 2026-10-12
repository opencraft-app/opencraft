/**
 * 云桌面媒体的 TAT 隧道传输。
 *
 * ingressproxy 下线后，`6080-<sandboxID>.<domain>` 这类泛域名不再可达，桌面画面
 * 必须改走实例的 TAT session：浏览器 → 已鉴权的 TAT WSS → 沙箱内回环端口。
 * 沙箱内的目标只有回环地址，公网无法直连，因此也不再需要把 VNC 密码下发到浏览器。
 *
 * 两种模式：
 *   - rfb：隧道内直接是 RFB 字节流（desktop/resource 准备的只读 observer）；
 *   - ws ：隧道内是 WebSocket 会话（broker 的 /desktop/connect），此时首帧是
 *          desktop/attach，用一次性票据换取媒体。
 */

import type { BotTerminalSession, CloudDesktopTunnel } from "@/domain/types";
import { createRfc6455Client, type Rfc6455Client } from "@/lib/rfc6455-over-stream";
import { TencentTsshProxyClient, type TsshProxyConnectionHandlers } from "@/lib/tencent-tssh-proxy-client";
import { TatTransportError, normalizeTatTransportError } from "@/lib/tat-transport-error";

export const DESKTOP_ATTACH_EVENT = "desktop/attach";
export const DESKTOP_ATTACH_VERSION = 1;

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSED = 3;

const DESKTOP_HANDSHAKE_TIMEOUT_MS = 15_000;

/** noVNC Websock.attach 要求的最小通道契约。 */
export interface DesktopRawChannel {
  binaryType: string;
  protocol: string;
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: ArrayBufferLike | Uint8Array): void;
  close(): void;
}

export interface DesktopTatProxyConnection {
  write(data: Uint8Array | ArrayBuffer | string): boolean;
  close(): void;
}

export interface DesktopTatProxy {
  openProxy(
    target: { ip?: string; port: number | string },
    handlers?: TsshProxyConnectionHandlers,
  ): Promise<DesktopTatProxyConnection>;
  close(): void;
}

export interface DesktopTatAttach {
  attachmentId: string;
  ticket: string;
}

export interface OpenDesktopTatSocketInput {
  bootstrap: BotTerminalSession;
  tunnel: CloudDesktopTunnel;
  /** ws 模式下作为首帧发送的一次性观看票据。 */
  attach?: DesktopTatAttach;
  /** 测试注入点：替换真实的 TAT 代理客户端。 */
  createProxyClient?: (bootstrap: BotTerminalSession) => DesktopTatProxy;
}

export interface DesktopTatConnection {
  channel: DesktopRawChannel;
  close: () => void;
}

export function buildDesktopAttachFrame(attach: DesktopTatAttach): string {
  return JSON.stringify({
    event: DESKTOP_ATTACH_EVENT,
    version: DESKTOP_ATTACH_VERSION,
    attachmentId: attach.attachmentId,
    ticket: attach.ticket,
  });
}

export async function openDesktopTatSocket(input: OpenDesktopTatSocketInput): Promise<DesktopTatConnection> {
  const { bootstrap, tunnel, attach } = input;
  const inputGateway = tunnel.mode === "rfb" && tunnel.path === "/desktop/input";
  if (inputGateway && (!attach?.attachmentId || !attach.ticket)) {
    throw new TatTransportError("fatal", "desktop input ticket is required", { phase: "open_proxy" });
  }
  const client: DesktopTatProxy = input.createProxyClient
    ? input.createProxyClient(bootstrap)
    : new TencentTsshProxyClient(bootstrap);

  let connection: DesktopTatProxyConnection | null = null;
  let rfc: Rfc6455Client | null = null;
  let settled = false;

  // noVNC 挂上 onmessage 之前到达的字节（RFB 服务端首包 ProtocolVersion 就在
  // 隧道建立后立即下发，而面板是先开隧道、再异步加载 noVNC）。直接丢弃会让
  // RFB 握手永远等不到首包，界面卡在「连接中」，因此先缓存、挂上后补发。
  const pending: ArrayBuffer[] = [];
  let messageHandler: DesktopRawChannel["onmessage"] = null;
  let flushScheduled = false;
  const scheduleFlush = () => {
    if (flushScheduled || pending.length === 0) return;
    flushScheduled = true;
    // 异步补发：noVNC 在 attach() 内同步赋值 onmessage，随后才进入
    // ProtocolVersion 状态；同步补发会让数据落在未初始化的状态机上。
    queueMicrotask(() => {
      flushScheduled = false;
      while (messageHandler && pending.length > 0 && channel.readyState !== WS_CLOSED) {
        messageHandler({ data: pending.shift()! });
      }
    });
  };

  const channel = {
    binaryType: "arraybuffer",
    protocol: "",
    readyState: WS_CONNECTING,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
      if (rfc) {
        rfc.send(bytes);
        return;
      }
      connection?.write(bytes);
    },
    close() {
      closeResources();
    },
  } as DesktopRawChannel;
  // 用可枚举的访问器承载 onmessage：noVNC Websock.attach 通过 Object.keys 校验
  // 通道属性，同时赋值时机即可触发缓存补发。
  Object.defineProperty(channel, "onmessage", {
    enumerable: true,
    configurable: true,
    get: () => messageHandler,
    set: (handler: DesktopRawChannel["onmessage"]) => {
      messageHandler = handler;
      if (handler) scheduleFlush();
    },
  });

  const emitMessage = (bytes: Uint8Array) => {
    if (channel.readyState === WS_CLOSED) return;
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    // 已有积压时必须继续排队，保证字节顺序。
    if (!messageHandler || pending.length > 0) {
      pending.push(copy.buffer);
      scheduleFlush();
      return;
    }
    messageHandler({ data: copy.buffer });
  };

  let clientClosed = false;
  let closeEmitted = false;
  let failure: Error | null = null;
  const safely = (action: () => void) => {
    try {
      action();
    } catch {
      // Cleanup/listener errors must not mask the transport failure or skip other resources.
    }
  };
  const closeResources = () => {
    channel.readyState = WS_CLOSED;
    pending.length = 0;
    const closingRfc = rfc;
    const closingConnection = connection;
    const closeClient = !clientClosed;
    rfc = null;
    connection = null;
    clientClosed = true;
    safely(() => closingRfc?.close());
    safely(() => closingConnection?.close());
    if (closeClient) safely(() => client.close());
  };
  const emitClose = () => {
    if (closeEmitted) return;
    closeEmitted = true;
    safely(() => channel.onclose?.({}));
  };

  let resolveOpened: (() => void) | null = null;
  let rejectOpened: ((error: Error) => void) | null = null;
  const opened =
    tunnel.mode === "ws"
      ? new Promise<void>((resolve, reject) => {
          resolveOpened = resolve;
          rejectOpened = reject;
        })
      : null;
  // A proxy failure may arrive before openProxy resolves and the handshake is awaited.
  void opened?.catch(() => {});

  const settleOpen = () => {
    if (settled || failure) return;
    settled = true;
    resolveOpened?.();
  };
  const settleFailure = (error: Error) => {
    if (failure || channel.readyState === WS_CLOSED) return;
    failure = error;
    if (!settled) rejectOpened?.(error);
    settled = true;
    closeResources();
    safely(() => channel.onerror?.({ message: error.message, error }));
    emitClose();
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (tunnel.mode === "ws") {
      rfc = createRfc6455Client(
        { host: tunnel.ip, port: tunnel.port, path: tunnel.path ?? "/desktop/connect" },
        (bytes) => {
          if (!connection?.write(bytes)) {
            throw new TatTransportError("connection_lost", "desktop tunnel is not writable", { phase: "websocket" });
          }
        },
        {
          onOpen: () => {
            if (failure || channel.readyState === WS_CLOSED) return;
            // 票据只在这一帧里出现：兑换成功才开始转发媒体。
            if (attach) rfc?.send(buildDesktopAttachFrame(attach));
            channel.readyState = WS_OPEN;
            settleOpen();
          },
          onBinary: (payload) => emitMessage(payload),
          onClose: () => settleFailure(new TatTransportError("connection_lost", "desktop websocket closed during handshake", { phase: "websocket" })),
          onError: (message) => settleFailure(new TatTransportError("fatal", message, { phase: "websocket" })),
        },
      );
    }

    connection = await client.openProxy(
      { ip: tunnel.ip, port: tunnel.port },
      {
        consumptionMode: "callback",
        onData: (data) => {
          if (channel.readyState === WS_CLOSED) return;
          if (rfc) {
            try {
              rfc.receive(data);
            } catch (error) {
              settleFailure(normalizeTatTransportError(error, "websocket"));
            }
            return;
          }
          emitMessage(data);
        },
        onClose: () => settleFailure(new TatTransportError("connection_lost", "desktop tunnel closed", { phase: "open_proxy" })),
        onError: (message, error) => settleFailure(error ?? normalizeTatTransportError(new Error(message), "open_proxy")),
      },
    );
    if (failure) throw failure;

    if (rfc) {
      rfc.start();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TatTransportError("request_timeout", "desktop websocket handshake timed out", { phase: "websocket" })), DESKTOP_HANDSHAKE_TIMEOUT_MS);
      });
      await Promise.race([opened as Promise<void>, timeout]);
    } else {
      if (inputGateway && attach) {
        if (!connection.write(new TextEncoder().encode(buildDesktopAttachFrame(attach) + "\n"))) {
          throw new TatTransportError("connection_lost", "desktop input ticket could not be sent", { phase: "open_proxy" });
        }
      }
      channel.readyState = WS_OPEN;
      settled = true;
    }
    if (failure) throw failure;
    return { channel, close: closeResources };
  } catch (error) {
    const cause = failure ?? error;
    closeResources();
    throw cause;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
