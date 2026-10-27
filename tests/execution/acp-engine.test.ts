import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpEngine, dshAcpCommand } from "../../plugins/acp-engine/src/index.js";
import { AcpGenerationHost } from "../../plugins/acp-engine/src/generations.js";
import type { ExecutionEngineClient } from "../../packages/appserver-client/src/execution-engine.js";

const peer = resolve("tests/fixtures/acp-engine-peer.mjs");
const client: ExecutionEngineClient = { notify() {}, async request() { throw new Error("No browser tool owner"); } };
async function fixture(t: test.TestContext, options: Record<string, any> = {}) {
  const root = await mkdtemp(join(tmpdir(), "acp-engine-test-")), trace = join(root, "trace.jsonl");
  const engine = new AcpEngine({ command: process.execPath, args: [peer], cwd: root, dataDirectory: join(root, "data"), env: { ACP_TEST_TRACE: trace }, permission: "allow-once", ...options });
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const calls = async () => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, engine, calls };
}
async function until(predicate: () => boolean) { const deadline = Date.now() + 4_000; while (!predicate()) { if (Date.now() >= deadline) throw new Error("ACP test condition timed out"); await delay(10); } }

test("trusted router metadata does not alter any ACP driver's frozen native settings", async t => {
  for (const id of ["acp", "dsh-acp", "claude-code"] as const) {
    const f = await fixture(t, { id });
    const prepared = await f.engine.request("opencraft/orchestration/prepare", { operationId: "routed-create", sourceSettings: { cwd: f.root }, arguments: {} }, client);
    const settings = { ...prepared, orchestrationDriver: id, orchestrationGenerationId: "generation-a" };
    const child = await f.engine.request("opencraft/orchestration/create", { operationId: "routed-create", settings }, client);
    assert.ok(f.engine.ownsThread(child.threadId));
    assert.deepEqual(await f.engine.request("opencraft/orchestration/create", { operationId: "routed-create", settings }, client), child);
    await assert.rejects(f.engine.request("opencraft/orchestration/create", { operationId: "routed-create", settings: { ...settings, cwd: join(f.root, "different") } }, client), /prepared settings changed/);
    assert.equal((await f.calls()).filter(call => call.method === "session/new").length, 1);
  }
});

test("ACP opens native history without starting a process or issuing session/resume", async t => {
  let reads = 0;
  const f = await fixture(t, { history: { async read() { reads++; return { data: [{ id: "native-turn", items: [], status: "completed" }], nextCursor: null }; } } });
  const created = await f.engine.request("thread/start", {}, client), id = created.thread.id;
  const pid = f.engine.processId, before = await f.calls();
  f.engine.disconnect(client);
  const read = await f.engine.request("thread/read", { threadId: id, initialTurnsPage: { limit: 10 } }, client);
  assert.equal(read.initialTurnsPage.data[0].id, "native-turn"); assert.equal(reads, 1);
  assert.deepEqual(await f.calls(), before); assert.equal(f.engine.processId, pid);
  assert.equal(before.filter(call => call.method === "session/resume").length, 0);
});

test("ACP child creation is idempotent and callback lane survives a frontend disconnect", async t => {
  const f = await fixture(t), replies: string[] = [], notices: any[] = [];
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  f.engine.setOrchestration({ tools: [{ name: "thread_spawn", description: "spawn", inputSchema: { type: "object" } }],
    async call(threadId, turnId, callId) { replies.push([threadId, turnId, callId].join(":")); await blocked; return { childId: "child" }; } });
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const prepared = await f.engine.request("opencraft/orchestration/prepare", { operationId: "op-1", sourceSettings: { cwd: f.root }, arguments: {} }, client);
  const params = { operationId: "op-1", settings: prepared };
  const [a, b] = await Promise.all([f.engine.request("opencraft/orchestration/create", params, client), f.engine.request("opencraft/orchestration/create", params, client)]);
  assert.equal(a.threadId, b.threadId); assert.equal((await f.calls()).filter(call => call.method === "session/new").length, 1);
  const started = await f.engine.request("turn/start", { threadId: a.threadId, input: [{ type: "text", text: "call:thread_spawn" }] }, client);
  await until(() => replies.length === 1); const pid = f.engine.processId;
  f.engine.disconnect(client); finish();
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  assert.equal(f.engine.processId, pid); assert.equal(replies.length, 1);
  assert.equal(f.engine.snapshot(a.threadId).turnId, started.turn.id); assert.equal(f.engine.snapshot(a.threadId).state, "completed");
  const tool = notices.find(notice => notice.method === "item/completed" && notice.params.item.type === "dynamicToolCall");
  assert.equal(tool.params.item.tool, "thread_spawn"); assert.equal(tool.params.item.status, "completed");
  assert.match(JSON.stringify(tool.params.item.contentItems), /child/);
});

