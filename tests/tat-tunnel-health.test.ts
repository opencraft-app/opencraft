import assert from "node:assert/strict";
import test from "node:test";
import { deserialize, serialize } from "bson";
import { TencentTatSessionMultiplexer } from "../plugins/lightvela-hermes/src/lib/tencent-tat-session-multiplexer";

class Socket {
  readyState = WebSocket.CONNECTING;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: Uint8Array }) => void) | null = null;
  onclose = null;
  onerror = null;
  sent: Record<string, any>[] = [];
  constructor() { queueMicrotask(() => { this.readyState = WebSocket.OPEN; this.onopen?.(); }); }
  send(data: string | Uint8Array) { this.sent.push(typeof data === "string" ? JSON.parse(data) : deserialize(data)); }
  close() { this.readyState = WebSocket.CLOSED; }
  receive(type: string, proxyId: string) {
    this.onmessage?.({ data: serialize({ Type: type, Data: { ChannelId: proxyId, Data: { ProxyId: proxyId } } }) });
  }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(options: { idleKeepaliveIntervalMs?: number } = {}) {
  let socket!: Socket;
  let failures = 0;
  const mux = new TencentTatSessionMultiplexer({
    poolId: "test", sessionId: "test", region: "test", instanceId: "test", ownerUin: "test",
    loginUin: "test", appId: 1, wsUrl: "wss://example.invalid", cols: 80, rows: 24,
    timeoutSeconds: 60, username: "test", workingDirectory: "/",
  }, {
    connectDelayMs: 0, requestTimeoutMs: 30,
    ...(options.idleKeepaliveIntervalMs === undefined ? {} : {
      idleKeepaliveIntervalMs: options.idleKeepaliveIntervalMs,
      idleKeepaliveTarget: { ip: "127.0.0.1", port: 9119 },
    }),
    WebSocketImpl: class extends Socket { constructor() { super(); socket = this; } } as unknown as typeof WebSocket,
    onUnhealthy: () => { failures++; },
  });
  await mux.connect();
  return { mux, get socket() { return socket; }, failures: () => failures };
}

test("an idle physical tunnel owns one keepalive probe and closes its temporary channel", async () => {
  const f = await fixture({ idleKeepaliveIntervalMs: 10 });
  await pause(15);
  const requests = f.socket.sent.filter(frame => frame.Type === "PtyProxyNew");
  assert.equal(requests.length, 1);
  const id = requests[0]!.Data.Data.ProxyId;
  f.socket.receive("PtyProxyReady", id);
  await pause(2);
  assert.equal(f.failures(), 0);
  assert(f.socket.sent.some(frame => frame.Type === "PtyProxyClose" && frame.Data.Data.ProxyId === id));
  f.mux.close();
});

test("real tunnel traffic postpones the idle keepalive lease probe", async () => {
  const f = await fixture({ idleKeepaliveIntervalMs: 20 });
  await pause(12);
  f.socket.receive("PtyProxyData", "unknown-but-live-channel");
  await pause(12);
  assert.equal(f.socket.sent.filter(frame => frame.Type === "PtyProxyNew").length, 0);
  await pause(12);
  assert.equal(f.socket.sent.filter(frame => frame.Type === "PtyProxyNew").length, 1);
  f.mux.close();
});

test("an unanswered idle keepalive retires the dead physical tunnel", async () => {
  const f = await fixture({ idleKeepaliveIntervalMs: 5 });
  await pause(45);
  assert.equal(f.failures(), 1);
  assert.equal(f.socket.readyState, WebSocket.CLOSED);
  await assert.rejects(f.mux.connect(), /retired/);
});

test("simultaneous timeouts have one confirmation probe and one tunnel failure", async () => {
  const f = await fixture();
  await Promise.all([1, 2].map(() => assert.rejects(f.mux.openProxy({ port: 9119 }), /timed out/)));
  await pause(50);
  assert.equal(f.socket.sent.filter(frame => frame.Type === "PtyProxyNew").length, 3);
  assert.equal(f.failures(), 1);
  assert.equal(f.socket.readyState, WebSocket.CLOSED);
  await assert.rejects(f.mux.connect(), /retired/);
});

test("probe success keeps the tunnel and closes the temporary channel", async () => {
  const f = await fixture();
  await assert.rejects(f.mux.openProxy({ port: 9119 }), /timed out/);
  await pause(1);
  const requests = f.socket.sent.filter(frame => frame.Type === "PtyProxyNew");
  const id = requests[1]!.Data.Data.ProxyId;
  f.socket.receive("PtyProxyReady", id);
  await pause(40);
  assert.equal(f.failures(), 0);
  assert(f.socket.sent.some(frame => frame.Type === "PtyProxyClose" && frame.Data.Data.ProxyId === id));
  f.mux.close();
});

test("other inbound progress prevents classifying target failure as tunnel death", async () => {
  const f = await fixture();
  await assert.rejects(f.mux.openProxy({ port: 9119 }), /timed out/);
  f.socket.receive("PtyProxyData", "another-channel");
  await pause(45);
  assert.equal(f.failures(), 0);
  f.mux.close();
});

test("explicit close cancels confirmation and settles pending requests", async () => {
  const f = await fixture();
  await assert.rejects(f.mux.openProxy({ port: 9119 }), /timed out/);
  f.mux.close();
  await pause(45);
  assert.equal(f.failures(), 0);
});

test("late Ready is closed without reviving a timed-out channel", async () => {
  const f = await fixture();
  await assert.rejects(f.mux.openProxy({ port: 9119 }), /timed out/);
  const id = f.socket.sent.find(frame => frame.Type === "PtyProxyNew")!.Data.Data.ProxyId;
  const before = f.socket.sent.filter(frame => frame.Type === "PtyProxyClose").length;
  f.socket.receive("PtyProxyReady", id);
  await pause(1);
  assert.equal(f.socket.sent.filter(frame => frame.Type === "PtyProxyClose").length, before + 1);
  f.mux.close();
});
