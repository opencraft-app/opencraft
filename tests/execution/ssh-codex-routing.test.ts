import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { ExecutionLeaseStore } from "../../apps/opencraft-daemon/src/execution-lease-store.js";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION } from "@opencraft/appserver-protocol";
import { OPENCRAFT_DESKTOP_EXTENSION, OPENCRAFT_DESKTOP_ATTACH, OPENCRAFT_DESKTOP_RELEASE } from "@opencraft/appserver-protocol/desktop";

class Physical implements DuplexTransport {
  status: TransportStatus = { state: "idle" };
  sent: any[] = [];
  readonly messages = new Set<(frame: string) => void>();
  readonly statuses = new Set<(status: TransportStatus) => void>();
  gate: Promise<void> | null = null;
  async connect() { this.status = { state: "open" }; }
  async send(frame: string) { if (this.gate) await this.gate; this.sent.push(JSON.parse(frame)); }
  receive(message: unknown) { for (const listener of this.messages) listener(JSON.stringify(message)); }
  publish(status: TransportStatus) { this.status = status; for (const listener of this.statuses) listener(status); }
  subscribeMessage(listener: (frame: string) => void) { this.messages.add(listener); return () => this.messages.delete(listener); }
  subscribeStatus(listener: (status: TransportStatus) => void) { this.statuses.add(listener); return () => this.statuses.delete(listener); }
  async close() { this.publish({ state: "closed" }); }
}
function setup(options: { attachmentHistoryDirectory?: string } = {}) {
  const physical = new Physical();
  const adapter = new CodexEngineAdapter({ kind: "remote", transport: physical, logDiagnostic: () => undefined, ...options });
  const frames: any[] = [];
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  const send = (client: string, id: number | string, method: string, params: unknown = {}) => adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
  const detach = (client: string) => adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: client }));
  const settleDiscovery = async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const query = physical.sent.find(frame => frame.method === "experimentalFeature/list");
    assert.ok(query, "shared initialization queries native capabilities before replying");
    physical.receive({ id: query.id, result: { data: [], nextCursor: null } });
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  const initialize = async () => {
    await adapter.connect(); await send("a", 1, "initialize", { capabilities: { experimentalApi: false } });
    physical.receive({ id: physical.sent.at(-1).id, result: { platform: "linux", codexHome: "/remote" } });
    await send("b", 1, "initialize"); await settleDiscovery(); frames.length = 0;
  };
  return { physical, adapter, frames, send, detach, initialize, settleDiscovery };
}
test("shared remote broker initializes once with backend policy; no local extensions or internal route reaches upstream", async () => {
  const f = setup();
  try {
    await f.adapter.connect();
    await f.send("a", 1, "initialize", { capabilities: { experimentalApi: false, optOutNotificationMethods: ["turn/started"] } });
    await f.send("b", "1", "initialize");
    assert.equal(f.physical.sent.length, 1);
    assert.deepEqual(f.physical.sent[0].params.capabilities, { experimentalApi: true });
    f.physical.receive({ id: f.physical.sent[0].id, result: { platform: "linux", capabilities: { extensions: { [OPENCRAFT_DESKTOP_EXTENSION]: { version: 1 } } } } });
    assert.equal(f.frames.length, 0, "initialization waits for shared capability discovery");
    await f.settleDiscovery();
    const [a, b] = f.frames;
    assert.equal(a.id, 1); assert.equal(b.id, "1");
    for (const extension of [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION, OPENCRAFT_DESKTOP_EXTENSION]) {
      assert.equal(a.result.capabilities.extensions[extension], undefined);
      assert.equal(b.result.capabilities.extensions[extension], undefined);
    }
    await f.detach("a");
    assert.equal(f.physical.sent.filter(message => message.method === "initialize").length, 1);
    assert.equal(f.physical.sent.filter(message => message.method === "experimentalFeature/list").length, 1);
    assert.ok(f.physical.sent.every(message => !message[LOGICAL_CLIENT_FIELD]));
    assert.ok(f.physical.sent.every(message => message.method !== "runtime/client/disconnect"));
  } finally { await f.adapter.close(); }
});

