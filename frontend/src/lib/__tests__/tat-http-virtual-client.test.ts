import { Binary, deserialize, serialize } from "bson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTatHermesFetch, createTatHermesWebFetch, createTatPortFetch, TatHttpVirtualClient } from "@/lib/tat-http-virtual-client";
import { TencentTsshProxyClient } from "@/lib/tencent-tssh-proxy-client";

const bootstrap = {
  sandboxId: "sb-1",
  poolId: "pool-1",
  sessionId: "session-1",
  region: "ap-guangzhou",
  instanceId: "rins-http001",
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

const textOfProxyDataFrame = (frame: Record<string, unknown>) => {
  const envelope = frame.Data as Record<string, unknown>;
  const payload = envelope.Data as Record<string, unknown>;
  return new TextDecoder().decode(bytesOf(payload.Data));
};

const concatBytes = (chunks: Uint8Array[]) => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const makePrng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const randomBytes = (length: number, seed: number) => {
  const next = makePrng(seed);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(next() * 256);
  }
  return bytes;
};

const splitRandomly = (bytes: Uint8Array, seed: number, maxChunkSize: number) => {
  const next = makePrng(seed);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const size = Math.max(1, Math.min(remaining, 1 + Math.floor(next() * maxChunkSize)));
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return chunks;
};

const sendProxyData = (socket: FakeWebSocket, proxyId: string, bytes: Uint8Array) => {
  socket.receive(bsonResponse("PtyProxyData", proxyId, {
    ProxyId: proxyId,
    Data: bytes,
  }));
};

const sendProxyDataChunks = (socket: FakeWebSocket, proxyId: string, chunks: Uint8Array[]) => {
  for (const chunk of chunks) {
    sendProxyData(socket, proxyId, chunk);
  }
};

const startHttpFetch = async (
  input: string,
  init: Parameters<TatHttpVirtualClient["fetch"]>[1] = {},
  options: ConstructorParameters<typeof TatHttpVirtualClient>[1] = {},
) => {
  const client = new TatHttpVirtualClient(bootstrap, {
    WebSocketImpl,
    connectDelayMs: 0,
    target: { port: 8642 },
    ...options,
  });
  const responsePromise = client.fetch(input, init);
  const socket = FakeWebSocket.instances.at(-1)!;
  const proxyId = await openSocketAndReadProxyId(socket);
  socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
  await flushPromises();
  return { client, socket, proxyId, responsePromise };
};

const encodeAscii = (value: string) => new TextEncoder().encode(value);

const flushPromises = async (times = 5) => {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
};

