import assert from "node:assert/strict";
import test from "node:test";

import type {TerminalSession} from "../platform/api.js";
import {
  TatPtyTerminal,
  type Base64Codec,
  type TextSocket,
  type TextSocketEvent,
  type TextSocketFactory,
} from "./tat-pty.js";

class FakeSocket implements TextSocket {
  public readonly sent: string[] = [];
  public closed = false;
  private listener: ((event: TextSocketEvent) => void) | null = null;

  public close(): void {
    this.closed = true;
  }

  public emit(event: TextSocketEvent): void {
    this.listener?.(event);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public subscribe(
    listener: (event: TextSocketEvent) => void,
  ): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
}

class FakeFactory implements TextSocketFactory {
  public readonly socket = new FakeSocket();
  public url = "";

  public open(url: string): TextSocket {
    this.url = url;
    return this.socket;
  }
}

const base64: Base64Codec = {
  decode(value) {
    return Uint8Array.from(Buffer.from(value, "base64"));
  },
  encode(value) {
    return Buffer.from(value).toString("base64");
  },
};

function session(): TerminalSession {
  return {
    authentication: {
      appId: 1_250_000_000,
      instanceId: "rins-test0001",
      uin: "100000000001",
    },
    expiresAt: "2026-07-30T22:05:00.000Z",
    protocol: "tencent-tat-pty-v1",
    sessionId: "session-test",
    terminal: {cols: 120, maxIdleSeconds: 3600, rows: 32},
    webSocketUrl: "wss://terminal.example.test/connect",
  };
}

test("TAT PTY authenticates before start and waits for PtyReady", async () => {
  const factory = new FakeFactory();
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
  });
  const opening = terminal.open(session(), {
    onOutput() {},
  });

  factory.socket.emit({type: "open"});

  assert.equal(factory.url, "wss://terminal.example.test/connect");
  assert.deepEqual(factory.socket.sent.map(JSON.parse), [
    {
      Data: {
        AppId: 1_250_000_000,
        InstanceId: "rins-test0001",
        SessionId: "session-test",
        Uin: "100000000001",
      },
      Type: "SessionAuth",
    },
    {
      Data: {
        ChannelId: "channel-test",
        Cols: 120,
        MaxIdleTime: 3600,
        Rows: 32,
        SessionId: "session-test",
      },
      Type: "PtyStart",
    },
  ]);

  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyReady",
    }),
    type: "message",
  });
  const connection = await opening;
  connection.close();
  assert.equal(
    JSON.parse(factory.socket.sent.at(-1) ?? "{}").Type,
    "PtyStop",
  );
});

test("TAT PTY carries base64 input/output and resize with channel fencing", async () => {
  const factory = new FakeFactory();
  const outputs: Uint8Array[] = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
  });
  const opening = terminal.open(session(), {
    onOutput(value) {
      outputs.push(value);
    },
  });
  factory.socket.emit({type: "open"});
  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyReady",
    }),
    type: "message",
  });
  const connection = await opening;

  connection.write(new TextEncoder().encode("hello"));
  connection.resize(160, 48);
  factory.socket.emit({
    data: JSON.stringify({
      Data: {
        ChannelId: "another-channel",
        Output: base64.encode(new TextEncoder().encode("ignored")),
        SessionId: "session-test",
      },
      Type: "PtyOutput",
    }),
    type: "message",
  });
  factory.socket.emit({
    data: JSON.stringify({
      Data: {
        ChannelId: "channel-test",
        Output: base64.encode(new TextEncoder().encode("world")),
        SessionId: "session-test",
      },
      Type: "PtyOutput",
    }),
    type: "message",
  });

  const sent = factory.socket.sent.map(JSON.parse);
  assert.equal(sent.at(-2)?.Type, "PtyInput");
  assert.equal(sent.at(-2)?.Data.Input, base64.encode(new TextEncoder().encode("hello")));
  assert.equal(sent.at(-1)?.Type, "PtyResize");
  assert.deepEqual(sent.at(-1)?.Data, {
    ChannelId: "channel-test",
    Cols: 160,
    Rows: 48,
    SessionId: "session-test",
  });
  assert.equal(outputs.length, 1);
  assert.equal(new TextDecoder().decode(outputs[0]), "world");
  connection.close();
});

test("TAT PTY reports PtyError and restores ownership by closing", async () => {
  const factory = new FakeFactory();
  const errors: string[] = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
  });
  const opening = terminal.open(session(), {
    onError(error) {
      errors.push(error.message);
    },
    onOutput() {},
  });
  factory.socket.emit({type: "open"});
  factory.socket.emit({
    data: JSON.stringify({
      Data: {
        ChannelId: "channel-test",
        Reason: "remote failure",
        SessionId: "session-test",
      },
      Type: "PtyError",
    }),
    type: "message",
  });

  await assert.rejects(opening, /终端会话失败/);
  assert.equal(factory.socket.closed, true);
  assert.deepEqual(errors, ["终端会话失败"]);
});

