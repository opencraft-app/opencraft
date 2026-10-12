import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { CodexMessageSenders } from "../apps/opencraft-daemon/src/codex-message-senders";
import { TencentOaParticipants } from "../plugins/tencentoa/src/participants-server";
import { TencentOaParticipantsController, type ParticipantsClient } from "../plugins/tencentoa/src/participants-controller";
import { TENCENTOA_PARTICIPANTS_CHANGED, TENCENTOA_PARTICIPANTS_METHOD } from "../plugins/tencentoa/src/contract";
import type { ThreadMetadataContext } from "@opencraft/appserver-client";

const employee = (loginName: string) => ({ kind: "employee" as const, loginName });
function setup() {
  const database = new DatabaseSync(":memory:");
  const senders = new CodexMessageSenders(database);
  const history = new Map<string, string[]>();
  const changes: unknown[] = [];
  const context: ThreadMetadataContext = { getSender: (t, m) => senders.get(t, m), hasSenders: t => senders.hasEmployees(t),
    readMessageIds: async t => history.get(t) ?? [], notify: (_method, params) => changes.push(params) };
  const service = new TencentOaParticipants(database, context);
  const query = async (...threadIds: string[]) => (await service.request(TENCENTOA_PARTICIPANTS_METHOD, { threadIds }) as any).data;
  return { database, senders, history, changes, context, service, query, close: () => { service.close(); database.close(); } };
}

test("participants exclude bound-only, cancelled/failed input and unknown authors; actual Items dedup within a Turn", async () => {
  const f = setup();
  try {
    f.senders.record("t", "a", employee("alice")); f.senders.record("t", "b", employee("bob"));
    f.senders.record("t", "cancelled", employee("carol")); f.senders.record("t", "failed", employee("dave")); f.senders.record("t", "unknown", null);
    f.history.set("t", ["a", "unknown"]);
    assert.deepEqual((await f.query("t"))[0].participants, ["alice"]);
    f.service.observeNotification({ method: "item/completed", params: { threadId: "t", turnId: "same-turn", item: { type: "userMessage", clientId: "b", sender: employee("forged") } } });
    f.service.observeNotification({ method: "item/started", params: { threadId: "t", item: { type: "userMessage", clientId: "a" } } });
    assert.deepEqual((await f.query("t"))[0].participants, ["alice", "bob"]);
    assert.equal(f.changes.length, 2, "only distinct set changes notify");
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM ioa_message_presence").get()?.n, 2);
  } finally { f.close(); }
});

