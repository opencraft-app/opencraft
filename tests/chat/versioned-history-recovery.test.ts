import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import { JsonRpcAppServerClient } from "@opencraft/appserver-client";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { createCordisThreadSessionRuntime } from "@opencraft/appserver-session";
import { createAppServerWorkbenchRuntime } from "@opencraft/workbench-runtime";
import { ConversationHistory } from "../../packages/app-host-server/src/conversation-history";
import { ConversationHistoryTransport } from "../../packages/app-host-server/src/conversation-history-transport";

type Value = Record<string, any>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await flush();
  assert.equal(check(), true);
}
const info = { codexHome: "/fixture", platformFamily: "unix", platformOs: "linux", userAgent: "versioned-history",
  capabilities: { extensions: { "opencraft/read-history": { version: 1, initialTurnsPage: true, boundedRecovery: true } } } };
const metadata = { id: "thread", sessionId: "thread", cwd: "/fixture", path: "/fixture/history", historyMode: "paginated", turns: [] };
const turn = (id: string, text = id, status = "completed") => ({ id, status, itemsView: "full", items: [
  { id: `item-${id}`, type: "agentMessage", text },
  { id: `tool-${id}`, type: "commandExecution", status: "completed", aggregatedOutput: "tool body ".repeat(2000) },
] });

class Engine implements DuplexTransport {
  status: TransportStatus = { state: "idle" };
  messages = new Set<(frame: string) => void>();
  statuses = new Set<(status: TransportStatus) => void>();
  requests: Value[] = [];
  async connect() { this.status = { state: "open" }; for (const listener of this.statuses) listener(this.status); }
  async send(frame: string) {
    const request = JSON.parse(frame); this.requests.push(request);
    if (request.id !== undefined && request.method === "initialize") this.emit({ id: request.id, result: info });
    // Native history intentionally remains unavailable. Stored history and its
    // committed stream must recover without an engine response or execution.
  }
  emit(value: Value) { for (const listener of this.messages) listener(JSON.stringify(value)); }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => { this.statuses.delete(listener); }; }
  async close() { this.status = { state: "closed" }; for (const listener of this.statuses) listener(this.status); }
}

class Wire implements DuplexTransport {
  requests: Value[] = [];
  onRequest?: (request: Value) => void;
  drop?: (packet: Value) => boolean;
  afterReply?: (packet: Value, request: Value | undefined) => void;
  holdRead = false;
  held: (() => void)[] = [];
  constructor(readonly inner: ConversationHistoryTransport) {}
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  send(frame: string, signal?: AbortSignal) {
    const request = JSON.parse(frame); this.requests.push(request); this.onRequest?.(request);
    return this.inner.send(frame, signal);
  }
  subscribeMessage(listener: (frame: string) => void) { return this.inner.subscribeMessage(frame => {
    const packet = JSON.parse(frame); if (this.drop?.(packet)) return;
    const request = this.requests.find(request => request.id === packet.id);
    const deliver = () => { listener(frame); this.afterReply?.(packet, request); };
    if (this.holdRead && packet.id !== undefined && request?.method === "thread/read") this.held.push(deliver);
    else deliver();
  }); }
  release() { this.holdRead = false; for (const deliver of this.held.splice(0)) deliver(); }
  subscribeStatus(listener: (status: TransportStatus) => void) { return this.inner.subscribeStatus(listener); }
  close() { return this.inner.close(); }
}

