/**
 * 最小 RFC6455（WebSocket）客户端，跑在任意字节流之上。
 *
 * 用途：桌面媒体走 TAT 代理的 TCP 隧道时，隧道内承载的是 WebSocket 会话
 * （broker 的 /desktop/connect）。noVNC 需要一个 WebSocket 对象，因此这里只在
 * 客户端侧完成握手与分帧，把字节流伪装成 WebSocket。
 *
 * 这里的握手不是信任边界：整条隧道已经由「产品登录 + 实例级 TAT session」鉴权，
 * 握手只做协议协商（因此不强依赖 crypto.subtle 的 SHA-1 校验）。
 */

export interface Rfc6455Target {
  host: string;
  port: string;
  path: string;
}

export interface Rfc6455Callbacks {
  onOpen?: () => void;
  onBinary?: (payload: Uint8Array) => void;
  onText?: (payload: string) => void;
  onClose?: () => void;
  onError?: (message: string) => void;
}

export interface Rfc6455Client {
  start: () => void;
  send: (data: Uint8Array | string) => void;
  close: (code?: number) => void;
  receive: (chunk: Uint8Array) => void;
}

const HEADER_TERMINATOR = "\r\n\r\n";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

function randomKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function" ? btoa(binary) : "";
}

function indexOfSequence(buffer: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= buffer.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (buffer[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function createRfc6455Client(
  target: Rfc6455Target,
  sink: (bytes: Uint8Array) => void,
  callbacks: Rfc6455Callbacks = {},
): Rfc6455Client {
  let queue: Uint8Array[] = [];
  let queueLength = 0;
  let handshakeDone = false;
  let closed = false;

  let fragmentOpcode = -1;
  let fragments: Uint8Array[] = [];
  let fragmentLength = 0;

  const drain = (): Uint8Array => {
    const out = new Uint8Array(queueLength);
    let offset = 0;
    for (const chunk of queue) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    queue = [];
    queueLength = 0;
    return out;
  };

  const writeFrame = (opcode: number, payload: Uint8Array) => {
    if (closed) return;
    const length = payload.length;
    const header = new Uint8Array(2 + (length < 126 ? 0 : length < 65536 ? 2 : 8) + 4);
    header[0] = 0x80 | opcode;
    let index = 2;
    if (length < 126) {
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header[1] = 0x80 | 126;
      header[index] = (length >> 8) & 0xff;
      header[index + 1] = length & 0xff;
      index += 2;
    } else {
      header[1] = 0x80 | 127;
      let remaining = length;
      for (let i = 7; i >= 0; i -= 1) {
        header[index + i] = remaining & 0xff;
        remaining = Math.floor(remaining / 256);
      }
      index += 8;
    }
    // 客户端→服务端的帧必须掩码（RFC6455 §5.3）。
    const mask = new Uint8Array(4);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      globalThis.crypto.getRandomValues(mask);
    } else {
      for (let i = 0; i < 4; i += 1) mask[i] = Math.floor(Math.random() * 256);
    }
    header.set(mask, index);
    index += 4;

    const masked = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i]! ^ mask[i & 3]!;

    const frame = new Uint8Array(index + length);
    frame.set(header.subarray(0, index), 0);
    frame.set(masked, index);
    sink(frame);
  };

  const resetFragments = () => {
    fragmentOpcode = -1;
    fragments = [];
    fragmentLength = 0;
  };

  const emitFragment = () => {
    const payload = new Uint8Array(fragmentLength);
    let offset = 0;
    for (const chunk of fragments) {
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    const opcode = fragmentOpcode;
    resetFragments();
    if (opcode === OPCODE_TEXT) {
      callbacks.onText?.(new TextDecoder().decode(payload));
    } else if (opcode === OPCODE_BINARY) {
      callbacks.onBinary?.(payload);
    }
  };

  const handleFrame = (fin: boolean, opcode: number, payload: Uint8Array) => {
    if (opcode === OPCODE_CLOSE) {
      if (!closed) {
        closed = true;
        writeFrame(OPCODE_CLOSE, new Uint8Array([0x03, 0xe8]));
      }
      callbacks.onClose?.();
      return;
    }
    if (opcode === OPCODE_PING) {
      writeFrame(OPCODE_PONG, payload);
      return;
    }
    if (opcode === OPCODE_PONG) return;

    if (opcode === OPCODE_CONTINUATION) {
      fragments.push(payload);
      fragmentLength += payload.length;
      if (fin) emitFragment();
      return;
    }
    if (fragmentOpcode !== -1) {
      // 未收到 FIN 就来了新的起始帧：协议错误，交给上层关闭。
      resetFragments();
      callbacks.onError?.("websocket framing error");
      return;
    }
    if (!fin) {
      fragmentOpcode = opcode;
      fragments.push(payload);
      fragmentLength += payload.length;
      return;
    }
    if (opcode === OPCODE_TEXT) {
      callbacks.onText?.(new TextDecoder().decode(payload));
    } else if (opcode === OPCODE_BINARY) {
      callbacks.onBinary?.(payload);
    }
  };

  return {
    start() {
      const key = randomKey();
      const path = target.path.startsWith("/") ? target.path : `/${target.path}`;
      const request =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${target.host}:${target.port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        "\r\n";
      sink(new TextEncoder().encode(request));
    },
    send(data) {
      if (closed) return;
      const payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
      writeFrame(typeof data === "string" ? OPCODE_TEXT : OPCODE_BINARY, payload);
    },
    close(code = 1000) {
      if (closed) return;
      closed = true;
      const payload = new Uint8Array(2);
      payload[0] = (code >> 8) & 0xff;
      payload[1] = code & 0xff;
      writeFrame(OPCODE_CLOSE, payload);
    },
    receive(chunk) {
      if (chunk.length === 0) return;
      queue.push(chunk);
      queueLength += chunk.length;
      let buffer = drain();
      let offset = 0;
      const terminator = new TextEncoder().encode(HEADER_TERMINATOR);
      for (;;) {
        if (!handshakeDone) {
          const end = indexOfSequence(buffer, terminator, offset);
          if (end < 0) break;
          const header = new TextDecoder().decode(buffer.subarray(offset, end + terminator.length));
          offset = end + terminator.length;
          const statusOk = /^HTTP\/1\.1\s+101\b/.test(header);
          const upgraded = /\r?\nupgrade:\s*websocket/i.test(header);
          if (!statusOk || !upgraded) {
            closed = true;
            callbacks.onError?.("websocket handshake rejected");
            callbacks.onClose?.();
            return;
          }
          handshakeDone = true;
          callbacks.onOpen?.();
          continue;
        }
        if (buffer.length - offset < 2) break;
        const b0 = buffer[offset]!;
        const b1 = buffer[offset + 1]!;
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let length = b1 & 0x7f;
        let index = offset + 2;
        if (length === 126) {
          if (buffer.length - index < 2) break;
          length = (buffer[index]! << 8) | buffer[index + 1]!;
          index += 2;
        } else if (length === 127) {
          if (buffer.length - index < 8) break;
          length = 0;
          for (let i = 0; i < 8; i += 1) length = length * 256 + buffer[index + i]!;
          index += 8;
        }
        let mask: Uint8Array | null = null;
        if (masked) {
          if (buffer.length - index < 4) break;
          mask = buffer.subarray(index, index + 4);
          index += 4;
        }
        if (buffer.length - index < length) break;
        const payload = buffer.subarray(index, index + length);
        if (mask) {
          for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
        }
        offset = index + length;
        handleFrame(fin, opcode, payload);
        if (closed) return;
      }
      if (offset < buffer.length) {
        const leftover = buffer.subarray(offset);
        queue.push(leftover);
        queueLength += leftover.length;
      }
    },
  };
}
