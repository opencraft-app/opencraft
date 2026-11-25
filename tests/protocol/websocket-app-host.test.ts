import assert from "node:assert/strict";
import test from "node:test";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { APP_HOST_IDLE_PROBE_ID } from "@opencraft/app-host-protocol";
import { APP_HOST_CLIENT_INSTANCE_PARAMETER } from "@opencraft/app-host-protocol/routing";

import { connectWebSocketAppHost, type AppHostRecoveryEvents } from "../../apps/workbench-web/src/runtime/websocket-app-host";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string; code?: number }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string; code?: number }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners); }
    listeners.add(listener);
  }

  constructor(private readonly replyToProbes = false) {}
  send(frame: string): void {
    this.sent.push(frame);
    const message = JSON.parse(frame);
    if (this.replyToProbes && message.type === "connection/probe")
      this.receive({ type: "response", requestId: message.requestId, ok: true, result: null });
  }
  close(code = 1000): void { this.readyState = 3; this.emit("close", { code }); }
  open(): void { this.readyState = FakeSocket.OPEN; this.emit("open"); }
  receive(message: unknown): void { this.emit("message", { data: JSON.stringify(message) }); }
  fail(): void { this.emit("error"); }
  private emit(type: string, event: { data?: string; code?: number } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class RecoveryEvents implements AppHostRecoveryEvents {
  visible = true;
  listeners = new Set<(reason?: string) => void>();
  isVisible = () => this.visible;
  subscribe(listener: (reason?: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  fire(visible = true, reason?: string) { this.visible = visible; for (const listener of this.listeners) listener(reason); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("probe failure captures delayed timers, recent traffic and buffer without mistaking five seconds for death", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100_000;
  context.mock.method(Date, "now", () => now);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/private-path" } } });
  const socket = new FakeSocket(), events = new RecoveryEvents();
  const diagnostics: Array<Record<string, unknown>> = [];
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    retryDelaysMs: [0], recoveryEvents: events, reportFailure: diagnostic => diagnostics.push({ ...diagnostic }),
  });
  try {
    const transport = client.createTransport("private-host"), connected = transport.connect();
    await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } });
    await flush();
    const connect = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: connect.requestId, ok: true, result: { hostId: "private-host", generation: 1 } });
    await connected;
    events.fire();
    const first = JSON.parse(socket.sent.at(-1)!);
    now += 40;
    socket.receive({ type: "response", requestId: first.requestId, ok: true, result: null });
    events.fire();
    socket.bufferedAmount = 4096;
    now += 81_000;
    context.mock.timers.tick(60_000);
    assert.equal(transport.status.state, "failed");
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]!.failure, "probe-timeout");
    assert.equal(diagnostics[0]!.probeElapsedMs, 81_000);
    assert.equal(diagnostics[0]!.timerLateMs, 21_000);
    assert.equal(diagnostics[0]!.timeoutMs, 60_000);
    assert.equal(diagnostics[0]!.lastMessageAgoMs, 81_000);
    assert.equal(diagnostics[0]!.lastProbeRttMs, 40);
    assert.equal(diagnostics[0]!.bufferedBytes, 4096);
    assert.equal(diagnostics[0]!.visibility, "visible");
    assert.equal(diagnostics[0]!.eventAtMs, now);
    assert(!JSON.stringify(diagnostics).includes("private"));
    context.mock.timers.tick(60_000);
    assert.equal(diagnostics.length, 1, "retired port emits only one failure");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("a visible mobile route is probed without browser wake events, once per shared socket", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents(), socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined });
  const accept = async (initial: boolean) => {
    await flush();
    if (initial) {
      socket.open();
      socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } });
      await flush();
    }
    const request = socket.sent.map(frame => JSON.parse(frame)).findLast(message => message.type === "host/connect")!;
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: request.hostId, generation: 1 } });
  };
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    const ca = a.connect(); await accept(true); await ca;
    const cb = b.connect(); await accept(false); await cb;
    let hints = 0; a.subscribeRecoveryHint?.(() => { hints++; });
    context.mock.timers.tick(5_000);
    const probes = socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "connection/probe");
    assert.equal(probes.length, 1, "two Host leases share one physical reachability probe");
    assert.equal(hints, 1);
    assert.equal(a.status.state, "open");
    context.mock.timers.tick(60_000);
    assert.equal(a.status.state, "failed", "a silent mobile socket must retire without close/online/pageshow events");
    assert.equal(b.status.state, "failed");
    client.close();
    const oldHints = hints, oldFrames = socket.sent.length;
    context.mock.timers.tick(60_000);
    events.fire();
    assert.equal(hints, oldHints); assert.equal(socket.sent.length, oldFrames);
    assert.equal(events.listeners.size, 0);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("an idle-probe route uses the platform response for periodic checks and fences a foreground revalidation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents(), socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    retryDelaysMs: [0], recoveryEvents: events, probeTimeoutMs: 5_000, reportFailure: () => undefined,
  });
  try {
    const transport = client.createTransport("local-codex");
    const connected = transport.connect();
    await flush();
    socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true, idleProbe: true } });
    await flush();
    const claim = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: claim.requestId, ok: true, result: { hostId: claim.hostId, generation: 1 } });
    await connected;
    context.mock.timers.tick(5_000);
    assert.equal(socket.sent.at(-1), JSON.stringify({ type: "connection/probe", requestId: APP_HOST_IDLE_PROBE_ID }));
    events.fire(false);
    events.fire(true);
    const current = JSON.parse(socket.sent.at(-1)!);
    assert.equal(current.type, "connection/probe");
    assert.notEqual(current.requestId, APP_HOST_IDLE_PROBE_ID);
    socket.receive({ type: "response", requestId: APP_HOST_IDLE_PROBE_ID, ok: true, result: null });
    context.mock.timers.tick(5_000);
    assert.equal(transport.status.state, "failed");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("visible route checks wake the existing Workbench retry owner before a long backoff", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents(), sockets: FakeSocket[] = [];
  const client = connectWebSocketAppHost(() => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; }, {
    retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined,
  });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "mobile", autoReconnect: true, reconnectDelaysMs: [60_000],
    createTransport: () => client.createTransport("mobile"),
    clock: { now: () => Date.now(), setTimeout: (run, delay) => setTimeout(run, delay), clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>) },
  });
  try {
    const failed = assert.rejects(runtime.connect(), /App Host connection failed/);
    await flush(); sockets[0]!.fail(); await failed;
    assert.equal(runtime.getSnapshot().phase, "reconnecting");
    assert.equal(sockets.length, 1);
    context.mock.timers.tick(5_000); await flush(); await flush();
    assert.equal(sockets.length, 2, "the same Host owner validates again after5s rather than waiting60s");
    events.fire(); events.fire(); await flush();
    assert.equal(sockets.length, 2, "periodic and browser hints join the current attempt");
    sockets[1]!.open();
    sockets[1]!.receive({ type: "fatal", error: { code: "APP_HOST_PROTOCOL_MISMATCH", message: "Client and server versions are incompatible", retryable: false } });
    await flush(); await flush();
    assert.equal(runtime.getSnapshot().phase, "error");
    context.mock.timers.tick(60_000); await flush();
    assert.equal(sockets.length, 2, "periodic hints cannot bypass manual recovery");
  } finally {
    await runtime.dispose(); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("periodic recovery checks stop while hidden and when the last Host releases its transport", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => { throw new Error("a recovery observation cannot allocate a socket"); }, {
    retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined,
  });
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    let hints = 0;
    a.subscribeRecoveryHint?.(() => { hints++; }); b.subscribeRecoveryHint?.(() => { hints++; });
    context.mock.timers.tick(5_000); assert.equal(hints, 2);
    events.fire(false); context.mock.timers.tick(60_000); assert.equal(hints, 2);
    events.fire(); assert.equal(hints, 4);
    await a.close();
    context.mock.timers.tick(5_000); assert.equal(hints, 5);
    await b.close();
    context.mock.timers.tick(60_000); assert.equal(hints, 5);
  } finally { client.close(); }
});

