import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TencentPtyClient, extractTencentPtyError, extractTencentPtyOutput } from "@/lib/tencent-pty-client";

const bootstrap = {
  sessionId: "session-1",
  ownerUin: "owner-1",
  appId: 1250000000,
  instanceId: "ins-cloud-1",
  wsUrl: "wss://ap-test.forward.tat-tc.tencent.cn/ws",
  cols: 80,
  rows: 24,
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType: BinaryType = "blob";
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

  constructor(readonly url: string | URL) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    this.sent.push(String(data));
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

const parseSentFrame = (socket: FakeWebSocket, index: number) => JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TencentPtyClient", () => {
  it("sends auth immediately and starts the PTY after the configured delay", () => {
    const states: string[] = [];
    const client = new TencentPtyClient(bootstrap, {
      WebSocketImpl,
      startDelayMs: 500,
      getDimensions: () => ({ cols: 120, rows: 40 }),
      onStateChange: (state) => states.push(state),
    });

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(parseSentFrame(socket, 0)).toMatchObject({
      Type: "SessionAuth",
      Data: {
        Uin: "owner-1",
        AppId: 1250000000,
        InstanceId: "ins-cloud-1",
        SessionId: "session-1",
      },
    });
    expect(socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(499);
    expect(socket.sent).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(parseSentFrame(socket, 1)).toMatchObject({
      Type: "PtyStart",
      Data: {
        SessionId: "session-1",
        Cols: 120,
        Rows: 40,
        UserName: "agentuser",
        MaxIdleTime: 3600,
        Username: "agentuser",
        WorkingDirectory: "/home/agentuser",
      },
    });
    expect(states).toEqual(["connecting", "authenticating", "starting"]);
  });

  it("allows the PTY start user, working directory, and timeout to be overridden by bootstrap data", () => {
    const client = new TencentPtyClient(
      {
        ...bootstrap,
        timeoutSeconds: 1800,
        username: "deploy",
        workingDirectory: "/srv/app",
      },
      { WebSocketImpl, startDelayMs: 0 },
    );

    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);

    expect(parseSentFrame(socket, 1)).toMatchObject({
      Type: "PtyStart",
      Data: {
        MaxIdleTime: 1800,
        Username: "deploy",
        WorkingDirectory: "/srv/app",
      },
    });
  });

  it("does not send input before PtyReady, then sends base64 input after ready", async () => {
    const client = new TencentPtyClient(bootstrap, { WebSocketImpl, startDelayMs: 0 });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();

    expect(client.sendInput("pwd\n")).toBe(false);
    expect(socket.sent.some((frame) => frame.includes("PtyInput"))).toBe(false);

    socket.receive(JSON.stringify({ Type: "PtyReady" }));
    await Promise.resolve();

    expect(client.sendInput("pwd\n")).toBe(true);
    expect(parseSentFrame(socket, socket.sent.length - 1)).toMatchObject({
      Type: "PtyInput",
      Data: {
        SessionId: "session-1",
        Input: "cHdkCg==",
      },
    });
  });

  it("stores resize dimensions before ready and uses them for PtyStart", () => {
    const client = new TencentPtyClient(bootstrap, { WebSocketImpl, startDelayMs: 100 });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;

    expect(client.resize(100, 32)).toBe(false);
    socket.open();
    vi.advanceTimersByTime(100);

    expect(parseSentFrame(socket, 1)).toMatchObject({
      Type: "PtyStart",
      Data: {
        Cols: 100,
        Rows: 32,
      },
    });
  });

  it("allows callers to override the PTY start user", () => {
    const client = new TencentPtyClient(bootstrap, { WebSocketImpl, startDelayMs: 0, userName: "root" });
    client.connect();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    vi.advanceTimersByTime(0);

    expect(parseSentFrame(socket, 1)).toMatchObject({
      Type: "PtyStart",
      Data: {
        UserName: "root",
      },
    });
  });

  it("extracts Tencent PTY output and error shapes", () => {
    expect(extractTencentPtyOutput({ Data: { Output: "aGVsbG8K" } })).toBe("hello\n");
    expect(extractTencentPtyError({ Data: { ErrMsg: "session is not ready" } })).toBe("session is not ready");
    expect(extractTencentPtyError({ Data: {} })).toBe("terminal error");
  });
});
