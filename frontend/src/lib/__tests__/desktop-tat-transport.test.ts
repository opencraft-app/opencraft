import { afterEach, describe, expect, it, vi } from "vitest";
import * as rfcModule from "@/lib/rfc6455-over-stream";
import { TatTransportError } from "@/lib/tat-transport-error";
import type { BotTerminalSession } from "@/domain/types";
import {
  openDesktopTatSocket,
  type DesktopTatProxy,
  type DesktopTatProxyConnection,
} from "@/lib/desktop-tat-transport";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const bootstrap = { sessionId: "sess-1" } as unknown as BotTerminalSession;

type DataHandler = ((data: Uint8Array) => void) | undefined;

class FakeProxy implements DesktopTatProxy {
  closed = false;
  clientClosed = false;
  targets: { ip?: string; port: number | string }[] = [];
  writes: Uint8Array[] = [];
  private handlers: { onData?: DataHandler; onClose?: () => void; onError?: (m: string) => void } = {};

  openProxy = vi.fn(async (target: { ip?: string; port: number | string }, handlers = {}) => {
    this.targets.push(target);
    this.handlers = handlers;
    const connection: DesktopTatProxyConnection = {
      write: (data) => {
        this.writes.push(data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer));
        return true;
      },
      close: () => {
        this.closed = true;
      },
    };
    return connection;
  });

  close = vi.fn(() => {
    this.clientClosed = true;
  });

  push(bytes: Uint8Array) {
    this.handlers.onData?.(bytes);
  }

  signalClose() {
    this.closed = true;
    this.handlers.onClose?.();
  }

  writtenText() {
    return this.writes.map((chunk) => new TextDecoder().decode(chunk)).join("");
  }
}

function decodeClientFrames(bytes: Uint8Array): { opcode: number; payload: Uint8Array }[] {
  const frames: { opcode: number; payload: Uint8Array }[] = [];
  let index = 0;
  while (index + 2 <= bytes.length) {
    const opcode = bytes[index]! & 0x0f;
    let length = bytes[index + 1]! & 0x7f;
    let cursor = index + 2;
    if (length === 126) {
      length = (bytes[cursor]! << 8) | bytes[cursor + 1]!;
      cursor += 2;
    } else if (length === 127) {
      length = 0;
      for (let i = 0; i < 8; i += 1) length = length * 256 + bytes[cursor + i]!;
      cursor += 8;
    }
    const mask = bytes.subarray(cursor, cursor + 4);
    cursor += 4;
    const payload = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) payload[i] = bytes[cursor + i]! ^ mask[i & 3]!;
    cursor += length;
    frames.push({ opcode, payload });
    index = cursor;
  }
  return frames;
}

function serverFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const header = new Uint8Array(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (payload.length < 126) {
    header[1] = payload.length;
  } else {
    header[1] = 126;
    header[2] = (payload.length >> 8) & 0xff;
    header[3] = payload.length & 0xff;
  }
  const frame = new Uint8Array(header.length + payload.length);
  frame.set(header, 0);
  frame.set(payload, header.length);
  return frame;
}

const HANDSHAKE_RESPONSE =
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n";

