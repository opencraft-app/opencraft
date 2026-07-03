import { Binary, deserialize, serialize } from "bson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TencentTsshFileClient } from "@/lib/tencent-tssh-file-client";

const bootstrap = {
  sessionId: "session-1",
  ownerUin: "10001",
  loginUin: "10002",
  appId: 1250000000,
  instanceId: "rins-file001",
  wsUrl: "wss://ap-guangzhou.forward.tat-tc.tencent.cn/ws",
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

const bsonResponse = (type: string, channelId: string, customData: string, data: Record<string, unknown>) =>
  serialize({
    Type: type,
    Data: {
      SessionId: "session-1",
      ChannelId: channelId,
      CustomData: customData,
      Data: data,
    },
  });

const bytesOf = (value: string) => new Binary(new TextEncoder().encode(value));

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

describe("TencentTsshFileClient", () => {
  it("keeps exec requests pending for the TAT command timeout window", async () => {
    const client = new TencentTsshFileClient(bootstrap, {
      WebSocketImpl,
      channelId: "file-test",
      requestTimeoutMs: 25,
      startDelayMs: 0,
    });
    const execPromise = client.execCommand("mv -- 'old' 'new'", 60);

    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);
    await flushPromises();
    socket.receive(JSON.stringify({ Type: "PtyReady" }));
    await flushPromises();

    const request = parseBsonFrames(socket).find((frame) => frame.Type === "PtyExecCmdStream")!;
    const envelope = request.Data as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ChannelId: "file-test",
      Data: {
        Cmd: "mv -- 'old' 'new'",
        Timeout: 60,
      },
    });

    let rejected: Error | null = null;
    execPromise.catch((error: unknown) => {
      rejected = error instanceof Error ? error : new Error(String(error));
    });
    vi.advanceTimersByTime(25);
    await flushPromises();
    expect(rejected).toBeNull();

    socket.receive(bsonResponse("PtyExecCmdStream", "file-test", String(envelope.CustomData), {
      Index: 0,
      IsLast: true,
      ExitCode: 0,
      Data: bytesOf("done"),
    }));

    await expect(execPromise).resolves.toEqual({ exitCode: 0, output: "done" });
    client.close();
  });
});
