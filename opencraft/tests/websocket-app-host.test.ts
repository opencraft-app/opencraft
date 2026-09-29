import assert from "node:assert/strict";
import test from "node:test";

import { connectWebSocketAppHost, type AppHostRecoveryEvents } from "../apps/workbench-web/src/runtime/websocket-app-host";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners); }
    listeners.add(listener);
  }

  send(frame: string): void { this.sent.push(frame); }
  close(): void { this.readyState = 3; this.emit("close"); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open"); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  fail(): void { this.emit("error"); }
  private emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class RecoveryEvents implements AppHostRecoveryEvents {
  visible = true;
  listeners = new Set<() => void>();
  isVisible = () => this.visible;
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  fire(visible = true) { this.visible = visible; for (const listener of this.listeners) listener(); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("foreground probes share the socket, pause in background, and cannot affect a successor", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents();
  const first = new FakeSocket(), next = new FakeSocket();
  const sockets = [first, next];
  const client = connectWebSocketAppHost(() => sockets.shift() as unknown as WebSocket, {
    recoveryEvents: events, probeTimeoutMs: 5_000, reportFailure: () => undefined,
  });
  const accept = async (socket: FakeSocket, initial: boolean) => {
    await flush();
    if (initial) {
      socket.open();
      const hello = JSON.parse(socket.sent[0]!);
      socket.receive({ type: "ready", protocolVersion: 1, connectionId: hello.rendererId, services: ["appserver"], capabilities: { connectionProbe: true } });
      await flush();
    }
    const request = socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "host/connect").at(-1)!;
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: request.hostId, generation: 1 } });
  };
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    const ca = a.connect(); await accept(first, true); await ca;
    const cb = b.connect(); await accept(first, false); await cb;
    events.fire(); events.fire();
    const probes = () => first.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "connection/probe");
    assert.equal(probes().length, 1);
    const oldProbe = probes()[0];
    events.fire(false);
    context.mock.timers.tick(20_000);
    assert.equal(a.status.state, "open");
    events.fire();
    assert.equal(probes().length, 2);
    // A late reply to the cancelled background probe cannot satisfy the new one.
    first.receive({ type: "response", requestId: oldProbe.requestId, ok: true, result: null });
    context.mock.timers.tick(5_000);
    assert.equal(a.status.state, "failed");
    assert.equal(b.status.state, "failed");
    const reconnect = a.connect(); await accept(next, true); await reconnect;
    first.receive({ type: "response", requestId: probes()[1].requestId, ok: true, result: null });
    context.mock.timers.tick(5_000);
    assert.equal(a.status.state, "open");
    assert.equal(sockets.length, 0);
  } finally {
    client.close();
    assert.equal(events.listeners.size, 0);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("legacy AppHost gets no unknown probe, while foreground wakes the retry owner", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents(), socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { recoveryEvents: events, reportFailure: () => undefined });
  try {
    const transport = client.createTransport("local");
    let hints = 0;
    transport.subscribeRecoveryHint?.(() => { hints++; });
    const connecting = transport.connect(); await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 1, services: ["appserver"] }); await flush();
    const request = JSON.parse(socket.sent[1]!);
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "local", generation: 1 } });
    await connecting;
    events.fire();
    assert.equal(hints, 1);
    assert.equal(socket.sent.length, 2);
    socket.fail(); events.fire();
    assert.equal(hints, 2);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("browser AppHost transport keeps its listeners and renews its lease after WebSocket close", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/chat" } } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class WrappedWebSocket {} });
  const socket = new FakeSocket();
  const replacementSocket = new FakeSocket();
  const sockets = [socket, replacementSocket];
  const urls: string[] = [];
  const diagnostics: Array<{ attemptId: string; failure: string; phase: string; readyState: number; ageMs: number }> = [];
  const client = connectWebSocketAppHost((url) => {
    urls.push(url);
    return sockets.shift() as unknown as WebSocket;
  }, { reportFailure: diagnostic => diagnostics.push(diagnostic) });
  try {
    const transport = client.createTransport("local-codex");
    const connection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new URL(urls[0]!).origin, "wss://example.test");
    assert.equal(new URL(urls[0]!).pathname, "/apphost");
    assert.ok(new URL(urls[0]!).searchParams.get("attempt"));
    socket.open();
    const hello = JSON.parse(socket.sent[0]!);
    assert.equal(hello.type, "hello");
    socket.receive({ type: "ready", protocolVersion: 1, connectionId: hello.rendererId, services: ["appserver"] });
    await new Promise(resolve => setImmediate(resolve));
    const connect = JSON.parse(socket.sent[1]!);
    assert.equal(connect.type, "host/connect");
    assert.equal(connect.hostId, "local-codex");
    socket.receive({ type: "response", requestId: connect.requestId, ok: true,
      result: { hostId: "local-codex", generation: 7 } });
    await connection;
    assert.equal(transport.status.state, "open");
    const sending = transport.send('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
    const send = JSON.parse(socket.sent[2]!);
    assert.equal(send.type, "host/send");
    assert.equal(send.generation, 7);
    socket.receive({ type: "response", requestId: send.requestId, ok: true });
    await sending;
    const frames: string[] = [];
    transport.subscribeMessage(frame => frames.push(frame));
    socket.receive({ type: "host/frame", hostId: "local-codex", generation: 7, frame: '{"id":1,"result":{}}' });
    assert.deepEqual(frames, ['{"id":1,"result":{}}']);
    socket.close();
    assert.equal(socket.readyState, 3);
    assert.equal(transport.status.state, "failed");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.attemptId, hello.rendererId);
    assert.equal(diagnostics[0]?.failure, "socket-close");
    assert.equal(diagnostics[0]?.phase, "ready");
    const reconnection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(urls.length, 2);
    assert.notEqual(new URL(urls[1]!).searchParams.get("attempt"), new URL(urls[0]!).searchParams.get("attempt"));
    replacementSocket.open();
    const replacementHello = JSON.parse(replacementSocket.sent[0]!);
    replacementSocket.receive({ type: "ready", protocolVersion: 1,
      connectionId: replacementHello.rendererId, services: ["appserver"] });
    await new Promise(resolve => setImmediate(resolve));
    const reconnect = JSON.parse(replacementSocket.sent[1]!);
    assert.equal(reconnect.type, "host/connect");
    assert.notEqual(reconnect.leaseId, connect.leaseId);
    replacementSocket.receive({ type: "response", requestId: reconnect.requestId, ok: true,
      result: { hostId: "local-codex", generation: 8 } });
    await reconnection;
    assert.equal(transport.status.state, "open");
    replacementSocket.receive({ type: "host/frame", hostId: "local-codex", generation: 8, frame: '{"id":2,"result":{}}' });
    assert.deepEqual(frames, ['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
    const renewedSend = transport.send('{"jsonrpc":"2.0","id":3}');
    const renewedFrame = JSON.parse(replacementSocket.sent[2]!);
    assert.equal(renewedFrame.generation, 8);
    replacementSocket.receive({ type: "response", requestId: renewedFrame.requestId, ok: true });
    await renewedSend;
    const closing = transport.close();
    const disconnect = JSON.parse(replacementSocket.sent[3]!);
    assert.equal(disconnect.type, "host/disconnect");
    replacementSocket.receive({ type: "response", requestId: disconnect.requestId, ok: true });
    await closing;
    await assert.rejects(transport.connect(), /App Host transport is closed/);
    assert.equal(urls.length, 2);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("browser AppHost transport fails a stalled handshake so Workbench can retry", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/chat" } } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class WrappedWebSocket {} });
  const socket = new FakeSocket();
  const diagnostics: Array<{ failure: string; phase: string }> = [];
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    handshakeTimeoutMs: 10,
    reportFailure: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    const transport = client.createTransport("local-codex");
    const connection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    socket.open();
    await assert.rejects(connection, /handshake timed out/u);
    assert.equal(transport.status.state, "failed");
    assert.deepEqual(diagnostics.map(({ failure, phase }) => ({ failure, phase })),
      [{ failure: "handshake-timeout", phase: "socket-open" }]);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousWebSocket) Object.defineProperty(globalThis, "WebSocket", previousWebSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("browser AppHost reports a pre-upgrade WebSocket error without exposing the conversation", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/threads/private" } } });
  const socket = new FakeSocket();
  const diagnostics: Array<Record<string, unknown>> = [];
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    reportFailure: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    const connection = client.createTransport("local-codex").connect();
    await new Promise(resolve => setImmediate(resolve));
    socket.fail();
    await assert.rejects(connection, /App Host connection failed/u);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.failure, "socket-error");
    assert.equal(diagnostics[0]?.phase, "connecting");
    assert.equal(diagnostics[0]?.readyState, FakeSocket.CONNECTING);
    assert.equal(JSON.stringify(diagnostics).includes("private"), false);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
