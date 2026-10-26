import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiEngine, piModel } from "../../plugins/pi-engine/src/index.js";
import type { ExecutionEngineClient } from "@opencraft/appserver-client";
import { startEngineHost } from "../../apps/local-agent-host/src/engine-host.js";
import WebSocket from "ws";

const noTools: ExecutionEngineClient = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
function fixtureModels(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], tokensPerSecond = 10000) {
  const faux = fauxProvider({ tokensPerSecond }); faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models: Object.assign(models, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime };
}
async function fixture(t: test.TestContext, responses: Parameters<typeof fixtureModels>[0], tokensPerSecond?: number) {
  const directory = await mkdtemp(join(tmpdir(), "opencraft-pi-durable-"));
  const { models, faux } = fixtureModels(responses, tokensPerSecond);
  const engine = new PiEngine({ directory, cwd: directory, models });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, engine, faux };
}
function completed(engine: PiEngine) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Pi did not settle")); }, 10_000);
    const stop = engine.subscribe((method, params) => {
      if (method === "turn/completed") { clearTimeout(timer); stop(); resolve(params.turn); }
    });
  });
}

test("native durable session streams, persists and restores without DSH", async t => {
  const f = await fixture(t, [fauxAssistantMessage("hello\u2028world")]);
  const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory }, noTools);
  const threadId = created.thread.id; assert.equal(created.thread.modelProvider, "pi");
  const done = completed(f.engine);
  const started = await f.engine.request("turn/start", { threadId, clientUserMessageId: "hello-client", input: [{ type: "text", text: "hello" }] }, noTools);
  assert.equal((await done).status, "completed");
  const retry = await f.engine.request("turn/start", { threadId, clientUserMessageId: "hello-client", input: [{ type: "text", text: "hello" }] }, noTools);
  assert.equal(retry.turn.id, started.turn.id);
  await f.engine.close();
  const models = fixtureModels([]).models;
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models }); t.after(() => reopened.close());
  const resumed = await reopened.request("thread/resume", { threadId }, noTools);
  assert.equal(resumed.thread.turns[0].id, started.turn.id);
  assert.equal(resumed.thread.turns.length, 1);
  assert.equal(resumed.thread.turns[0].items.find((item: any) => item.type === "userMessage").clientId, "hello-client");
  assert.equal(resumed.thread.turns[0].status, "completed");
  assert.equal(resumed.thread.turns[0].items.find((item: any) => item.type === "agentMessage").text, "hello\u2028world");
  await assert.rejects(reopened.request("turn/start", { threadId, model: "dsh:model", input: [{ type: "text", text: "wrong engine" }] }, noTools), /belongs to Pi/);
});

test("platform tool calls are namespaced and use the live owner", async t => {
  const f = await fixture(t, [fauxAssistantMessage([fauxToolCall("opencraft_0_lookup", { key: "one" }, { id: "tool-one" })], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  let called = 0;
  const owner: ExecutionEngineClient = { notify() {}, async request(method, params) {
    called++; assert.equal(method, "item/tool/call"); assert.equal(params.namespace, "platform"); assert.equal(params.tool, "lookup");
    return { success: true, contentItems: [{ type: "inputText", text: "result" }] };
  } };
  const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory,
    dynamicTools: [{ type: "namespace", name: "platform", tools: [{ type: "function", name: "lookup", description: "Lookup a key", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] }] }, owner);
  const done = completed(f.engine);
  await f.engine.request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "lookup" }] }, owner);
  assert.equal((await done).status, "completed"); assert.equal(called, 1);
  const read = await f.engine.request("thread/read", { threadId: created.thread.id, includeTurns: true }, owner);
  assert.equal(read.thread.turns[0].items.find((item: any) => item.type === "dynamicToolCall").status, "completed");
});

test("closing a durable owner suspends work; reopening resumes the same input", async t => {
  const f = await fixture(t, [fauxAssistantMessage("unfinished response ".repeat(20))], 20);
  const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory }, noTools);
  const threadId = created.thread.id;
  const partial = new Promise<void>(resolve => {
    const stop = f.engine.subscribe(method => { if (method === "item/agentMessage/delta") { stop(); resolve(); } });
  });
  const started = await f.engine.request("turn/start", { threadId, input: [{ type: "text", text: "work" }] }, noTools);
  await partial; await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([fauxAssistantMessage("recovered")]).models });
  t.after(() => reopened.close());
  const done = completed(reopened);
  const restored = await reopened.request("thread/resume", { threadId }, noTools);
  assert.equal(restored.thread.turns[0].id, started.turn.id);
  assert.equal((await done).status, "completed");
  const read = await reopened.request("thread/read", { threadId, includeTurns: true }, noTools);
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].items.filter((item: any) => item.type === "userMessage").length, 1);
});

test("Pi-only Host routes models and threads without allocating a legacy Host", async t => {
  const f = await fixture(t, []);
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  const socket = new WebSocket(host.websocketUrl); t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let next = 0;
  const call = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++next;
    const listener = (data: WebSocket.RawData) => { const reply = JSON.parse(data.toString()); if (reply.id !== id) return;
      socket.off("message", listener); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result); };
    socket.on("message", listener); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const initialized = await call("initialize"); assert.equal(initialized.capabilities.extensions["opencraft/execution-engines"].defaultEngine, "pi");
  assert.equal(initialized.capabilities.extensions["opencraft/permission-modes"].version, 1);
  assert.deepEqual((await call("permissionProfile/list")).data.map((p: any) => p.openCraftLabel), ["Full access"]);
  assert.equal((host.storageOutcomes[0] as any).name, "pi-conversation-schedules");
  const project = await call("project/create", { name: "Pi workspace", roots: [{ path: f.directory }], idempotencyKey: "pi-only-project" });
  assert.equal((await call("project/list")).data[0].id, project.project.id);
  assert.equal((await call("fs/getMetadata", { path: f.directory })).isDirectory, true);
  const models = await call("model/list"); assert.equal(models.data[0].groupLabel, "Pi · faux"); assert.equal(models.data[0].isDefault, true);
  const thread = await call("thread/start", { model: models.data[0].model, cwd: f.directory }); assert.match(thread.thread.id, /^pi_/);
  await assert.rejects(call("turn/start", { threadId: "existing-dsh-thread", model: models.data[0].model }), /change execution engines/);
});

test("cancelling a pending platform tool settles the turn and preserves native interruption", async t => {
  const f = await fixture(t, [fauxAssistantMessage([fauxToolCall("opencraft_0_wait", {}, { id: "blocked-tool" })], { stopReason: "toolUse" })]);
  let invoked!: () => void;
  const called = new Promise<void>(resolve => { invoked = resolve; });
  const owner: ExecutionEngineClient = { notify() {}, request() { invoked(); return new Promise(() => {}); } };
  const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"),
    dynamicTools: [{ type: "function", name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }] }, owner);
  const started = await f.engine.request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "wait" }] }, owner);
  await called;
  await assert.rejects(f.engine.request("runtime/capabilities/register", { threadId: created.thread.id }, noTools), /owner during a Pi turn/);
  const done = completed(f.engine);
  f.engine.disconnect(owner);
  await f.engine.request("turn/interrupt", { threadId: created.thread.id, turnId: started.turn.id }, noTools);
  assert.equal((await done).status, "interrupted");
  await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models }); t.after(() => reopened.close());
  const restored = await reopened.request("thread/resume", { threadId: created.thread.id }, noTools);
  assert.equal(restored.thread.turns[0].id, started.turn.id);
  assert.equal(restored.thread.turns[0].status, "interrupted");
});

test("engine capabilities override host defaults without changing legacy threads", async () => {
  const { executionEngineExtension } = await import("../../packages/appserver-client/src/execution-engine.js");
  const goal = { version: 1 };
  const extensions = { "opencraft/thread-goal": goal, "opencraft/execution-engines": { providers: [{ threadPrefix: "pi_", modelPrefix: "pi:", extensions: {} }] } };
  assert.equal(executionEngineExtension(extensions, "dsh-existing", "opencraft/thread-goal"), goal);
  assert.equal(executionEngineExtension(extensions, "pi_session", "opencraft/thread-goal"), undefined);
  assert.equal(executionEngineExtension(extensions, piModel("faux", "faux-1"), "opencraft/thread-goal"), undefined);
});


test("durable Host clients send outbox input to Pi without DSH queue or history APIs", async t => {
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  const f = await fixture(t, [fauxAssistantMessage("outbox accepted")]);
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  const sent: string[] = [];
  let rows: any[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-fixture", hostKind: "durable",
    outbox: { read: () => rows, write: (_key, next) => { rows = [...next]; }, subscribe: () => () => {} },
    createTransport: () => {
      const transport = new WebSocketTransport(host.websocketUrl);
      const send = transport.send.bind(transport);
      transport.send = frame => { sent.push(JSON.parse(frame).method); return send(frame); };
      return transport;
    },
  });
  t.after(() => runtime.dispose());
  await runtime.connect();
  const thread = await runtime.resources.threads.start({ model: piModel("faux", "faux-1"), cwd: f.directory });
  const lease = await runtime.acquireThread(thread.id); t.after(() => lease.release());
  for (let i = 0; i < 100 && !lease.getSnapshot().authoritative; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lease.getSnapshot().authoritative, true);
  const done = completed(f.engine);
  await lease.submit({ commandId: "command-one", clientMessageId: "outbox-client", target: { type: "existing-thread", key: lease.getSnapshot().key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "outbox input" }] }] },
    attachments: [], context: [], selections: { model: piModel("faux", "faux-1"), permissionProfile: null }, options: { autoContext: true }, createdAt: 1 });
  assert.equal((await done).status, "completed");
  assert.ok(sent.includes("turn/start"));
  assert.ok(!sent.includes("thread/queue/add"));
  assert.ok(!sent.includes("thread/turns/list"));
});