test("periodic route checks probe every five seconds but space their recovery hints", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => { throw new Error("a recovery observation cannot allocate a socket"); }, {
    recoveryEvents: events, retryDelaysMs: [0], reportFailure: () => undefined,
  });
  try {
    const transport = client.createTransport("weak-route");
    let hints = 0;
    transport.subscribeRecoveryHint?.(() => { hints++; });
    context.mock.timers.tick(5_000);
    assert.equal(hints, 1, "the first periodic observation may validate the route");
    context.mock.timers.tick(25_000);
    assert.equal(hints, 1, "later five-second checks cannot bypass the Host retry backoff");
    events.fire();
    assert.equal(hints, 2, "an explicit online/foreground event is still delivered immediately");
    context.mock.timers.tick(5_000);
    assert.equal(hints, 3, "a silent mobile route is revalidated at the spaced cadence");
    for (let elapsed = 0; elapsed < 270_000; elapsed += 5_000) context.mock.timers.tick(5_000);
    assert.equal(hints, 12, "five minutes produce about ten periodic hints instead of sixty");
  } finally { client.close(); }
});

test("a retired observation timer cannot take ownership from the resumed timer", context => {
  const callbacks: (() => void)[] = [], active = new Set<number>();
  context.mock.method(globalThis, "setTimeout", (run: () => void) => {
    callbacks.push(run); active.add(callbacks.length);
    return callbacks.length as unknown as ReturnType<typeof setTimeout>;
  });
  context.mock.method(globalThis, "clearTimeout", (id: unknown) => { active.delete(id as number); });
  const events = new RecoveryEvents();
  const client = connectWebSocketAppHost(undefined, { recoveryEvents: events });
  try {
    const transport = client.createTransport("mobile"); let hints = 0;
    transport.subscribeRecoveryHint?.(() => { hints++; });
    const retired = callbacks[0]!;
    events.fire(false); events.fire();
    assert.equal(hints, 1); assert.equal(callbacks.length, 2); assert.equal(active.size, 1);
    retired();
    assert.equal(hints, 1); assert.equal(callbacks.length, 2); assert.equal(active.size, 1);
    client.close(); callbacks[1]!();
    assert.equal(hints, 1); assert.equal(active.size, 0);
  } finally { client.close(); }
});