test("ACP rejects a changed create receipt and a wider child workspace", async t => {
  const f = await fixture(t);
  await assert.rejects(f.engine.request("opencraft/orchestration/prepare", { sourceSettings: { cwd: f.root }, arguments: { cwd: "/" } }, client), /workspace exceeds/);
  const prepared = await f.engine.request("opencraft/orchestration/prepare", { operationId: "one", sourceSettings: { cwd: f.root }, arguments: {} }, client);
  await f.engine.request("opencraft/orchestration/create", { operationId: "one", settings: prepared }, client);
  await assert.rejects(f.engine.request("opencraft/orchestration/create", { operationId: "one", settings: { ...prepared, cwd: join(f.root, "other") } }, client), (error: any) => error.code === 409);
});

test("ACP generation switch keeps the old active turn and pins new children to the prepared generation", async t => {
  const root = await mkdtemp(join(tmpdir(), "acp-generations-test-"));
  const configs = new Map(["a", "b"].map(id => [join(root, `${id}.json`), { command: process.execPath, args: [peer], cwd: root, dataDirectory: "overridden", permission: "allow-once" as const }]));
  const host = new AcpGenerationHost({ id: "dsh-acp", dataDirectory: join(root, "host"), initialGeneration: { id: "a", configPath: join(root, "a.json") }, async readConfig(path) { return configs.get(path)!; } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  const old = await host.request("thread/start", {}, client), notices: any[] = [];
  host.subscribe((method, params) => notices.push({ method, params }));
  const started = await host.request("turn/start", { threadId: old.thread.id, input: [{ type: "text", text: "wait" }] }, client);
  await host.manage("add", { id: "b", configPath: join(root, "b.json"), expectedCurrent: "a" });
  await host.manage("activate", { id: "b", expectedCurrent: "a" });
  await assert.rejects(host.manage("retire", { id: "a" }), /active turns/);
  const prepared = await host.request("opencraft/orchestration/prepare", { operationId: "new-child", sourceSettings: { cwd: root }, arguments: {} }, client);
  assert.equal(prepared.orchestrationGenerationId, "b");
  const created = await host.request("opencraft/orchestration/create", { operationId: "new-child", settings: prepared }, client);
  assert.equal(created.generationId, "b"); assert.match(created.threadId, /^dsh_acp_/);
  await until(() => notices.some(notice => notice.method === "turn/completed" && notice.params.threadId === old.thread.id));
  const snapshot = await host.request("opencraft/orchestration/status", { threadId: old.thread.id }, client);
  assert.equal(snapshot.turnId, started.turn.id); assert.equal(snapshot.state, "completed");
});

test("DSH ACP launch uses the explicit ACP profile and preserves the exact entry and patch arguments", () => {
  const launch = dshAcpCommand("/runtime/dsh/lib/bin.js", ["/private/one.json", "/private/two.json"]);
  assert.equal(launch.command, process.execPath);
  assert.deepEqual(launch.args, ["--expose-internals", "/runtime/dsh/lib/bin.js", "--profile", "acp", "--patch", "/private/one.json", "--patch", "/private/two.json"]);
});

test("ACP prepare preserves canonical Full settings across drivers and rejects an unknown Host policy", async t => {
  const f = await fixture(t);
  const prepared = await f.engine.request("opencraft/orchestration/prepare", { operationId: "full", sourceSettings: { cwd: f.root, approvalPolicy: "never", sandbox: "danger-full-access" }, arguments: {} }, client);
  assert.equal(prepared.approvalPolicy, "never"); assert.equal(prepared.sandbox, "danger-full-access"); assert.ok(prepared.permissions);
  const target = await f.engine.request("opencraft/orchestration/create", { operationId: "full", settings: prepared }, client);
  const metadata = await f.engine.request("thread/read", { threadId: target.threadId }, client);
  assert.equal(metadata.thread.permissions, prepared.permissions);
  const denied = await fixture(t, { permission: "reject" });
  await assert.rejects(denied.engine.request("opencraft/orchestration/prepare", { sourceSettings: { cwd: denied.root }, arguments: {} }, client), /Full access is not configured/);
  assert.equal(denied.engine.processId, null);
});

async function generationFixture(t: test.TestContext, resume = true) {
  const root = await mkdtemp(join(tmpdir(), "acp-suspend-test-")), trace = join(root, "trace.jsonl");
  const configurations = new Map(["a", "b"].map(id => [join(root, `${id}.json`), {
    command: process.execPath, args: [peer], cwd: root, dataDirectory: "overridden", permission: "allow-once" as const,
    env: { ACP_TEST_TRACE: trace, ACP_TEST_BUILD: id, ...(resume ? {} : { ACP_TEST_NO_RESUME: "1" }) },
    history: { async read() { return { data: [{ id: "native-history", status: "completed", items: [] }], nextCursor: null }; } },
  }]));
  const options = { id: "dsh-acp" as const, dataDirectory: join(root, "host"), initialGeneration: { id: "a", configPath: join(root, "a.json") }, async readConfig(path: string) { return configurations.get(path)!; } };
  let host = new AcpGenerationHost(options); await host.start();
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const switchToB = async () => { await host.manage("add", { id: "b", configPath: join(root, "b.json") }); await host.manage("activate", { id: "b" }); };
  const calls = async () => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { root, configurations, calls, get host() { return host; }, switchToB, async restart() { await host.close(); host = new AcpGenerationHost(options); await host.start(); } };
}

test("drained ACP generation suspends its PID, reads without waking, and resumes the same native session on its original build", async t => {
  const f = await generationFixture(t), old = await f.host.request("thread/start", {}, client);
  const beforePid = f.host.snapshot().generations[0].pid;
  const route = JSON.parse(await readFile(join(f.root, "host", "generations", "a", old.thread.id + ".json"), "utf8"));
  await f.switchToB();
  await f.host.manage("suspend", { id: "a" });
  assert.equal(f.host.snapshot().generations[0].state, "dormant"); assert.equal(f.host.snapshot().generations[0].pid, null);
  assert.throws(() => process.kill(beforePid, 0), /ESRCH/);
  const calls = await f.calls();
  const read = await f.host.request("thread/read", { threadId: old.thread.id, initialTurnsPage: { limit: 10 } }, client);
  const list = await f.host.request("thread/list", {}, client);
  assert.equal(read.initialTurnsPage.data[0].id, "native-history"); assert.ok(list.data.some((entry: any) => entry.id === old.thread.id));
  assert.deepEqual(await f.calls(), calls); assert.equal(f.host.snapshot().generations[0].pid, null);
  await f.restart();
  assert.equal(f.host.snapshot().generations[0].state, "dormant"); assert.equal(f.host.snapshot().generations[0].pid, null);
  const beforeResume = await f.calls();
  await f.host.request("thread/read", { threadId: old.thread.id }, client);
  assert.deepEqual(await f.calls(), beforeResume);
  await f.host.request("thread/resume", { threadId: old.thread.id }, client);
  const resumes = (await f.calls()).filter((call: any) => call.method === "session/resume");
  assert.equal(resumes.length, 1); assert.equal(resumes[0].sessionId, route.nativeId); assert.equal(resumes[0].build, "a");
  assert.notEqual(f.host.snapshot().generations[0].pid, beforePid); assert.equal(f.host.snapshot().current, "b");
  const fresh = await f.host.request("thread/start", {}, client);
  const newCalls = await f.calls(); assert.equal(newCalls.filter((call: any) => call.method === "session/new").at(-1).build, "b");
  assert.notEqual(fresh.thread.id, old.thread.id);
});

test("ACP preparations and unacknowledged creates block suspension through a default-generation switch", async t => {
  const f = await generationFixture(t);
  const prepared = await f.host.request("opencraft/orchestration/prepare", { operationId: "prepared", sourceSettings: { cwd: f.root }, arguments: {} }, client);
  await f.switchToB();
  await assert.rejects(f.host.manage("suspend", { id: "a" }), /preparations/);
  const child = await f.host.request("opencraft/orchestration/create", { operationId: "prepared", settings: prepared }, client);
  assert.equal(child.generationId, "a");
  await assert.rejects(f.host.manage("suspend", { id: "a" }), /unacknowledged/);
  await f.host.request("opencraft/orchestration/ack", { operationId: "prepared" }, client);
  await f.host.manage("suspend", { id: "a" }); assert.equal(f.host.snapshot().generations[0].pid, null);
});

test("ACP refuses suspension for a peer without native resume support", async t => {
  const f = await generationFixture(t, false);
  await f.host.request("thread/start", {}, client); const pid = f.host.snapshot().generations[0].pid;
  await f.switchToB();
  await assert.rejects(f.host.manage("suspend", { id: "a" }), /cannot resume persisted sessions/);
  assert.equal(f.host.snapshot().generations[0].pid, pid); assert.equal(f.host.snapshot().generations[0].state, "draining");
});

test("ACP rejects changed command options when reopening a pinned dormant generation", async t => {
  const f = await generationFixture(t);
  await f.host.request("thread/start", {}, client); await f.switchToB(); await f.host.manage("suspend", { id: "a" });
  f.configurations.get(join(f.root, "a.json"))!.env.ACP_TEST_BUILD = "different-build";
  await assert.rejects(f.restart(), /Pinned ACP generation command or options changed/);
});

test("ACP native tool callbacks keep a direct human input identity and the originally accepted turn after frontend disconnect", async t => {
  const f = await fixture(t), calls: any[] = [], notices: any[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.engine.setOrchestration({ tools: [{ name: "thread_spawn", description: "spawn", inputSchema: { type: "object" } }],
    async call(threadId, turnId, callId, name, args, _signal, inputId) { calls.push({ threadId, turnId, callId, name, args, inputId }); await blocked; return { threadId: "child" }; } });
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const created = await f.engine.request("thread/start", {}, client), inputId = "human-input:direct-acp-root";
  const started = await f.engine.request("turn/start", { threadId: created.thread.id, clientUserMessageId: inputId, input: [{ type: "text", text: "call:thread_spawn" }] }, client);
  assert.equal(started.turn.items.find((item: any) => item.type === "userMessage").clientId, inputId);
  await until(() => calls.length === 1); const pid = f.engine.processId;
  f.engine.disconnect(client); release();
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  assert.equal(calls[0].inputId, inputId); assert.equal(calls[0].turnId, started.turn.id); assert.equal(calls[0].threadId, created.thread.id);
  assert.equal(f.engine.processId, pid); assert.equal(f.engine.snapshot(created.thread.id).state, "completed");
  assert.equal(f.engine.snapshot(created.thread.id).turnId, started.turn.id);
});

test("ACP source-only preparation does not retain a ticket or wake an old generation", async t => {
  const f = await generationFixture(t), source = await f.host.request("thread/start", {}, client);
  await f.switchToB();
  const settings = await f.host.request("opencraft/orchestration/prepare", { operationId: "context-only", threadId: source.thread.id, sourceOnly: true, arguments: {} }, client);
  assert.equal(settings.orchestrationGenerationId, "a"); assert.equal(f.host.snapshot().current, "b");
  assert.equal(f.host.snapshot().generations[0].occupancy.preparedTickets, 0);
  await f.host.manage("suspend", { id: "a" });
  const calls = await f.calls();
  const dormant = await f.host.request("opencraft/orchestration/prepare", { operationId: "context-only-again", threadId: source.thread.id, sourceOnly: true, arguments: {} }, client);
  assert.equal(dormant.orchestrationGenerationId, "a"); assert.equal(f.host.snapshot().generations[0].state, "dormant");
  assert.equal(f.host.snapshot().generations[0].pid, null); assert.deepEqual(await f.calls(), calls);
});

test("ACP delegated children follow their source generation while ordinary roots and cross-driver destinations follow current", async t => {
  const f = await generationFixture(t), source = await f.host.request("thread/start", {}, client);
  await f.switchToB();
  const delegated = await f.host.request("opencraft/orchestration/prepare", { operationId: "old-source-child", threadId: source.thread.id, arguments: {} }, client);
  assert.equal(delegated.orchestrationGenerationId, "a");
  const child = await f.host.request("opencraft/orchestration/create", { operationId: "old-source-child", settings: delegated }, client);
  assert.equal(child.generationId, "a"); assert.equal(f.host.snapshot().current, "b");
  await f.host.request("opencraft/orchestration/ack", { operationId: "old-source-child" }, client);
  const crossDestination = await f.host.request("opencraft/orchestration/prepare", { operationId: "cross-destination", threadId: source.thread.id, sourceSettings: { cwd: f.root, approvalPolicy: "never", sandbox: "danger-full-access" }, arguments: {} }, client);
  assert.equal(crossDestination.orchestrationGenerationId, "b");
  await f.host.request("opencraft/orchestration/ack", { operationId: "cross-destination" }, client);
  const fresh = await f.host.request("thread/start", {}, client);
  assert.notEqual(fresh.thread.id, source.thread.id); assert.equal((await f.calls()).filter((call: any) => call.method === "session/new").at(-1).build, "b");
  await f.host.manage("suspend", { id: "a" }); assert.equal(f.host.snapshot().generations[0].pid, null);
});

test("ACP concurrent copies of one input share admission while a slow authorization resolves", async t => {
  const f = await fixture(t), created = await f.engine.request("thread/start", {}, client);
  let entered!: () => void, release!: () => void, firstAuthorization = true;
  const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const first = f.engine.inputs.submit(created.thread.id, "actor-input:shared", "quick", async () => {
    if (firstAuthorization) { firstAuthorization = false; entered(); await blocked; } return true;
  });
  await reached;
  const second = f.engine.inputs.submit(created.thread.id, "actor-input:shared", "quick", () => true);
  await delay(30); assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 0);
  release(); const [a, b] = await Promise.all([first, second]);
  assert.equal(a?.state, "delivered"); assert.deepEqual(b, a);
  await until(() => f.engine.snapshot(created.thread.id).state === "completed");
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1);
  assert.equal(f.engine.snapshot(created.thread.id).turnId, a?.turnId);
  assert.deepEqual(await f.engine.inputs.receipt(created.thread.id, "actor-input:shared"), a);
  assert.deepEqual(await f.engine.inputs.submit(created.thread.id, "actor-input:shared", "quick", () => true), a);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1);
});