test("workspace first submission accepts native full access and retains project ownership on restart", async t => {
  const f = await fixture(t, [fauxAssistantMessage("First workspace reply")]);
  const permissions = "opencraft:permission-mode:full";
  const created = await f.engine.request("thread/start", {
    model: piModel("faux", "faux-1"), permissions, projectId: "workspace-project", cwd: f.directory,
    runtimeWorkspaceRoots: [f.directory], serviceTier: null, historyMode: "paginated",
  }, noTools);
  assert.equal(created.thread.projectId, "workspace-project");
  assert.equal(created.activePermissionProfile.id, permissions);
  const done = completed(f.engine);
  await f.engine.request("turn/start", { threadId: created.thread.id, permissions,
    sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never",
    clientUserMessageId: "workspace-first", input: [{ type: "text", text: "hello workspace" }] }, noTools);
  assert.equal((await done).status, "completed");
  await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models });
  t.after(() => reopened.close());
  const restored = await reopened.request("thread/resume", { threadId: created.thread.id, permissions }, noTools);
  assert.equal(restored.thread.projectId, "workspace-project");
  assert.equal(restored.activePermissionProfile.id, permissions);
  assert.equal(restored.thread.turns[0].items.find((item: any) => item.type === "agentMessage").text, "First workspace reply");
  for (const method of ["thread/start", "thread/resume", "turn/start"]) {
    for (const override of [{ permissions: "opencraft:permission-mode:read-only" }, { permissions: "custom-profile" },
      { sandbox: "workspace-write" }, { sandboxPolicy: { type: "workspaceWrite" } }, { approvalPolicy: "on-request" }]) {
      await assert.rejects(reopened.request(method, { threadId: created.thread.id, model: piModel("faux", "faux-1"),
        input: [{ type: "text", text: "must not execute" }], ...override }, noTools), /Full access only/);
    }
  }
  const instructed = await reopened.request("thread/start", { model: piModel("faux", "faux-1"), developerInstructions: "do not discard" }, noTools);
  assert.equal(instructed.thread.historyMode, "paginated");
  assert.equal((await reopened.request("thread/read", { threadId: created.thread.id, includeTurns: true }, noTools)).thread.turns.length, 1);
});

test("Pi workspace outbox drains after baseline into the durable server queue", async t => {
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  const f = await fixture(t, [fauxAssistantMessage("workspace outbox replied ".repeat(10)), fauxAssistantMessage("queued follow-up replied")], 100);
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  let rows: any[] = [];
  const methods: string[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-first-message", hostKind: "durable",
    dynamicTools: [{ type: "namespace", name: "platform", description: "Platform", tools: [{ type: "function", name: "lookup", description: "Lookup", inputSchema: { type: "object" } }] }],
    outbox: { read: () => rows, write: (_key, next) => { rows = [...next]; }, subscribe: () => () => {} },
    createTransport: () => {
      const transport = new WebSocketTransport(host.websocketUrl), send = transport.send.bind(transport);
      transport.send = frame => { methods.push(JSON.parse(frame).method); return send(frame); }; return transport;
    },
  });
  t.after(() => runtime.dispose()); await runtime.connect();
  const thread = await runtime.resources.threads.start({ model: piModel("faux", "faux-1"), cwd: f.directory,
    permissions: "opencraft:permission-mode:full", projectId: "first-message-project" });
  const lease = await runtime.acquireThread(thread.id); t.after(() => lease.release());
  assert.equal(lease.getSnapshot().authoritative, false);
  const partial = new Promise<void>(resolve => {
    const stop = f.engine.subscribe(method => { if (method === "item/agentMessage/delta") { stop(); resolve(); } });
  });
  const done = new Promise<void>((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => { stop(); reject(new Error("Both Pi outbox messages did not settle")); }, 10_000);
    const stop = f.engine.subscribe((method, params) => {
      if (method !== "turn/completed") return;
      assert.equal(params.turn.status, "completed");
      if (++count === 2) { clearTimeout(timer); stop(); resolve(); }
    });
  });
  await lease.submit({ commandId: "first-workspace-command", clientMessageId: "first-workspace-client",
    target: { type: "existing-thread", key: lease.getSnapshot().key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "first workspace input" }] }] },
    attachments: [], context: [], selections: { model: piModel("faux", "faux-1"), effort: "none", permissionProfile: "opencraft:permission-mode:full" },
    options: { autoContext: true }, createdAt: 1 });
  await partial;
  await lease.submit({ commandId: "second-workspace-command", clientMessageId: "second-workspace-client",
    target: { type: "enqueue-follow-up", key: lease.getSnapshot().key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "second workspace input" }] }] },
    attachments: [], context: [], selections: { model: piModel("faux", "faux-1"), permissionProfile: "opencraft:permission-mode:full" },
    options: { autoContext: true }, createdAt: 2 });
  assert.equal(rows.length, 0, "the server retains follow-up custody after ACK");
  await done;
  for (let i = 0; i < 100 && (lease.getSnapshot().threadStatus as any)?.type !== "idle"; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((lease.getSnapshot().threadStatus as any)?.type, "idle");
  assert.ok(methods.includes("runtime/capabilities/register"));
  assert.equal(methods.filter(method => method === "thread/queue/add").length, 2);
  assert.ok(methods.includes("thread/queue/add"));
  const restored = await f.engine.request("thread/read", { threadId: thread.id, includeTurns: true }, noTools);
  assert.equal(restored.thread.projectId, "first-message-project");
  assert.equal(restored.thread.turns.length, 2);
  assert.equal(restored.thread.turns[0].items.find((item: any) => item.type === "userMessage").clientId, "first-workspace-client");
  assert.equal(restored.thread.turns[1].items.find((item: any) => item.type === "userMessage").clientId, "second-workspace-client");
});

test("Pi native input metadata, context, thinking, identity and timing survive restart", async t => {
  const { fauxThinking } = await import("@earendil-works/pi-ai/providers/faux");
  let captured = "";
  const f = await fixture(t, [(ctx: any) => { captured = JSON.stringify(ctx); return fauxAssistantMessage([fauxThinking("reasoning body"), { type: "text", text: "answer body" }]); }]);
  const created = await f.engine.request("thread/start", { cwd: f.directory, baseInstructions: "BASE_CONTRACT", developerInstructions: "DEVELOPER_CONTRACT" }, noTools);
  const input = [{ type: "text", text: "question", text_elements: [{ byteRange: { start: 0, end: 8 }, placeholder: "element" }] }];
  const params = { threadId: created.thread.id, clientUserMessageId: "stable-input", input,
    additionalContext: { app: { kind: "application", value: "APPLICATION_CONTEXT" }, file: { kind: "untrusted", value: "UNTRUSTED_CONTEXT" } } };
  const done = completed(f.engine);
  await f.engine.request("turn/start", params, noTools);
  const final = structuredClone(await done);
  assert.match(captured, /BASE_CONTRACT/); assert.match(captured, /DEVELOPER_CONTRACT/);
  assert.match(captured, /APPLICATION_CONTEXT/); assert.match(captured, /UNTRUSTED_CONTEXT/);
  assert.ok(final.items.some((item: any) => item.type === "reasoning" && item.content.includes("reasoning body")));
  assert.notEqual(final.durationMs, null); assert.notEqual(final.completedAt, null);
  const read = await f.engine.request("thread/read", { threadId: created.thread.id, includeTurns: true }, noTools);
  assert.deepEqual(read.thread.turns[0], final);
  assert.deepEqual(final.items[0].content, input);
  await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models }); t.after(() => reopened.close());
  const restored = await reopened.request("thread/resume", { threadId: created.thread.id }, noTools);
  assert.deepEqual(restored.thread.turns[0], final);
  const retry = await reopened.request("turn/start", params, noTools);
  assert.deepEqual(retry.turn, final); assert.equal(restored.thread.turns.length, 1);
});

test("Pi applies saved defaults and durable resume overrides, rejects unsupported semantics", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-config-contract-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const other = join(directory, "other"); const { mkdir } = await import("node:fs/promises"); await mkdir(other);
  const faux = fauxProvider({ models: [{ id: "first", reasoning: true }, { id: "second", reasoning: true }] });
  const runtime = createModels(); runtime.setProvider(faux.provider);
  const models = Object.assign(runtime, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime;
  const engine = new PiEngine({ directory, cwd: directory, models }); t.after(() => engine.close());
  await engine.request("config/batchWrite", { edits: [{ keyPath: "model", value: piModel("faux", "second") }, { keyPath: "model_reasoning_effort", value: "high" }] }, noTools);
  const created = await engine.request("thread/start", {}, noTools);
  assert.equal(created.model, piModel("faux", "second")); assert.equal(created.reasoningEffort, "high");
  assert.deepEqual((await engine.models()).filter(model => model.isDefault).map(model => model.model), [piModel("faux", "second")]);
  const host = await startEngineHost({ providers: [engine], defaultEngine: "pi" }); t.after(() => host.close());
  const socket = new WebSocket(host.websocketUrl); t.after(() => socket.terminate());
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  let next = 0;
  const call = (method: string) => new Promise<any>((resolve, reject) => {
    const id = ++next;
    const listener = (data: WebSocket.RawData) => { const reply = JSON.parse(data.toString()); if (reply.id !== id) return;
      socket.off("message", listener); reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result); };
    socket.on("message", listener); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
  });
  await call("initialize");
  assert.deepEqual((await call("model/list")).data.filter((model: any) => model.isDefault).map((model: any) => model.model), [piModel("faux", "second")]);
  const resumed = await engine.request("thread/resume", { threadId: created.thread.id, model: piModel("faux", "first"), cwd: other,
    excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
    runtimeWorkspaceRoots: [other], baseInstructions: "replacement", developerInstructions: "developer" }, noTools);
  assert.equal(resumed.model, piModel("faux", "first")); assert.equal(resumed.cwd, other);
  assert.equal(resumed.thread.historyMode, "paginated"); assert.deepEqual(resumed.initialTurnsPage, { data: [], nextCursor: null, backwardsCursor: null, itemsPaginationByTurnId: {} });
  for (const fields of [{ outputSchema: { type: "object" } }, { serviceTier: "priority" }, { disabledPluginIds: ["opencraft"] },
    { runtimeWorkspaceRoots: [directory, other] }, { collaborationMode: { mode: "plan" } }]) {
    await assert.rejects(engine.request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "question" }], ...fields }, noTools));
  }
  await assert.rejects(engine.request("thread/resume", { threadId: created.thread.id, history: [] }, noTools), /history/);
  await engine.close();
  const reopened = new PiEngine({ directory, cwd: directory, models }); t.after(() => reopened.close());
  const restored = await reopened.request("thread/resume", { threadId: created.thread.id }, noTools);
  assert.equal(restored.cwd, other); assert.equal(restored.model, piModel("faux", "first")); assert.equal(restored.reasoningEffort, "high");
});