test("foreground probes share the socket, pause in background, and cannot affect a successor", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents();
  const first = new FakeSocket(), next = new FakeSocket();
  const sockets = [first, next];
  const client = connectWebSocketAppHost(() => sockets.shift() as unknown as WebSocket, {
    retryDelaysMs: [0], recoveryEvents: events, probeTimeoutMs: 5_000, reportFailure: () => undefined,
  });
  const accept = async (socket: FakeSocket, initial: boolean) => {
    await flush();
    if (initial) {
      socket.open();
      const hello = JSON.parse(socket.sent[0]!);
      socket.receive({ type: "ready", protocolVersion: 2, connectionId: hello.rendererId, services: ["appserver"], capabilities: { connectionProbe: true } });
      await flush();
    }
    const request = socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "host/connect").at(-1)!;
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: request.hostId, generation: 1 } });
  };
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    const ca = a.connect(); await accept(first, true); await ca;
    const cb = b.connect(); await accept(first, false); await cb;
    assert.equal(a.status.attemptId, JSON.parse(first.sent[0]!).rendererId);
    assert.equal(b.status.attemptId, a.status.attemptId);
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
    const oldAttemptId = a.status.attemptId;
    const reconnect = a.connect(); await accept(next, true); await reconnect;
    assert.notEqual(a.status.attemptId, oldAttemptId);
    assert.equal(a.status.attemptId, JSON.parse(next.sent[0]!).rendererId);
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
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined });
  try {
    const transport = client.createTransport("local");
    let hints = 0;
    transport.subscribeRecoveryHint?.(() => { hints++; });
    const connecting = transport.connect(); await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] }); await flush();
    const request = JSON.parse(socket.sent[1]!);
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "local", generation: 1 } });
    await connecting;
    events.fire();
    assert.equal(hints, 1);
    assert.equal(socket.sent.length, 2);
    socket.fail(); events.fire();
    assert.equal(hints, 1, "a burst of foreground hints shares the cooldown");
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
  }, { retryDelaysMs: [0], reportFailure: diagnostic => diagnostics.push(diagnostic) });
  try {
    const transport = client.createTransport("fixture-host");
    const connection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new URL(urls[0]!).origin, "wss://example.test");
    assert.equal(new URL(urls[0]!).pathname, "/apphost");
    const instance = new URL(urls[0]!).searchParams.get(APP_HOST_CLIENT_INSTANCE_PARAMETER);
    assert.ok(instance);
    assert.ok(new URL(urls[0]!).searchParams.get("attempt"));
    assert.notEqual(instance, new URL(urls[0]!).searchParams.get("attempt"));
    socket.open();
    const hello = JSON.parse(socket.sent[0]!);
    assert.equal(hello.type, "hello");
    socket.receive({ type: "ready", protocolVersion: 2, connectionId: hello.rendererId, services: ["appserver"] });
    await new Promise(resolve => setImmediate(resolve));
    const connect = JSON.parse(socket.sent[1]!);
    assert.equal(connect.type, "host/connect");
    assert.equal(connect.hostId, "fixture-host");
    socket.receive({ type: "response", requestId: connect.requestId, ok: true,
      result: { hostId: "fixture-host", generation: 7 } });
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
    socket.receive({ type: "host/frame", hostId: "fixture-host", generation: 7, frame: '{"id":1,"result":{}}' });
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
    assert.equal(new URL(urls[1]!).searchParams.get(APP_HOST_CLIENT_INSTANCE_PARAMETER), instance);
    replacementSocket.open();
    const replacementHello = JSON.parse(replacementSocket.sent[0]!);
    replacementSocket.receive({ type: "ready", protocolVersion: 2,
      connectionId: replacementHello.rendererId, services: ["appserver"] });
    await new Promise(resolve => setImmediate(resolve));
    const reconnect = JSON.parse(replacementSocket.sent[1]!);
    assert.equal(reconnect.type, "host/connect");
    assert.notEqual(reconnect.leaseId, connect.leaseId);
    replacementSocket.receive({ type: "response", requestId: reconnect.requestId, ok: true,
      result: { hostId: "fixture-host", generation: 8 } });
    await reconnection;
    assert.equal(transport.status.state, "open");
    replacementSocket.receive({ type: "host/frame", hostId: "fixture-host", generation: 8, frame: '{"id":2,"result":{}}' });
    assert.deepEqual(frames, ['{"id":1,"result":{}}', '{"id":2,"result":{}}']);
    const renewedSend = transport.send('{"jsonrpc":"2.0","id":3}');
    const renewedFrame = JSON.parse(replacementSocket.sent[2]!);
    assert.equal(renewedFrame.generation, 8);
    replacementSocket.receive({ type: "response", requestId: renewedFrame.requestId, ok: true });
    await renewedSend;
    const closing = transport.close();
    await flush();
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
    retryDelaysMs: [0], reportFailure: diagnostic => diagnostics.push(diagnostic),
  });
  try {
    const transport = client.createTransport("fixture-host");
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
    retryDelaysMs: [0], reportFailure: diagnostic => diagnostics.push({ ...diagnostic }),
  });
  try {
    const connection = client.createTransport("fixture-host").connect();
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

test("version-1 AppHost cannot silently downgrade lease isolation", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], reportFailure: () => undefined });
  try {
    const transport = client.createTransport("local");
    const rejected = assert.rejects(transport.connect(), /versions are incompatible/i);
    await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 1, services: ["appserver"] });
    await rejected;
    assert.deepEqual(transport.status.failure, { code: "APP_HOST_PROTOCOL_MISMATCH", recovery: "manual" });
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("protocol fatal survives Workbench cleanup and foreground hints without scheduling another socket", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const events = new RecoveryEvents(), socket = new FakeSocket();
  let sockets = 0;
  const client = connectWebSocketAppHost(() => { sockets++; return socket as unknown as WebSocket; }, {
    retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined,
  });
  const timers = new Set<() => void>();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", autoReconnect: true,
    createTransport: () => client.createTransport("local"),
    clock: { setTimeout(callback) { timers.add(callback); return callback; }, clearTimeout(timer) { timers.delete(timer as () => void); } },
  });
  try {
    const rejected = assert.rejects(runtime.connect(), /versions are incompatible/);
    await flush(); socket.open();
    socket.receive({ type: "fatal", error: { code: "APP_HOST_PROTOCOL_MISMATCH", message: "Client and server versions are incompatible", retryable: false } });
    await rejected;
    events.fire(false); events.fire(); events.fire(); await flush();
    assert.equal(runtime.getSnapshot().phase, "error");
    assert.deepEqual(runtime.getSnapshot().transport.failure, { code: "APP_HOST_PROTOCOL_MISMATCH", recovery: "manual" });
    assert.equal(timers.size, 0);
    assert.equal(sockets, 1);
    assert.equal(socket.sent.length, 1); // hello only; no Host claim or business request.
  } finally {
    await runtime.dispose(); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("a generic policy close stays recoverable instead of being guessed to be a version failure", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], reportFailure: () => undefined });
  try {
    const transport = client.createTransport("local");
    const rejected = assert.rejects(transport.connect(), /connection closed/);
    await flush(); socket.open(); socket.close(1008);
    await rejected;
    assert.equal(transport.status.failure?.code, "APP_HOST_DISCONNECTED");
    assert.equal(transport.status.failure?.recovery, "automatic");
    assert.equal(transport.status.failure?.diagnostic?.closeCode, 1008);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("failed leases retain the exact server diagnostic attempt, successors clear it", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const reports: any[] = [];
  const client = connectWebSocketAppHost(url => {
    urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  }, { retryDelaysMs: [0], recoveryEvents: new RecoveryEvents(), reportFailure: report => reports.push(report) });
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    const ca = a.connect().catch(() => undefined), cb = b.connect().catch(() => undefined);
    await flush();
    sockets[0]!.fail(); await Promise.all([ca, cb]);
    const failure = a.status.failure;
    assert.equal(failure?.code, "APP_HOST_DISCONNECTED");
    assert.equal(failure?.recovery, "automatic");
    assert.equal(failure?.diagnostic?.attemptId, new URL(urls[0]!).searchParams.get("attempt"));
    assert.equal(failure?.diagnostic?.attemptId, reports[0].attemptId);
    assert.equal(failure?.diagnostic?.failure, "socket-error");
    assert.equal(failure?.diagnostic?.phase, "connecting");
    assert.ok(Number.isFinite(Date.parse(failure!.diagnostic!.occurredAt)));
    assert.deepEqual(b.status.failure?.diagnostic, failure?.diagnostic);
    const reconnect = a.connect(); await flush();
    const next = sockets[1]!; next.open();
    const hello = JSON.parse(next.sent[0]!);
    next.receive({ type: "ready", protocolVersion: 2, connectionId: hello.rendererId, services: ["appserver"] });
    await flush();
    const request = next.sent.map(frame => JSON.parse(frame)).find(frame => frame.type === "host/connect");
    next.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "a", generation: 1 } });
    await reconnect;
    assert.equal(a.status.state, "open");
    assert.equal(a.status.failure, undefined);
    // The other lease still describes its own failed socket, not the successor.
    assert.deepEqual(b.status.failure, failure);
    assert.notEqual(new URL(urls[1]!).searchParams.get("attempt"), failure!.diagnostic!.attemptId);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});


