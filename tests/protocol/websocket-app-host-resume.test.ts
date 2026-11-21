import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { createConversationKey } from "@opencraft/chat-core";
import { createConversationOutbox, SubmissionNotDispatchedError, type ConversationOutboxEntry } from "@opencraft/chat-runtime";
import { APP_HOST_PROTOCOL_VERSION } from "@opencraft/app-host-protocol/version";
import { createWorkbenchWebServer } from "../../apps/headless-server/src/serve-workbench-web.mjs";
import { connectWebSocketAppHost, type AppHostRecoveryEvents } from "../../apps/workbench-web/src/runtime/websocket-app-host";

class Events implements AppHostRecoveryEvents {
  listeners = new Set<(reason?: string) => void>();
  isVisible = () => true;
  subscribe(listener: (reason?: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
const until = async (predicate: () => boolean, label = "condition") => {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(predicate(), label);
};

interface FakeConnection { closed: boolean; received: Array<Record<string, unknown>>; port: { postMessage(message: unknown): void } }

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(join(tmpdir(), "apphost-resume-client-"));
  const connections: FakeConnection[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const appHostServer = {
    accept(port: { postMessage(message: unknown): void; subscribe(listener: (message: Record<string, unknown>) => void): () => void }) {
      const connection: FakeConnection = { closed: false, received: [], port };
      port.subscribe(message => {
        connection.received.push(message);
        if (message.type === "host/connect") port.postMessage({ type: "response", requestId: message.requestId, ok: true, result: { hostId: message.hostId, generation: 1 } });
        if (message.type === "host/send") port.postMessage({ type: "response", requestId: message.requestId, ok: true, result: null });
      });
      connections.push(connection);
      port.postMessage({ type: "ready", protocolVersion: APP_HOST_PROTOCOL_VERSION, services: ["appserver"], capabilities: { connectionProbe: true } });
      return { close() { connection.closed = true; } };
    },
  };
  const server = await createWorkbenchWebServer({ root, appServerTarget: null, loopbackOnly: false,
    webSocketHeartbeatIntervalMs: 0, onAppHostDiagnostic: (event: Record<string, unknown>) => logs.push(event), appHostServer });
  const address = await server.listen({ host: "127.0.0.1", port: 0 }) as { port: number };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: `http://127.0.0.1:${address.port}/` } } });
  const sockets: WebSocket[] = [];
  const gate = { blocked: false, dropResumeReply: false };
  const failures: string[] = [];
  const client = connectWebSocketAppHost(url => { if (gate.blocked) throw new Error("offline"); const socket = new WebSocket(url);
    const emit = socket.emit.bind(socket);
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === 'message' && gate.dropResumeReply && JSON.parse(String(args[0])).type === 'connection/resumed') {
        gate.dropResumeReply = false;
        queueMicrotask(() => socket.emit('error', new Error('lost resume reply')));
        return true;
      }
      return emit(event, ...args);
    }) as typeof socket.emit;
    sockets.push(socket); return socket as unknown as globalThis.WebSocket; },
    { recoveryEvents: new Events(), retryDelaysMs: [0], reportFailure: diagnostic => failures.push(diagnostic.failure) });
  t.after(async () => {
    client.close();
    await server.close();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    await rm(root, { recursive: true, force: true });
  });
  const transport = client.createTransport("h");
  const frames: number[] = [];
  transport.subscribeMessage(frame => frames.push(JSON.parse(frame).params.i));
  await transport.connect();
  const stream = (connection: FakeConnection, from: number, to: number) => {
    for (let i = from; i <= to; i++) connection.port.postMessage({ type: "host/frame", hostId: "h", generation: 1,
      frame: JSON.stringify({ method: "item/delta", params: { i } }) });
  };
  return { connections, logs, sockets, failures, transport, frames, stream, gate };
}

test("a dropped socket is resumed transparently: no fatal, no new lease, output continues in order", async t => {
  const f = await fixture(t);
  const connection = f.connections[0]!;
  f.stream(connection, 1, 3);
  await until(() => f.frames.length === 3, "first frames");
  // The route dies abnormally while the turn keeps streaming on the server.
  const statuses: string[] = [];
  f.transport.subscribeStatus(status => statuses.push(status.state));
  f.sockets[0]!.terminate();
  await until(() => f.logs.some(l => l.event === "resume-detached"), "server detached");
  f.stream(connection, 4, 6);
  // A request issued while the route is down is queued and replayed after resumption.
  const sent = f.transport.send('{"jsonrpc":"2.0","id":9,"method":"ping"}');
  await until(() => f.logs.some(l => l.event === "resume-accepted"), "server resumed");
  await sent;
  await until(() => f.frames.length === 6, "replayed frames");
  assert.deepEqual(f.frames, [1, 2, 3, 4, 5, 6], "each frame exactly once, in order");
  assert.equal(f.connections.length, 1, "no new App Host connection");
  assert.equal(connection.closed, false);
  assert.deepEqual(statuses.filter(s => s !== "open"), [], "consumers never saw the route fail");
  assert.deepEqual(f.failures, [], "no failure was reported");
  assert.equal(connection.received.filter(m => m.type === "host/connect").length, 1, "the lease was not renewed");
  assert.equal(connection.received.filter(m => m.type === "host/send").length, 1, "the queued request arrived once");
  // Later output still flows over the resumed socket.
  f.stream(connection, 7, 7);
  await until(() => f.frames.length === 7);
});