test("Pi catalog filters before sorting, and one corrupt index cannot disable other threads", async t => {
  const f = await fixture(t, []);
  const a = await f.engine.request("thread/start", { projectId: "A" }, noTools);
  const b = await f.engine.request("thread/start", { projectId: "B" }, noTools);
  assert.deepEqual((await f.engine.request("thread/list", { projectId: "A" }, noTools)).data.map((row: any) => row.id), [a.thread.id]);
  for (const filter of [{ projectId: null }, { cwd: "/missing-workspace" }, { modelProviders: ["other"] }, { sourceKinds: ["cli"] }, { sectionId: "section" }, { parentThreadId: a.thread.id }])
    assert.equal((await f.engine.request("thread/list", filter, noTools)).data.length, 0);
  const rows = (await f.engine.request("thread/list", { sortKey: "created_at", sortDirection: "asc" }, noTools)).data;
  assert.equal(rows.length, 2); assert.ok(rows[0].createdAt <= rows[1].createdAt);
  const { writeFile } = await import("node:fs/promises");
  await f.engine.close(); await writeFile(join(f.directory, "pi_deadbeef.json"), "{broken");
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models }); t.after(() => reopened.close());
  const restored = await reopened.request("thread/list", {}, noTools); assert.equal(restored.data.length, 2);
  assert.ok(restored.data.some((row: any) => row.id === b.thread.id));
});

test("Pi reattaches an expired owner during a live turn without stealing a live lease", async t => {
  const f = await fixture(t, [fauxAssistantMessage("a deliberately slow answer for reconnect")], 5);
  const a = { ...noTools }, b = { ...noTools };
  const created = await f.engine.request("thread/start", {}, a), threadId = created.thread.id;
  await f.engine.request("turn/start", { threadId, input: [{ type: "text", text: "question" }] }, a);
  await assert.rejects(f.engine.request("runtime/capabilities/register", { threadId, dynamicTools: [] }, b), /owner during a Pi turn/);
  f.engine.disconnect(a);
  await f.engine.request("thread/resume", { threadId }, b);
  assert.equal((await f.engine.request("runtime/capabilities/register", { threadId, dynamicTools: [] }, b)).registered, 0);
  await f.engine.request("turn/interrupt", { threadId }, b);
});

test("Pi platform images preserve model content and original tool namespace in live and restored history", async t => {
  let modelContext = "";
  const f = await fixture(t, [fauxAssistantMessage([fauxToolCall("opencraft_0_lookup", {}, { id: "media-call" })], { stopReason: "toolUse" }),
    (ctx: any) => { modelContext = JSON.stringify(ctx); return fauxAssistantMessage("done"); }]);
  const owner = { notify() {}, async request() { return { success: true, contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,AA==" }] }; } };
  const created = await f.engine.request("thread/start", { dynamicTools: [{ type: "namespace", name: "platform", tools: [{ type: "function", name: "lookup", description: "lookup", inputSchema: { type: "object" } }] }] }, owner);
  const done = completed(f.engine);
  await f.engine.request("turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "lookup" }] }, owner);
  const final = structuredClone(await done), tool = final.items.find((item: any) => item.type === "dynamicToolCall");
  assert.equal(tool.namespace, "platform"); assert.equal(tool.tool, "lookup"); assert.equal(tool.success, true);
  assert.equal(tool.contentItems[0].type, "inputImage"); assert.notEqual(tool.durationMs, null); assert.match(modelContext, /image\/png/);
  assert.deepEqual((await f.engine.request("thread/read", { threadId: created.thread.id, includeTurns: true }, owner)).thread.turns[0], final);
});

test("Pi file/skill/image input is explicit and upload staging works without DSH", async t => {
  const f = await fixture(t, []);
  const { LocalHostResources } = await import("../../apps/local-agent-host/src/host-resources.js");
  const { compilePiInput } = await import("../../plugins/pi-engine/src/input.js");
  const { writeFile } = await import("node:fs/promises");
  const resources = new LocalHostResources({ projectDirectory: join(f.directory, "projects"), attachmentDirectory: join(f.directory, "attachments") });
  t.after(() => resources.close());
  const staged: any = await resources.request("attachment/stage", { clientAttachmentId: "file-one", name: "note.txt", mimeType: "text/plain", size: 4,
    source: { kind: "client-bytes", dataBase64: Buffer.from("note").toString("base64") } });
  const ref = staged.attachment ?? staged.ref;
  assert.equal(ref.location.kind, "host-file");
  const skill = join(f.directory, "SKILL.md"); await writeFile(skill, "SKILL_CONTENT");
  const compiled = await compilePiInput([{ type: "mention", name: "note.txt", path: ref.location.path }, { type: "skill", name: "selected", path: skill }], null, f.directory, { input: ["text"] });
  assert.match(JSON.stringify(compiled), /SKILL_CONTENT/); assert.match(JSON.stringify(compiled), /note.txt/);
  await assert.rejects(compilePiInput([{ type: "image", url: "data:image/png;base64,AA==" }], null, f.directory, { input: ["text"] }), /does not support image/);
  const image = await compilePiInput([{ type: "image", url: "data:image/png;base64,AA==" }], null, f.directory, { input: ["text", "image"] });
  assert.equal(image[0].mimeType, "image/png");
  const stagedImage: any = await resources.request("attachment/stage", { clientAttachmentId: "image-one", name: "sample.png", mimeType: "image/png", size: 1,
    source: { kind: "client-bytes", dataBase64: "AA==" } });
  const imageRef = stagedImage.attachment ?? stagedImage.ref;
  const byFileId = await compilePiInput([{ type: "image", fileId: imageRef.id }], null, f.directory, { input: ["image"] }, { attachmentDirectory: join(f.directory, "attachments") });
  assert.deepEqual(byFileId[0], image[0]);
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "image/png", "content-length": "1" }); response.end(Buffer.from([0])); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === "object");
  const remote = await compilePiInput([{ type: "image", url: `http://127.0.0.1:${address.port}/sample.png` }], null, f.directory, { input: ["image"] });
  assert.deepEqual(remote[0], image[0]);
  await assert.rejects(compilePiInput([{ type: "image", fileId: "missing-image" }], null, f.directory, { input: ["image"] }, { attachmentDirectory: join(f.directory, "attachments") }), /ENOENT|manifest/);
  await assert.rejects(compilePiInput([{ type: "localImage", path: join(f.directory, "missing.png") }], null, f.directory, { input: ["image"] }));
  await assert.rejects(compilePiInput([{ type: "audio", url: "data:audio/wav;base64,AA==" }], null, f.directory, { input: ["text"] }), /input.audio/);
});


test("Pi online first attachment waits for baseline without claiming offline custody", async t => {
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  const { writeFile } = await import("node:fs/promises");
  let modelContext = "";
  const f = await fixture(t, [(context: any) => { modelContext = JSON.stringify(context); return fauxAssistantMessage("file received"); }]);
  const file = join(f.directory, "first-attachment.txt"); await writeFile(file, "note");
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  const methods: string[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-first-attachment", hostKind: "durable",
    outbox: { read: () => [], write: () => { throw new Error("Attachment must not enter the offline outbox"); }, subscribe: () => () => {} },
    createTransport: () => {
      const transport = new WebSocketTransport(host.websocketUrl), send = transport.send.bind(transport);
      transport.send = frame => { methods.push(JSON.parse(frame).method); return send(frame); }; return transport;
    },
  });
  t.after(() => runtime.dispose()); await runtime.connect();
  const thread = await runtime.resources.threads.start({ model: piModel("faux", "faux-1"), cwd: f.directory });
  const lease = await runtime.acquireThread(thread.id); t.after(() => lease.release());
  assert.equal(lease.getSnapshot().authoritative, false);
  const done = completed(f.engine);
  const receipt = await lease.submit({ commandId: "first-attachment-command", clientMessageId: "first-attachment-client",
    target: { type: "existing-thread", key: lease.getSnapshot().key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "Read the file" }] }] },
    attachments: [{ id: "first-attachment", kind: "file", name: "first-attachment.txt", mimeType: "text/plain", size: 4,
      uri: `file://${file}`, lifecycle: "ready", error: null }],
    context: [], selections: { model: piModel("faux", "faux-1"), permissionProfile: "opencraft:permission-mode:full" }, options: { autoContext: true }, createdAt: Date.now(),
  });
  assert.notEqual(receipt.disposition, "local-queue"); assert.equal((await done).status, "completed");
  assert.match(modelContext, /first-attachment.txt/); assert.equal(methods.filter(method => method === "turn/start").length, 1);
  assert.ok(methods.indexOf("thread/resume") < methods.indexOf("turn/start"));
});


