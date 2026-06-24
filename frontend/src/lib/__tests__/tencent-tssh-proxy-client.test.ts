import { Binary, deserialize, serialize } from "bson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TatTransportError } from "@/lib/tat-transport-error";
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

  markClosedWithoutEvent() {
    this.readyState = WebSocket.CLOSED;
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

const makePrng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
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
        MaxIdleTime: 3600,
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

  it("passes a configurable proxy websocket idle timeout to TAT auth", async () => {
    const client = new TencentTsshProxyClient({ ...bootstrap, timeoutSeconds: 5 }, { WebSocketImpl, connectDelayMs: 0 });
    const openPromise = client.openProxy({ ip: "127.0.0.1", port: 8080, proxyId: "proxy-short-idle" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(parseJsonFrame(socket, 0)).toMatchObject({
      Type: "SessionAuth",
      Data: {
        MaxIdleTime: 5,
      },
    });

    vi.advanceTimersByTime(0);
    await flushPromises();
    socket.receive(bsonResponse("PtyProxyReady", "proxy-short-idle", { ProxyId: "proxy-short-idle" }));
    await expect(openPromise).resolves.toMatchObject({ proxyId: "proxy-short-idle" });
    client.close();
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

  it("classifies TAT session invalid errors as lease expiry", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const openPromise = client.openProxy({ port: 9001, proxyId: "proxy-expired" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyReady", "proxy-expired", {
      Error: "session not valid",
      ProxyId: "proxy-expired",
    }));

    await expect(openPromise).rejects.toMatchObject({
      kind: "lease_expired",
      phase: "open_proxy",
      retryable: true,
    } satisfies Partial<TatTransportError>);
  });

  it("classifies websocket close as connection loss", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const openPromise = client.openProxy({ port: 9001, proxyId: "proxy-closed" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    socket.close();

    await expect(openPromise).rejects.toMatchObject({
      kind: "connection_lost",
      phase: "websocket",
      retryable: true,
    } satisfies Partial<TatTransportError>);
  });

  it("routes concurrent proxy bytes only to their matching channel", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const firstPromise = client.openProxy({ port: 9001, proxyId: "proxy-a" });
    const secondPromise = client.openProxy({ port: 9002, proxyId: "proxy-b" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    expect(parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew")).toHaveLength(2);
    socket.receive(bsonResponse("PtyProxyReady", "proxy-a", { ProxyId: "proxy-a" }));
    socket.receive(bsonResponse("PtyProxyReady", "proxy-b", { ProxyId: "proxy-b" }));

    const first = await firstPromise;
    const second = await secondPromise;
    const firstReader = first.readable.getReader();
    const secondReader = second.readable.getReader();
    let firstSettled = false;
    const firstRead = firstReader.read().then((result) => {
      firstSettled = true;
      return result;
    });
    const secondRead = secondReader.read();

    socket.receive(bsonResponse("PtyProxyData", "proxy-b", {
      ProxyId: "proxy-b",
      Data: new TextEncoder().encode("second-only"),
    }));
    const secondResult = await secondRead;
    expect(secondResult.done).toBe(false);
    expect(new TextDecoder().decode(secondResult.value)).toBe("second-only");
    await flushPromises();
    expect(firstSettled).toBe(false);

    socket.receive(bsonResponse("PtyProxyData", "proxy-a", {
      ProxyId: "proxy-a",
      Data: new TextEncoder().encode("first-only"),
    }));
    const firstResult = await firstRead;
    expect(firstResult.done).toBe(false);
    expect(new TextDecoder().decode(firstResult.value)).toBe("first-only");
    client.close();
  });

  it("preserves per-channel byte order under deterministic interleaved proxy frames", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const proxyIds = ["mux-a", "mux-b", "mux-c", "mux-d"];
    const received = new Map<string, string[]>();
    const openPromises = proxyIds.map((proxyId, index) =>
      client.openProxy({ port: 9100 + index, proxyId }, {
        onData: (data) => {
          received.set(proxyId, [...(received.get(proxyId) ?? []), new TextDecoder().decode(data)]);
        },
      }),
    );
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    for (const proxyId of proxyIds) {
      socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    }
    await Promise.all(openPromises);

    const nextRandom = makePrng(0xace0ff);
    const queues = new Map(
      proxyIds.map((proxyId) => [
        proxyId,
        Array.from({ length: 9 }, (_, index) => ({
          proxyId,
          text: `${proxyId}:${index};`,
        })),
      ]),
    );
    const frames: Array<{ proxyId: string; text: string }> = [];
    while ([...queues.values()].some((queue) => queue.length > 0)) {
      const available = proxyIds.filter((proxyId) => (queues.get(proxyId)?.length ?? 0) > 0);
      const proxyId = available[Math.floor(nextRandom() * available.length)]!;
      frames.push(queues.get(proxyId)!.shift()!);
    }

    for (const frame of frames) {
      socket.receive(bsonResponse("PtyProxyData", frame.proxyId, {
        ProxyId: frame.proxyId,
        Data: new TextEncoder().encode(frame.text),
      }));
    }
    await flushPromises();

    for (const proxyId of proxyIds) {
      expect(received.get(proxyId)?.join("")).toBe(Array.from({ length: 9 }, (_, index) => `${proxyId}:${index};`).join(""));
    }
    client.close();
  });

  it("closing one proxy channel does not close sibling channels on the same socket", async () => {
    const client = new TencentTsshProxyClient(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const firstPromise = client.openProxy({ port: 9001, proxyId: "proxy-close-a" });
    const secondPromise = client.openProxy({ port: 9002, proxyId: "proxy-close-b" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyReady", "proxy-close-a", { ProxyId: "proxy-close-a" }));
    socket.receive(bsonResponse("PtyProxyReady", "proxy-close-b", { ProxyId: "proxy-close-b" }));

    const first = await firstPromise;
    const second = await secondPromise;
    const secondReader = second.readable.getReader();
    first.close();

    const closeFrame = parseBsonFrames(socket).at(-1)!;
    expect(closeFrame).toMatchObject({
      Type: "PtyProxyClose",
      Data: {
        ChannelId: "proxy-close-a",
        Data: {
          ProxyId: "proxy-close-a",
        },
      },
    });

    socket.receive(bsonResponse("PtyProxyData", "proxy-close-b", {
      ProxyId: "proxy-close-b",
      Data: new TextEncoder().encode("still-alive"),
    }));
    const secondResult = await secondReader.read();
    expect(secondResult.done).toBe(false);
    expect(new TextDecoder().decode(secondResult.value)).toBe("still-alive");
    client.close();
  });

  it("ignores late ready frames after a proxy request timeout and keeps the client reusable", async () => {
    const client = new TencentTsshProxyClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      requestTimeoutMs: 25,
    });
    const timedOutPromise = client.openProxy({ port: 9001, proxyId: "proxy-timeout" });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();

    vi.advanceTimersByTime(25);
    await expect(timedOutPromise).rejects.toThrow("TAT proxy request timed out");

    socket.receive(bsonResponse("PtyProxyReady", "proxy-timeout", { ProxyId: "proxy-timeout" }));
    await flushPromises();

    const recoveredPromise = client.openProxy({ port: 9002, proxyId: "proxy-recovered" });
    await flushPromises();
    socket.receive(bsonResponse("PtyProxyReady", "proxy-recovered", { ProxyId: "proxy-recovered" }));
    await expect(recoveredPromise).resolves.toMatchObject({ proxyId: "proxy-recovered" });
    client.close();
  });

  it("reconnects after the TAT server closes an idle proxy websocket", async () => {
    const client = new TencentTsshProxyClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      requestTimeoutMs: 25,
    });
    const firstPromise = client.openProxy({ port: 9001, proxyId: "proxy-before-idle" });
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    firstSocket.receive(bsonResponse("PtyProxyReady", "proxy-before-idle", { ProxyId: "proxy-before-idle" }));
    await expect(firstPromise).resolves.toMatchObject({ proxyId: "proxy-before-idle" });

    firstSocket.close();
    await flushPromises();

    const secondPromise = client.openProxy({ port: 9002, proxyId: "proxy-after-idle" });
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    secondSocket.receive(bsonResponse("PtyProxyReady", "proxy-after-idle", { ProxyId: "proxy-after-idle" }));

    await expect(secondPromise).resolves.toMatchObject({ proxyId: "proxy-after-idle" });
    client.close();
  });

  it("does not reuse a resolved websocket promise when the browser socket is already closed", async () => {
    const client = new TencentTsshProxyClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      requestTimeoutMs: 25,
    });
    const firstPromise = client.openProxy({ port: 9001, proxyId: "proxy-before-stale" });
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    firstSocket.receive(bsonResponse("PtyProxyReady", "proxy-before-stale", { ProxyId: "proxy-before-stale" }));
    await expect(firstPromise).resolves.toMatchObject({ proxyId: "proxy-before-stale" });

    firstSocket.markClosedWithoutEvent();

    const secondPromise = client.openProxy({ port: 9002, proxyId: "proxy-after-stale" });
    await flushPromises();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const secondSocket = FakeWebSocket.instances[1]!;
    secondSocket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    secondSocket.receive(bsonResponse("PtyProxyReady", "proxy-after-stale", { ProxyId: "proxy-after-stale" }));

    await expect(secondPromise).resolves.toMatchObject({ proxyId: "proxy-after-stale" });
    client.close();
  });
});
