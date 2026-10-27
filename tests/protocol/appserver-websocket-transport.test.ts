import assert from "node:assert/strict";
import test from "node:test";

import {
  type AppServerWebSocket,
  WebSocketTransport,
} from "@opencraft/appserver-transport-websocket";
import { encodeUtf8 } from "@opencraft/appserver-client/utf8";

type SocketEventName = "open" | "message" | "error" | "close";

class FakeSocket implements AppServerWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  terminated = false;
  autoClose = true;
  throwOnClose = false;

  private readonly listeners = new Map<SocketEventName, Set<(event: never) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.throwOnClose) throw new Error("synthetic close failure");
    this.readyState = 2;
    if (this.autoClose) this.emitClose(1000, "");
  }

  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }

  addEventListener(type: SocketEventName, listener: (event: never) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventName, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emitOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  emitMessage(data: unknown): void {
    this.emit("message", { data });
  }

  emitError(): void {
    this.emit("error", {});
  }

  emitClose(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  private emit(type: SocketEventName, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
}

function transportFixture(closeTimeoutMs = 20) {
  const sockets: FakeSocket[] = [];
  const transport = new WebSocketTransport({
    url: "ws://test.invalid/rpc",
    closeTimeoutMs,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { transport, sockets };
}

async function connectCurrent(fixture: ReturnType<typeof transportFixture>): Promise<FakeSocket> {
  const connected = fixture.transport.connect();
  const socket = fixture.sockets.at(-1);
  assert.ok(socket);
  socket.emitOpen();
  await connected;
  return socket;
}

test("WebSocket transport sends only while its socket is open", async () => {
  const fixture = transportFixture();
  await assert.rejects(fixture.transport.send("before"), /not open/);
  const socket = await connectCurrent(fixture);
  await fixture.transport.send("hello");
  assert.deepEqual(socket.sent, ["hello"]);
  await fixture.transport.close();
  await assert.rejects(fixture.transport.send("after"), /not open/);
});

test("WebSocket transport never submits a frame whose signal is already aborted", async () => {
  const fixture = transportFixture(); const socket = await connectCurrent(fixture);
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(fixture.transport.send("cancelled", controller.signal), { name: "AbortError" });
    assert.deepEqual(socket.sent, []);
    await fixture.transport.send("current"); assert.deepEqual(socket.sent, ["current"]);
  } finally { await fixture.transport.close(); }
});

test("WebSocket transport decodes every binary frame as UTF-8 in order", async () => {
  const fixture = transportFixture();
  const messages: string[] = [];
  fixture.transport.subscribeMessage((frame) => messages.push(frame));
  const socket = await connectCurrent(fixture);
  socket.emitMessage("one");
  socket.emitMessage(encodeUtf8("你好").buffer);
  socket.emitMessage(encodeUtf8("世界"));
  socket.emitMessage(new Blob([encodeUtf8("👋")]));
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.deepEqual(messages, ["one", "你好", "世界", "👋"]);
  await fixture.transport.close();
});

test("events from an old socket cannot poison a reconnected generation", async () => {
  const fixture = transportFixture();
  const messages: string[] = [];
  fixture.transport.subscribeMessage((frame) => messages.push(frame));
  const oldSocket = await connectCurrent(fixture);
  await fixture.transport.close();
  const currentSocket = await connectCurrent(fixture);

  oldSocket.emitMessage("stale");
  oldSocket.emitError();
  oldSocket.emitClose(1006, "late old close");
  currentSocket.emitMessage("current");
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

  assert.equal(fixture.transport.status.state, "open");
  assert.deepEqual(messages, ["current"]);
  await fixture.transport.close();
});

test("an already-aborted connect does not allocate a socket", async () => {
  const fixture = transportFixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture.transport.connect(controller.signal), { name: "AbortError" });
  assert.equal(fixture.sockets.length, 0);
});

test("abort during connecting notification revokes the attempt before allocating a socket", async () => {
  const fixture = transportFixture(); const controller = new AbortController();
  fixture.transport.subscribeStatus(status => { if (status.state === "connecting") controller.abort(); });
  const connecting = fixture.transport.connect(controller.signal);
  if (fixture.sockets[0]) fixture.sockets[0].emitOpen();
  try {
    await assert.rejects(connecting, { name: "AbortError" });
    assert.equal(fixture.sockets.length, 0);
    assert.notEqual(fixture.transport.status.state, "open");
  } finally { await fixture.transport.close(); }
});

test("close during connecting notification cannot be followed by a revived attempt", async () => {
  const fixture = transportFixture(); let closing: Promise<void> | undefined;
  fixture.transport.subscribeStatus(status => { if (status.state === "connecting") closing = fixture.transport.close(); });
  const connecting = fixture.transport.connect();
  if (fixture.sockets[0]) fixture.sockets[0].emitOpen();
  try {
    await closing; await assert.rejects(connecting, /closed before opening/);
    assert.equal(fixture.sockets.length, 0); assert.equal(fixture.transport.status.state, "closed");
  } finally { await fixture.transport.close(); }
});

test("old close finalization cannot erase a retry started by a status observer", async () => {
  const fixture = transportFixture(); let retry: Promise<void> | undefined;
  const original = fixture.transport.connect();
  const rejected = assert.rejects(original, /old attempt/);
  let once = false;
  fixture.transport.subscribeStatus(status => {
    if (status.state === "closed" && !once) { once = true; retry = fixture.transport.connect(); }
  });
  fixture.sockets[0]!.emitClose(1006, "old attempt"); await rejected;
  assert.equal(fixture.sockets.length, 2);
  assert.equal(fixture.transport.connect(), retry, "the retry retains its coalescing slot");
  fixture.sockets[1]!.emitOpen(); await retry;
  await fixture.transport.close();
});

test("a socket factory failure transitions the transport out of connecting", async () => {
  const transport = new WebSocketTransport({
    url: "not-a-websocket-url",
    createSocket: () => {
      throw new TypeError("invalid websocket URL");
    },
  });
  await assert.rejects(transport.connect(), /invalid websocket URL/);
  assert.deepEqual(transport.status, { state: "failed", reason: "invalid websocket URL" });
});

test("aborting an in-progress connect closes its socket and rejects", async () => {
  const fixture = transportFixture();
  const controller = new AbortController();
  const connected = fixture.transport.connect(controller.signal);
  const socket = fixture.sockets[0];
  assert.ok(socket);
  controller.abort();
  await assert.rejects(connected, { name: "AbortError" });
  assert.equal(socket.readyState, 3);
});

test("close is bounded and terminates a peer that omits its close frame", async () => {
  const fixture = transportFixture(5);
  const socket = await connectCurrent(fixture);
  socket.autoClose = false;
  await fixture.transport.close();
  assert.equal(socket.terminated, true);
  assert.equal(fixture.transport.status.state, "closed");
});

test("close recovers when the platform socket throws synchronously", async () => {
  const fixture = transportFixture();
  const socket = await connectCurrent(fixture);
  socket.throwOnClose = true;
  await fixture.transport.close();
  assert.equal(socket.terminated, true);
  assert.equal(fixture.transport.status.state, "closed");
});

test("a non-text current frame transitions the transport to failed", async () => {
  const fixture = transportFixture();
  const socket = await connectCurrent(fixture);
  socket.emitMessage({ unsupported: true });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(fixture.transport.status.state, "failed");
  await fixture.transport.close();
});


test("closing an unfinished connect rejects its wait even when the close event is omitted", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = transportFixture(1000);
  let settled = false;
  const connecting = fixture.transport.connect();
  const rejected = assert.rejects(connecting, /closed before opening/).then(() => { settled = true; });
  const old = fixture.sockets[0]!; old.autoClose = false;
  const closing = fixture.transport.close();
  context.mock.timers.tick(1000); await closing; await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, "close must settle the original caller as well as its own wait");
  await rejected;
  const current = await connectCurrent(fixture);
  old.emitOpen(); old.emitClose(1006, "late close");
  assert.equal(fixture.transport.status.state, "open");
  await fixture.transport.send("successor"); assert.deepEqual(current.sent, ["successor"]);
  await fixture.transport.close();
});

test("a previous close fallback cannot close an already-open successor", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = transportFixture(1000);
  const old = await connectCurrent(fixture); old.autoClose = false;
  const closing = fixture.transport.close();
  const current = await connectCurrent(fixture);
  context.mock.timers.tick(1000); await closing;
  assert.equal(fixture.transport.status.state, "open");
  await fixture.transport.send("still open"); assert.deepEqual(current.sent, ["still open"]);
  await fixture.transport.close();
});

test("a retired socket's pending Blob failure cannot poison its successor", async () => {
  const fixture = transportFixture();
  let rejectDecode!: (error: Error) => void;
  const decoding = new Promise<ArrayBuffer>((_resolve, reject) => { rejectDecode = reject; });
  class HeldBlob extends Blob { override arrayBuffer() { return decoding; } }
  const old = await connectCurrent(fixture);
  old.emitMessage(new HeldBlob()); await new Promise(resolve => setImmediate(resolve));
  await fixture.transport.close();
  const current = await connectCurrent(fixture);
  rejectDecode(new Error("retired Blob decode failed")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.transport.status.state, "open");
  await fixture.transport.send("current"); assert.deepEqual(current.sent, ["current"]);
  await fixture.transport.close();
});
