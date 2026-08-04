import type {TerminalSession} from "@raft-platform/client-core";

import {
  createExpoTerminalOpener,
  expoBase64,
  type WebSocketLike,
} from "./expo-terminal";

class FakeWebSocket implements WebSocketLike {
  public static latest: FakeWebSocket | null = null;
  public onclose: ((event: {code?: number; reason?: string}) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onmessage: ((event: {data: string}) => void) | null = null;
  public onopen: (() => void) | null = null;
  public readonly sent: string[] = [];
  public closed = false;

  public constructor(public readonly url: string) {
    FakeWebSocket.latest = this;
  }

  public close() { this.closed = true; }
  public send(value: string) { this.sent.push(value); }
}

const session: TerminalSession = {
  authentication: {appId: 1, instanceId: "rins-test", uin: "10001"},
  expiresAt: "2026-08-01T03:05:00.000Z",
  protocol: "tencent-tat-pty-v1",
  sessionId: "session-1",
  terminal: {cols: 80, maxIdleSeconds: 3600, rows: 24},
  webSocketUrl: "wss://terminal.example.test/connect",
};

describe("Expo terminal adapter", () => {
  it("round-trips arbitrary bytes without Node Buffer", () => {
    const value = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    expect(expoBase64.decode(expoBase64.encode(value))).toEqual(value);
  });

  it("bridges the global WebSocket shape to the TAT text protocol", async () => {
    const opener = createExpoTerminalOpener({
      randomId: () => "channel-1",
      WebSocketImpl: FakeWebSocket,
    });
    const opening = opener.open(session, {onOutput: jest.fn()});
    const socket = FakeWebSocket.latest;
    expect(socket?.url).toBe(session.webSocketUrl);

    socket?.onopen?.();
    socket?.onmessage?.({
      data: JSON.stringify({
        Data: {ChannelId: "channel-1", SessionId: session.sessionId},
        Type: "PtyReady",
      }),
    });
    const connection = await opening;
    connection.write(new TextEncoder().encode("pwd\r"));

    expect(JSON.parse(socket?.sent.at(-1) ?? "{}")).toMatchObject({
      Data: {ChannelId: "channel-1", SessionId: session.sessionId},
      Type: "PtyInput",
    });
    connection.close();
    expect(socket?.closed).toBe(true);
  });
});
