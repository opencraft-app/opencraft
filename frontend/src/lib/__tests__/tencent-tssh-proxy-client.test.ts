import { Binary, deserialize, serialize } from "bson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TencentTsshProxyClient } from "@/lib/tencent-tssh-proxy-client";

const bootstrap = {
  sandboxId: "sb-1",
  poolId: "pool-1",
  sessionId: "session-1",
  region: "ap-guangzhou",
  instanceId: "rins-proxy001",
  ownerUin: "10001",
  loginUin: "10002",
  appId: 1250000000,
  wsUrl: "wss://ap-guangzhou.forward.tat-tc.tencent.cn/ws",
  cols: 120,
  rows: 32,
  timeoutSeconds: 3600,
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  sent: Array<string | Uint8Array> = [];
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string") {
      this.sent.push(data);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    }
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  receive(data: unknown) {
    this.onmessage?.call(this as unknown as WebSocket, { data } as MessageEvent);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.call(this as unknown as WebSocket, new CloseEvent("close", { code: 1000 }));
  }
}

const WebSocketImpl = FakeWebSocket as unknown as new (url: string | URL, protocols?: string | string[]) => WebSocket;

const parseJsonFrame = (socket: FakeWebSocket, index: number) => JSON.parse(String(socket.sent[index] ?? "{}")) as Record<string, unknown>;

const parseBsonFrames = (socket: FakeWebSocket) =>
  socket.sent.filter((frame): frame is Uint8Array => frame instanceof Uint8Array).map((frame) => deserialize(frame) as Record<string, unknown>);

const bsonResponse = (type: string, channelId: string, data: Record<string, unknown>) =>
  serialize({
    Type: type,
    Data: {
      SessionId: "session-1",
      ChannelId: channelId,
      CustomData: "",
      Data: data,
    },
  });

const bytesOf = (value: unknown) => {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Binary) return value.buffer;
  throw new Error("value is not binary data");
};

const flushPromises = async (times = 5) => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TencentTsshProxyClient", () => {
  it("authenticates and opens a TAT proxy channel", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 10 });
    const openPromise = client.openProxy({ ip: "127.0.0.1", port: 8080, proxyId: "proxy-1" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(parseJsonFrame(socket, 0)).toMatchObject({
      Type: "SessionAuth",
      Data: {
        Uin: "10001",
        AppId: 1250000000,
        InstanceId: "rins-proxy001",
        SessionId: "session-1",
      },
    });

    vi.advanceTimersByTime(10);
    await flushPromises();

    const request = parseBsonFrames(socket)[0]!;
    expect(request).toMatchObject({
      Type: "PtyProxyNew",
      Data: {
        SessionId: "session-1",
        ChannelId: "proxy-1",
        Data: {
          ProxyId: "proxy-1",
          Ip: "127.0.0.1",
          Port: "8080",
        },
      },
    });

    socket.receive(bsonResponse("PtyProxyReady", "proxy-1", { ProxyId: "proxy-1" }));
    await expect(openPromise).resolves.toMatchObject({ proxyId: "proxy-1", channelId: "proxy-1" });
  });

  it("sends and receives proxy bytes", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const openPromise = client.openProxy({ port: "9000", proxyId: "proxy-2" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyReady", "proxy-2", { ProxyId: "proxy-2" }));
    const connection = await openPromise;

    expect(connection.write("ping")).toBe(true);
    const writeFrame = parseBsonFrames(socket).at(-1)!;
    expect(writeFrame).toMatchObject({
      Type: "PtyProxyData",
      Data: {
        ChannelId: "proxy-2",
        Data: {
          ProxyId: "proxy-2",
        },
      },
    });
    const writePayload = ((writeFrame.Data as Record<string, unknown>).Data as Record<string, unknown>).Data;
    expect(new TextDecoder().decode(bytesOf(writePayload))).toBe("ping");

    const reader = connection.readable.getReader();
    socket.receive(bsonResponse("PtyProxyData", "proxy-2", {
      ProxyId: "proxy-2",
      Data: new TextEncoder().encode("pong"),
    }));
    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(new TextDecoder().decode(result.value)).toBe("pong");
  });

  it("closes a proxy stream on remote close", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const openPromise = client.openProxy({ port: 9001, proxyId: "proxy-3" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyReady", "proxy-3", { ProxyId: "proxy-3" }));
    const connection = await openPromise;
    const reader = connection.readable.getReader();

    socket.receive(bsonResponse("PtyProxyClose", "proxy-3", { ProxyId: "proxy-3" }));
    await expect(connection.waitClosed()).resolves.toBeUndefined();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });
});
