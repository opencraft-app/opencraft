import assert from "node:assert/strict";
import test from "node:test";
import { LOGICAL_CLIENT_FIELD } from "@opencraft/app-host-protocol";
import type { DuplexTransport, TransportStatus } from "@opencraft/appserver-client/transport";
import { CodexEngineAdapter } from "../apps/opencraft-daemon/src/codex-engine-adapter.js";
import { OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION } from "@opencraft/appserver-protocol";

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
function setup() {
  const physical = new Physical();
  const adapter = new CodexEngineAdapter({ kind: "remote", transport: physical, logDiagnostic: () => undefined });
  const frames: any[] = [];
  adapter.subscribeMessage(frame => frames.push(JSON.parse(frame)));
  const send = (client: string, id: number | string, method: string, params: unknown = {}) => adapter.send(JSON.stringify({ id, method, params, [LOGICAL_CLIENT_FIELD]: client }));
  const detach = (client: string) => adapter.send(JSON.stringify({ method: "runtime/client/disconnect", [LOGICAL_CLIENT_FIELD]: client }));
  const initialize = async () => {
    await adapter.connect(); await send("a", 1, "initialize", { capabilities: { experimentalApi: false } });
    physical.receive({ id: physical.sent.at(-1).id, result: { platform: "linux", codexHome: "/remote" } });
    await send("b", 1, "initialize"); frames.length = 0;
  };
  return { physical, adapter, frames, send, detach, initialize };
}
test("shared remote broker initializes once with backend policy; no local extensions or internal route reaches upstream", async () => {
  const f = setup();
  try {
    await f.adapter.connect();
    await f.send("a", 1, "initialize", { capabilities: { experimentalApi: false, optOutNotificationMethods: ["turn/started"] } });
    await f.send("b", "1", "initialize");
    assert.equal(f.physical.sent.length, 1);
    assert.deepEqual(f.physical.sent[0].params.capabilities, { experimentalApi: true });
    f.physical.receive({ id: f.physical.sent[0].id, result: { platform: "linux" } });
    const [a, b] = f.frames;
    assert.equal(a.id, 1); assert.equal(b.id, "1");
    for (const extension of [OPENCRAFT_ATTACHMENT_STAGING_EXTENSION, OPENCRAFT_THREAD_QUEUE_EXTENSION, OPENCRAFT_THREAD_GOAL_EXTENSION]) assert.equal(a.result.capabilities.extensions[extension], undefined);
    await f.detach("a");
    assert.equal(f.physical.sent.filter(message => message.method === "initialize").length, 1);
    assert.ok(f.physical.sent.every(message => !message[LOGICAL_CLIENT_FIELD]));
    assert.ok(f.physical.sent.every(message => message.method !== "runtime/client/disconnect"));
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
test("logical detach cannot unsubscribe another reader; owner-only approval and resumed successor claim", async () => {
  const f = setup();
  try {
    await f.initialize();
    for (const client of ["a", "b"]) { await f.send(client, 2, "thread/resume", { threadId: "t" }); f.physical.receive({ id: f.physical.sent.at(-1).id, result: { thread: { id: "t" } } }); }
    f.frames.length = 0;
    f.physical.receive({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: "t", turnId: "turn" } });
    assert.equal(f.frames.length, 1); assert.equal(f.frames[0][LOGICAL_CLIENT_FIELD], "a");
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "b" }));
    assert.ok(!f.physical.sent.some(message => message.id === "approval"));
    await f.detach("a");
    assert.ok(!f.physical.sent.some(message => message.method === "thread/unsubscribe"));
    f.frames.length = 0;
    f.physical.receive({ method: "item/agentMessage/delta", params: { threadId: "t", delta: "live" } });
    assert.equal(f.frames.length, 1); assert.equal(f.frames[0][LOGICAL_CLIENT_FIELD], "b");
    await f.send("b", 3, "thread/resume", { threadId: "t" }); f.physical.receive({ id: f.physical.sent.at(-1).id, result: { thread: { id: "t" } } });
    assert.equal(f.frames.filter(frame => frame.id === "approval").length, 1);
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "a" }));
    assert.ok(!f.physical.sent.some(message => message.id === "approval"));
    await f.adapter.send(JSON.stringify({ id: "approval", result: { decision: "accept" }, [LOGICAL_CLIENT_FIELD]: "b" }));
    assert.equal(f.physical.sent.filter(message => message.id === "approval").length, 1);
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
