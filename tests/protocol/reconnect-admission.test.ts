import assert from "node:assert/strict";
import test from "node:test";
import { connectWebSocketAppHost } from "../../apps/workbench-web/src/runtime/websocket-app-host";
import { SshConnectionsController } from "../../plugins/builtin-agents/src/ssh-connections/controller";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
class Socket {
  readyState = 0; sent: any[] = []; listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void) { const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set); }
  removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, event: any = {}) { for (const f of this.listeners.get(type) ?? []) f(event); }
  send(raw: string) { const m = JSON.parse(raw); this.sent.push(m); if (m.type === "connection/probe") this.receive({ type: "response", requestId: m.requestId, ok: true, result: null }); }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close", { code: 1000 }); }
  receive(message: unknown) { this.emit("message", { data: JSON.stringify(message) }); }
}
test("missing release ACK closes the ambiguous bridge within five seconds before reacquisition", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "https://synthetic.test" } } });
  const first = new Socket(), next = new Socket(), sockets = [first, next];
  const factory = connectWebSocketAppHost(() => sockets.shift() as unknown as WebSocket, { reportFailure() {}, recoveryEvents: { isVisible: () => true, subscribe: () => () => {} } });
  const connectRequest = (socket: Socket) => socket.sent.findLast(m => m.type === "host/connect");
  const ready = async (socket: Socket, generation: number) => { await flush(); socket.open(); socket.receive({ type: "ready", protocolVersion: 2, services: ["appserver"], capabilities: { connectionProbe: true } }); await flush(); socket.receive({ type: "response", requestId: connectRequest(socket).requestId, ok: true, result: { hostId: "a", generation } }); };
  try {
    const transport = factory.createTransport("a"); const initial = transport.connect(); await ready(first, 1); await initial;
    first.receive({ type: "host/status", hostId: "a", generation: 1, status: { state: "failed", reason: "synthetic loss" } });
    const reconnect = transport.connect(); await flush(); assert.equal(first.sent.filter(m => m.type === "host/disconnect").length, 1);
    t.mock.timers.tick(4999); await flush(); assert.equal(sockets.length, 1); assert.equal(first.readyState, 1);
    t.mock.timers.tick(1); await flush(); await flush(); assert.equal(first.readyState, 3, "ambiguous claims must be revoked by bridge close");
    await ready(next, 2); await reconnect; assert.equal(sockets.length, 0);
    assert.equal(first.sent.filter(m => m.type === "host/connect").length, 1, "the retired bridge cannot acquire a successor claim");
  } finally { factory.close(); if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow); else Reflect.deleteProperty(globalThis, "window"); }
});
test("SSH admission joins authentication without waiting for held discovery catalogs", async () => {
  let release!: () => void; const catalogs = new Promise<void>(resolve => { release = resolve; });
  let sessionReads = 0, catalogReads = 0;
  const controller = new SshConnectionsController(async path => {
    if (String(path).endsWith("/session")) { sessionReads++; return Response.json({ available: true, authenticated: true, accessMode: "shared" }); }
    catalogReads++; await catalogs; return Response.json([]);
  });
  try {
    const discovery = controller.refresh(); await flush(); assert.equal(catalogReads, 2);
    await controller.prepareConnection(); assert.ok(sessionReads >= 1); assert.equal(controller.getSnapshot().authenticated, true);
    release(); await discovery;
  } finally { release(); controller.dispose(); }
});