async function fixture(rows = [turn("live", "hello ", "inProgress")]) {
  const directory = mkdtempSync(join(tmpdir(), "versioned-history-"));
  const storage = await openServerDatabase(directory), history = new ConversationHistory(storage.database, "audit");
  history.importResult("initialize", {}, info, 0);
  history.importResult("thread/read", { threadId: "thread", includeTurns: true }, { thread: { ...metadata, turns: rows } }, 0);
  const engine = new Engine(), inner = new ConversationHistoryTransport(engine, history, undefined, 10_000), wire = new Wire(inner);
  return { history, storage, engine, wire,
    async close() { wire.release(); await inner.close(); await storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("the real persisted declaration arms an initial local deadline without checkpoint recovery", async () => {
  const f = await fixture(); let now = 0, sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const client = new JsonRpcAppServerClient({ hostId: "audit", transport: f.wire });
  await client.connect({ clientInfo: { name: "audit", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client, requestTimeoutMs: 1000, readClock: {
    now: () => now, setTimeout(run, delay) { timers.set(++sequence, { at: now + delay, run }); return sequence; }, clearTimeout(id) { timers.delete(id as number); },
  } });
  try {
    const declaration = client.initializeResult!.capabilities!.extensions!["opencraft/read-history"] as Value;
    assert.equal(declaration.boundedRecovery, undefined); assert.equal(declaration.versionedUpdates, true);
    let settled = false, failure: unknown;
    const result = session.resume.read("missing").catch(error => { settled = true; failure = error; });
    await until(() => f.engine.requests.some(request => request.method === "thread/read"));
    now = 1001; for (const [id, timer] of [...timers]) if (timer.at <= now && timers.delete(id)) timer.run();
    await until(() => settled); assert.equal((failure as { code?: string }).code, "TIMEOUT"); await result;
    assert.equal(timers.size, 0);
    assert.equal(f.engine.requests.some(request => ["thread/resume", "turn/start"].includes(request.method)), false);
  } finally { await session.dispose(); await client.close(); await f.close(); }
});

test("a versioned snapshot opens under ongoing output and preserves both sides of its synchronous receive cut", async () => {
  const f = await fixture();
  const runtime = createAppServerWorkbenchRuntime({ hostId: "audit", transport: f.wire, autoReconnect: false, requestTimeoutMs: 1000, onRecoveryEvent() {} });
  try {
    await runtime.connect(); const lease = await runtime.acquireThread("thread"); lease.setRecoveryVisibility(true);
    await until(() => lease.getSnapshot().authoritative && f.engine.status.state === "open");
    const before = f.wire.requests.filter(request => request.method === "thread/read").length;
    let injected = false;
    f.wire.onRequest = request => { if (request.method === "thread/read") {
      f.engine.emit({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "live", itemId: "item-live", delta: "world" } });
    } };
    f.wire.afterReply = (packet, request) => { if (!injected && packet.result && request?.method === "thread/read") {
      injected = true;
      // This frame is delivered before the request Promise can resume.
      f.engine.emit({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "live", itemId: "item-live", delta: "!" } });
    } };
    const retry = lease.retryRestore(); void retry.catch(() => undefined);
    await until(() => injected);
    assert.equal(f.wire.requests.filter(request => request.method === "thread/read").length - before, 1, "native activity must not trigger quiet rereads");
    await retry; await until(() => JSON.stringify(lease.getSnapshot().timeline).includes("hello world!"));
    assert.equal(lease.getSnapshot().authoritative, true);
    assert.equal(f.engine.requests.some(request => ["thread/resume", "turn/start"].includes(request.method)), false);
    lease.release();
  } finally { await runtime.dispose(); await f.close(); }
});

test("the request-owned receive boundary runs before same-batch notifications and Promise adoption", async () => {
  const order: string[] = [];
  const transport = new MemoryTransport({ receive(frame, peer) {
    const request = JSON.parse(frame); if (request.id === undefined) return;
    peer.send(JSON.stringify({id:request.id,result:request.method === "initialize" ? info:{data:[],nextCursor:null}}));
    if (request.method !== "initialize") peer.send(JSON.stringify({method:"audit/after-result",params:{}}));
  } });
  const client = new JsonRpcAppServerClient({hostId:"receive-cut",transport});
  try {
    await client.connect({clientInfo:{name:"audit",version:"1"}});
    client.subscribeNotification(() => order.push("notification"));
    await client.request("model/list",{}, {receiveResult(){ assert.equal(this,undefined); order.push("receive"); }});
    order.push("promise"); assert.deepEqual(order,["receive","notification","promise"]);
  } finally {await client.close();}
});

test("a rejected receive projection settles only its own request and releases its reservation", async () => {
  const transport = new MemoryTransport({receive(frame,peer){const request=JSON.parse(frame);if(request.id!==undefined)
    peer.send(JSON.stringify({id:request.id,result:request.method === "initialize" ? info:{data:[],nextCursor:null}}));}});
  const client = new JsonRpcAppServerClient({hostId:"receive-failure",transport,maxPendingRequests:1});
  try {
    await client.connect({clientInfo:{name:"audit",version:"1"}});
    let receives=0;
    await assert.rejects(client.request("model/list",{},{receiveResult(){receives++;throw new Error("rejected snapshot");}}),/rejected snapshot/);
    assert.equal(receives,1);assert.deepEqual(await client.request("model/list",{}),{data:[],nextCursor:null});
  } finally {await client.close();}
});

test("a missing committed range revokes authority and automatically repairs loaded older pages", async () => {
  const f = await fixture(Array.from({ length: 37 }, (_, i) => turn(`history-${i}`)));
  const runtime = createAppServerWorkbenchRuntime({ hostId: "audit", transport: f.wire, autoReconnect: false, requestTimeoutMs: 1000, onRecoveryEvent() {} });
  try {
    await runtime.connect(); const lease = await runtime.acquireThread("thread"); lease.setRecoveryVisibility(true); await until(() => lease.getSnapshot().authoritative);
    await lease.loadOlder(); const before = lease.getSnapshot(); assert.ok(before.history.cursor);
    let omitted: Value | undefined;
    f.wire.drop = packet => { if (!omitted && packet.method === "opencraft/history/changed") { omitted = packet; return true; } return false; };
    f.history.observe("item/completed", { threadId: "thread", turnId: "history-30", item: { id: "item-history-30", type: "agentMessage", text: "missed older answer" } });
    assert.ok(omitted); f.wire.holdRead = true;
    f.history.metadata({ ...f.history.thread("thread"), name: "new title" });
    assert.equal(lease.getSnapshot().authoritative, false, "a gap cannot keep the transcript authoritative");
    await until(() => f.wire.held.length > 0);
    assert.match(JSON.stringify(lease.getSnapshot().timeline), /history-26/);
    f.wire.release(); await until(() => lease.getSnapshot().authoritative);
    assert.match(JSON.stringify(lease.getSnapshot().timeline), /missed older answer/);
    assert.match(JSON.stringify(lease.getSnapshot().timeline), /history-26/);
    assert.equal(lease.getSnapshot().history.cursor, before.history.cursor);
    assert.equal(lease.getSnapshot().history.error, null);
    const count = f.wire.requests.length;
    // A delayed old patch cannot reopen the gap after the new durable cut.
    f.engine.emit(omitted!); for (let i = 0; i < 5; i++) await flush();
    assert.equal(lease.getSnapshot().authoritative, true); assert.equal(f.wire.requests.length, count);
    assert.equal(f.engine.requests.some(request => ["thread/resume", "turn/start"].includes(request.method)), false);
    lease.release();
  } finally { await runtime.dispose(); await f.close(); }
});

test("unchanged disclosed tool bodies survive a sparse recovery", async () => {
  const f = await fixture([turn("live", "final")]);
  const client = new JsonRpcAppServerClient({ hostId: "audit", transport: f.wire });
  await client.connect({ clientInfo: { name: "audit", version: "1" } });
  const session = await createCordisThreadSessionRuntime({ client });
  try {
    await session.resume.read("thread"); await session.resume.loadItemDetails("thread", ["tool-live"]);
    const tool = session.views.get("thread")!.turns[0]!.items!.find(item => item.id === "tool-live")!;
    assert.equal(tool.historyDetail, undefined); assert.equal(String(tool.aggregatedOutput).length, 20_000);
    f.history.metadata({ ...f.history.thread("thread"), name: "renamed" });
    await session.resume.read("thread");
    const restored = session.views.get("thread")!.turns[0]!.items!.find(item => item.id === "tool-live")!;
    assert.equal(restored.historyDetail, undefined); assert.equal(restored.aggregatedOutput, tool.aggregatedOutput);
  } finally { await session.dispose(); await client.close(); await f.close(); }
});

test("a canonical terminal snapshot supersedes native lifecycle frames received before its cut", async () => {
  const f = await fixture([turn("live", "canonical final")]); await f.engine.connect();
  const client = new JsonRpcAppServerClient({hostId:"audit",transport:f.wire});
  await client.connect({clientInfo:{name:"audit",version:"1"}});
  const session = await createCordisThreadSessionRuntime({client,requestTimeoutMs:1000});
  try {
    f.wire.onRequest = request => {if (request.method === "thread/read") {
      f.engine.emit({method:"turn/started",params:{threadId:"thread",turn:{id:"live",status:"inProgress",items:[]}}});
      f.engine.emit({method:"item/started",params:{threadId:"thread",turnId:"live",item:{id:"item-live",type:"agentMessage",text:"older partial"}}});
    }};
    const view = await session.resume.read("thread");
    assert.equal(view.turns[0]!.status,"completed");
    assert.equal(view.turns[0]!.items![0]!.text,"canonical final");
    assert.equal(f.wire.requests.filter(request=>request.method === "thread/read").length,1);
  } finally {await session.dispose();await client.close();await f.close();}
});

test("a terminal Item snapshot wins while its enclosing Turn remains active", async () => {
  const f = await fixture(); await f.engine.connect();
  const client = new JsonRpcAppServerClient({hostId:"audit",transport:f.wire});
  await client.connect({clientInfo:{name:"audit",version:"1"}});
  const session = await createCordisThreadSessionRuntime({client,requestTimeoutMs:1000});
  try {
    f.wire.onRequest = request => {if (request.method === "thread/read") {
      f.engine.emit({method:"item/started",params:{threadId:"thread",turnId:"live",item:{id:"tool-live",type:"commandExecution",status:"inProgress",aggregatedOutput:"older tool"}}});
    }};
    const view = await session.resume.read("thread");
    assert.equal(view.turns[0]!.status,"inProgress");
    const tool = view.turns[0]!.items!.find(item=>item.id === "tool-live")!;
    assert.equal(tool.status,"completed"); assert.notEqual(tool.aggregatedOutput,"older tool");
  } finally {await session.dispose();await client.close();await f.close();}
});

test("a malformed range cannot acknowledge a version and poison its later recovery", async () => {
  const f = await fixture([turn("live","final")]);
  const runtime = createAppServerWorkbenchRuntime({hostId:"audit",transport:f.wire,autoReconnect:false,requestTimeoutMs:1000,onRecoveryEvent(){}});
  try {
    await runtime.connect();const lease=await runtime.acquireThread("thread");lease.setRecoveryVisibility(true);
    await until(()=>lease.getSnapshot().authoritative && f.engine.status.state === "open");
    const version=f.history.read("thread/read",{threadId:"thread",includeTurns:false}).historyVersion;
    f.wire.holdRead=true;
    f.engine.emit({method:"opencraft/history/changed",params:{threadId:"thread",historyVersion:{...version,revision:version.revision+1},
      update:{baseVersion:version,version:{...version,revision:version.revision+1},turns:"invalid",removedTurnIds:[],removedItems:[]}}});
    assert.equal(lease.getSnapshot().authoritative,false);await until(()=>f.wire.held.length>0);
    assert.deepEqual(f.wire.requests.filter(request=>request.method === "thread/read").at(-1)!.params.historyBaseVersion,version);
    f.wire.release();await until(()=>lease.getSnapshot().authoritative);
    assert.match(JSON.stringify(lease.getSnapshot().timeline),/final/);lease.release();
  }finally{await runtime.dispose();await f.close();}
});

test("transaction coverage is frozen across reentrant commit observers and rolls back with facts", async () => {
  const f = await fixture([turn("live", "final")]);
  try {
    const baseline = f.history.read("thread/read", { threadId: "thread", includeTurns: false }).historyVersion;
    const updates: Value[] = []; let nested = false;
    const remove = f.history.subscribeCommitted((_ids, _revision, values) => {
      const update = values.get("thread"); if (!update) return; updates.push(update);
      if (!nested) { nested = true; f.history.metadata({ ...f.history.thread("thread"), name: "nested" }); }
    });
    f.history.observe("item/completed", { threadId: "thread", turnId: "live", item: { id: "item-live", type: "agentMessage", text: "changed" } });
    assert.equal(updates.length, 2); assert.deepEqual(updates[0]!.baseVersion, baseline);
    assert.deepEqual(updates[1]!.baseVersion, updates[0]!.version);
    assert.notDeepEqual(updates[0]!.version, updates[1]!.version); remove();
    const stable = f.history.read("thread/read", { threadId: "thread", includeTurns: false }).historyVersion;
    f.storage.database.exec("CREATE TRIGGER fail_fact BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT,'audit fault'); END");
    assert.throws(() => f.history.metadata({ ...f.history.thread("thread"), name: "failed" }), /audit fault/);
    f.storage.database.exec("DROP TRIGGER fail_fact");
    let next: Value | undefined; f.history.subscribeCommitted((_ids, _revision, values) => { next = values.get("thread"); });
    f.history.metadata({ ...f.history.thread("thread"), name: "success" }); assert.deepEqual(next!.baseVersion, stable);
  } finally { await f.close(); }
});