test("when the server cannot resume, the client falls back to the full reconnect", async t => {
  const f = await fixture(t);
  f.stream(f.connections[0]!, 1, 1);
  await until(() => f.frames.length === 1);
  const statuses: string[] = [];
  f.transport.subscribeStatus(status => statuses.push(status.state));
  // Keep the client offline, then overflow the detached session's window so its replay is gone.
  f.gate.blocked = true;
  f.sockets[0]!.terminate();
  await until(() => f.logs.some(l => l.event === "resume-detached"));
  f.connections[0]!.port.postMessage({ type: "host/frame", hostId: "h", generation: 1, frame: "x".repeat(2 * 1024 * 1024) });
  await until(() => f.connections[0]!.closed, "overflowed session ended");
  f.gate.blocked = false;
  await until(() => statuses.includes("failed"), "fallback surfaced");
  await f.transport.connect();
  assert.equal(f.connections.length, 2, "a fresh App Host connection");
  f.stream(f.connections[1]!, 2, 2);
  await until(() => f.frames.includes(2));
});

test('an open but unusable socket can be replaced without losing the session', async t => {
  const f = await fixture(t), connection = f.connections[0]!;
  f.stream(connection, 1, 1);
  await until(() => f.frames.length === 1);
  f.sockets[0]!.emit('error', new Error('route unavailable before close'));
  await until(() => f.logs.some(l => l.event === 'resume-accepted'));
  f.stream(connection, 2, 3);
  await until(() => f.frames.length === 3);
  assert.deepEqual(f.frames, [1,2,3]);
  assert.equal(f.connections.length, 1);
  assert.equal(connection.closed, false);
});
test('losing a resume reply allows a second resume on the same session', async t => {
  const f = await fixture(t), connection = f.connections[0]!;
  f.stream(connection, 1, 1);
  await until(() => f.frames.length === 1);
  f.gate.dropResumeReply = true;
  f.sockets[0]!.terminate();
  await until(() => f.logs.filter(l => l.event === 'resume-accepted').length === 2);
  f.stream(connection, 2, 3);
  await until(() => f.frames.length === 3);
  assert.deepEqual(f.frames, [1,2,3]);
  assert.equal(f.connections.length, 1);
  assert.equal(connection.closed, false);
  assert.deepEqual(f.failures, []);
});


test('progress-observed input during transparent resume drains without another timeline event or reload', async t => {
  const f = await fixture(t), key = createConversationKey('h', 'idle-thread');
  let rows: readonly ConversationOutboxEntry[] = [], attempts = 0, progress = 0;
  const box = createConversationOutbox({ key, ready: () => f.transport.status.state === 'open',
    blocked: () => false, publish() {}, retire() {},
    storage: { read: () => rows, write: (_key, value) => { rows = structuredClone(value); }, subscribe: () => () => {} },
    async send(intent) {
      attempts++;
      try { await f.transport.send(JSON.stringify({ id: 81, method: 'turn/start', params: { clientUserMessageId: intent.clientMessageId } }),
        undefined, { onProgress: () => { progress++; } }); }
      catch (cause) { throw new SubmissionNotDispatchedError(undefined, { cause }); }
      return { commandId: intent.commandId, clientMessageId: intent.clientMessageId, hostId: key.hostId,
        threadId: key.threadId, turnId: null, acceptedAt: 1, replayed: false };
    },
  });
  t.after(() => box.dispose());
  f.gate.blocked = true;
  f.sockets[0]!.terminate();
  await until(() => f.logs.some(l => l.event === 'resume-detached'));
  await box.admit({ commandId: 'resume-input', clientMessageId: 'resume-input-client', target: { type: 'existing-thread', key },
    document: { version: 1, blocks: [{ type: 'paragraph', children: [{ type: 'text', text: '上线' }] }] },
    attachments: [], context: [], selections: {}, options: { autoContext: false }, createdAt: 1 });
  await until(() => attempts > 0 && rows[0]?.state === 'waiting', 'known undispatched input returns to waiting');
  assert.equal(progress, 0, 'no bytes crossed the route during resumption');
  assert.equal(f.transport.status.state, 'open', 'transparent resumption does not change logical readiness');
  assert.equal(f.connections[0]!.received.filter(m => m.type === 'host/send').length, 0);
  f.gate.blocked = false;
  await until(() => f.logs.some(l => l.event === 'resume-accepted'), 'the same physical session resumed');
  await until(() => rows.length === 0, 'waiting input must drain without refresh, status change or timeline data');
  assert.deepEqual(f.frames, [], 'no incoming business event was needed to wake custody');
  assert.equal(f.connections.length, 1, 'no logical reconnect or new lease');
  assert.equal(f.connections[0]!.received.filter(m => m.type === 'host/send').length, 1, 'exactly one wire admission');
  assert.equal(box.project().length, 0);
});