test("Workbench preserves initial connection diagnostic after factory cleanup and replaces it on retry", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const sockets: FakeSocket[] = [];
  const client = connectWebSocketAppHost(() => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  }, { retryDelaysMs: [0], recoveryEvents: new RecoveryEvents(), reportFailure: () => undefined });
  const runtime = createAppServerWorkbenchRuntime({ hostId: "local", autoReconnect: false,
    createTransport: () => client.createTransport("local"),
  });
  try {
    const initial = assert.rejects(runtime.connect(), /connection failed/);
    await flush(); sockets[0]!.fail(); await initial;
    const failure = runtime.getSnapshot().transport.failure;
    assert.equal(runtime.getSnapshot().phase, "error");
    assert.equal(runtime.getSnapshot().transport.state, "failed");
    assert.ok(failure?.diagnostic?.attemptId);
    assert.equal(failure?.diagnostic?.phase, "connecting");
    const retry = assert.rejects(runtime.reconnect(), /connection failed/);
    assert.equal(runtime.getSnapshot().transport.failure, undefined, "a new attempt clears retired diagnostics");
    await flush(); sockets[1]!.fail(); await retry;
    assert.ok(runtime.getSnapshot().transport.failure?.diagnostic?.attemptId);
    assert.notEqual(runtime.getSnapshot().transport.failure?.diagnostic?.attemptId, failure?.diagnostic?.attemptId);
  } finally {
    await runtime.dispose(); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});


test("expired claim saturation renews the shared browser socket and lets its peer recover", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/chat" } } });
  const first = new FakeSocket(true), successor = new FakeSocket(true), sockets = [first, successor];
  const events = new RecoveryEvents(); let created = 0;
  const client = connectWebSocketAppHost(() => { created++; return sockets.shift() as unknown as WebSocket; }, { retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined });
  const slow = client.createTransport("slow"), peer = client.createTransport("healthy");
  const accept = async (socket: FakeSocket, initial: boolean) => {
    await flush();
    if (initial) { socket.open(); socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } }); await flush(); }
    const request = socket.sent.map(frame => JSON.parse(frame)).findLast(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: request.hostId, generation: 1 } });
  };
  try {
    const connected = peer.connect(); await accept(first, true); await connected;
    for (let index = 0; index < 256; index++) {
      const expired = assert.rejects(slow.connect(), /host\/connect timed out/);
      await flush(); context.mock.timers.tick(30_000); await expired;
    }
    events.fire(); const probe = first.sent.map(frame => JSON.parse(frame)).findLast(message => message.type === "connection/probe");
    first.receive({ type: "response", requestId: probe.requestId, ok: true, result: null });
    await assert.rejects(slow.connect(), /pending request limit reached/);
    assert.equal(first.readyState, 3);
    assert.deepEqual(peer.status.failure, { code: "APP_HOST_REQUEST_LIMIT", recovery: "automatic" });
    const reconnect = slow.connect(); await accept(successor, true); await reconnect;
    const peerReconnect = peer.connect(); await accept(successor, false); await peerReconnect;
    assert.equal(created, 2); assert.equal(slow.status.state, "open"); assert.equal(peer.status.state, "open");
    assert.equal(peer.status.attemptId, slow.status.attemptId);
    first.receive({ type: "fatal", error: { code: "OLD_ERROR", message: "late old error", retryable: false } });
    assert.equal(peer.status.state, "open");
    const closes = [slow.close(), peer.close()]; await flush();
    for (const message of successor.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "host/disconnect")) successor.receive({ type: "response", requestId: message.requestId, ok: true });
    await Promise.all(closes);
  } finally { client.close(); if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); }
});


test("private recovery awaits admission and never opens a socket after cancellation", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  try {
    for (const stop of ["abort", "dispose", "deny"] as const) {
      let release!: () => void, reads = 0, sockets = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const client = connectWebSocketAppHost(() => { sockets++; return new FakeSocket() as unknown as WebSocket; }, {
        path: "/ssh-apphost", retryDelaysMs: [0], reportFailure: () => undefined,
        beforeConnect: async () => { reads++; await gate; if (stop === "deny") throw new Error("locked"); },
      });
      const transport = client.createTransport("ssh:fixture"), abort = new AbortController();
      const pending = transport.connect(abort.signal);
      const rejected = assert.rejects(pending);
      assert.equal(transport.connect(abort.signal), pending);
      assert.equal(sockets, 0); assert.equal(reads, 1);
      if (stop === "abort") abort.abort();
      if (stop === "dispose") await transport.close();
      release(); await rejected;
      assert.equal(sockets, 0);
      client.close();
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as { window?: unknown }).window;
  }
});

test("RECOVERY-GAP-04: revoked local admission must settle without waiting for old external work", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  let release!: () => void, settled = false, sockets = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = connectWebSocketAppHost(() => { sockets++; return new FakeSocket() as unknown as WebSocket; }, {
    retryDelaysMs: [0], reportFailure: () => undefined, beforeConnect: () => gate,
  });
  const abort = new AbortController();
  const pending = client.createTransport("a").connect(abort.signal);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await flush(); abort.abort(); await flush();
    assert.equal(settled, true, "local revocation must not depend on the retired admission promise settling");
    assert.equal(sockets, 0);
  } finally {
    release(); await pending.catch(() => undefined); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("RECOVERY-GAP-05: a successor cannot join a revoked renewable transport operation", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = connectWebSocketAppHost(() => new FakeSocket() as unknown as WebSocket, {
    retryDelaysMs: [0], reportFailure: () => undefined, beforeConnect: async () => { if (++reads === 1) await gate; },
  });
  const transport = client.createTransport("a"), abort = new AbortController();
  const old = transport.connect(abort.signal); void old.catch(() => undefined);
  let next: Promise<void> | undefined;
  try {
    await flush(); abort.abort(); await flush();
    next = transport.connect(); void next.catch(() => undefined);
    await flush();
    assert.notEqual(next, old, "an aborted attempt must release its logical promise ownership");
    assert.equal(reads, 2, "the successor must get its own admission check");
  } finally {
    release(); client.close(); await Promise.allSettled([old, ...(next ? [next] : [])]);
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("formal trace replay: a failed Host lease and its late frames cannot revoke a healthy peer sharing the socket", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket(); let sockets = 0;
  const client = connectWebSocketAppHost(() => { sockets++; return (sockets === 1 ? socket : new FakeSocket()) as unknown as WebSocket; }, { reportFailure: () => undefined });
  const frames: string[] = [];
  const messages = (type: string) => socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === type);
  const acknowledge = (message: { requestId: string }, result?: unknown) => socket.receive({ type: "response", requestId: message.requestId, ok: true, result });
  try {
    const a = client.createTransport("a"), b = client.createTransport("b");
    const first = a.connect(); await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] }); await flush();
    acknowledge(messages("host/connect").at(-1), { hostId: "a", generation: 10 }); await first;
    const second = b.connect(); await flush();
    const oldLease = messages("host/connect").at(-1);
    acknowledge(oldLease, { hostId: "b", generation: 20 }); await second;
    b.subscribeMessage(frame => frames.push(frame));
    socket.receive({ type: "host/status", hostId: "b", generation: 20, status: { state: "failed", reason: "synthetic Host failure" } });
    assert.equal(a.status.state, "open"); assert.equal(b.status.state, "failed");
    const recovery = b.connect(); await flush();
    acknowledge(messages("host/disconnect").at(-1)); await flush();
    const newLease = messages("host/connect").at(-1);
    assert.notEqual(newLease.leaseId, oldLease.leaseId);
    acknowledge(newLease, { hostId: "b", generation: 21 }); await recovery;
    socket.receive({ type: "host/frame", hostId: "b", generation: 20, leaseId: oldLease.leaseId, frame: "retired" });
    socket.receive({ type: "host/status", hostId: "b", generation: 20, status: { state: "failed" } });
    socket.receive({ type: "host/frame", hostId: "b", generation: 21, leaseId: newLease.leaseId, frame: "current" });
    assert.deepEqual(frames, ["current"]);
    assert.equal(a.status.state, "open"); assert.equal(b.status.state, "open");
    assert.equal(a.status.attemptId, b.status.attemptId);
    assert.equal(sockets, 1); assert.equal(messages("host/send").length, 0);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});



