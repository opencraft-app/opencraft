import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { openServerDatabase } from "@opencraft/storage-node/server";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { ConversationHistory } from "../../packages/app-host-server/src/conversation-history.js";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport.js";

const metadata = (id = "thread") => ({ id, cwd: "/synthetic", createdAt: 1, updatedAt: 2, turns: [] });
async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "history-fairness-"));
  const storage = await openServerDatabase(directory);
  t.after(async () => { await storage.close(); rmSync(directory, { recursive: true, force: true }); });
  const history = new ConversationHistory(storage.database, "local-codex");
  history.metadata(metadata());
  return { directory, storage, history };
}

test("unchanged directory captures do not fingerprint every thread again", async t => {
  const { history } = await fixture(t);
  for (let i = 0; i < 20; i++) history.metadata(metadata(`thread-${i}`));
  const fingerprints = t.mock.method(history as any, "directoryRecordFence");
  const first = history.directoryFence();
  for (let i = 0; i < 30; i++) assert.deepEqual(history.directoryFence(), first);
  assert.equal(fingerprints.mock.callCount(), 21, "one complete capture for unchanged database state");
});

test("repeated unarchived observations preserve the reusable directory snapshot", async t => {
  const { history } = await fixture(t);
  history.observe("thread/unarchived", { threadId: "thread" });
  const first = history.directoryFence();
  const fingerprints = t.mock.method(history as any, "directoryRecordFence");
  for (let i = 0; i < 10; i++) {
    history.observe("thread/unarchived", { threadId: "thread" });
    assert.deepEqual(history.directoryFence(), first);
  }
  assert.equal(fingerprints.mock.callCount(), 0, "idempotent directory observations do not force full captures");
});

test("same-connection schema replacement invalidates a reusable directory snapshot",async t=>{
  const {history,storage}=await fixture(t);
  assert.equal(history.directoryFence().size,1);
  storage.database.exec("ALTER TABLE conversation_threads RENAME TO previous_threads; CREATE TABLE conversation_threads AS SELECT * FROM previous_threads WHERE 0");
  assert.equal(history.directoryFence().size,0);
});

test("local metadata changes invalidate future captures and preserve an outstanding native fence", async t => {
  const { history } = await fixture(t);
  const before = history.directoryFence();
  history.metadata({ ...metadata(), name: "newer local name" });
  const after = history.directoryFence();
  assert.notEqual(after.get("thread"), before.get("thread"));
  history.importResult("thread/list", {}, { data: [{ ...metadata(), name: "old native name" }, metadata("unrelated")], nextCursor: null }, history.catalogRevision(), before);
  assert.equal(history.thread("thread")?.name, "newer local name");
  assert.ok(history.thread("unrelated"));
  assert.equal(before.size, 1, "a retained source checkpoint remains immutable");
});

test("another repository on the same SQLite connection cannot leave a stale directory capture", async t => {
  const { history, storage } = await fixture(t);
  const before = history.directoryFence();
  storage.database.prepare("UPDATE conversation_threads SET archived=1 WHERE scope=? AND id=?").run("local-codex", "thread");
  assert.notEqual(history.directoryFence().get("thread"), before.get("thread"));
});

test("an older writer on another SQLite connection invalidates directory captures", async t => {
  const { history, directory } = await fixture(t);
  const writer = new DatabaseSync(join(directory, "opencraft-server.sqlite"));
  t.after(() => writer.close());
  const before = history.directoryFence();
  writer.prepare("UPDATE conversation_threads SET metadata=? WHERE scope=? AND id=?").run(JSON.stringify({ ...metadata(), name: "external writer" }), "local-codex", "thread");
  assert.notEqual(history.directoryFence().get("thread"), before.get("thread"));
  history.importResult("thread/list", {}, { data: [{ ...metadata(), name: "stale source" }], nextCursor: null }, history.catalogRevision(), before);
  assert.equal(history.thread("thread")?.name, "external writer");
});

test("a rolled-back transaction never publishes a reusable dirty directory snapshot", async t => {
  const { history, storage } = await fixture(t);
  const before = history.directoryFence();
  storage.database.exec("BEGIN");
  storage.database.prepare("UPDATE conversation_threads SET archived=1 WHERE scope=? AND id=?").run("local-codex", "thread");
  const dirty = history.directoryFence();
  assert.notEqual(dirty.get("thread"), before.get("thread"));
  storage.database.exec("ROLLBACK");
  assert.deepEqual(history.directoryFence(), before);
});