const openSocketAndReadProxyId = async (socket: FakeWebSocket) => {
  socket.open();
  vi.advanceTimersByTime(0);
  await flushPromises();
  return (((parseBsonFrames(socket)[0]!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string) ?? "";
};

const readTextChunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const result = await reader.read();
  expect(result.done).toBe(false);
  return new TextDecoder().decode(result.value);
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TatHttpVirtualClient", () => {
  it("exposes a fetch-compatible HTTP API over TAT proxy", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { ip: "127.0.0.1", host: "hermes.local", port: 8642 },
    });
    const responsePromise = client.fetch("/v1/models?limit=1");
    const socket = FakeWebSocket.instances[0]!;

    const proxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();

    const requestFrame = parseBsonFrames(socket).at(-1)!;
    expect(requestFrame).toMatchObject({ Type: "PtyProxyData" });
    expect(textOfProxyDataFrame(requestFrame)).toContain("GET /v1/models?limit=1 HTTP/1.1\r\n");
    expect(textOfProxyDataFrame(requestFrame)).toContain("host: hermes.local:8642\r\n");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"),
    }));

    const response = await responsePromise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("sends JSON request bodies and parses chunked responses", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { port: 8642 },
    });
    const responsePromise = client.fetch("/v1/chat/completions", { json: { message: "ping" } });
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();

    const requestText = textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!);
    expect(requestText).toContain("POST /v1/chat/completions HTTP/1.1\r\n");
    expect(requestText).toContain("content-type: application/json\r\n");
    expect(requestText).toContain("\r\n\r\n{\"message\":\"ping\"}");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"),
    }));

    const response = await responsePromise;
    await expect(response.text()).resolves.toBe("hello world");
  });

  it("reuses an idle proxy connection after a complete fixed-length response", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { port: 8642 },
    });
    const firstPromise = client.fetch("/first");
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"),
    }));
    await expect((await firstPromise).text()).resolves.toBe("one");
    const framesAfterFirst = parseBsonFrames(socket);
    expect(framesAfterFirst.filter((frame) => frame.Type === "PtyProxyNew")).toHaveLength(1);

    const secondPromise = client.fetch("/second");
    await flushPromises();
    const framesAfterSecondRequest = parseBsonFrames(socket);
    expect(framesAfterSecondRequest.filter((frame) => frame.Type === "PtyProxyNew")).toHaveLength(1);
    expect(textOfProxyDataFrame(framesAfterSecondRequest.at(-1)!)).toContain("GET /second HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"),
    }));
    await expect((await secondPromise).text()).resolves.toBe("two");
    client.close();
  });

  it("does not reuse a proxy connection when the server asks to close it", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { port: 8642 },
    });
    const firstPromise = client.fetch("/close-first");
    const socket = FakeWebSocket.instances[0]!;
    const firstProxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", firstProxyId, { ProxyId: firstProxyId }));
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyData", firstProxyId, {
      ProxyId: firstProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 3\r\n\r\none"),
    }));
    await expect((await firstPromise).text()).resolves.toBe("one");

    const secondPromise = client.fetch("/close-second");
    await flushPromises();
    const proxyNewFrames = parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew");
    expect(proxyNewFrames).toHaveLength(2);
    const secondProxyId = ((proxyNewFrames.at(-1)!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string;
    expect(secondProxyId).not.toBe(firstProxyId);

    socket.receive(bsonResponse("PtyProxyReady", secondProxyId, { ProxyId: secondProxyId }));
    await flushPromises();
    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("GET /close-second HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", secondProxyId, {
      ProxyId: secondProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"),
    }));
    await expect((await secondPromise).text()).resolves.toBe("two");
    client.close();
  });

  it("uses Connection close and avoids pooling when keepAlive is disabled", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      keepAlive: false,
      target: { port: 8642 },
    });
    const firstPromise = client.fetch("/no-keepalive");
    const socket = FakeWebSocket.instances[0]!;
    const firstProxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", firstProxyId, { ProxyId: firstProxyId }));
    await flushPromises();

    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("connection: close\r\n");
    socket.receive(bsonResponse("PtyProxyData", firstProxyId, {
      ProxyId: firstProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"),
    }));
    await expect((await firstPromise).text()).resolves.toBe("one");

    const secondPromise = client.fetch("/new-connection");
    await flushPromises();
    const proxyNewFrames = parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew");
    expect(proxyNewFrames).toHaveLength(2);
    const secondProxyId = ((proxyNewFrames.at(-1)!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string;
    expect(secondProxyId).not.toBe(firstProxyId);

    socket.receive(bsonResponse("PtyProxyReady", secondProxyId, { ProxyId: secondProxyId }));
    await flushPromises();
    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("GET /new-connection HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", secondProxyId, {
      ProxyId: secondProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"),
    }));
    await expect((await secondPromise).text()).resolves.toBe("two");
    client.close();
  });

  it("does not reuse proxy connections after chunked responses", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { port: 8642 },
    });
    const firstPromise = client.fetch("/chunked-first");
    const socket = FakeWebSocket.instances[0]!;
    const firstProxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", firstProxyId, { ProxyId: firstProxyId }));
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyData", firstProxyId, {
      ProxyId: firstProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\none\r\n0\r\n\r\n"),
    }));
    await expect((await firstPromise).text()).resolves.toBe("one");

    const secondPromise = client.fetch("/after-chunked");
    await flushPromises();
    const proxyNewFrames = parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew");
    expect(proxyNewFrames).toHaveLength(2);
    const secondProxyId = ((proxyNewFrames.at(-1)!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string;
    expect(secondProxyId).not.toBe(firstProxyId);

    socket.receive(bsonResponse("PtyProxyReady", secondProxyId, { ProxyId: secondProxyId }));
    await flushPromises();
    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("GET /after-chunked HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", secondProxyId, {
      ProxyId: secondProxyId,
      Data: encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"),
    }));
    await expect((await secondPromise).text()).resolves.toBe("two");
    client.close();
  });

  it("finishes close-delimited keep-alive responses after a body idle gap", async () => {
    const { client, socket, proxyId, responsePromise } = await startHttpFetch("/api/plugins/hermes-achievements/achievements", {}, {
      closeDelimitedBodyIdleTimeoutMs: 25,
    });

    sendProxyData(socket, proxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n{\"items\":[]}"));
    const response = await responsePromise;
    const bodyPromise = response.text();
    await flushPromises();
    vi.advanceTimersByTime(25);

    await expect(bodyPromise).resolves.toBe("{\"items\":[]}");
    expect(parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew")).toHaveLength(1);
    client.close();
  });

  it("releases close-delimited body bytes incrementally before the idle completion timer", async () => {
    const { client, socket, proxyId, responsePromise } = await startHttpFetch("/api/v1/sessions/ses/events?stream=1", {}, {
      closeDelimitedBodyIdleTimeoutMs: 30_000,
    });

    sendProxyData(
      socket,
      proxyId,
      encodeAscii("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\ndata: first\n\n"),
    );

    const response = await responsePromise;
    const reader = response.body!.getReader();
    await expect(readTextChunk(reader)).resolves.toBe("data: first\n\n");

    sendProxyData(socket, proxyId, encodeAscii("data: second\n\n"));
    await expect(readTextChunk(reader)).resolves.toBe("data: second\n\n");
    client.close();
  });

  it("releases chunked response chunks incrementally before the terminal zero chunk", async () => {
    const { client, socket, proxyId, responsePromise } = await startHttpFetch("/chunked-live");

    sendProxyData(socket, proxyId, encodeAscii("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n"));

    const response = await responsePromise;
    const reader = response.body!.getReader();
    await expect(readTextChunk(reader)).resolves.toBe("hello");

    sendProxyData(socket, proxyId, encodeAscii("6\r\n world\r\n"));
    await expect(readTextChunk(reader)).resolves.toBe(" world");

    sendProxyData(socket, proxyId, encodeAscii("0\r\n\r\n"));
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    client.close();
  });

  it("offers a fetchJson helper that throws on non-2xx responses", async () => {
    const client = new TatHttpVirtualClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
      target: { port: 8642 },
    });
    const responsePromise = client.fetchJson("/v1/models");
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4\r\n\r\nfail"),
    }));

    await expect(responsePromise).rejects.toThrow("HTTP 500: fail");
  });

  it("creates a Hermes fetch function that defaults to vm 127.0.0.1:8642", async () => {
    const tatFetch = createTatHermesFetch(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const responsePromise = tatFetch("/health");
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    const openFrame = parseBsonFrames(socket)[0]!;
    expect(openFrame).toMatchObject({
      Type: "PtyProxyNew",
      Data: {
        Data: {
          Ip: "127.0.0.1",
          Port: "8642",
        },
      },
    });

    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();
    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("GET /health HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
    }));
    await expect((await responsePromise).text()).resolves.toBe("ok");
    tatFetch.close();
  });

  it("creates a Hermes WebUI fetch function that defaults to vm 127.0.0.1:9119", async () => {
    const tatFetch = createTatHermesWebFetch(bootstrap, { WebSocketImpl, connectDelayMs: 0 });
    const responsePromise = tatFetch("/");
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    const openFrame = parseBsonFrames(socket)[0]!;
    expect(openFrame).toMatchObject({
      Type: "PtyProxyNew",
      Data: {
        Data: {
          Ip: "127.0.0.1",
          Port: "9119",
        },
      },
    });

    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();
    expect(textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!)).toContain("GET / HTTP/1.1\r\n");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 15\r\n\r\n<h1>Hermes</h1>"),
    }));
    await expect((await responsePromise).text()).resolves.toBe("<h1>Hermes</h1>");
    tatFetch.close();
  });

  it("allows callers to freely bind any vm loopback port", async () => {
    const tatFetch = createTatPortFetch(bootstrap, 7777, { WebSocketImpl, connectDelayMs: 0 });
    const responsePromise = tatFetch("/custom");
    const socket = FakeWebSocket.instances[0]!;
    const proxyId = await openSocketAndReadProxyId(socket);
    const openFrame = parseBsonFrames(socket)[0]!;
    expect(openFrame).toMatchObject({
      Type: "PtyProxyNew",
      Data: {
        Data: {
          Ip: "127.0.0.1",
          Port: "7777",
        },
      },
    });

    socket.receive(bsonResponse("PtyProxyReady", proxyId, { ProxyId: proxyId }));
    await flushPromises();
    const requestText = textOfProxyDataFrame(parseBsonFrames(socket).at(-1)!);
    expect(requestText).toContain("GET /custom HTTP/1.1\r\n");
    expect(requestText).toContain("host: 127.0.0.1:7777\r\n");

    socket.receive(bsonResponse("PtyProxyData", proxyId, {
      ProxyId: proxyId,
      Data: new TextEncoder().encode("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"),
    }));
    expect((await responsePromise).status).toBe(204);
    tatFetch.close();
  });

  it("lets independent virtual HTTP clients share one TSSH proxy websocket", async () => {
    const proxyClient = new TencentTsshProxyClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
    });
    const apiClient = new TatHttpVirtualClient(bootstrap, {
      keepAlive: false,
      proxyClient,
      target: { port: 3857 },
    });
    const streamClient = new TatHttpVirtualClient(bootstrap, {
      closeDelimitedBodyIdleTimeoutMs: 300_000,
      proxyClient,
      target: { port: 3857 },
    });

    const firstPromise = apiClient.fetch("/api/v1/views/sessions");
    const socket = FakeWebSocket.instances[0]!;
    const firstProxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", firstProxyId, { ProxyId: firstProxyId }));
    await flushPromises();
    sendProxyData(socket, firstProxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none"));
    await expect((await firstPromise).text()).resolves.toBe("one");

    const secondPromise = streamClient.fetch("/api/v1/sessions/ses/events?stream=1");
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(1);

    const proxyNewFrames = parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew");
    expect(proxyNewFrames).toHaveLength(2);
    const secondProxyId = ((proxyNewFrames.at(-1)!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string;
    expect(secondProxyId).not.toBe(firstProxyId);

    socket.receive(bsonResponse("PtyProxyReady", secondProxyId, { ProxyId: secondProxyId }));
    await flushPromises();
    sendProxyData(socket, secondProxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\ntwo"));
    await expect((await secondPromise).text()).resolves.toBe("two");

    apiClient.close();
    streamClient.close();
    proxyClient.close();
  });

  it("keeps short JSON requests responsive while a shared close-delimited stream is open", async () => {
    const proxyClient = new TencentTsshProxyClient(bootstrap, {
      WebSocketImpl,
      connectDelayMs: 0,
    });
    const streamClient = new TatHttpVirtualClient(bootstrap, {
      closeDelimitedBodyIdleTimeoutMs: 300_000,
      proxyClient,
      target: { port: 3857 },
    });
    const apiClient = new TatHttpVirtualClient(bootstrap, {
      keepAlive: false,
      proxyClient,
      target: { port: 3857 },
    });

    const streamPromise = streamClient.fetch("/api/v1/sessions/ses/events?stream=1");
    const socket = FakeWebSocket.instances[0]!;
    const streamProxyId = await openSocketAndReadProxyId(socket);
    socket.receive(bsonResponse("PtyProxyReady", streamProxyId, { ProxyId: streamProxyId }));
    await flushPromises();
    sendProxyData(socket, streamProxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\ndata: open\n\n"));

    const streamResponse = await streamPromise;
    const streamReader = streamResponse.body!.getReader();
    await expect(readTextChunk(streamReader)).resolves.toBe("data: open\n\n");

    const apiPromise = apiClient.fetch("/api/v1/views/sessions");
    await flushPromises();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const proxyNewFrames = parseBsonFrames(socket).filter((frame) => frame.Type === "PtyProxyNew");
    expect(proxyNewFrames).toHaveLength(2);
    const apiProxyId = ((proxyNewFrames.at(-1)!.Data as Record<string, unknown>).Data as Record<string, unknown>).ProxyId as string;
    expect(apiProxyId).not.toBe(streamProxyId);

    socket.receive(bsonResponse("PtyProxyReady", apiProxyId, { ProxyId: apiProxyId }));
    await flushPromises();
    sendProxyData(socket, apiProxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}"));

    const apiResponse = await apiPromise;
    expect(apiResponse.status).toBe(200);
    await expect(apiResponse.json()).resolves.toEqual({ ok: true });

    sendProxyData(socket, streamProxyId, encodeAscii("data: still-open\n\n"));
    await expect(readTextChunk(streamReader)).resolves.toBe("data: still-open\n\n");
    apiClient.close();
    streamClient.close();
    proxyClient.close();
  });

  it("parses Content-Length responses when headers and binary body are randomly split", async () => {
    for (let caseIndex = 0; caseIndex < 18; caseIndex += 1) {
      const payload = randomBytes(caseIndex * 257 + 31, 0xabc000 + caseIndex);
      const head = encodeAscii(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${payload.byteLength}\r\n\r\n`);
      const wireBytes = concatBytes([head, payload]);
      const { client, socket, proxyId, responsePromise } = await startHttpFetch(`/binary-${caseIndex}`);

      sendProxyDataChunks(socket, proxyId, splitRandomly(wireBytes, 0x123400 + caseIndex, 17));

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      client.close();
    }
  });

  it("parses chunked responses across randomized TAT frame boundaries", async () => {
    for (let caseIndex = 0; caseIndex < 18; caseIndex += 1) {
      const payload = randomBytes(caseIndex * 191 + 7, 0xf00d00 + caseIndex);
      const bodyChunks: Uint8Array[] = [];
      let offset = 0;
      const chunkSizer = makePrng(0x515100 + caseIndex);
      while (offset < payload.byteLength) {
        const size = Math.min(payload.byteLength - offset, 1 + Math.floor(chunkSizer() * 29));
        const bodyChunk = payload.slice(offset, offset + size);
        bodyChunks.push(encodeAscii(`${bodyChunk.byteLength.toString(16)}\r\n`), bodyChunk, encodeAscii("\r\n"));
        offset += size;
      }
      bodyChunks.push(encodeAscii("0\r\n\r\n"));

      const wireBytes = concatBytes([
        encodeAscii("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"),
        ...bodyChunks,
      ]);
      const { client, socket, proxyId, responsePromise } = await startHttpFetch(`/chunked-${caseIndex}`);

      sendProxyDataChunks(socket, proxyId, splitRandomly(wireBytes, 0xcafe00 + caseIndex, 11));

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
      client.close();
    }
  });

  it("fails when fixed-length response bodies are cut off mid-stream", async () => {
    const payload = encodeAscii("partial");
    const { client, socket, proxyId, responsePromise } = await startHttpFetch("/cut-off");

    sendProxyData(socket, proxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 32\r\n\r\n"));
    const response = await responsePromise;
    sendProxyData(socket, proxyId, payload);
    socket.receive(bsonResponse("PtyProxyClose", proxyId, { ProxyId: proxyId }));

    await expect(response.text()).rejects.toThrow("declared HTTP response body was complete");
    client.close();
  });

  it("treats HEAD and 304 responses as null-body responses", async () => {
    const headFetch = await startHttpFetch("/head", { method: "HEAD" });
    sendProxyData(headFetch.socket, headFetch.proxyId, encodeAscii("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nignored"));
    const headResponse = await headFetch.responsePromise;
    expect(headResponse.body).toBeNull();
    await expect(headResponse.text()).resolves.toBe("");
    headFetch.client.close();

    const notModifiedFetch = await startHttpFetch("/cache");
    sendProxyData(notModifiedFetch.socket, notModifiedFetch.proxyId, encodeAscii("HTTP/1.1 304 Not Modified\r\nContent-Length: 10\r\n\r\nignored"));
    const notModifiedResponse = await notModifiedFetch.responsePromise;
    expect(notModifiedResponse.body).toBeNull();
    await expect(notModifiedResponse.text()).resolves.toBe("");
    notModifiedFetch.client.close();
  });

  it("rejects responses whose headers exceed the configured bound", async () => {
    const { client, socket, proxyId, responsePromise } = await startHttpFetch("/large-headers", {}, { headerLimitBytes: 64 });
    sendProxyData(socket, proxyId, encodeAscii(`HTTP/1.1 200 OK\r\nX-Large: ${"x".repeat(96)}\r\n\r\n`));

    await expect(responsePromise).rejects.toThrow("HTTP response headers exceeded");
    client.close();
  });
});