test("Pi native compaction and passive context writes never invent user Turns", async t => {
  const { Harness, createRegistry, CompactionEntry } = await import("@earendil-works/pi-durable");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
  const { writeFile } = await import("node:fs/promises");
  const { randomUUID } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "pi-native-compaction-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const { models } = fixtureModels([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"),
    fauxAssistantMessage("native compaction summary"), fauxAssistantMessage("third answer")]);
  const id = `pi_${randomUUID()}`, file = join(directory, `${id}.sqlite`);
  const storage = await openNodeSqliteStorage(file);
  const harness = await Harness.open(storage, { models, registry: createRegistry(), settings: { compaction: { enabled: false, keepRecentTokens: 1 } } }, context);
  t.after(() => harness.close(context));
  const root = await harness.root(context); await root.configure({ model: { provider: "faux", modelId: "faux-1" }, cwd: directory }, context);
  const submit = async (n: number) => {
    const requestId = `${id}:turn:client:input-${n}`, text = `user input ${n}`;
    const submission = await root.submit({ type: "input", content: text, requestId, whenBusy: "reject",
      entry: { kind: "opencraft.input", data: { turnId: requestId, clientId: `input-${n}`, input: [{ type: "text", text, text_elements: [] }], createdAtMs: Date.now() } } }, context);
    assert.equal((await submission.wait(context)).status, "done");
  };
  await submit(1); await submit(2);
  const task = await root.compact(undefined, context); await harness.waitForTask(task, context);
  const compacted = await root.context(context); assert.ok(compacted.entries.some(entry => CompactionEntry.is(entry)));
  const write = await root.submit({ type: "write", entry: { kind: "application.context", model: [{ role: "user", content: [{ type: "text", text: "passive context" }], timestamp: Date.now() }] } }, context);
  assert.equal((await write.wait(context)).status, "done");
  await submit(3); await harness.close(context);
  const now = Math.floor(Date.now() / 1000);
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ format: "pi-durable-1", id, cwd: directory,
    model: piModel("faux", "faux-1"), name: null, preview: "", createdAt: now, updatedAt: now, archived: false, tools: [] }));
  const engine = new PiEngine({ directory, cwd: directory, models }); t.after(() => engine.close());
  const history = (await engine.request("thread/read", { threadId: id, includeTurns: true }, noTools)).thread.turns;
  assert.equal(history.length, 3); assert.deepEqual(history.map((turn: any) => turn.items[0].clientId), ["input-1", "input-2", "input-3"]);
  assert.equal(history.flatMap((turn: any) => turn.items).filter((item: any) => item.type === "contextCompaction").length, 1);
  assert.ok(history.every((turn: any) => turn.status === "completed"));
  await engine.close();
  const reopened = new PiEngine({ directory, cwd: directory, models }); t.after(() => reopened.close());
  assert.deepEqual((await reopened.request("thread/resume", { threadId: id }, noTools)).thread.turns, history);
});

test("temporary Pi fork inherits committed context, stays memory-only and closes independently", async t => {
  const prompts: string[] = [];
  const f = await fixture(t, [fauxAssistantMessage("parent answer"), context => {
    prompts.push(JSON.stringify(context)); return fauxAssistantMessage("side answer");
  }, context => { prompts.push(JSON.stringify(context)); return fauxAssistantMessage("second side answer"); }]);
  const parent = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory,
    developerInstructions: "parent developer policy", baseInstructions: "parent base policy", effort: "none" }, noTools);
  let done = completed(f.engine);
  await f.engine.request("turn/start", { threadId: parent.thread.id, input: [{ type: "text", text: "parent question" }] }, noTools); await done;
  const before = await f.engine.request("thread/read", { threadId: parent.thread.id, includeTurns: true }, noTools);
  const files = (await readdir(f.directory)).filter(file => !file.endsWith(".tmp")).sort();
  const child = await f.engine.request("thread/fork", { threadId: parent.thread.id, ephemeral: true, excludeTurns: true,
    developerInstructions: "side policy" }, noTools);
  const threadId = child.thread.id;
  assert.equal(child.thread.ephemeral, true); assert.equal(child.thread.path, null);
  assert.equal(child.thread.forkedFromId, parent.thread.id);
  assert.equal(child.model, parent.model); assert.equal(child.reasoningEffort, parent.reasoningEffort);
  await f.engine.request("thread/inject_items", { threadId, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "side boundary" }] }] }, noTools);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual((await f.engine.request("thread/read", { threadId, includeTurns: true }, noTools)).thread.turns, []);
  await f.engine.request("runtime/capabilities/register", { threadId, dynamicTools: [{ type: "function", name: "unused", description: "unused", inputSchema: { type: "object" } }] }, noTools);
  for (const text of ["child first", "child second"]) {
    done = completed(f.engine);
    await f.engine.request("turn/start", { threadId, input: [{ type: "text", text }] }, noTools);
    assert.equal((await done).status, "completed");
  }
  for (const text of ["parent question", "parent answer", "parent developer policy", "parent base policy", "side policy", "side boundary"])
    assert.ok(prompts[0]!.includes(text), `Missing inherited context: ${text}`);
  assert.match(prompts[1]!, /side answer/); assert.match(prompts[1]!, /child second/);
  assert.equal((await f.engine.request("thread/read", { threadId, includeTurns: true }, noTools)).thread.turns.length, 2);
  assert.deepEqual(await f.engine.request("thread/read", { threadId: parent.thread.id, includeTurns: true }, noTools), before);
  assert.deepEqual((await f.engine.request("thread/list", {}, noTools)).data.map((row: any) => row.id), [parent.thread.id]);
  assert.deepEqual((await readdir(f.directory)).filter(file => !file.endsWith(".tmp")).sort(), files);
  await f.engine.request("thread/unsubscribe", { threadId }, noTools);
  await assert.rejects(f.engine.request("thread/read", { threadId }, noTools), /not found/);
  assert.deepEqual((await readdir(f.directory)).filter(file => !file.endsWith(".tmp")).sort(), files);
  await assert.rejects(f.engine.request("thread/fork", { threadId: parent.thread.id }, noTools), /temporary forks/);
});

test("Pi side chat opens through the shared service over the actual Engine Host", async t => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { createConversationKey } = await import("@opencraft/chat-core");
  const { SideChatService } = await import("../../packages/workbench-runtime/src/side-chat/service.js");
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  const f = await fixture(t, [fauxAssistantMessage("shared child answer")]);
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  const sent: string[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-side", hostKind: "durable", createTransport: () => {
    const transport = new WebSocketTransport(host.websocketUrl), send = transport.send.bind(transport);
    transport.send = frame => { sent.push(JSON.parse(frame).method); return send(frame); }; return transport;
  } });
  t.after(() => runtime.dispose()); await runtime.connect();
  const parent = await runtime.resources.threads.start({ model: piModel("faux", "faux-1"), cwd: f.directory });
  assert.equal(runtime.resources.threads.capabilities(parent.id).fork, false);
  assert.equal(runtime.resources.threads.supportsSideChat!(parent.id), true);
  const service = new SideChatService(new Context(), { resolveHost: async () => runtime });
  t.after(() => service.close("side-one"));
  const child = await service.open("side-one", createConversationKey("pi-side", parent.id), f.directory);
  for (let i = 0; i < 100 && !child.lease.getSnapshot().authoritative; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(child.lease.getSnapshot().authoritative, true);
  const done = completed(f.engine);
  await service.submit("side-one", { commandId: "side-command", clientMessageId: "side-client", target: { type: "existing-thread", key: child.key },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "shared child question" }] }] },
    attachments: [], context: [], selections: { model: null, permissionProfile: null }, options: { autoContext: true }, createdAt: Date.now() }, null);
  assert.equal((await done).status, "completed");
  assert.equal(sent.filter(method => method === "thread/fork").length, 1);
  assert.ok(sent.includes("thread/inject_items")); assert.ok(sent.includes("turn/start"));
  assert.equal(sent.filter(method => method === "thread/resume").length, 0);
  await service.close("side-one");
  await assert.rejects(f.engine.request("thread/read", { threadId: child.key.threadId }, noTools), /not found/);
});

test("Pi temporary fork validates before allocation and does not survive engine restart", async t => {
  const f = await fixture(t, []);
  const parent = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory }, noTools);
  const fork = { threadId: parent.thread.id, ephemeral: true, excludeTurns: true };
  for (const override of [{ permissions: "restricted" }, { lastTurnId: "old" }, { model: "other-engine" }, { collaborationMode: {} }])
    await assert.rejects(f.engine.request("thread/fork", { ...fork, ...override }, noTools));
  const child = await f.engine.request("thread/fork", fork, noTools), threadId = child.thread.id;
  await assert.rejects(f.engine.request("thread/inject_items", { threadId, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "must not commit" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "wrong role" }] },
  ] }, noTools), /user text/);
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([context => {
    assert.ok(!JSON.stringify(context).includes("must not commit")); return fauxAssistantMessage("validated");
  }]);
  const done = completed(f.engine);
  await f.engine.request("turn/start", { threadId, input: [{ type: "text", text: "new child question" }] }, noTools);
  assert.equal((await done).status, "completed");
  const next = fixtureModels([]);
  await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: next.models }); t.after(() => reopened.close());
  await assert.rejects(reopened.request("thread/read", { threadId }, noTools), /not found/);
  assert.equal((await reopened.request("thread/list", {}, noTools)).data.length, 1);
  assert.equal((await reopened.request("thread/resume", { threadId: parent.thread.id }, noTools)).thread.id, parent.thread.id);
});