test("expired claim saturation renews the shared browser socket and lets its peer recover", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/chat" } } });
  const first = new FakeSocket(true), successor = new FakeSocket(true), sockets = [first, successor];
  const events = new RecoveryEvents(); let created = 0;
  const client = connectWebSocketAppHost(() => { created++; return sockets.shift() as unknown as WebSocket; }, { retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined });
  const slow = client.createTransport("slow"), peer = client.createTransport("healthy");
  const accept = async (socket: FakeSocket, initial: boolean) => {
    await flush();
    if (initial) { socket.open(); socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } }); await flush(); }
    const request = socket.sent.map(frame => JSON.parse(frame)).findLast(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: request.hostId, generation: 1 } });
  };
  try {
    const connected = peer.connect(); await accept(first, true); await connected;
    for (let index = 0; index < 256; index++) {
      const expired = assert.rejects(slow.connect(), /host\/connect timed out/);
      await flush(); context.mock.timers.tick(30_000); await expired;
    }
    events.fire(); const probe = first.sent.map(frame => JSON.parse(frame)).findLast(message => message.type === "connection/probe");
    first.receive({ type: "response", requestId: probe.requestId, ok: true, result: null });
    await assert.rejects(slow.connect(), /pending request limit reached/);
    assert.equal(first.readyState, 3);
    assert.deepEqual(peer.status.failure, { code: "APP_HOST_REQUEST_LIMIT", recovery: "automatic" });
    const reconnect = slow.connect(); await accept(successor, true); await reconnect;
    const peerReconnect = peer.connect(); await accept(successor, false); await peerReconnect;
    assert.equal(created, 2); assert.equal(slow.status.state, "open"); assert.equal(peer.status.state, "open");
    assert.equal(peer.status.attemptId, slow.status.attemptId);
    first.receive({ type: "fatal", error: { code: "OLD_ERROR", message: "late old error", retryable: false } });
    assert.equal(peer.status.state, "open");
    const closes = [slow.close(), peer.close()]; await flush();
    for (const message of successor.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "host/disconnect")) successor.receive({ type: "response", requestId: message.requestId, ok: true });
    await Promise.all(closes);
  } finally { client.close(); if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); }
});

for (const late of ["resolve", "reject"] as const) test(`retired admission ${late} cannot allocate or fail the connected successor`, async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  let release!: () => void, fail!: (error: Error) => void, reads = 0, sockets = 0;
  const gate = new Promise<void>((resolve, reject) => { release = resolve; fail = reject; });
  const socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => { sockets++; return socket as unknown as WebSocket; }, {
    retryDelaysMs: [0], reportFailure: () => undefined, beforeConnect: () => ++reads === 1 ? gate : Promise.resolve(),
  });
  try {
    const transport = client.createTransport("a"), abort = new AbortController();
    const old = transport.connect(abort.signal); const rejected = assert.rejects(old);
    abort.abort();
    const next = transport.connect(); // Deliberately before old finally/microtask cleanup.
    assert.notEqual(next, old); await rejected; await flush();
    socket.open(); socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] }); await flush();
    const request = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "a", generation: 2 } }); await next;
    if (late === "resolve") release(); else fail(new Error("retired denial"));
    await flush();
    assert.equal(transport.status.state, "open"); assert.equal(sockets, 1); assert.equal(reads, 2);
  } finally {
    release(); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("local cancellation releases callers but successors still wait for the physical lease close barrier", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], reportFailure: () => undefined });
  const messages = (type: string) => socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === type);
  const acknowledge = (message: { requestId: string }, result?: unknown) => socket.receive({ type: "response", requestId: message.requestId, ok: true, result });
  try {
    const transport = client.createTransport("a"); const first = transport.connect(); await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] }); await flush();
    acknowledge(messages("host/connect").at(-1), { hostId: "a", generation: 1 }); await first;
    socket.receive({ type: "host/status", hostId: "a", generation: 1, status: { state: "failed", reason: "synthetic loss" } });
    const abort = new AbortController(); const second = transport.connect(abort.signal); const rejected = assert.rejects(second);
    await flush(); assert.equal(messages("host/disconnect").length, 1);
    abort.abort(); await rejected;
    const third = transport.connect(); await flush();
    assert.equal(messages("host/connect").length, 1, "a pending physical release cannot be bypassed by local retirement");
    acknowledge(messages("host/disconnect").at(-1)); await flush();
    assert.equal(messages("host/connect").length, 2);
    acknowledge(messages("host/connect").at(-1), { hostId: "a", generation: 2 }); await third;
    assert.equal(transport.status.state, "open");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("synchronous connecting observer can revoke before admission or socket allocation", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  let reads = 0, sockets = 0;
  const client = connectWebSocketAppHost(() => { sockets++; return new FakeSocket() as unknown as WebSocket; }, {
    retryDelaysMs: [0], reportFailure: () => undefined, beforeConnect: async () => { reads++; },
  });
  try {
    const transport = client.createTransport("a"), abort = new AbortController(); let shared: Promise<void> | undefined;
    transport.subscribeStatus(status => { if (status.state === "connecting") { shared = transport.connect(); abort.abort(); } });
    const pending = transport.connect(abort.signal);
    assert.equal(shared, pending); await assert.rejects(pending); await flush();
    assert.equal(reads, 0); assert.equal(sockets, 0);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});