describe("desktop failure cleanup", () => {
  const tunnel = { mode: "ws" as const, ip: "127.0.0.1", port: "6080", path: "/desktop/connect" };

  it.each(["ws", "rfb"] as const)("preserves openProxy rejection and closes the %s client even when close throws", async (mode) => {
    const error = new TatTransportError("lease_expired", "session not valid", { phase: "open_proxy" });
    const proxy = new FakeProxy();
    proxy.openProxy.mockRejectedValueOnce(error);
    proxy.close.mockImplementation(() => { throw new Error("cleanup failed"); });
    const createRfc = vi.spyOn(rfcModule, "createRfc6455Client");
    const opened = openDesktopTatSocket({ bootstrap, tunnel: { ...tunnel, mode }, createProxyClient: () => proxy });
    const rfcClose = mode === "ws" ? vi.spyOn(createRfc.mock.results[0]!.value as rfcModule.Rfc6455Client, "close") : null;
    await expect(opened).rejects.toBe(error);
    expect(proxy.close).toHaveBeenCalledTimes(1);
    if (rfcClose) expect(rfcClose).toHaveBeenCalledTimes(1);
  });

  it.each(["rejected", "timeout", "start throws"])("cleans all resources exactly once when websocket %s", async (failure) => {
    vi.useFakeTimers();
    const proxy = new FakeProxy();
    const connection = { write: vi.fn(() => true), close: vi.fn(() => proxy.signalClose()) };
    const originalOpen = proxy.openProxy.getMockImplementation()!;
    proxy.openProxy.mockImplementation(async (target, handlers) => {
      await originalOpen(target, handlers);
      return connection;
    });
    const createRfc = vi.spyOn(rfcModule, "createRfc6455Client");
    const error = new TatTransportError("connection_lost", "write failed", { phase: "websocket" });
    if (failure === "start throws") connection.write.mockImplementation(() => { throw error; });
    const opened = openDesktopTatSocket({ bootstrap, tunnel, createProxyClient: () => proxy });
    const rejection = opened.catch((cause: unknown) => cause);
    const rfcClose = vi.spyOn(createRfc.mock.results[0]!.value as rfcModule.Rfc6455Client, "close");
    if (failure === "start throws") {
      rfcClose.mockImplementation(() => { throw new Error("rfc close failed"); });
      connection.close.mockImplementation(() => { proxy.signalClose(); throw new Error("proxy close failed"); });
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (failure === "rejected") proxy.push(new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\n\r\n"));
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(15_000);
    const cause = await rejection;
    if (failure === "start throws") expect(cause).toBe(error);
    else expect(cause).toMatchObject({ retryable: failure === "timeout", kind: failure === "timeout" ? "request_timeout" : "fatal" });
    expect(rfcClose).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(proxy.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks missing input tickets as non-retryable", async () => {
    await expect(openDesktopTatSocket({ bootstrap, tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5904", path: "/desktop/input" } }))
      .rejects.toMatchObject({ retryable: false, kind: "fatal" });
  });

  it("emits remote close once even when the listener throws and closes reentrantly", async () => {
    const proxy = new FakeProxy();
    const desktop = await openDesktopTatSocket({ bootstrap, tunnel: { ...tunnel, mode: "rfb" }, createProxyClient: () => proxy });
    const onclose = vi.fn(() => { desktop.close(); throw new Error("listener failed"); });
    desktop.channel.onclose = onclose;
    expect(() => proxy.signalClose()).not.toThrow();
    expect(() => proxy.signalClose()).not.toThrow();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(proxy.close).toHaveBeenCalledTimes(1);
  });
});

describe("openDesktopTatSocket", () => {
  it("rfb 模式把隧道字节直接喂给 noVNC 通道", async () => {
    const proxy = new FakeProxy();
    const connection = await openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5901" },
      createProxyClient: () => proxy,
    });

    expect(proxy.targets).toEqual([{ ip: "127.0.0.1", port: "5901" }]);
    // noVNC Websock.attach 要求的通道属性必须齐全。
    for (const prop of ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"]) {
      expect(Object.keys(connection.channel)).toContain(prop);
    }
    expect(connection.channel.readyState).toBe(1);

    const received: Uint8Array[] = [];
    connection.channel.onmessage = ({ data }) => received.push(new Uint8Array(data));
    proxy.push(new Uint8Array([0x52, 0x46, 0x42]));
    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([0x52, 0x46, 0x42]);

    connection.channel.send(new Uint8Array([3, 1, 0]));
    expect([...proxy.writes[proxy.writes.length - 1]!]).toEqual([3, 1, 0]);

    connection.close();
    expect(proxy.closed).toBe(true);
    expect(proxy.clientClosed).toBe(true);
  });

  it("输入网关在 RFB 握手前发送绑定票据，只读端点不受影响", async () => {
    const proxy = new FakeProxy();
    const connection = await openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5904", path: "/desktop/input" },
      attach: { attachmentId: "att-1", ticket: "ticket-1" },
      createProxyClient: () => proxy,
    });
    expect(proxy.writtenText()).toBe(JSON.stringify({ event: "desktop/attach", version: 1, attachmentId: "att-1", ticket: "ticket-1" }) + "\n");
    connection.channel.send(new TextEncoder().encode("RFB 003.008\n"));
    expect(proxy.writes).toHaveLength(2);
    connection.close();
  });

  it("输入网关缺少票据时不打开连接", async () => {
    const proxy = new FakeProxy();
    await expect(openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5904", path: "/desktop/input" },
      createProxyClient: () => proxy,
    })).rejects.toThrow(/ticket/);
    expect(proxy.openProxy).not.toHaveBeenCalled();
  });

  it("ws 模式先握手再以首帧携带一次性票据", async () => {
    const proxy = new FakeProxy();
    const attach = { attachmentId: "att-1", ticket: "ticket-1" };
    const opened = openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "ws", ip: "127.0.0.1", port: "6080", path: "/desktop/connect" },
      attach,
      createProxyClient: () => proxy,
    });

    // 握手响应在 openProxy 之后才可能到达，这里等第一帧写入后再喂。
    await vi.waitFor(() => expect(proxy.writes.length).toBeGreaterThan(0));
    expect(proxy.writtenText()).toContain("GET /desktop/connect HTTP/1.1");
    expect(proxy.writtenText()).toContain("Upgrade: websocket");

    proxy.push(new TextEncoder().encode(HANDSHAKE_RESPONSE));
    const connection = await opened;
    expect(connection.channel.readyState).toBe(1);

    const attachFrames = decodeClientFrames(proxy.writes[proxy.writes.length - 1]!);
    expect(attachFrames).toHaveLength(1);
    const payload = JSON.parse(new TextDecoder().decode(attachFrames[0]!.payload));
    expect(payload).toMatchObject({
      event: "desktop/attach",
      version: 1,
      attachmentId: "att-1",
      ticket: "ticket-1",
    });

    const received: Uint8Array[] = [];
    connection.channel.onmessage = ({ data }) => received.push(new Uint8Array(data));
    proxy.push(serverFrame(0x2, new Uint8Array([0x52, 0x46, 0x42])));
    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([0x52, 0x46, 0x42]);
  });

  it("noVNC 挂上 onmessage 之前到达的 RFB 首包不丢失且保持顺序", async () => {
    const proxy = new FakeProxy();
    const connection = await openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5901" },
      createProxyClient: () => proxy,
    });

    // 模拟服务端在 noVNC 异步加载完成前就推送 ProtocolVersion。
    proxy.push(new TextEncoder().encode("RFB 003.008\n"));
    proxy.push(new Uint8Array([1, 2]));

    const received: number[][] = [];
    connection.channel.onmessage = ({ data }) => received.push([...new Uint8Array(data)]);
    // 补发是异步的：attach 同步赋值 onmessage 后才进入握手状态。
    expect(received).toHaveLength(0);
    // 补发完成前到达的新字节必须排在积压之后。
    proxy.push(new Uint8Array([3]));
    await Promise.resolve();

    expect(received).toEqual([[...new TextEncoder().encode("RFB 003.008\n")], [1, 2], [3]]);

    proxy.push(new Uint8Array([4]));
    expect(received[received.length - 1]).toEqual([4]);
    // noVNC Websock.attach 用 Object.keys 校验属性，访问器也必须可枚举。
    expect(Object.keys(connection.channel)).toContain("onmessage");
  });

  it("通道关闭后丢弃积压，不再回调", async () => {
    const proxy = new FakeProxy();
    const connection = await openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "rfb", ip: "127.0.0.1", port: "5901" },
      createProxyClient: () => proxy,
    });
    proxy.push(new Uint8Array([1]));
    connection.close();

    const onmessage = vi.fn();
    connection.channel.onmessage = onmessage;
    await Promise.resolve();
    expect(onmessage).not.toHaveBeenCalled();
  });

  it("握手被拒绝时不返回可用通道", async () => {
    const proxy = new FakeProxy();
    const opened = openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "ws", ip: "127.0.0.1", port: "6080", path: "/desktop/connect" },
      createProxyClient: () => proxy,
    });
    await vi.waitFor(() => expect(proxy.writes.length).toBeGreaterThan(0));
    proxy.push(new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\n\r\n"));

    await expect(opened).rejects.toThrow(/handshake rejected/);
  });

  it("隧道打开前断开会让通道进入关闭态", async () => {
    const proxy = new FakeProxy();
    const opened = openDesktopTatSocket({
      bootstrap,
      tunnel: { mode: "ws", ip: "127.0.0.1", port: "6080", path: "/desktop/connect" },
      createProxyClient: () => proxy,
    });
    await vi.waitFor(() => expect(proxy.writes.length).toBeGreaterThan(0));
    proxy.signalClose();

    await expect(opened).rejects.toThrow(/closed/);
  });
});