for (const ephemeral of [false,true]) test(`Host tools and browser tools coexist on an existing ${ephemeral?"temporary":"durable"} Pi session`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),"pi-host-tools-"));let target="",hostCalls=0,browserCalls=0;
 const {models,faux}=fixtureModels([]);
 const engine=new PiEngine({directory,cwd:directory,models,sessionCapabilities:{tools:id=>id===target?[{name:"im_reply",description:"Reply",inputSchema:{type:"object",properties:{}}}]:[],async call(id,name){assert.equal(id,target);assert.equal(name,"im_reply");hostCalls++;return {success:true,contentItems:[{type:"inputText",text:"receipt"}]};}}});
 t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
 const owner:ExecutionEngineClient={notify(){},async request(){browserCalls++;return {success:true,contentItems:[{type:"inputText",text:"browser"}]};}};
 const created=await engine.request("thread/start",{model:piModel("faux","faux-1"),cwd:directory,ephemeral},owner);target=created.thread.id;
 await engine.request("runtime/capabilities/register",{threadId:target,dynamicTools:[{type:"function",name:"lookup",description:"Browser lookup",inputSchema:{type:"object",properties:{}}}]},owner);
 faux.setResponses([fauxAssistantMessage([fauxToolCall("opencraft_host_im_reply",{},{id:"host"}),fauxToolCall("opencraft_0_lookup",{},{id:"browser"})],{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
 let done=completed(engine);await engine.request("turn/start",{threadId:target,input:[{type:"text",text:"use both tools"}]},owner);assert.equal((await done).status,"completed");assert.equal(hostCalls,1);assert.equal(browserCalls,1);
 // A browser full-list update cannot erase the Host contribution.
 await engine.request("runtime/capabilities/register",{threadId:target,dynamicTools:[]},owner);engine.disconnect(owner);
 faux.setResponses([fauxAssistantMessage([fauxToolCall("opencraft_host_im_reply",{},{id:"host-again"})],{stopReason:"toolUse"}),fauxAssistantMessage("done")]);
 done=completed(engine);await engine.request("turn/start",{threadId:target,input:[{type:"text",text:"Host without browser"}]},noTools);assert.equal((await done).status,"completed");assert.equal(hostCalls,2);assert.equal(browserCalls,1);
});

test("Pi resumes a bounded tail and uses stable turn/item cursors across native reopen", async t => {
  const f = await fixture(t, [fauxAssistantMessage("first"), fauxAssistantMessage("second"), fauxAssistantMessage("third")]);
  const { thread } = await f.engine.request("thread/start", { model: piModel("faux", "faux-1") }, noTools);
  for (let i = 0; i < 3; i++) { const done = completed(f.engine); await f.engine.request("turn/start", { threadId: thread.id, clientUserMessageId: `page-${i}`, input: [{ type: "text", text: `input ${i}` }] }, noTools); await done; }
  const tail = await f.engine.request("thread/resume", { threadId: thread.id, excludeTurns: true, initialTurnsPage: { limit: 1, itemsView: "notLoaded", sortDirection: "desc" } }, noTools);
  assert.deepEqual(tail.thread.turns, []); assert.equal(tail.initialTurnsPage.data.length, 1);
  assert.match(tail.initialTurnsPage.data[0].id, /page-2$/); assert.deepEqual(tail.initialTurnsPage.data[0].items, []);
  const cursor = tail.initialTurnsPage.nextCursor; assert(cursor);
  await f.engine.close(); const engine = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models }); t.after(() => engine.close());
  const older = await engine.request("thread/turns/list", { threadId: thread.id, cursor, limit: 1, itemsView: "full", sortDirection: "desc" }, noTools);
  assert.equal(older.data[0].itemsView, "full"); assert.match(older.data[0].id, /page-1$/); assert.equal(older.data[0].items.find((item: any) => item.type === "agentMessage").text, "second");
  const items = await engine.request("thread/items/list", { threadId: thread.id, turnId: older.data[0].id, limit: 1, sortDirection: "asc" }, noTools);
  assert.equal(items.data[0].item.type, "userMessage"); assert(items.nextCursor);
  const next = await engine.request("thread/items/list", { threadId: thread.id, turnId: older.data[0].id, cursor: items.nextCursor, limit: 1, sortDirection: "asc" }, noTools);
  assert.equal(next.data[0].item.type, "agentMessage");
  await assert.rejects(engine.request("thread/turns/list", { threadId: thread.id, cursor: encodeURIComponent(JSON.stringify({ version: 1, kind: "thread/turns/list", threadId: "another", direction: "desc", anchor: "x" })) }, noTools), /does not match/);
});

test("Pi schedule completion uses native receipts and survives restart without history or resubmission", async t => {
  const f = await fixture(t, [fauxAssistantMessage("scheduled result")]);
  const { thread } = await f.engine.request("thread/start", { model: piModel("faux", "faux-1") }, noTools);
  assert.equal(f.engine.extensions["opencraft/conversation-schedules"].summary, true);
  const done = completed(f.engine);
  await f.engine.request("opencraft/schedules/save", { threadId: thread.id, expectedRevision: 0, nextRunAt: Date.now(), intervalMinutes: null, timeZone: "UTC", prompt: "scheduled work", permissions: "opencraft:permission-mode:full" }, noTools);
  await (f.engine as any).scheduleService.tick(); const turn = await done;
  await (f.engine as any).scheduleService.tick();
  assert.equal((await f.engine.request("opencraft/schedules/read", { threadId: thread.id }, noTools)).runs[0].state, "completed");
  const receipt = await (f.engine as any).sessions.get(thread.id).native.execution(turn.id); assert.equal(receipt, "completed");
  await f.engine.close(); const engine = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models }); t.after(() => engine.close());
  await engine.start(); await (engine as any).scheduleService.tick();
  const view = await engine.request("opencraft/schedules/read", { threadId: thread.id }, noTools);
  assert.equal(view.runs.length, 1); assert.equal(view.runs[0].turnId, turn.id); assert.equal(view.schedule.status, "completed");
  (engine as any).refresh = () => { throw new Error("execution inspection must not project transcript"); };
  assert.equal((await (engine as any).scheduleService.port.inspect(view.runs[0])).state, "completed");
});

test("Pi archive is terminal for resume and rejects scheduled targets without changing permissions", async t => {
  const f = await fixture(t, []); const { thread } = await f.engine.request("thread/start", { model: piModel("faux", "faux-1") }, noTools);
  await assert.rejects(f.engine.request("opencraft/schedules/save", { threadId: thread.id, expectedRevision: 0, nextRunAt: Date.now(), intervalMinutes: null, timeZone: "UTC", prompt: "task", permissions: "opencraft:permission-mode:read-only" }, noTools), /Invalid schedule/);
  await f.engine.request("thread/archive", { threadId: thread.id }, noTools);
  await assert.rejects(f.engine.request("thread/resume", { threadId: thread.id, excludeTurns: true }, noTools), (error: any) => error.data?.code === "THREAD_ARCHIVED" && error.data.retryable === false);
  await assert.rejects(f.engine.request("opencraft/schedules/save", { threadId: thread.id, expectedRevision: 0, nextRunAt: Date.now(), intervalMinutes: null, timeZone: "UTC", prompt: "task" }, noTools), /unarchived/);
  await f.engine.request("thread/unarchive", { threadId: thread.id }, noTools);
  assert.equal((await f.engine.request("thread/resume", { threadId: thread.id, excludeTurns: true }, noTools)).thread.id, thread.id);
});

test("Pi confirms Host tools only after native installation and retries a failed rollback", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-tools-confirmed-"));
  const declaration = { name: "reply", description: "v1", inputSchema: { type: "object", properties: { text: { type: "string" } } } };
  let enabled = false;
  const engine = new PiEngine({ directory, cwd: directory, models: fixtureModels([]).models,
    sessionCapabilities: { tools: () => enabled ? [declaration] : [], async call() { return {}; } } });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const { thread } = await engine.request("thread/start", { model: piModel("faux", "faux-1") }, noTools);
  const session = (engine as any).sessions.get(thread.id), native = session.native, install = native.tools.bind(native);
  const calls: any[] = []; let fail = true;
  native.tools = (tools: any[]) => { calls.push(structuredClone(tools)); install(tools); if (fail) throw new Error("partial install"); };
  enabled = true;
  await assert.rejects(engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "must not submit" }] }, noTools), /partial install/);
  assert.equal(session.hostTools, undefined); assert.equal(session.turns.length, 0);
  enabled = false; fail = false;
  await (engine as any).refreshHostTools(session);
  assert.deepEqual(calls[1], [], "rollback must reinstall even though it equals the old configuration");
  enabled = true; await (engine as any).refreshHostTools(session);
  declaration.inputSchema.properties.text.type = "number";
  assert.equal(session.hostTools[0].inputSchema.properties.text.type, "string", "confirmed snapshot cannot alias provider schema");
  await (engine as any).refreshHostTools(session); assert.equal(calls.length, 4);
  await (engine as any).refreshHostTools(session); assert.equal(calls.length, 4, "identical configuration is installed once");
});


test("Pi skill discovery uses native roots, keeps explicit-only entries and rejects foreign retained references", async t => {
  const f = await fixture(t, []);
  const writeSkill = async (root: string, name: string, extra = "") => {
    const path = join(root, name, "SKILL.md"); await mkdir(join(root, name), { recursive: true });
    await writeFile(path, `---\nname: ${name}\ndescription: ${name} instructions\n${extra}---\nBODY_ONLY_SENTINEL`); return path;
  };
  const userPath = await writeSkill(join(f.directory, "skills"), "pi-user");
  const projectPath = await writeSkill(join(f.directory, ".pi", "skills"), "pi-project", "disable-model-invocation: true\n");
  await writeSkill(join(f.directory, ".codex", "skills"), "codex-only");
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-skills", createTransport: () => new WebSocketTransport({ url: host.websocketUrl, createSocket: url => new WebSocket(url) as any }) });
  t.after(() => runtime.dispose()); await runtime.connect();
  const catalog = await runtime.resources.composerCatalog.listSkills({ cwds: [f.directory], model: piModel("faux", "faux-1") });
  const skills = catalog.data[0]!.skills;
  assert.equal(skills.find(skill => skill.name === "pi-user")?.path, userPath);
  assert.equal(skills.find(skill => skill.name === "pi-project")?.path, projectPath);
  assert.equal(skills.find(skill => skill.name === "pi-project")?.scope, "repo");
  assert.equal(skills.some(skill => skill.name === "codex-only"), false);
  assert.equal(JSON.stringify(catalog).includes("BODY_ONLY_SENTINEL"), false);
  const { validatePiSkillInput } = await import("../../plugins/pi-engine/src/skills.js");
  validatePiSkillInput([{ type: "skill", name: "pi-project", path: projectPath }], f.directory, f.directory);
  assert.throws(() => validatePiSkillInput([{ type: "skill", name: "codex-only", path: join(f.directory, ".codex/skills/codex-only/SKILL.md") }], f.directory, f.directory), /unavailable/);
  await rm(projectPath);
  const reloaded = await runtime.resources.composerCatalog.listSkills({ cwds: [f.directory], forceReload: true });
  assert.equal(reloaded.data[0]!.skills.some(skill => skill.name === "pi-project"), false);
  assert.throws(() => validatePiSkillInput([{ type: "skill", name: "pi-project", path: projectPath }], f.directory, f.directory), /unavailable/);
  await assert.rejects(runtime.resources.composerCatalog.listSkills({ threadId: "foreign-thread" }), /unavailable/);
  assert.equal(f.faux.state.callCount, 0);
});