test("ACP concurrent distinct inputs leave a busy native turn and its receipt intact", async t => {
  const f = await fixture(t), created = await f.engine.request("thread/start", {}, client);
  const [first, second] = await Promise.all([
    f.engine.inputs.submit(created.thread.id, "actor-input:first", "wait", () => true),
    f.engine.inputs.submit(created.thread.id, "actor-input:second", "quick", () => true),
  ]);
  assert.equal(first?.state, "delivered"); assert.equal(second, null);
  assert.equal(f.engine.snapshot(created.thread.id).turnId, first?.turnId);
  assert.deepEqual(await f.engine.inputs.receipt(created.thread.id, "actor-input:first"), first);
  assert.equal(await f.engine.inputs.receipt(created.thread.id, "actor-input:second"), null);
  await until(() => f.engine.snapshot(created.thread.id).state === "completed");
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1);
});

test("ACP prepare replay after a Host restart and default switch retains its sole frozen preparation and creation generation", async t => {
  const f = await generationFixture(t), params = { operationId: "replayed-preparation", sourceSettings: { cwd: f.root, approvalPolicy: "never", sandbox: "danger-full-access" }, arguments: {} };
  const initial = await f.host.request("opencraft/orchestration/prepare", params, client);
  assert.equal(initial.orchestrationGenerationId, "a");
  await f.switchToB(); await f.restart();
  const replay = await f.host.request("opencraft/orchestration/prepare", params, client);
  assert.deepEqual(replay, initial);
  assert.equal(f.host.snapshot().generations[0].occupancy.preparedTickets, 1);
  assert.equal(f.host.snapshot().generations[1].occupancy.preparedTickets, 0);
  const child = await f.host.request("opencraft/orchestration/create", { operationId: params.operationId, settings: replay }, client);
  assert.equal(child.generationId, "a"); assert.equal(f.host.snapshot().current, "b");
  const afterCreate = await f.host.request("opencraft/orchestration/prepare", params, client);
  assert.deepEqual(afterCreate, initial); assert.equal(f.host.snapshot().generations[1].occupancy.preparedTickets, 0);
  await f.host.request("opencraft/orchestration/ack", { operationId: params.operationId }, client);
  await f.host.manage("suspend", { id: "a" }); assert.equal(f.host.snapshot().generations[0].pid, null);
});

