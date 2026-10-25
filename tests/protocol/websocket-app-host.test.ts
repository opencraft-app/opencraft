import assert from "node:assert/strict";
import test from "node:test";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";

import { connectWebSocketAppHost, type AppHostRecoveryEvents } from "../../apps/workbench-web/src/runtime/websocket-app-host";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: string; code?: number }) => void>>();

  addEventListener(type: string, listener: (event: { data?: string; code?: number }) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) { listeners = new Set(); this.listeners.set(type, listeners); }
    listeners.add(listener);
  }

  send(frame: string): void { this.sent.push(frame); }
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
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { recoveryEvents: events, reportFailure: () => undefined });
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
    const transport = client.createTransport("fixture-host");
    const connection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(new URL(urls[0]!).origin, "wss://example.test");
    assert.equal(new URL(urls[0]!).pathname, "/apphost");
    assert.ok(new URL(urls[0]!).searchParams.get("attempt"));
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
    reportFailure: diagnostic => diagnostics.push(diagnostic),
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
    reportFailure: diagnostic => diagnostics.push({ ...diagnostic }),
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
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { reportFailure: () => undefined });
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
    recoveryEvents: events, reportFailure: () => undefined,
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
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { reportFailure: () => undefined });
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
  }, { recoveryEvents: new RecoveryEvents(), reportFailure: report => reports.push(report) });
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
  }, { recoveryEvents: new RecoveryEvents(), reportFailure: () => undefined });
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
  const first = new FakeSocket(), successor = new FakeSocket(), sockets = [first, successor];
  const events = new RecoveryEvents(); let created = 0;
  const client = connectWebSocketAppHost(() => { created++; return sockets.shift() as unknown as WebSocket; }, { recoveryEvents: events, reportFailure: () => undefined });
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
        path: "/ssh-apphost", reportFailure: () => undefined,
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
    reportFailure: () => undefined, beforeConnect: () => gate,
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
    reportFailure: () => undefined, beforeConnect: async () => { if (++reads === 1) await gate; },
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
  const client = connectWebSocketAppHost(() => { sockets++; return socket as unknown as WebSocket; }, { reportFailure: () => undefined });
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
  const first = new FakeSocket(), successor = new FakeSocket(), sockets = [first, successor];
  const events = new RecoveryEvents(); let created = 0;
  const client = connectWebSocketAppHost(() => { created++; return sockets.shift() as unknown as WebSocket; }, { recoveryEvents: events, reportFailure: () => undefined });
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
    reportFailure: () => undefined, beforeConnect: () => ++reads === 1 ? gate : Promise.resolve(),
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
  const client = connectWebSocketAppHost(() => socket as unknown as WebSocket, { reportFailure: () => undefined });
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
    reportFailure: () => undefined, beforeConnect: async () => { reads++; },
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