test("opening Pi native history never creates an execution owner; Resume can continue", async t => {
  const f = await fixture(t, [fauxAssistantMessage("historical reply")]);
  const { thread } = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: f.directory }, noTools);
  const done = completed(f.engine);
  await f.engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "history" }] }, noTools);
  await done; await f.engine.close();
  const models = fixtureModels([fauxAssistantMessage("continued reply")]).models;
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models });
  t.after(() => reopened.close());
  const { readFile } = await import("node:fs/promises");
  const path = join(f.directory, `${thread.id}.sqlite`), original = await readFile(path);
  const read = () => reopened.request("thread/read", { threadId: thread.id, watch: true, initialTurnsPage: { limit: 10 } }, noTools);
  const cold = await read(), warm = await read();
  assert.deepEqual(warm.initialTurnsPage, cold.initialTurnsPage);
  assert.equal(cold.initialTurnsPage.data[0].items.find((item: any) => item.type === "agentMessage").text, "historical reply");
  assert.deepEqual(await readFile(path), original);
  assert.equal((reopened as any).sessions.get(thread.id).native, undefined);
  assert.equal((reopened as any).sessions.get(thread.id).owner, undefined);
  const full = await reopened.request("thread/read", { threadId: thread.id, includeTurns: true }, noTools);
  assert.deepEqual(full.thread.turns.map((turn: any) => ({ id: turn.id, items: turn.items })), [...cold.initialTurnsPage.data].reverse().map((turn: any) => ({ id: turn.id, items: turn.items })));
  await rm(join(f.directory, "cache"), { recursive: true });
  assert.deepEqual((await read()).initialTurnsPage.data, cold.initialTurnsPage.data);
  assert.equal((reopened as any).sessions.get(thread.id).native, undefined);
  await reopened.request("thread/resume", { threadId: thread.id }, noTools);
  const continued = completed(reopened);
  await reopened.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "continue" }] }, noTools);
  assert.equal((await continued).status, "completed");
  assert.equal((await read()).initialTurnsPage.data[0].items.find((item: any) => item.type === "agentMessage").text, "continued reply");
});

test("Pi steer stays on the active Turn across tool and final boundaries, retries and native restore", async t => {
  let entered!: () => void, release!: () => void;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; });
  const toolGate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let finalEntered!: () => void, finalRelease!: () => void;
  const finalStarted = new Promise<void>(resolve => { finalEntered = resolve; });
  const finalGate = new Promise<void>(resolve => { finalRelease = resolve; });
  t.after(() => finalRelease());
  const f = await fixture(t, [
    fauxAssistantMessage([fauxToolCall("opencraft_0_wait", {}, { id: "wait" })], { stopReason: "toolUse" }),
    async context => {
      assert.match(JSON.stringify(context.messages), /change direction/);
      assert.match(JSON.stringify(context.messages), /quoted steer context/);
      finalEntered(); await finalGate; return fauxAssistantMessage("intermediate answer");
    },
    context => { assert.match(JSON.stringify(context.messages), /one more correction/); return fauxAssistantMessage("steered answer"); },
  ]);
  const owner: ExecutionEngineClient = { notify() {}, async request() {
    entered(); await toolGate; return { success: true, contentItems: [{ type: "inputText", text: "tool result" }] };
  } };
  const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1"),
    dynamicTools: [{ type: "function", name: "wait", description: "Wait", inputSchema: { type: "object", properties: {} } }] }, owner);
  const threadId = created.thread.id;
  assert.equal(f.engine.extensions["opencraft/thread-follow-up"].steer, true);
  const done = completed(f.engine);
  const started = await f.engine.request("turn/start", { threadId, input: [{ type: "text", text: "original" }] }, owner);
  await toolEntered;
  const steer = { threadId, expectedTurnId: started.turn.id, clientUserMessageId: "correction",
    input: [{ type: "text", text: "change direction", text_elements: [] }],
    additionalContext: { selection: { kind: "untrusted", value: "quoted steer context" } } };
  await assert.rejects(f.engine.request("turn/steer", { ...steer, expectedTurnId: "stale" }, owner), /identity changed/);
  await assert.rejects(f.engine.request("turn/steer", { ...steer, input: [] }, owner), /must not be empty/);
  assert.deepEqual(await f.engine.request("turn/steer", steer, owner), { turnId: started.turn.id });
  assert.deepEqual(await f.engine.request("turn/steer", steer, owner), { turnId: started.turn.id });
  let read = await f.engine.request("thread/read", { threadId, includeTurns: true }, owner);
  assert.equal(read.thread.turns.length, 1);
  assert.equal(read.thread.turns[0].items.filter((item: any) => item.clientId === "correction").length, 1);
  assert.equal(read.thread.turns[0].status, "inProgress");
  release(); await finalStarted;
  await f.engine.request("turn/steer", { threadId, expectedTurnId: started.turn.id, clientUserMessageId: "last",
    input: [{ type: "text", text: "one more correction" }] }, owner);
  finalRelease();
  assert.equal((await done).status, "completed");
  assert.equal(f.faux.state.callCount, 3);
  await assert.rejects(f.engine.request("turn/steer", { ...steer, clientUserMessageId: "late" }, owner), /identity changed/);
  assert.deepEqual(await f.engine.request("turn/steer", steer, owner), { turnId: started.turn.id });
  await f.engine.close();
  const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: fixtureModels([]).models });
  t.after(() => reopened.close());
  read = await reopened.request("thread/read", { threadId, includeTurns: true }, owner);
  assert.equal(read.thread.turns.length, 1);
  const turn = read.thread.turns[0]; assert.equal(turn.id, started.turn.id); assert.equal(turn.status, "completed");
  assert.deepEqual(turn.items.filter((item: any) => item.type === "userMessage" || item.type === "steeringUserMessage").map((item: any) => item.clientId), [null, "correction", "last"]);
  assert.equal(new Set(turn.items.map((item: any) => item.id)).size, turn.items.length);
  assert.equal(turn.items.at(-1).text, "steered answer");
  assert.deepEqual(await reopened.request("turn/steer", steer, owner), { turnId: started.turn.id });
});

test("Pi stop withdraws pending steer and owner restart recovers pending steer exactly once", async t => {
  for (const stop of [true, false]) {
    const f = await fixture(t, [fauxAssistantMessage("partial answer ".repeat(40))], 40);
    const created = await f.engine.request("thread/start", { model: piModel("faux", "faux-1") }, noTools);
    const threadId = created.thread.id;
    const partial = new Promise<void>(resolve => {
      const off = f.engine.subscribe(method => { if (method === "item/agentMessage/delta") { off(); resolve(); } });
    });
    const started = await f.engine.request("turn/start", { threadId, input: [{ type: "text", text: "begin" }] }, noTools);
    await partial;
    await f.engine.request("turn/steer", { threadId, expectedTurnId: started.turn.id, clientUserMessageId: "retained-steer",
      input: [{ type: "text", text: "recover correction" }] }, noTools);
    if (stop) {
      const done = completed(f.engine);
      await f.engine.request("turn/interrupt", { threadId, turnId: started.turn.id }, noTools);
      assert.equal((await done).status, "interrupted");
    }
    await f.engine.close();
    const models = fixtureModels([fauxAssistantMessage("resumed first"), context => {
      assert.match(JSON.stringify(context.messages), /recover correction/); return fauxAssistantMessage("resumed correction");
    }]);
    const reopened = new PiEngine({ directory: f.directory, cwd: f.directory, models: models.models });
    t.after(() => reopened.close());
    const done = stop ? null : completed(reopened);
    await reopened.request("thread/resume", { threadId }, noTools);
    if (done) assert.equal((await done).status, "completed");
    const read = await reopened.request("thread/read", { threadId, includeTurns: true }, noTools);
    assert.equal(read.thread.turns.length, 1);
    assert.equal(read.thread.turns[0].status, stop ? "interrupted" : "completed");
    assert.equal(models.faux.state.callCount, stop ? 0 : 2);
    assert.equal(read.thread.turns[0].items.filter((item: any) => item.clientId === "retained-steer").length, 1);
  }
});