test("mobile pause context survives two socket owners and a cache restore before foreground failure", async context => {
  let now = 100_000;
  context.mock.method(Date, "now", () => now);
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const browser = Object.assign(new EventTarget(), { location: { href: "https://example.test/" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  const sockets = [new FakeSocket(), new FakeSocket()];
  const reports: Array<Record<string, unknown>> = [];
  const owners = sockets.map(socket => connectWebSocketAppHost(() => socket as unknown as WebSocket, {
    retryDelaysMs: [0], reportFailure: diagnostic => reports.push({ ...diagnostic }),
  }));
  try {
    const transports = owners.map(owner => owner.createTransport("local"));
    const connecting = transports.map(transport => transport.connect().catch(() => undefined));
    await flush();
    page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
    browser.dispatchEvent(new Event("pagehide"));
    now += 94_000;
    page.visibilityState = "visible";
    const shown = new Event("pageshow"); Object.defineProperty(shown, "persisted", { value: true });
    browser.dispatchEvent(shown);
    now += 30;
    for (const socket of sockets) socket.fail();
    await Promise.all(connecting);
    assert.equal(reports.length, 2);
    for (const report of reports) {
      assert.equal(report.visibility, "visible");
      assert.equal(report.pagePauseMs, 94_000);
      assert.equal(report.pageResumeAgoMs, 30);
      assert.equal(report.pageHiddenForMs, undefined);
    }
  } finally {
    for (const owner of owners) owner.close();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window");
    if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

test("recent application progress preserves a slow probe, with a bounded missing-ACK deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket(), events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], recoveryEvents: events, reportFailure: () => undefined });
  try {
    const transport = client.createTransport("host"), connected = transport.connect();
    await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } });
    await flush();
    const request = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "host", generation: 1 } });
    await connected; events.fire();
    context.mock.timers.tick(5_000); assert.equal(transport.status.state, "open", "five seconds alone cannot kill slow delivery");
    for (let i = 0; i < 5; i++) {
      context.mock.timers.tick(50_000);
      socket.receive({ type: "fixture" });
      assert.equal(transport.status.state, "open");
    }
    context.mock.timers.tick(45_000); assert.equal(transport.status.state, "failed", "one-way traffic does not acknowledge a probe forever");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("browser AppHost projects local frame progress without completing the forwarded request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/" } } });
  const socket = new FakeSocket(), events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { recoveryEvents: events, retryDelaysMs: [0], reportFailure: () => {} });
  try {
    const transport = client.createTransport("local"), connecting = transport.connect();
    await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] });
    await flush();
    const connect = socket.sent.map(f => JSON.parse(f)).find(m => m.type === "host/connect");
    socket.receive({ type: "response", requestId: connect.requestId, ok: true, result: { hostId: "local", generation: 1 } });
    await connecting;
    const originalSend = socket.send.bind(socket);
    socket.send = frame => { socket.bufferedAmount += new TextEncoder().encode(frame).length; originalSend(frame); };
    const progress: number[] = []; let settled = false;
    const sending = transport.send('{"id":42,"method":"attachment/uploadChunk","params":{}}', undefined,
      { onProgress: p => progress.push(p.loaded / p.total) }).then(() => { settled = true; });
    await flush();
    const outbound = JSON.parse(socket.sent.at(-1)!);
    assert(!("onProgress" in outbound), "callback remains client-local");
    assert.deepEqual(progress, [0]);
    socket.bufferedAmount /= 2; t.mock.timers.tick(50);
    assert.deepEqual(progress, [0, 0.5]);
    socket.bufferedAmount = 0; t.mock.timers.tick(50);
    assert.deepEqual(progress, [0, 0.5, 1]); assert.equal(settled, false);
    socket.receive({ type: "response", requestId: outbound.requestId, ok: true });
    await sending; assert.equal(settled, true);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("freeze and BFCache suspension retire a visible page's probe; resume gets a fresh deadline", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const browser = Object.assign(new EventTarget(), { location: { href: "https://example.test" } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  const socket = new FakeSocket(), failures: unknown[] = [];
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { retryDelaysMs: [0], reportFailure: value => failures.push(value) });
  try {
    const transport = client.createTransport("local-codex"), connected = transport.connect();
    await flush(); socket.open();
    socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } });
    await flush();
    const request = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "local-codex", generation: 1 } });
    await connected;
    const probes = () => socket.sent.map(frame => JSON.parse(frame)).filter(message => message.type === "connection/probe");
    for (const [suspend, resume, target] of [["freeze", "resume", page], ["pagehide", "pageshow", browser]] as const) {
      browser.dispatchEvent(new Event("online"));
      const oldProbe = probes().at(-1)!;
      target.dispatchEvent(new Event(suspend));
      context.mock.timers.tick(120_000);
      assert.equal(transport.status.state, "open", "visibility=visible does not spend a frozen page's foreground deadline");
      target.dispatchEvent(new Event(resume));
      const freshProbe = probes().at(-1)!;
      assert.notEqual(freshProbe.requestId, oldProbe.requestId, "resumption must probe immediately, using a new deadline");
      socket.receive({ type: "response", requestId: oldProbe.requestId, ok: true, result: null });
      context.mock.timers.tick(59_000);
      assert.equal(transport.status.state, "open");
      socket.receive({ type: "response", requestId: freshProbe.requestId, ok: true, result: null });
    }
    assert.deepEqual(failures, []);
    client.close();
    const frames = socket.sent.length;
    page.dispatchEvent(new Event("resume")); browser.dispatchEvent(new Event("pageshow"));
    context.mock.timers.tick(120_000);
    assert.equal(socket.sent.length, frames, "disposal removes lifecycle subscriptions and timers");
  } finally {
    browser.dispatchEvent(new Event("pageshow")); client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else Reflect.deleteProperty(globalThis, "document");
  }
});