test("SSH creates one private title turn through its existing connection and notifies catalog-only readers", async () => {
  const f = setup(); let name: string | null = null;
  try {
    await f.initialize();
    f.physical.send = async frame => {
      const message = JSON.parse(frame); f.physical.sent.push(message);
      const { id, method, params = {} } = message;
      let result: unknown = {};
      if (method === "thread/start") result = { thread: { id: params.ephemeral ? "private-title" : "new-thread", ephemeral: !!params.ephemeral, name: null } };
      if (method === "thread/read") result = { thread: { id: params.threadId, name } };
      if (method === "model/list") result = { data: [{ model: "gpt-6-luna" }] };
      if (method === "turn/start") result = { turn: { id: params.threadId === "private-title" ? "title-turn" : "user-turn" } };
      if (method === "thread/name/set") name = params.name;
      queueMicrotask(() => {
        f.physical.receive({ id, result });
        if (method === "thread/start" && params.ephemeral) f.physical.receive({ method: "thread/started", params: { thread: (result as any).thread } });
        if (method === "turn/start" && params.threadId === "private-title") {
          f.physical.receive({ method: "item/completed", params: { threadId: "private-title", turnId: "title-turn", item: { type: "agentMessage", text: '{"title":"修复远端会话标题"}' } } });
          f.physical.receive({ method: "turn/completed", params: { threadId: "private-title", turn: { id: "title-turn", status: "completed" } } });
        }
      });
    };
    await f.send("a", 2, "thread/start", {});
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.send("a", 3, "turn/start", { threadId: "new-thread", input: [{ type: "text", text: "修复远端会话自动标题" }] });
    for (let i = 0; i < 50 && !name; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(name, "修复远端会话标题");
    assert.equal(f.physical.sent.filter(row => row.method === "thread/start" && row.params.ephemeral).length, 1);
    assert.ok(f.frames.some(row => row.method === "thread/name/updated" && row[LOGICAL_CLIENT_FIELD] === "b"));
    assert.ok(f.physical.sent.some(row => row.method === "thread/unsubscribe" && row.params.threadId === "private-title"));
    assert.ok(f.frames.every(row => !JSON.stringify(row).includes("private-title")));
  } finally { await f.adapter.close(); }
});

test("silent Goal discovery times out without blocking ordinary SSH initialization", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup();
  try {
    await f.adapter.connect(); await f.send("a", 1, "initialize"); await f.send("b", 1, "initialize");
    f.physical.receive({ id: f.physical.sent[0].id, result: {} });
    await new Promise<void>(resolve => setImmediate(resolve));
    const query = f.physical.sent.find(frame => frame.method === "experimentalFeature/list");
    assert.ok(query);
    context.mock.timers.tick(3_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.frames.length, 2);
    assert.equal(f.adapter.status.state, "open");
    for (const frame of f.frames) assert.equal(frame.result.capabilities.extensions[OPENCRAFT_THREAD_GOAL_EXTENSION], undefined);
    f.physical.receive({ id: query.id, result: { data: [{ name: "goals", enabled: true }] } });
    assert.equal(f.frames.length, 2, "late capabilities cannot alter initialized Clients");
  } finally { await f.adapter.close(); }
});

