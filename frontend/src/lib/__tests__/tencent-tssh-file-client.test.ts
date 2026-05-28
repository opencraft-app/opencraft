import { deserialize, serialize } from "bson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinTsshPath, parentTsshPath, TencentTsshFileClient } from "@/lib/tencent-tssh-file-client";

const bootstrap = {
  sandboxId: "sb-1",
  poolId: "pool-1",
  sessionId: "session-1",
  region: "ap-guangzhou",
  instanceId: "rins-file001",
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

const parseBsonFrame = (socket: FakeWebSocket, index: number) => {
  const bytes = socket.sent[index];
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`sent frame ${index} is not BSON`);
  }
  return deserialize(bytes) as Record<string, unknown>;
};

const parseFirstBsonFrame = (socket: FakeWebSocket) => {
  const index = socket.sent.findIndex((frame) => frame instanceof Uint8Array);
  if (index < 0) {
    throw new Error("no BSON frame was sent");
  }
  return parseBsonFrame(socket, index);
};

const requestIdOf = (frame: Record<string, unknown>) => {
  const data = frame.Data as Record<string, unknown>;
  return String(data.CustomData);
};

const bsonResponse = (type: string, requestId: string, data: Record<string, unknown>) =>
  serialize({
    Type: type,
    Data: {
      SessionId: "session-1",
      ChannelId: "file-session-1",
      CustomData: requestId,
      Data: data,
    },
  });

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TencentTsshFileClient", () => {
  it("starts a no-shell PTY channel for file requests", async () => {
    const client = new TencentTsshFileClient(bootstrap, {
      WebSocketImpl,
      startDelayMs: 50,
    });
    const ready = client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(parseJsonFrame(socket, 0)).toMatchObject({
      Type: "SessionAuth",
      Data: {
        Uin: "10001",
        AppId: 1250000000,
        InstanceId: "rins-file001",
        SessionId: "session-1",
      },
    });

    vi.advanceTimersByTime(50);
    expect(parseJsonFrame(socket, 1)).toMatchObject({
      Type: "PtyStart",
      Data: {
        SessionId: "session-1",
        ChannelId: "file-session-1",
        NoShell: true,
      },
    });

    socket.receive(JSON.stringify({ Type: "PtyReady" }));
    await expect(ready).resolves.toBeUndefined();
  });

  it("aggregates list path BSON chunks by custom data", async () => {
    const client = new TencentTsshFileClient(bootstrap, { WebSocketImpl, startDelayMs: 0 });
    const listPromise = client.listPath("/var/log");
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    socket.receive(JSON.stringify({ Type: "PtyReady" }));
    await Promise.resolve();
    await Promise.resolve();

    const request = parseFirstBsonFrame(socket);
    expect(request).toMatchObject({
      Type: "PtyListPath",
      Data: {
        SessionId: "session-1",
        ChannelId: "file-session-1",
        Data: {
          Path: "/var/log",
          Filter: "*",
          ShowHidden: true,
        },
      },
    });
    const requestId = requestIdOf(request);

    socket.receive(bsonResponse("PtyListPath", requestId, {
      Index: 0,
      IsLast: false,
      Files: [{ Type: "d", Name: "nginx", Size: 0, ModifyTime: 10, AccessTime: 10 }],
    }));
    socket.receive(bsonResponse("PtyListPath", requestId, {
      Index: 1,
      IsLast: true,
      Files: [{ Type: "-", Name: "system.log", Size: 42, ModifyTime: 11, AccessTime: 11 }],
    }));

    await expect(listPromise).resolves.toEqual([
      expect.objectContaining({ name: "nginx", type: "d" }),
      expect.objectContaining({ name: "system.log", size: 42 }),
    ]);
  });

  it("downloads file chunks and exposes path helpers", async () => {
    const client = new TencentTsshFileClient(bootstrap, { WebSocketImpl, startDelayMs: 0, readSizeBytes: 8 });
    const readPromise = client.readFile("/tmp/app.log", 0, 8);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    socket.receive(JSON.stringify({ Type: "PtyReady" }));
    await Promise.resolve();
    await Promise.resolve();

    const request = parseFirstBsonFrame(socket);
    expect(request).toMatchObject({
      Type: "PtyReadFile",
      Data: {
        Data: {
          Path: "/tmp/app.log",
          Offset: 0,
          Size: 8,
        },
      },
    });

    socket.receive(bsonResponse("PtyReadFile", requestIdOf(request), {
      Data: new Uint8Array([104, 105]),
      Offset: 0,
      Length: 2,
      IsLast: true,
    }));

    const chunks = await readPromise;
    expect(new TextDecoder().decode(chunks[0]?.data)).toBe("hi");
    expect(joinTsshPath("/tmp/", "app.log")).toBe("/tmp/app.log");
    expect(parentTsshPath("/tmp/app.log")).toBe("/tmp");
    expect(parentTsshPath("/tmp")).toBe("/");
  });
});