for (const random of [0, 0.5, 1]) test(`physical retry admission cannot be bypassed by IM demand or recovery hints (jitter ${random})`, async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100_000;
  context.mock.method(Date, "now", () => now);
  context.mock.method(Math, "random", () => random);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const sockets: FakeSocket[] = [], events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  }, { recoveryEvents: events, reportFailure: () => undefined });
  const pending: Promise<unknown>[] = [];
  const connect = (host: string, signal?: AbortSignal) => {
    const transport = client.createTransport(host);
    pending.push(transport.connect(signal).catch(() => undefined));
    return transport;
  };
  const advance = async (ms: number) => { now += ms; context.mock.timers.tick(ms); await flush(); };
  try {
    connect("workbench"); await flush();
    assert.equal(sockets.length, 1);
    sockets[0]!.fail(); await flush();
    const abort = new AbortController();
    connect("canceled-watch", abort.signal); await flush();
    abort.abort();
    for (let i = 0; i < 33; i++) { connect(`im-watch-${i}`); events.fire(); }
    await flush();
    const firstDelay = Math.round(500 * (0.8 + random * 0.4));
    await advance(firstDelay - 1);
    assert.equal(sockets.length, 1, "direct demand cannot spend another consumer's cooldown");
    await advance(1);
    assert.equal(sockets.length, 2, "all surviving consumers share one replacement socket");
    sockets[1]!.fail(); await flush();
    connect("next-watch"); await flush();
    const secondDelay = Math.round(1_000 * (0.8 + random * 0.4));
    await advance(secondDelay - 1);
    assert.equal(sockets.length, 2, "new callers cannot reset the physical failure count");
    await advance(1);
    assert.equal(sockets.length, 3);
    sockets[2]!.fail(); await flush();
    connect("disposed-waiter"); await flush();
    client.close();
    await advance(60_000);
    assert.equal(sockets.length, 3, "factory disposal revokes queued allocations");
    await Promise.all(pending);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("synchronous socket construction failures share the physical backoff", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100_000, attempts = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(Math, "random", () => 0.5);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const client = connectWebSocketAppHost(() => { attempts++; throw new Error("offline"); }, { recoveryEvents: new RecoveryEvents() });
  try {
    await assert.rejects(client.createTransport("workbench").connect(), /offline/);
    const next = client.createTransport("im-watch").connect(); const rejected = assert.rejects(next, /offline/);
    await flush(); assert.equal(attempts, 1);
    now += 500; context.mock.timers.tick(500); await rejected;
    assert.equal(attempts, 2);
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("canceling a handshake waiter preserves a peer's shared physical attempt", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket(); let sockets = 0;
  const client = connectWebSocketAppHost(() => { sockets++; return (sockets === 1 ? socket : new FakeSocket()) as unknown as WebSocket; }, { recoveryEvents: new RecoveryEvents() });
  try {
    const abort = new AbortController();
    const canceled = client.createTransport("im").connect(abort.signal);
    const rejected = assert.rejects(canceled);
    const peer = client.createTransport("workbench"), connected = peer.connect();
    await flush(); abort.abort(); await rejected;
    assert.equal(socket.readyState, FakeSocket.CONNECTING);
    socket.open(); socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"] }); await flush();
    const request = socket.sent.map(frame => JSON.parse(frame)).find(message => message.type === "host/connect" && message.hostId === "workbench");
    socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "workbench", generation: 1 } });
    await connected;
    assert.equal(sockets, 1); assert.equal(peer.status.state, "open");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("private admission is revalidated after physical backoff before socket allocation", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100_000, allowed = true, sockets = 0;
  context.mock.method(Date, "now", () => now);
  context.mock.method(Math, "random", () => 0.5);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const socket = new FakeSocket();
  const client = connectWebSocketAppHost(() => { sockets++; return socket as unknown as WebSocket; }, {
    recoveryEvents: new RecoveryEvents(), reportFailure: () => undefined,
    beforeConnect: async () => { if (!allowed) throw new Error("locked"); },
  });
  try {
    const first = client.createTransport("first").connect(); const rejected = assert.rejects(first);
    await flush(); socket.fail(); await rejected;
    const next = client.createTransport("second").connect(); const denied = assert.rejects(next, /locked/);
    await flush(); allowed = false;
    now += 500; context.mock.timers.tick(500); await denied;
    assert.equal(sockets, 1, "a pre-cooldown admission cannot authorize a later socket");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

test("ten seconds of offline IM watch demand stays within one exponential physical retry budget", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 100_000;
  context.mock.method(Date, "now", () => now);
  context.mock.method(Math, "random", () => 0.5);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test" } } });
  const sockets: FakeSocket[] = [], events = new RecoveryEvents();
  const client = connectWebSocketAppHost(() => {
    const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket;
  }, { recoveryEvents: events, reportFailure: () => undefined });
  try {
    const im = client.createTransport("im-watch"), workbench = client.createTransport("workbench");
    let failed = 0;
    for (let elapsed = 0; elapsed <= 10_000; elapsed += 100) {
      void im.connect().catch(() => undefined);
      void workbench.connect().catch(() => undefined);
      events.fire(); await flush();
      while (failed < sockets.length) sockets[failed++]!.fail();
      await flush();
      now += 100; context.mock.timers.tick(100);
    }
    assert.equal(sockets.length, 5, "attempts at 0, 500, 1500, 3500 and 8500ms; watch demand cannot create 33 sockets");
  } finally {
    client.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});

for (const outcome of ["replace", "failed", "old-recovered", "dispose", "close-failed"] as const)
test("suspect socket replacement validation: " + outcome, async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let now=100_000;t.mock.method(Date,"now",()=>now);
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{href:"https://example.test"}}});
  const sockets:FakeSocket[]=[],events=new RecoveryEvents();
  const client=connectWebSocketAppHost(()=>{const s=new FakeSocket();sockets.push(s);return s as unknown as WebSocket;},
    {recoveryEvents:events,reportFailure:()=>{}});
  const advance=async(ms:number)=>{now+=ms;t.mock.timers.tick(ms);await flush();};
  try {
    const transport=client.createTransport("host"),ready=transport.connect();await flush();
    const old=sockets[0]!;old.open();old.receive({type:"ready",protocolVersion:2,services:["appserver"],capabilities:{connectionProbe:true}});await flush();
    const req=old.sent.map(x=>JSON.parse(x)).find(x=>x.type==="host/connect");
    old.receive({type:"response",requestId:req.requestId,ok:true,result:{hostId:"host",generation:1}});await ready;
    events.fire();await advance(15_000);
    assert.equal(sockets.length,2);
    const candidate=sockets[1]!;
    assert.equal(transport.status.state,"open","unverified candidate cannot revoke old leases");
    if(outcome==="failed"){candidate.fail();await flush();assert.equal(transport.status.state,"open");return;}
    if(outcome==="dispose"){client.close();assert.equal(candidate.readyState,3);return;}
    candidate.open();candidate.receive({type:"ready",protocolVersion:2,services:["appserver"],capabilities:{connectionProbe:true}});await flush();
    assert.deepEqual(candidate.sent.map(x=>JSON.parse(x)).map(x=>x.type),["hello","connection/probe"],"no business request or Host lease before validation");
    if(outcome==="old-recovered"){
      const probe=old.sent.map(x=>JSON.parse(x)).findLast(x=>x.type==="connection/probe");
      old.receive({type:"response",requestId:probe.requestId,ok:true,result:null});
    }
    const probe=candidate.sent.map(x=>JSON.parse(x)).find(x=>x.type==="connection/probe");
    const closeOld=old.close.bind(old);
    if(outcome==="close-failed")old.close=()=>{throw Error("native close refused");};
    candidate.receive({type:"response",requestId:probe.requestId,ok:true,result:null});await flush();
    old.close=closeOld;
    if(outcome==="close-failed"){assert.equal(candidate.readyState,3);assert.equal(sockets.length,2);return;}
    if(outcome==="old-recovered"){assert.equal(candidate.readyState,3);assert.equal(transport.status.state,"open");return;}
    assert.equal(old.readyState,3);
    const reconnect=transport.connect();await flush();
    const next=candidate.sent.map(x=>JSON.parse(x)).find(x=>x.type==="host/connect");
    candidate.receive({type:"response",requestId:next.requestId,ok:true,result:{hostId:"host",generation:2}});
    await reconnect;assert.equal(transport.status.state,"open");assert.equal(sockets.length,2);
  } finally {client.close();if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");}
});

test("explicit online event advances one shared cooldown, but repeated hints retain backoff",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  let now=100_000;t.mock.method(Date,"now",()=>now);
  const previous=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"window",{configurable:true,value:{location:{href:"https://example.test"}}});
  const sockets:FakeSocket[]=[],events=new RecoveryEvents();
  const client=connectWebSocketAppHost(()=>{const s=new FakeSocket();sockets.push(s);return s as unknown as WebSocket;},
    {recoveryEvents:events,retryDelaysMs:[60_000],reportFailure:()=>{}});
  try{
    const transport=client.createTransport("host");void transport.connect().catch(()=>{});await flush();
    sockets[0]!.fail();await flush();void transport.connect().catch(()=>{});await flush();
    assert.equal(sockets.length,1);events.fire(true,"online");await flush();assert.equal(sockets.length,2);
    sockets[1]!.fail();await flush();void transport.connect().catch(()=>{});await flush();
    for(let i=0;i<10;i++)events.fire(true,"online");await flush();
    assert.equal(sockets.length,2,"a burst of events cannot bypass the next backoff");
  }finally{client.close();if(previous)Object.defineProperty(globalThis,"window",previous);else Reflect.deleteProperty(globalThis,"window");}
});