test("closing the connection fences a pending native Goal discovery", async () => {
  const f = setup();
  try {
    await f.adapter.connect(); await f.send("a", 1, "initialize");
    f.physical.receive({ id: f.physical.sent[0].id, result: {} });
    await new Promise<void>(resolve => setImmediate(resolve));
    const query = f.physical.sent.find(frame => frame.method === "experimentalFeature/list");
    assert.ok(query);
    const queuedReceive = [...f.physical.messages][0]!;
    await f.adapter.close();
    queuedReceive(JSON.stringify({ id: query.id, result: { data: [{ name: "goals", enabled: true }] } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.frames.length, 0);
    assert.equal(f.adapter.status.state, "closed");
  } finally { await f.adapter.close(); }
});

test("explicit read-only upstream Goal capability only admits native reads", async () => {
  const f = setup();
  try {
    await f.adapter.connect(); await f.send("a", 1, "initialize");
    f.physical.receive({ id: f.physical.sent[0].id, result: { capabilities: { extensions: {
      [OPENCRAFT_THREAD_GOAL_EXTENSION]: { version: 1, read: true, write: false },
    } } } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.frames[0].result.capabilities.extensions[OPENCRAFT_THREAD_GOAL_EXTENSION].write, false);
    assert.ok(!f.physical.sent.some(frame => frame.method === "experimentalFeature/list"));
    await f.send("a", 2, "thread/goal/get", { threadId: "existing" });
    assert.equal(f.physical.sent.at(-1).method, "thread/goal/get");
    const count = f.physical.sent.length;
    await f.send("a", 3, "thread/goal/set", { threadId: "existing", status: "active" });
    await f.send("a", 4, "thread/goal/clear", { threadId: "existing" });
    assert.equal(f.physical.sent.length, count);
    assert.equal(f.frames.at(-1).error.code, -32601);
  } finally { await f.adapter.close(); }
});
test("reverse RPC replies preserve client and numeric/string ID; stale incarnation cannot receive a late reply", async () => {
  const f = setup();
  try {
    await f.initialize();
    await f.send("a", 1, "thread/list"); const first = f.physical.sent.at(-1);
    await f.send("b", "1", "model/list"); const second = f.physical.sent.at(-1);
    assert.notEqual(first.id, second.id);
    f.physical.receive({ id: second.id, result: { data: ["b"] } });
    f.physical.receive({ id: first.id, result: { data: ["a"] } });
    assert.deepEqual(f.frames.map(frame => [frame[LOGICAL_CLIENT_FIELD], frame.id, frame.result.data]), [["b", "1", ["b"]], ["a", 1, ["a"]]]);
    await f.send("a", 8, "thread/resume", { threadId: "t" }); const old = f.physical.sent.at(-1);
    await f.detach("a"); await f.send("a", 9, "initialize"); f.frames.length = 0;
    f.physical.receive({ id: old.id, result: { thread: { id: "t" } } });
    f.physical.receive({ method: "item/agentMessage/delta", params: { threadId: "t", delta: "stale" } });
    assert.equal(f.frames.length, 0);
  } finally { await f.adapter.close(); }
});
test("silent native initialize expires all waiters and rejects a late ready response", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup();
  try {
    await f.adapter.connect();
    await f.send("a", 1, "initialize");
    await f.send("b", "1", "initialize");
    const initial = f.physical.sent[0];
    context.mock.timers.tick(15_000);
    assert.equal(f.adapter.status.failure?.code, "SSH_RPC_INITIALIZE_TIMEOUT");
    assert.deepEqual(f.frames.map(frame => [frame[LOGICAL_CLIENT_FIELD], frame.id, frame.error.code]), [["a", 1, -32000], ["b", "1", -32000]]);
    const count = f.frames.length;
    f.physical.receive({ id: initial.id, result: { platform: "linux" } });
    assert.equal(f.frames.length, count);
    assert.equal(f.adapter.status.state, "failed");
    assert.equal(f.physical.sent.length, 1);
  } finally { await f.adapter.close(); }
});
test("native fork preserves the caller's no-fixed-deadline contract", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup();
  try {
    await f.initialize();
    await f.send("a", 77, "thread/fork", { threadId: "source" });
    const request = f.physical.sent.at(-1);
    context.mock.timers.tick(180_000);
    assert.equal(f.frames.length, 0);
    f.physical.receive({ id: request.id, result: { thread: { id: "forked" } } });
    assert.equal(f.frames.at(-1).id, 77);
    assert.equal(f.frames.at(-1).result.thread.id, "forked");
  } finally { await f.adapter.close(); }
});
test("logical detach preserves another reader and shared human approval admits one subscribed answer", async () => {
  const f = setup();
  try {
    await f.initialize();
    for (const client of ["a", "b"]) { await f.send(client, 2, "thread/resume", { threadId: "t" }); f.physical.receive({ id: f.physical.sent.at(-1).id, result: { thread: { id: "t" } } }); }
    f.frames.length = 0;
    f.physical.receive({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "turn" } });
    assert.deepEqual(f.frames.map(frame => frame[LOGICAL_CLIENT_FIELD]), ["a", "b"]);
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "unsubscribed" }));
    assert.ok(!f.physical.sent.some(message => message.id === "approval"));
    await f.detach("a");
    assert.ok(!f.physical.sent.some(message => message.method === "thread/unsubscribe"));
    f.frames.length = 0;
    f.physical.receive({ method: "item/agentMessage/delta", params: { threadId: "t", delta: "live" } });
    assert.equal(f.frames.length, 1); assert.equal(f.frames[0][LOGICAL_CLIENT_FIELD], "b");
    await f.send("b", 3, "thread/resume", { threadId: "t" }); f.physical.receive({ id: f.physical.sent.at(-1).id, result: { thread: { id: "t" } } });
    assert.equal(f.frames.filter(frame => frame.id === "approval").length, 0, "an already offered request is not dispatched twice");
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "a" }));
    assert.ok(!f.physical.sent.some(message => message.id === "approval"));
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "b" }));
    assert.equal(f.physical.sent.filter(message => message.id === "approval").length, 1);
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "b" }));
    assert.equal(f.physical.sent.filter(message => message.id === "approval").length, 1, "duplicate legacy answer cannot repeat native execution");
  } finally { await f.adapter.close(); }
});
test("no local extension or unowned connection-resource RPC is forwarded remotely", async () => {
  const f = setup();
  try {
    await f.initialize(); const count = f.physical.sent.length;
    for (const method of ["attachment/stage", "thread/queue/add", "command/exec", "fs/watch", "fuzzyFileSearch/sessionStart", "thread/goal/set"]) {
      await f.send("a", method, method, {});
      assert.equal(f.frames.at(-1).error.code, -32601);
    }
    assert.equal(f.physical.sent.length, count);
    await f.adapter.send(JSON.stringify({ method: "turn/start", params: { threadId: "t", input: [] }, [LOGICAL_CLIENT_FIELD]: "not-initialized" }));
    await f.adapter.send(JSON.stringify({ method: "turn/start", params: { threadId: "t", input: [] }, [LOGICAL_CLIENT_FIELD]: "a" }));
    assert.equal(f.physical.sent.length, count, "RPC notification cannot bypass logical request ownership");
  } finally { await f.adapter.close(); }
});
test("remote clients cannot attach or release this host's local desktop", async () => {
  const f = setup();
  try {
    await f.initialize();
    const count = f.physical.sent.length;
    for (const [method, params] of [
      [OPENCRAFT_DESKTOP_ATTACH, { threadId: "remote-thread" }],
      [OPENCRAFT_DESKTOP_RELEASE, { attachmentId: "local-attachment" }],
    ] as const) {
      await f.send("a", method, method, params);
      assert.ok(f.frames.at(-1).error, "local desktop must not be available through a remote binding");
    }
    assert.equal(f.physical.sent.length, count, "desktop RPC must not reach remote native Codex");
  } finally { await f.adapter.close(); }
});
test("transport acknowledgement waits for write; failed mutation is unknown and never replayed", async () => {
  const f = setup();
  try {
    await f.initialize();
    let release!: () => void;
    f.physical.gate = new Promise(resolve => { release = resolve; });
    let acknowledged = false;
    const operation = f.send("a", 6, "turn/start", { threadId: "t", input: [] }).then(() => { acknowledged = true; });
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(acknowledged, false);
    release(); await operation; assert.equal(acknowledged, true);
    const sent = f.physical.sent.length;
    f.physical.publish({ state: "failed", reason: "Link lost", failure: { code: "SSH_LINK_LOST", recovery: "automatic" } });
    assert.equal(f.adapter.status.failure?.code, "SSH_LINK_LOST");
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(f.physical.sent.length, sent);
  } finally { await f.adapter.close(); }
});