test("ACP source context lookup ignores a same-operation destination ticket in a different generation", async t => {
  const f = await generationFixture(t), source = await f.host.request("thread/start", {}, client);
  await f.switchToB();
  const target = await f.host.request("opencraft/orchestration/prepare", { operationId: "source-and-target", threadId: source.thread.id, sourceSettings: { cwd: f.root }, arguments: {} }, client);
  assert.equal(target.orchestrationGenerationId, "b");
  const context = await f.host.request("opencraft/orchestration/prepare", { operationId: "source-and-target", threadId: source.thread.id, sourceOnly: true, arguments: {} }, client);
  assert.equal(context.orchestrationGenerationId, "a"); assert.equal(f.host.snapshot().generations[0].occupancy.preparedTickets, 0);
  await f.host.manage("suspend", { id: "a" }); assert.equal(f.host.snapshot().generations[0].pid, null);
});

test("P2c ACP preparation is bound to Host incarnation and admission epoch, including ABA", async t => {
  const f = await generationFixture(t);
  await f.host.manage("add", { id: "b", configPath: join(f.root, "b.json"), expectedCurrent: "a" });
  const first = await f.host.manage("preparation", { id: "b" });
  await f.host.manage("activate", { id: "b", expectedCurrent: "a", preparation: first.preparation });
  await f.host.manage("activate", { id: "a", expectedCurrent: "b" });
  await assert.rejects(f.host.manage("activate", { id: "b", expectedCurrent: "a", preparation: first.preparation }), /preparation/);
  const next = await f.host.manage("preparation", { id: "b" });
  const before = f.host.snapshot().ownerIncarnation;
  await f.restart(); assert.notEqual(f.host.snapshot().ownerIncarnation, before);
  await assert.rejects(f.host.manage("preparation", { id: "b", expectedOwner: before }), /owner changed/);
  await assert.rejects(f.host.manage("activate", { id: "b", expectedCurrent: "a", preparation: next.preparation }), /preparation/);
  assert.equal(f.host.snapshot().current, "a");
});