test("Workbench sends Pi steer over the durable Host WebSocket and retains one Turn", async t => {
  const { createAppServerWorkbenchRuntime } = await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const { WebSocketTransport } = await import("../../packages/appserver-transport-websocket/src/index.js");
  let entered!: () => void, release!: () => void;
  const generating = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const f = await fixture(t, [async () => { entered(); await gate; return fauxAssistantMessage("first answer"); }, context => {
    assert.match(JSON.stringify(context.messages), /client correction/); return fauxAssistantMessage("client steer accepted");
  }], 200);
  const host = await startEngineHost({ providers: [f.engine], defaultEngine: "pi" }); t.after(() => host.close());
  let rows: any[] = []; const sent: string[] = [];
  const runtime = createAppServerWorkbenchRuntime({ hostId: "pi-steer", hostKind: "durable",
    outbox: { read: () => rows, write: (_key, next) => { rows = [...next]; }, subscribe: () => () => {} },
    createTransport: () => {
      const transport = new WebSocketTransport(host.websocketUrl), send = transport.send.bind(transport);
      transport.send = frame => { sent.push(JSON.parse(frame).method); return send(frame); }; return transport;
    },
  });
  t.after(() => runtime.dispose()); await runtime.connect();
  const thread = await runtime.resources.threads.start({ model: piModel("faux", "faux-1"), cwd: f.directory });
  const lease = await runtime.acquireThread(thread.id); t.after(() => lease.release());
  for (let i = 0; i < 200 && !lease.getSnapshot().authoritative; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lease.getSnapshot().authoritative, true);
  const done = completed(f.engine);
  const intent = { commandId: "first", clientMessageId: "first-client", target: { type: "existing-thread" as const, key: lease.getSnapshot().key },
    document: { version: 1 as const, blocks: [{ type: "paragraph" as const, children: [{ type: "text" as const, text: "initial client message" }] }] },
    attachments: [], context: [], selections: { model: piModel("faux", "faux-1"), permissionProfile: null }, options: { autoContext: true }, createdAt: 1 };
  await lease.submit(intent); await generating;
  const read = await f.engine.request("thread/read", { threadId: thread.id, includeTurns: true }, noTools);
  const turnId = read.thread.turns[0].id;
  await lease.submit({ ...intent, commandId: "correction", clientMessageId: "steer-client",
    target: { type: "steer-active-turn", key: lease.getSnapshot().key, turnId },
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "client correction" }] }] } });
  for (let i = 0; i < 200 && !sent.includes("turn/steer"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(sent.includes("turn/steer"));
  // Wait for the native admission, not merely the outbox enqueue/send call.
  for (let i = 0; i < 200; i++) {
    const pending = await f.engine.request("thread/read", { threadId: thread.id, includeTurns: true }, noTools);
    if (pending.thread.turns[0].items.some((item: any) => item.clientId === "steer-client")) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  release();
  assert.equal((await done).id, turnId);
  assert.equal(sent.filter(method => method === "turn/steer").length, 1);
  assert.equal(sent.filter(method => method === "turn/start").length, 1);
  const result = await f.engine.request("thread/read", { threadId: thread.id, includeTurns: true }, noTools);
  assert.equal(result.thread.turns.length, 1);
  assert.equal(result.thread.turns[0].items.filter((item: any) => item.clientId === "steer-client").length, 1);
  assert.equal(result.thread.turns[0].items.at(-1).text, "client steer accepted");
});

test("Pi durable queue edits, reorders, withdraws and atomically steers without double execution", async t => {
  let entered!: () => void, release!: () => void;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = await fixture(t, [
    fauxAssistantMessage([fauxToolCall("opencraft_0_wait", {}, { id: "queue-wait" })], { stopReason: "toolUse" }),
    context => { const text=JSON.stringify(context.messages); assert.match(text,/edited instruction/); assert.doesNotMatch(text,/deleted instruction/); return fauxAssistantMessage("steered root finished"); },
    context => { assert.match(JSON.stringify(context.messages),/last queued instruction/); return fauxAssistantMessage("queued turn finished"); },
  ]);
  const owner: ExecutionEngineClient = {notify(){}, async request(){entered();await gate;return {success:true,contentItems:[{type:"inputText",text:"tool finished"}]};}};
  const {thread}=await f.engine.request("thread/start",{model:piModel("faux","faux-1"),dynamicTools:[{type:"function",name:"wait",description:"Wait",inputSchema:{type:"object"}}]},owner);
  const completedTurns:any[]=[];f.engine.subscribe((method,params)=>{if(method==="turn/completed")completedTurns.push(params.turn)});
  const root=await f.engine.request("turn/start",{threadId:thread.id,input:[{type:"text",text:"root"}]},owner);await toolEntered;
  const add=async(id:string,text:string)=>(await f.engine.request("thread/queue/add",{threadId:thread.id,clientUserMessageId:id,input:[{type:"text",text}]},owner)).queuedSubmission;
  const a=await add("delete-me","deleted instruction"),b=await add("steer-me","original instruction"),c=await add("later","last queued instruction");
  const list=()=>f.engine.request("thread/queue/list",{threadId:thread.id},owner);
  assert.equal((await list()).data.length,3);
  await f.engine.request("thread/queue/update",{threadId:thread.id,queuedSubmissionId:b.id,input:[{type:"text",text:"edited instruction"}]},owner);
  await f.engine.request("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[c.id,b.id,a.id]},owner);
  assert.deepEqual((await list()).data.map((x:any)=>x.id),[c.id,b.id,a.id]);
  await assert.rejects(f.engine.request("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[c.id,c.id,a.id]},owner),/order changed/);
  assert.equal((await f.engine.request("thread/queue/delete",{threadId:thread.id,queuedSubmissionId:a.id},owner)).deleted,true);
  await add("delete-me","deleted instruction"); // A lost delete/add ACK cannot resurrect discarded work.
  assert.deepEqual((await list()).data.map((x:any)=>x.id),[c.id,b.id]);
  const steer={threadId:thread.id,queuedSubmissionId:b.id,expectedTurnId:root.turn.id};
  await assert.rejects(f.engine.request("thread/queue/steer",{...steer,expectedTurnId:"stale"},owner),/identity changed/);
  assert.equal((await list()).data.length,2);
  const replies=await Promise.all([f.engine.request("thread/queue/steer",steer,owner),f.engine.request("thread/queue/steer",steer,noTools)]);
  assert.ok(replies.every(reply=>reply.turnId===root.turn.id));
  const waiting=await list();assert.equal(waiting.data.length,1);assert.equal(waiting.steering.length,1);
  const pending=await f.engine.request("thread/read",{threadId:thread.id,includeTurns:true},owner);
  assert.equal(pending.thread.turns.length,1);
  const input=pending.thread.turns[0].items.find((item:any)=>item.clientId==="steer-me");
  assert.equal(input.type,"userMessage");assert.equal(input.__opencraftSteeringStatus,"pending");assert.equal(input.content[0].text,"edited instruction");
  release();
  for(let i=0;i<400&&completedTurns.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(completedTurns.length,2);assert.ok(completedTurns.every(turn=>turn.status==="completed"));
  assert.equal(f.faux.state.callCount,3);assert.equal((await list()).data.length,0);
  const read=await f.engine.request("thread/read",{threadId:thread.id,includeTurns:true},owner);
  assert.equal(read.thread.turns.length,2);
  assert.equal(read.thread.turns[0].items.find((item:any)=>item.clientId==="steer-me").__opencraftSteeringStatus,"accepted");
  assert.equal(read.thread.turns[1].id,c.id);
  assert.equal((await f.engine.request("thread/queue/steer",steer,owner)).turnId,root.turn.id);
});

test("Pi stop preserves paused queued input across restart; explicit start resumes it once", async t => {
  const f=await fixture(t,[fauxAssistantMessage("long running response ".repeat(30))],30);
  const {thread}=await f.engine.request("thread/start",{model:piModel("faux","faux-1")},noTools);
  const partial=new Promise<void>(resolve=>{const off=f.engine.subscribe(method=>{if(method==="item/agentMessage/delta"){off();resolve();}})});
  const started=await f.engine.request("turn/start",{threadId:thread.id,input:[{type:"text",text:"root"}]},noTools);await partial;
  const queued=await f.engine.request("thread/queue/add",{threadId:thread.id,clientUserMessageId:"paused",input:[{type:"text",text:"preserved next task"}]},noTools);
  const stopped=completed(f.engine);await f.engine.request("turn/interrupt",{threadId:thread.id,turnId:started.turn.id},noTools);assert.equal((await stopped).status,"interrupted");
  assert.equal((await f.engine.request("thread/queue/list",{threadId:thread.id},noTools)).data[0].pausedReason,"user-stopped");
  await f.engine.close();
  const models=fixtureModels([context=>{assert.match(JSON.stringify(context.messages),/preserved next task/);return fauxAssistantMessage("resumed next task");}]);
  const reopened=new PiEngine({directory:f.directory,cwd:f.directory,models:models.models});t.after(()=>reopened.close());await reopened.start();
  const list=await reopened.request("thread/queue/list",{threadId:thread.id},noTools);assert.equal(list.data.length,1);assert.equal(models.faux.state.callCount,0);
  const done=completed(reopened);
  await reopened.request("thread/queue/start",{threadId:thread.id,queuedSubmissionId:queued.queuedSubmission.id},noTools);
  assert.equal((await done).status,"completed");assert.equal(models.faux.state.callCount,1);
  await reopened.request("thread/queue/add",{threadId:thread.id,clientUserMessageId:"paused",input:[{type:"text",text:"preserved next task"}]},noTools);
  assert.equal((await reopened.request("thread/queue/list",{threadId:thread.id},noTools)).data.length,0);
  assert.equal(models.faux.state.callCount,1);
});

test("Pi queue reconciles a lost native submission ACK rather than replaying its input", async t => {
  const f=await fixture(t,[fauxAssistantMessage("one native execution")]);
  const {thread}=await f.engine.request("thread/start",{model:piModel("faux","faux-1")},noTools);
  const native=(f.engine as any).sessions.get(thread.id).native;
  const submit=native.submit.bind(native);let admissions=0;
  native.submit=async(...args:any[])=>{admissions++;await submit(...args);throw new Error("Simulated lost native ACK");};
  const done=completed(f.engine);
  await f.engine.request("thread/queue/add",{threadId:thread.id,clientUserMessageId:"lost-ack",input:[{type:"text",text:"once"}]},noTools);
  assert.equal((await done).status,"completed");
  assert.equal(admissions,1);assert.equal(f.faux.state.callCount,1);
  assert.equal((await f.engine.request("thread/queue/list",{threadId:thread.id},noTools)).data.length,0);
});

test("Workbench preserves Pi queue preference and atomically steers the queued message with native status", async t => {
  const {createAppServerWorkbenchRuntime}=await import("../../packages/workbench-runtime/src/appserver-runtime.js");
  const {WebSocketTransport}=await import("../../packages/appserver-transport-websocket/src/index.js");
  let entered!:()=>void,release!:()=>void;
  const generating=new Promise<void>(resolve=>{entered=resolve});const gate=new Promise<void>(resolve=>{release=resolve});t.after(()=>release());
  const f=await fixture(t,[async()=>{entered();await gate;return fauxAssistantMessage("first answer")},context=>{
    assert.match(JSON.stringify(context.messages),/queued correction/);return fauxAssistantMessage("steered answer");
  }]);
  const host=await startEngineHost({providers:[f.engine],defaultEngine:"pi"});t.after(()=>host.close());
  let rows:any[]=[];const sent:string[]=[];
  const runtime=createAppServerWorkbenchRuntime({hostId:"pi-parity",hostKind:"durable",
    outbox:{read:()=>rows,write:(_key,next)=>{rows=[...next]},subscribe:()=>()=>{}},
    createTransport:()=>{const transport=new WebSocketTransport(host.websocketUrl),send=transport.send.bind(transport);transport.send=frame=>{sent.push(JSON.parse(frame).method);return send(frame)};return transport},
  });t.after(()=>runtime.dispose());await runtime.connect();
  const thread=await runtime.resources.threads.start({model:piModel("faux","faux-1"),cwd:f.directory});
  const lease=await runtime.acquireThread(thread.id);t.after(()=>lease.release());
  for(let i=0;i<200&&!lease.getSnapshot().authoritative;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const intent={commandId:"first",clientMessageId:"first",target:{type:"existing-thread" as const,key:lease.getSnapshot().key},
    document:{version:1 as const,blocks:[{type:"paragraph" as const,children:[{type:"text" as const,text:"first"}]}]},attachments:[],context:[],
    selections:{model:piModel("faux","faux-1"),permissionProfile:null},options:{autoContext:true},createdAt:1};
  await lease.submit(intent);await generating;
  await lease.submit({...intent,commandId:"correction",clientMessageId:"correction",target:{type:"enqueue-follow-up",key:lease.getSnapshot().key},
    document:{version:1,blocks:[{type:"paragraph",children:[{type:"text",text:"queued correction"}]}]}});
  for(let i=0;i<200&&!lease.getSnapshot().queuedSubmissions.some(item=>item.serverSubmissionId!==null);i++)await new Promise(resolve=>setTimeout(resolve,10));
  const queued=lease.getSnapshot().queuedSubmissions.find(item=>item.serverSubmissionId!==null)!;assert.ok(queued);assert.equal(rows.length,0);
  const done=completed(f.engine);
  const turnId=await lease.steerQueuedSubmission(queued.serverSubmissionId!);
  const correction=()=>lease.getSnapshot().timeline.frames.flatMap(frame=>frame.blocks).filter((block:any)=>block.type==="user-message"&&block.clientId==="correction") as any[];
  for(let i=0;i<200&&correction()[0]?.steeringStatus!=="pending";i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(correction().length,1);assert.equal(correction()[0].steeringStatus,"pending");
  assert.equal(correction()[0].deliveryStatus,"sent");
  assert.ok(sent.includes("thread/queue/add"));assert.ok(sent.includes("thread/queue/steer"));
  release();assert.equal((await done).id,turnId);
  for(let i=0;i<200&&correction()[0]?.steeringStatus!=="accepted";i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(correction().length,1);assert.equal(correction()[0].steeringStatus,"accepted");assert.equal(f.faux.state.callCount,2);
});

test("Pi cold owner reconciles claimed queue custody from native receipts and drains the next input", async t => {
  const f=await fixture(t,[fauxAssistantMessage("already delivered")]);
  const {thread}=await f.engine.request("thread/start",{model:piModel("faux","faux-1")},noTools);
  const requestId=`${thread.id}:turn:client:delivered`;
  const done=completed(f.engine);
  await f.engine.request("turn/start",{threadId:thread.id,clientUserMessageId:"delivered",input:[{type:"text",text:"delivered"}]},noTools);await done;
  const {PiQueueDoc}=await import("../../plugins/pi-engine/src/queue.js");
  const {BACKGROUND_CONTEXT}=await import("@earendil-works/chord/context");
  const session=(f.engine as any).sessions.get(thread.id);
  // A crashed dispatcher can leave custody after native admission. Suppress
  // the old gateway's drain while constructing exactly that durable state.
  (f.engine as any).queueDrains.add(thread.id);
  await session.native.root.commit(async(tx:any)=>{
    const queue=await tx.doc(PiQueueDoc,session.native.root.id);
    queue.items.push({id:requestId,clientId:"delivered",input:[{type:"text",text:"delivered"}],content:[{type:"text",text:"delivered"}],additionalContext:null,createdAtMs:1,state:"dispatching"});
    queue.items.push({id:`${thread.id}:turn:client:next`,clientId:"next",input:[{type:"text",text:"next input"}],content:[{type:"text",text:"next input"}],additionalContext:null,createdAtMs:2,state:"queued"});
  },BACKGROUND_CONTEXT);
  session.pendingRecovery=true;await (f.engine as any).save(session);await f.engine.close();
  const models=fixtureModels([context=>{const text=JSON.stringify(context.messages);assert.match(text,/next input/);return fauxAssistantMessage("next delivered") }]);
  const reopened=new PiEngine({directory:f.directory,cwd:f.directory,models:models.models});t.after(()=>reopened.close());
  const nextDone=completed(reopened);await reopened.start();assert.equal((await nextDone).status,"completed");
  assert.equal(models.faux.state.callCount,1);
  const read=await reopened.request("thread/read",{threadId:thread.id,includeTurns:true},noTools);assert.equal(read.thread.turns.length,2);
  assert.equal(read.thread.turns.filter((turn:any)=>turn.id===requestId).length,1);
  assert.equal((await reopened.request("thread/queue/list",{threadId:thread.id},noTools)).data.length,0);
});

test("Pi queue survives an actual dropped WebSocket ACK and reconnecting clients steer it only once", async t => {
  const {WebSocketServer}=await import("ws");
  let entered!:()=>void,release!:()=>void;
  const generating=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve});t.after(()=>release());
  const f=await fixture(t,[async()=>{entered();await gate;return fauxAssistantMessage("first result")},context=>{
    assert.match(JSON.stringify(context.messages),/network correction/);return fauxAssistantMessage("correction applied");
  }]);
  const host=await startEngineHost({providers:[f.engine],defaultEngine:"pi"});t.after(()=>host.close());
  const proxy=new WebSocketServer({host:"127.0.0.1",port:0});await new Promise<void>(resolve=>proxy.once("listening",resolve));
  const upstreams=new Set<WebSocket>();let dropped=false;
  proxy.on("connection",downstream=>{
    const upstream=new WebSocket(host.websocketUrl);upstreams.add(upstream);let droppedId:any=null;const waiting:WebSocket.RawData[]=[];
    downstream.on("message",raw=>{const frame=JSON.parse(raw.toString());if(frame.method==="thread/queue/add")droppedId=frame.id;if(upstream.readyState===WebSocket.OPEN)upstream.send(raw);else waiting.push(raw)});
    upstream.on("open",()=>{for(const raw of waiting)upstream.send(raw)});
    upstream.on("message",raw=>{const frame=JSON.parse(raw.toString());
      if(!frame.method&&frame.id===droppedId){dropped=true;downstream.close(1012,"Synthetic ACK loss");upstream.close();return}
      if(downstream.readyState===WebSocket.OPEN)downstream.send(raw);
    });
    downstream.on("close",()=>upstream.close());upstream.on("close",()=>upstreams.delete(upstream));
  });
  t.after(async()=>{for(const ws of proxy.clients)ws.terminate();for(const ws of upstreams)ws.terminate();await new Promise<void>(resolve=>proxy.close(()=>resolve()))});
  const open=async(url:string)=>{const ws=new WebSocket(url);await new Promise<void>((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});t.after(()=>ws.terminate());return ws};
  let counter=0;
  const call=(ws:WebSocket,method:string,params:any={})=>new Promise<any>((resolve,reject)=>{
    const id=++counter;
    const cleanup=()=>{clearTimeout(timer);ws.off("message",receive);ws.off("close",closed)};
    const receive=(raw:WebSocket.RawData)=>{const frame=JSON.parse(raw.toString());if(frame.method||frame.id!==id)return;cleanup();frame.error?reject(new Error(frame.error.message)):resolve(frame.result)};
    const closed=()=>{cleanup();reject(new Error("WebSocket closed before ACK"))};
    const timer=setTimeout(()=>{cleanup();reject(new Error("RPC timed out"))},5000);
    ws.on("message",receive);ws.once("close",closed);ws.send(JSON.stringify({jsonrpc:"2.0",id,method,params}));
  });
  const a=await open(`ws://127.0.0.1:${(proxy.address() as any).port}`);await call(a,"initialize");
  const {thread}=await call(a,"thread/start",{model:piModel("faux","faux-1"),cwd:f.directory});
  const root=await call(a,"turn/start",{threadId:thread.id,input:[{type:"text",text:"root"}]});await generating;
  const add={threadId:thread.id,clientUserMessageId:"network-correction",input:[{type:"text",text:"network correction"}]};
  await assert.rejects(call(a,"thread/queue/add",add),/closed before ACK/);assert.equal(dropped,true);
  const b=await open(host.websocketUrl);await call(b,"initialize");await call(b,"thread/resume",{threadId:thread.id});
  const queue=await call(b,"thread/queue/list",{threadId:thread.id});assert.equal(queue.data.length,1);
  const steer={threadId:thread.id,queuedSubmissionId:queue.data[0].id,expectedTurnId:root.turn.id};
  assert.equal((await call(b,"thread/queue/steer",steer)).turnId,root.turn.id);
  assert.equal((await call(b,"thread/queue/steer",steer)).turnId,root.turn.id);
  await call(b,"thread/queue/add",add);
  await assert.rejects(call(b,"thread/queue/add",{...add,input:[{type:"text",text:"conflicting retry"}]}),/different input/);
  assert.equal((await call(b,"thread/queue/list",{threadId:thread.id})).data.length,0);
  const done=completed(f.engine);release();assert.equal((await done).status,"completed");
  assert.equal(f.faux.state.callCount,2);
  const read=await call(b,"thread/read",{threadId:thread.id,includeTurns:true});assert.equal(read.thread.turns.length,1);
  assert.equal(read.thread.turns[0].items.filter((item:any)=>item.clientId==="network-correction").length,1);
});

test("Pi queued first input binds live platform tools and updates the conversation preview", async t => {
  const f=await fixture(t,[fauxAssistantMessage([fauxToolCall("opencraft_0_lookup",{}, {id:"queued-tool"})],{stopReason:"toolUse"}),fauxAssistantMessage("tool done")]);
  let calls=0;const owner:ExecutionEngineClient={notify(){},async request(){calls++;return {success:true,contentItems:[{type:"inputText",text:"looked up"}]}}};
  const {thread}=await f.engine.request("thread/start",{model:piModel("faux","faux-1"),dynamicTools:[{type:"function",name:"lookup",description:"Lookup",inputSchema:{type:"object"}}]},owner);
  const done=completed(f.engine);
  await f.engine.request("thread/queue/add",{threadId:thread.id,clientUserMessageId:"first-queued",input:[{type:"text",text:"queued first request"}]},owner);
  assert.equal((await done).status,"completed");assert.equal(calls,1);
  const read=await f.engine.request("thread/read",{threadId:thread.id,includeTurns:true},owner);
  assert.equal(read.thread.preview,"queued first request");
  assert.equal(read.thread.turns[0].items.find((item:any)=>item.type==="dynamicToolCall").status,"completed");
});
