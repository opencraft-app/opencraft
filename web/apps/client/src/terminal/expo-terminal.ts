import {
  TatPtyTerminal,
  type Base64Codec,
  type TextSocket,
  type TextSocketEvent,
  type TextSocketFactory,
  type TerminalOpener,
} from "@raft-platform/client-core";

export interface WebSocketLike {
  close(): void;
  onclose: ((event: {code?: number; reason?: string}) => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: {data: string}) => void) | null;
  onopen: (() => void) | null;
  send(value: string): void;
}

export interface WebSocketConstructor {
  new(url: string): WebSocketLike;
}

export const expoBase64: Base64Codec = {
  decode(value) {
    const normalized = value.trim();
    if (
      normalized.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
      throw new Error("base64 编码无效");
    }
    const padding = normalized.endsWith("==")
      ? 2
      : normalized.endsWith("=")
        ? 1
        : 0;
    const output = new Uint8Array((normalized.length / 4) * 3 - padding);
    let offset = 0;
    for (let index = 0; index < normalized.length; index += 4) {
      const chunk = normalized.slice(index, index + 4);
      const bits =
        (base64Value(chunk[0]) << 18) |
        (base64Value(chunk[1]) << 12) |
        (base64Value(chunk[2]) << 6) |
        base64Value(chunk[3]);
      if (offset < output.length) output[offset++] = (bits >> 16) & 0xff;
      if (offset < output.length) output[offset++] = (bits >> 8) & 0xff;
      if (offset < output.length) output[offset++] = bits & 0xff;
    }
    return output;
  },
  encode(value) {
    let result = "";
    for (let index = 0; index < value.length; index += 3) {
      const first = value[index] ?? 0;
      const second = value[index + 1] ?? 0;
      const third = value[index + 2] ?? 0;
      const bits = (first << 16) | (second << 8) | third;
      result += base64Alphabet[(bits >> 18) & 0x3f];
      result += base64Alphabet[(bits >> 12) & 0x3f];
      result += index + 1 < value.length
        ? base64Alphabet[(bits >> 6) & 0x3f]
        : "=";
      result += index + 2 < value.length
        ? base64Alphabet[bits & 0x3f]
        : "=";
    }
    return result;
  },
};

export function createExpoTerminalOpener(options: {
  randomId?: () => string;
  WebSocketImpl?: WebSocketConstructor;
} = {}): TerminalOpener {
  const WebSocketImpl = options.WebSocketImpl ??
    (globalThis.WebSocket as unknown as WebSocketConstructor);
  if (!WebSocketImpl) throw new Error("当前环境不支持 WebSocket");
  return new TatPtyTerminal({
    base64: expoBase64,
    randomId: options.randomId ?? randomChannelId,
    sockets: new ExpoTextSocketFactory(WebSocketImpl),
  });
}

class ExpoTextSocketFactory implements TextSocketFactory {
  public constructor(private readonly WebSocketImpl: WebSocketConstructor) {}

  public open(url: string): TextSocket {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:") {
      throw new Error("终端只允许安全 WebSocket");
    }
    const socket = new this.WebSocketImpl(parsed.toString());
    return {
      close() {
        socket.close();
      },
      send(data) {
        socket.send(data);
      },
      subscribe(listener) {
        const emit = (event: TextSocketEvent) => listener(event);
        socket.onopen = () => emit({type: "open"});
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") {
            emit({message: "终端返回了非文本帧", type: "error"});
            return;
          }
          emit({data: event.data, type: "message"});
        };
        socket.onerror = () => emit({message: "WebSocket 错误", type: "error"});
        socket.onclose = (event) => emit({
          ...(event.code === undefined ? {} : {code: event.code}),
          ...(event.reason === undefined ? {} : {reason: event.reason}),
          type: "close",
        });
        return () => {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
        };
      },
    };
  }
}

const base64Alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Value(value: string | undefined): number {
  if (!value || value === "=") return 0;
  const index = base64Alphabet.indexOf(value);
  if (index < 0) throw new Error("base64 编码无效");
  return index;
}

function randomChannelId(): string {
  const cryptoValue = globalThis.crypto;
  if (cryptoValue && "randomUUID" in cryptoValue) {
    return cryptoValue.randomUUID();
  }
  return `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