test("TAT PTY treats a remote PtyStop as terminal completion", async () => {
  const factory = new FakeFactory();
  const closes: string[] = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
  });
  const opening = terminal.open(session(), {
    onClose(reason) {
      closes.push(reason);
    },
    onOutput() {},
  });
  factory.socket.emit({type: "open"});
  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyReady",
    }),
    type: "message",
  });
  await opening;
  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyStop",
    }),
    type: "message",
  });

  assert.deepEqual(closes, ["remote"]);
  assert.equal(factory.socket.closed, true);
});

test("TAT PTY treats Tencent logout PtyError as normal remote completion", async () => {
  const factory = new FakeFactory();
  const closes: string[] = [];
  const errors: string[] = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
  });
  const opening = terminal.open(session(), {
    onClose(reason) {
      closes.push(reason);
    },
    onError(error) {
      errors.push(error.message);
    },
    onOutput() {},
  });
  factory.socket.emit({type: "open"});
  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyReady",
    }),
    type: "message",
  });
  await opening;
  factory.socket.emit({
    data: JSON.stringify({
      Data: {
        ChannelId: "channel-test",
        Reason: "logout",
        SessionId: "session-test",
      },
      Type: "PtyError",
    }),
    type: "message",
  });

  assert.deepEqual(closes, ["remote"]);
  assert.deepEqual(errors, []);
  assert.equal(factory.socket.closed, true);
});

test("TAT PTY probes after input and treats a removed channel as remote EOF", async () => {
  const factory = new FakeFactory();
  const closes: string[] = [];
  const errors: string[] = [];
  const callbacks: Array<() => void> = [];
  const milliseconds: number[] = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-test",
    sockets: factory,
    timers: {
      clearTimeout() {},
      setTimeout(callback, duration) {
        callbacks.push(callback);
        milliseconds.push(duration);
        return callbacks.length;
      },
    },
  });
  const opening = terminal.open(session(), {
    onClose(reason) {
      closes.push(reason);
    },
    onError(error) {
      errors.push(error.message);
    },
    onOutput() {},
  });
  factory.socket.emit({type: "open"});
  factory.socket.emit({
    data: JSON.stringify({
      Data: {ChannelId: "channel-test", SessionId: "session-test"},
      Type: "PtyReady",
    }),
    type: "message",
  });
  const connection = await opening;
  connection.write(new TextEncoder().encode("exit\n"));

  assert.deepEqual(milliseconds, [10_000, 10_000, 1_000]);
  callbacks[2]?.();
  assert.equal(JSON.parse(factory.socket.sent.at(-1) ?? "{}").Type, "PtyPing");

  factory.socket.emit({
    data: JSON.stringify({
      Data: {
        ChannelId: "channel-test",
        Reason: "Channel not found",
        SessionId: "session-test",
      },
      Type: "PtyError",
    }),
    type: "message",
  });

  assert.deepEqual(closes, ["remote"]);
  assert.deepEqual(errors, []);
  assert.equal(factory.socket.closed, true);
});

test("TAT PTY enforces separate WebSocket open and PtyReady deadlines", async () => {
  const factory = new FakeFactory();
  const callbacks: Array<() => void> = [];
  const terminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-timeout",
    sockets: factory,
    timers: {
      clearTimeout() {},
      setTimeout(callback, milliseconds) {
        assert.equal(milliseconds, 10_000);
        callbacks.push(callback);
        return callbacks.length;
      },
    },
  });

  const opening = terminal.open(session(), {onOutput() {}});
  callbacks[0]?.();
  await assert.rejects(opening, /连接超时/);
  assert.equal(factory.socket.closed, true);

  const readyFactory = new FakeFactory();
  const readyCallbacks: Array<() => void> = [];
  const readyTerminal = new TatPtyTerminal({
    base64,
    randomId: () => "channel-ready-timeout",
    sockets: readyFactory,
    timers: {
      clearTimeout() {},
      setTimeout(callback, milliseconds) {
        assert.equal(milliseconds, 10_000);
        readyCallbacks.push(callback);
        return readyCallbacks.length;
      },
    },
  });
  const waiting = readyTerminal.open(session(), {onOutput() {}});
  readyFactory.socket.emit({type: "open"});
  readyCallbacks[1]?.();
  await assert.rejects(waiting, /启动超时/);
  assert.equal(readyFactory.socket.closed, true);
});
