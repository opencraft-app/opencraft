import assert from "node:assert/strict";
import test from "node:test";

import { connectWebSocketAppHost } from "../apps/workbench-web/src/runtime/websocket-app-host";

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
  private emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test("browser AppHost transport keeps its listeners and renews its lease after WebSocket close", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://example.test/chat" } } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class WrappedWebSocket {} });
  const socket = new FakeSocket();
  const replacementSocket = new FakeSocket();
  const sockets = [socket, replacementSocket];
  const urls: string[] = [];
  const client = connectWebSocketAppHost((url) => {
    urls.push(url);
    return sockets.shift() as unknown as WebSocket;
  });
  try {
    const transport = client.createTransport("local-codex");
    const connection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(urls, ["wss://example.test/apphost"]);
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
    const reconnection = transport.connect();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(urls, ["wss://example.test/apphost", "wss://example.test/apphost"]);
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