async function resumableFakeFixture(t: import("node:test").TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/" } } });
  const socket = new FakeSocket(); let sockets = 0;
  const client = connectWebSocketAppHost(() => { sockets++; return (sockets === 1 ? socket : new FakeSocket()) as unknown as WebSocket; },
    { recoveryEvents: new RecoveryEvents(), retryDelaysMs: [0], reportFailure() {} });
  t.after(() => { client.close(); if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  const transport = client.createTransport("host"), connecting = transport.connect();
  await flush(); socket.open();
  socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: {
    resume: { v: 1, sessionId: "a".repeat(32), token: "A".repeat(43), detachMs: 300000 } } });
  await flush();
  const request = socket.sent.map(f => JSON.parse(f)).find(f => f.type === "host/connect");
  socket.receive({ type: "response", requestId: request.requestId, ok: true, result: { hostId: "host", generation: 1 }, seq: 1 });
  await connecting;
  return { socket, transport, sockets: () => sockets };
}

test("already-aborted progress send never reserves a resume sequence", async t => {
  const f = await resumableFakeFixture(t), controller = new AbortController(); controller.abort();
  const before = f.socket.sent.length;
  await assert.rejects(f.transport.send("cancelled", controller.signal, { onProgress() {} }));
  assert.equal(f.socket.sent.length, before);
  const sending = f.transport.send("next", undefined, { onProgress() {} }); await flush();
  const request = f.socket.sent.map(f => JSON.parse(f)).findLast(f => f.type === "host/send");
  assert.equal(request.seq, 2, "cancelled send did not leave a sequence gap");
  f.socket.receive({ type: "response", requestId: request.requestId, ok: true, result: null, seq: 2 });
  await sending;
});

for (const observed of [false, true]) test(`throwing local send cannot retain a replayable non-dispatch (progress=${observed})`, async t => {
  const f = await resumableFakeFixture(t);
  f.socket.send = () => { throw new Error("native send refused"); };
  await assert.rejects(f.transport.send("must-not-replay", undefined, observed ? { onProgress() {} } : undefined));
  assert.equal(f.transport.status.state, "failed");
  f.socket.fail(); await flush();
  assert.equal(f.sockets(), 1, "a non-dispatched write cannot start transparent replay");
});

for (const frame of [
  { type: "host/frame", hostId: "host", generation: 1, frame: "unnumbered" },
  { type: "host/frame", hostId: "host", generation: 1, frame: "gap", seq: 3 },
  { type: "ready", protocolVersion: 2, services: ["appserver"] },
  { type: "connection/ack", received: 999 },
]) test(`negotiated client retires invalid resume data: ${JSON.stringify(frame)}`, async t => {
  const f = await resumableFakeFixture(t), frames: string[] = [];
  f.transport.subscribeMessage(frame => frames.push(frame)); f.socket.receive(frame); await flush();
  assert.equal(f.transport.status.state, "failed"); assert.deepEqual(frames, []);
});


test("resume handshakes share a strict thirty-second total deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = await resumableFakeFixture(t); f.socket.fail(); await flush();
  assert.equal(f.sockets(), 2);
  for (const step of [10000, 500, 10000, 1000, 8499]) { t.mock.timers.tick(step); await flush(); }
  assert.equal(Date.now(), 29999); assert.equal(f.transport.status.state, "open");
  t.mock.timers.tick(1); await flush();
  assert.equal(f.transport.status.state, "failed", "last handshake cannot extend the total resume deadline");
  const attempts = f.sockets(); t.mock.timers.tick(60000); await flush();
  assert.equal(f.sockets(), attempts, "retired resume timers cannot allocate another carrier");
});