test("archive, delete and scope changes retain independent immutable directory fences", async t => {
  const { history, storage } = await fixture(t);
  const peer = new ConversationHistory(storage.database, "opencraft-server");
  peer.metadata({ ...metadata(), name: "other scope" });
  const original = history.directoryFence(), other = peer.directoryFence();
  history.observe("thread/archived", { threadId: "thread" });
  const archived = history.directoryFence();
  history.observe("thread/deleted", { threadId: "thread" });
  assert.notEqual(archived.get("thread"), original.get("thread"));
  assert.notEqual(history.directoryFence().get("thread"), archived.get("thread"));
  assert.deepEqual(peer.directoryFence(), other);
});

class Engine implements DuplexTransport {
  status: TransportStatus = { state: "open" };
  messages = new Set<(frame: string) => void>();
  async connect() {}
  async send() {}
  async close() { this.status = { state: "closed" }; }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus() { return () => {}; }
  emit(packet: unknown) { for (const listener of this.messages) listener(JSON.stringify(packet)); }
}

test("a busy persistence tail lets network timers run while close drains every accepted event in order", async t => {
  const { history } = await fixture(t);
  history.importResult("thread/read", { threadId: "thread", includeTurns: true }, { thread: { ...metadata(), turns: [{ id: "turn", status: "inProgress", itemsView: "full", items: [] }] } }, history.revision("thread"));
  const engine = new Engine(), transport = new ConversationHistoryTransport(engine, history);
  t.after(() => transport.close());
  await transport.connect();
  const observed: number[] = [], live: number[] = [];
  const observe = history.observe.bind(history);
  t.mock.method(history, "observe", (method: string, params: Record<string, any>) => {
    const start = performance.now(); while (performance.now() - start < 2) { /* synthetic synchronous storage work */ }
    observed.push(Number(params.item.text));
    return observe(method, params);
  });
  transport.subscribeMessage(frame => { const packet = JSON.parse(frame); if (packet.method === "item/completed") live.push(Number(packet.params.item.text)); });
  let workAtTimer = -1;
  const networkTimer = new Promise<void>(resolve => setTimeout(() => { workAtTimer = observed.length; resolve(); }, 0));
  for (let i = 0; i < 40; i++) engine.emit({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { id: "answer", type: "agentMessage", text: String(i) } } });
  assert.equal(live.length, 40, "live delivery remains synchronous and ahead of SQLite");
  assert.equal(observed.length, 0);
  await Promise.all([transport.close(), networkTimer]);
  assert.ok(workAtTimer < 40, `timer waited for all ${workAtTimer} synchronous writes`);
  assert.deepEqual(observed, Array.from({ length: 40 }, (_, i) => i));
  const page = history.read("thread/turns/list", { threadId: "thread", itemsView: "full" });
  assert.equal(page.data[0].items[0].text, "39");
});

test("a real WebSocket handshake advances before the busy persistence tail finishes", async t => {
  const { history } = await fixture(t);
  const engine = new Engine(), transport = new ConversationHistoryTransport(engine, history);
  const server = createServer(), sockets = new WebSocketServer({ server });
  let completed = 0, workAtHandshake = -1;
  sockets.on("connection", () => { workAtHandshake = completed; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  t.after(async () => {
    socket.terminate(); for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await transport.close();
  });
  const connected = new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const observe = history.observe.bind(history);
  t.mock.method(history, "observe", (method: string, params: Record<string, any>) => {
    const start = performance.now(); while (performance.now() - start < 2) {}
    observe(method, params); completed++;
  });
  for (let i = 0; i < 40; i++) engine.emit({ method: "thread/name/updated", params: { threadId: "thread", name: String(i) } });
  await Promise.all([transport.close(), connected]);
  assert.ok(workAtHandshake >= 0 && workAtHandshake < 40, `handshake waited for ${workAtHandshake} synchronous writes`);
  assert.equal(completed, 40);
  assert.equal(history.thread("thread")?.name, "39");
});

test("accepted live observations still drain after their source scope retires", async t => {
  const { history } = await fixture(t);
  const engine = new Engine(), transport = new ConversationHistoryTransport(engine, history);
  t.after(() => transport.close());
  engine.emit({ method: "thread/name/updated", params: { threadId: "thread", name: "accepted before close" } });
  engine.status = { state: "closed" };
  await transport.close();
  assert.equal(history.thread("thread")?.name, "accepted before close");
});