test("accepted history survives model failure; steer ack reconciles history; fork and rollback use retained IDs", async () => {
  const f = setup();
  try {
    f.senders.record("t", "a", employee("alice")); f.senders.record("t", "b", employee("bob")); f.history.set("t", ["a"]);
    await f.query("t"); f.history.set("t", ["a", "b"]);
    f.service.observeResult("turn/steer", { threadId: "t", expectedTurnId: "turn" }, { turnId: "turn" });
    f.service.observeNotification({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn", error: { message: "model failed" } } } });
    assert.deepEqual((await f.query("t"))[0].participants, ["alice", "bob"]);
    f.senders.cloneThread("t", "fork"); f.history.set("fork", ["a"]);
    f.service.observeResult("thread/fork", { threadId: "t" }, { thread: { id: "fork" } });
    assert.deepEqual((await f.query("fork"))[0].participants, ["alice"]);
    f.history.set("t", ["b"]); f.service.observeResult("thread/rollback", { threadId: "t" }, { thread: { id: "t" } });
    assert.deepEqual((await f.query("t"))[0].participants, ["bob"]);
    f.service.close();
    f.history.set("t", []);
    const restored = new TencentOaParticipants(f.database, f.context);
    assert.deepEqual((await restored.request(TENCENTOA_PARTICIPANTS_METHOD, { threadIds: ["t"] }) as any).data[0].participants, []);
    restored.close();
  } finally { f.close(); }
});

test("late full history cannot erase a live participant; closing fences pending reads", async () => {
  const f = setup();
  try {
    f.senders.record("t", "a", employee("alice")); f.senders.record("t", "b", employee("bob"));
    let release!: (ids: string[]) => void; let reads = 0;
    f.context.readMessageIds = async () => ++reads === 1 ? new Promise<string[]>(resolve => { release = resolve; }) : ["a", "b"];
    const pending = f.query("t"); await new Promise(resolve => setImmediate(resolve));
    f.service.observeNotification({ method: "item/completed", params: { threadId: "t", item: { type: "userMessage", clientId: "b" } } });
    release(["a"]); assert.deepEqual((await pending)[0].participants, ["alice", "bob"]);
    const isolated = new TencentOaParticipants(f.database, { ...f.context, readMessageIds: () => new Promise(resolve => { release = resolve; }) });
    const late = isolated.request(TENCENTOA_PARTICIPANTS_METHOD, { threadIds: ["t"] });
    await new Promise(resolve => setImmediate(resolve)); isolated.close(); release([]);
    await assert.rejects(late, /closed/);
    assert.deepEqual(f.service.snapshot("t").participants, ["alice", "bob"]);
  } finally { f.close(); }
});

function clientFixture() {
  const notifications = new Set<Parameters<ParticipantsClient["subscribeNotification"]>[0]>();
  const statuses = new Set<Parameters<ParticipantsClient["subscribeStatus"]>[0]>();
  const lifecycle = new Set<Parameters<ParticipantsClient["subscribeRequestLifecycle"]>[0]>();
  const calls: any[] = [];
  let request: (params: any) => Promise<any> = async params => ({ data: params.threadIds.map((threadId: string) => ({ threadId, revision: 1, participants: ["alice"] })) });
  const client = { connectionGeneration: 1, initializeResult: { capabilities: { extensions: { [TENCENTOA_PARTICIPANTS_METHOD]: { version: 1 } } } },
    requestRaw: async (_method: string, params: any) => { calls.push(params); return request(params); },
    subscribeNotification: (listener: any) => { notifications.add(listener); return () => notifications.delete(listener); },
    subscribeStatus: (listener: any) => { statuses.add(listener); return () => statuses.delete(listener); },
    subscribeRequestLifecycle: (listener: any) => { lifecycle.add(listener); return () => lifecycle.delete(listener); },
  } as unknown as ParticipantsClient;
  return { client, calls, notifications, statuses, lifecycle, setRequest: (value: typeof request) => { request = value; } };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

test("IOA client batches visible rows and refreshes a non-active conversation on metadata changes", async () => {
  const f = clientFixture(), controller = new TencentOaParticipantsController(() => f.client);
  const unwatch = [controller.watch("h", "t1"), controller.watch("h", "t2")];
  try {
    await settle(); assert.deepEqual(f.calls[0].threadIds, ["t1", "t2"]); assert.equal(f.calls.length, 1);
    f.setRequest(async params => ({ data: params.threadIds.map((threadId: string) => ({ threadId, revision: 2, participants: ["alice", "bob"] })) }));
    for (const listener of f.notifications) listener({ method: TENCENTOA_PARTICIPANTS_CHANGED, params: { threadId: "t2", revision: 2 } });
    await settle(); assert.deepEqual(controller.getSnapshot("h", "t2").data?.participants, ["alice", "bob"]);
    assert.deepEqual(controller.getSnapshot("h", "t1").data?.participants, ["alice"]);
  } finally { unwatch.forEach(dispose => dispose()); controller.dispose(); }
  assert.equal(f.notifications.size, 0); assert.equal(f.statuses.size, 0); assert.equal(f.lifecycle.size, 0);
});

test("replaced Host and account scope fence late responses; failure retains names; unsupported capability sends no RPC", async () => {
  const f = clientFixture(), g = clientFixture(); let current = f.client;
  const controller = new TencentOaParticipantsController(() => current); const unwatch = controller.watch("h", "t");
  try {
    let release!: (value: any) => void; f.setRequest(() => new Promise(resolve => { release = resolve; })); await settle();
    current = g.client; controller.clear(); await settle();
    release({ data: [{ threadId: "t", revision: 99, participants: ["old-account"] }] }); await settle();
    assert.deepEqual(controller.getSnapshot("h", "t").data?.participants, ["alice"]);
    g.setRequest(async () => { throw new Error("offline"); }); controller.refresh("h", "t"); await settle();
    assert.equal(controller.getSnapshot("h", "t").phase, "error"); assert.deepEqual(controller.getSnapshot("h", "t").data?.participants, ["alice"]);
    Object.defineProperty(g.client, "initializeResult", { value: { capabilities: { extensions: {} } }, configurable: true });
    const count = g.calls.length; controller.refresh("h", "t"); await settle();
    assert.equal(g.calls.length, count); assert.equal(controller.getSnapshot("h", "t").phase, "unsupported");
  } finally { unwatch(); controller.dispose(); }
});

test("real Host broker gates IOA RPC, advertises capability, broadcasts to non-active readers and strips model metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ioa-participants-broker-"));
  class Native implements DuplexTransport {
    status: TransportStatus = { state: "idle" };
    sent: any[] = []; ids: string[] = [];
    listeners = new Set<(frame: string) => void>();
    async connect() { this.status = { state: "open" }; }
    async send(frame: string) {
      const value = JSON.parse(frame); this.sent.push(value);
      queueMicrotask(() => {
        let result: unknown = {};
        if (value.method === "initialize") result = { platform: "linux", codexHome: root };
        if (value.method === "experimentalFeature/list") result = { data: [], nextCursor: null };
        if (value.method === "turn/start") { this.ids.push(value.params.clientUserMessageId); result = { turn: { id: "turn", items: [] } }; }
        if (value.method === "thread/items/list") result = { data: this.ids.map(clientId => ({ item: { type: "userMessage", clientId } })), nextCursor: null };
        for (const listener of this.listeners) listener(JSON.stringify({ id: value.id, result }));
      });
    }
    subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    subscribeStatus() { return () => {}; }
    async close() { this.status = { state: "closed" }; }
  }
  const physical = new Native(), frames: any[] = [];
  const adapter = new CodexEngineAdapter({ kind: "remote", transport: physical, attachmentHistoryDirectory: root,
    logDiagnostic: () => {}, createThreadMetadata: (db, context) => new TencentOaParticipants(db, context) });
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  const send = (client: string, id: number, method: string, params: unknown = {}) => adapter.send(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: client, id, method, params }));
  try {
    await adapter.connect();
    await send("stranger", 1, TENCENTOA_PARTICIPANTS_METHOD, { threadIds: ["t"] });
    assert.equal(frames.at(-1).error.code, -32600);
    for (const client of ["a", "b", "catalog-only"]) { await send(client, 2, "initialize"); await settle(); }
    const initialized = frames.find(frame => frame.id === 2 && frame[LOGICAL_CLIENT_FIELD] === "a");
    assert.equal(initialized.result.capabilities.extensions[TENCENTOA_PARTICIPANTS_METHOD].version, 1);
    await adapter.sendWithContext(JSON.stringify({ [LOGICAL_CLIENT_FIELD]: "a", id: 3, method: "turn/start",
      params: { threadId: "t", clientUserMessageId: "m", sender: employee("spoof"), input: [{ type: "text", text: "hello" }] } }), { sender: employee("alice"), validUntil: Date.now() + 60000 });
    await settle();
    await send("catalog-only", 4, TENCENTOA_PARTICIPANTS_METHOD, { threadIds: ["t"] }); await settle();
    assert.deepEqual(frames.find(frame => frame.id === 4).result.data[0].participants, ["alice"]);
    const recipients = frames.filter(frame => frame.method === TENCENTOA_PARTICIPANTS_CHANGED).map(frame => frame[LOGICAL_CLIENT_FIELD]);
    assert.deepEqual(new Set(recipients), new Set(["a", "b", "catalog-only"]));
    assert.ok(!physical.sent.some(value => value.method === TENCENTOA_PARTICIPANTS_METHOD));
    const nativeInput = physical.sent.find(value => value.method === "turn/start").params;
    assert.equal(nativeInput.sender, undefined); assert.ok(!JSON.stringify(nativeInput).includes("alice"));
  } finally { await adapter.close(); await rm(root, { recursive: true, force: true }); }
});