for (const unknownTurn of [false, true]) test(`remote initialization reconciles ${unknownTurn ? "unknown input" : "known Turn"} leases without full history`, async () => {
  const root = await mkdtemp(join(tmpdir(), "ssh-lease-reconcile-"));
  const owner = new OpenCraftHostStateDatabase(root), leases = new ExecutionLeaseStore(owner.database);
  leases.capture("thread", "original-input", { principal: null, ownership: "unowned" });
  const executionId = leases.begin("thread", "original-input");
  if (!unknownTurn) leases.started("thread", "target", "original-input");
  leases.suspend(); owner.close();
  const f = setup({ attachmentHistoryDirectory: root });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  try {
    await f.initialize();
    const request = () => f.physical.sent.filter(frame => frame.method === "thread/turns/list").at(-1);
    const first = request();
    assert.ok(first, "native initialization must start a bounded lease read");
    assert.equal(first.params.itemsView, unknownTurn ? "summary" : "notLoaded");
    assert.equal(first.params.sortDirection, "desc");
    f.physical.receive({ id: first.id, result: { data: [{ id: "unrelated", status: "completed",
      items: unknownTurn ? [{ type: "userMessage", clientId: "other-input" }] : [], itemsView: first.params.itemsView }], nextCursor: "older" } });
    await settle();
    const second = request();
    assert.equal(second.params.cursor, "older");
    f.physical.receive({ id: second.id, result: { data: [{ id: "target", status: "completed",
      items: unknownTurn ? [{ type: "userMessage", clientId: "original-input" }] : [], itemsView: second.params.itemsView }], nextCursor: "unneeded" } });
    await settle();
    assert.equal(f.physical.sent.filter(frame => frame.method === "thread/turns/list").length, 2, "stop after the exact unsettled lease is resolved");
    assert.ok(!f.physical.sent.some(frame => frame.method === "thread/read"), "never download full history during initialization");
    const store = (f.adapter as any).executionLeases as ExecutionLeaseStore;
    assert.equal(store.resolve({ threadId: "thread", executionId }).status, "expired");
    assert.equal((f.adapter as any).hostState.database.prepare("SELECT 1 FROM execution_leases WHERE turn_id='unrelated'").get(), undefined,
      "reconciliation cannot create unrelated historical execution leases");
  } finally { await f.adapter.close(); await rm(root, { recursive: true, force: true }); }
});
