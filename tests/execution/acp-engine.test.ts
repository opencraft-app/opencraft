import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpEngine, dshAcpCommand } from "../../plugins/acp-engine/src/index.js";
import { AcpGenerationHost } from "../../plugins/acp-engine/src/generations.js";
import { codexBaseModelId, splitModelVariant } from "../../plugins/acp-engine/src/model-variant.js";
import type { ExecutionEngineClient } from "../../packages/appserver-client/src/execution-engine.js";

const peer = resolve("tests/fixtures/acp-engine-peer.mjs");
const client: ExecutionEngineClient = { notify() {}, async request() { throw new Error("No browser tool owner"); } };
test("native model suffix parsing handles long hostile names without backtracking", () => {
  assert.deepEqual(splitModelVariant("one[reasoning=high,fast=true]"), { base: "one", parameters: "reasoning=high,fast=true" });
  assert.deepEqual(splitModelVariant("one[]"), { base: "one", parameters: "" });
  assert.equal(splitModelVariant("one[high]tail"), null);
  assert.equal(splitModelVariant("one[high]tail]"), null);
  for (const input of ["[".repeat(100000), "[\\".repeat(100000)]) {
    assert.equal(splitModelVariant(input), null);
    assert.equal(codexBaseModelId(input), input);
  }
  assert.equal(codexBaseModelId("codex:one[low]"), "codex:one");
  assert.equal(codexBaseModelId("one[other]tail[high]"), "one[other]tail");
  assert.equal(codexBaseModelId("one[]"), "one[]");
  assert.equal(codexBaseModelId("one" + "[".repeat(100000) + "]"), "one");
});
async function fixture(t: test.TestContext, options: Record<string, any> = {}) {
  const root = await mkdtemp(join(tmpdir(), "acp-engine-test-")), trace = join(root, "trace.jsonl");
  const engineOptions = { command: process.execPath, args: [peer], cwd: root, dataDirectory: join(root, "data"), permission: "allow-once" as const, ...options, env: { ACP_TEST_TRACE: trace, ...options.env } };
  const engine = new AcpEngine(engineOptions);
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const calls = async () => { try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { root, engine, calls, engineOptions };
}
async function until(predicate: () => boolean) { const deadline = Date.now() + 4_000; while (!predicate()) { if (Date.now() >= deadline) throw new Error("ACP test condition timed out"); await delay(10); } }

test("ACP titles persist accepted input and native updates even after completion; manual rename wins", async t => {
  const f = await fixture(t), notices: { method: string; params: any }[] = [];
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const { thread } = await f.engine.request("thread/start", {}, client);
  await f.engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "  整理\n模型选择菜单  " }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const path = join(f.root, "data", `${thread.id}.json`);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.name, "整理 模型选择菜单"); assert.equal(saved.preview, "整理 模型选择菜单");
  assert.equal((await f.engine.request("thread/list", {}, client)).data[0].name, saved.name);
  const native = (f.engine as any).native((f.engine as any).sessions.get(thread.id));
  const info = (title: unknown) => native.request("fixture/sessionInfo", { sessionId: saved.nativeId, title });
  await info("整理模型与推理选项");
  await until(() => notices.some(notice => notice.params.threadName === "整理模型与推理选项"));
  assert.equal(JSON.parse(await readFile(path, "utf8")).name, "整理模型与推理选项", "title notifications follow persistence");
  await info(null); await info(" "); await info({ title: "invalid" });
  await f.engine.request("thread/name/set", { threadId: thread.id, name: "我的自定义标题" }, client);
  await info("迟到的自动标题"); await delay(20);
  assert.equal((await f.engine.request("thread/read", { threadId: thread.id }, client)).thread.name, "我的自定义标题");
  assert.ok(!notices.some(notice => notice.params.threadName === "迟到的自动标题"));
  await f.engine.close();
  const restored = new AcpEngine(f.engineOptions); t.after(() => restored.close());
  assert.equal((await restored.request("thread/list", {}, client)).data[0].name, "我的自定义标题");
  assert.equal(restored.processId, null, "catalog reads never wake an agent");
  await restored.close();
});

test("old ACP records recover a native catalog title on resume without resending input", async t => {
  const f = await fixture(t, { env: { ACP_TEST_TITLE_LIST: "Recovered native title" } });
  const { thread } = await f.engine.request("thread/start", {}, client); await f.engine.close();
  const restored = new AcpEngine(f.engineOptions); t.after(() => restored.close());
  const notices: any[] = []; restored.subscribe((method, params) => notices.push({ method, params }));
  await restored.request("thread/resume", { threadId: thread.id }, client);
  await until(() => notices.some(notice => notice.params.threadName === "Recovered native title"));
  assert.equal((await restored.request("thread/list", {}, client)).data[0].name, "Recovered native title");
  assert.ok(!(await f.calls()).some(call => call.method === "session/prompt"));
  await restored.close();
});

test("ACP reports native context/plans, surfaces failures and only continues after an explicit request", async t => {
  const f = await fixture(t, { env: { ACP_TEST_PROGRESS: "1" } }), notices: any[] = [];
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const { thread } = await f.engine.request("thread/start", {}, client);
  await assert.rejects(f.engine.request("turn/start", { threadId: thread.id, input: [] }, client), /cannot be continued/);
  await f.engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "fail:response" }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const failed = notices.find(notice => notice.method === "turn/completed").params.turn;
  assert.equal(failed.status, "failed"); assert.equal(failed.items.at(-1).code, "acpPromptFailed");
  assert.equal(failed.error.codexErrorInfo, "other");
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1, "a failure is never automatically replayed");
  const plans = notices.filter(notice => notice.method === "turn/plan/updated");
  assert.equal(plans.length, 1); assert.equal(plans[0].params.plan[0].status, "inProgress");
  const usage = await f.engine.request("opencraft/thread-usage/read", { threadId: thread.id }, client);
  assert.deepEqual(usage.context, { usedTokens: 1200, limitTokens: 200000 }); assert.equal(usage.total, null);
  await f.engine.request("turn/start", { threadId: thread.id, input: [] }, client);
  await until(() => notices.filter(notice => notice.method === "turn/completed").length === 2);
  assert.equal(notices.filter(notice => notice.method === "turn/completed").at(-1).params.turn.status, "completed");
});

test("ACP connection loss exposes a controlled error and cannot replay an unknown native outcome", async t => {
  const f = await fixture(t), notices: any[] = [];
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const { thread } = await f.engine.request("thread/start", {}, client);
  await f.engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "wait:unknown" }] }, client);
  process.kill(f.engine.processIds[0], "SIGKILL");
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const turn = notices.find(notice => notice.method === "turn/completed").params.turn;
  assert.equal(turn.error.message, "acpPromptUnconfirmed"); assert.equal(turn.items.at(-1).code, "acpPromptUnconfirmed");
  const before = (await f.calls()).length;
  await assert.rejects(f.engine.request("turn/start", { threadId: thread.id, input: [] }, client), /cannot be continued/);
  assert.equal((await f.calls()).length, before, "unsafe Continue never starts or resumes the native peer");
});

test("Cursor negotiates base models and sends native reasoning/Fast without replacing unrelated parameters", async t => {
  const f = await fixture(t, { id: "cursor", env: { ACP_TEST_PARAMETERIZED: "1" } });
  const created = await f.engine.request("thread/start", { model: "cursor:one", reasoningEffort: "low", serviceTier: "fast" }, client);
  assert.equal(created.model, "cursor:one"); assert.equal(created.reasoningEffort, "low"); assert.equal(created.serviceTier, "fast");
  const mutationsBeforeDiscovery = (await f.calls()).filter(call => call.method === "session/set_config_option").length;
  await f.engine.discoverModelCapabilities(created.thread.id);
  assert.equal((await f.calls()).filter(call => call.method === "session/set_config_option").length, mutationsBeforeDiscovery, "declared schemas need no per-model mutations");
  const catalog = (await f.engine.request("model/list", {}, client)).data;
  assert.deepEqual(catalog.map((model: any) => model.id), ["cursor:one", "cursor:two"], "structured choices supersede legacy variants");
  assert.deepEqual(catalog[0].supportedReasoningEfforts.map((effort: any) => effort.reasoningEffort), ["low", "high"]);
  assert.equal(catalog[0].defaultReasoningEffort, "high"); assert.equal(catalog[0].serviceTiers[0].id, "fast");
  assert.deepEqual(catalog[1].supportedReasoningEfforts, []); assert.deepEqual(catalog[1].serviceTiers, []);
  const notices: any[] = []; f.engine.subscribe((method, params) => notices.push({ method, params }));
  await f.engine.request("turn/start", { threadId: created.thread.id, model: "cursor:one", effort: "high", serviceTier: null, input: [{ type: "text", text: "first" }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const calls = await f.calls();
  assert.ok(calls.filter(call => call.method === "initialize").every(call => call.parameterizedPicker === true));
  assert.deepEqual(calls.find(call => call.method === "session/prompt").settings, { model: "one", effort: "high", fast: false, context: "1m" });
  const configured = calls.filter(call => call.method === "session/set_config_option");
  assert.ok(configured.some(call => call.configId === "reasoning" && call.value === "low"));
  assert.ok(configured.some(call => call.configId === "fast" && call.value === "true"));
  assert.ok(configured.some(call => call.configId === "fast" && call.value === "false"));
  assert.ok(!configured.some(call => call.configId === "context"));
  await assert.rejects(f.engine.request("turn/start", { threadId: created.thread.id, effort: "ultra", input: [{ type: "text", text: "invalid" }] }, client), /reasoning level is unavailable/);
  await assert.rejects(f.engine.request("turn/start", { threadId: created.thread.id, model: "cursor:two", serviceTier: "fast", input: [{ type: "text", text: "invalid" }] }, client), /Fast mode is unavailable/);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1);
});

test("Cursor falls back to standard ACP option discovery when the model-schema extension is unavailable", async t => {
  const f = await fixture(t, { id: "cursor", env: { ACP_TEST_PARAMETERIZED: "1", ACP_TEST_NO_MODEL_EXTENSION: "1" } });
  const created = await f.engine.request("thread/start", {}, client);
  await f.engine.discoverModelCapabilities(created.thread.id);
  const catalog = (await f.engine.request("model/list", {}, client)).data;
  assert.equal(catalog[0].serviceTiers[0].id, "fast"); assert.deepEqual(catalog[1].supportedReasoningEfforts, []);
  assert.equal((await f.engine.request("thread/read", { threadId: created.thread.id }, client)).thread.model, "cursor:one");
});

test("Cursor restores old parameterized IDs after restart and isolates conversations' model settings", async t => {
  const f = await fixture(t, { id: "cursor", env: { ACP_TEST_PARAMETERIZED: "1" } });
  const first = await f.engine.request("thread/start", { model: "cursor:one[context=256k,reasoning=low,fast=true]" }, client);
  const second = await f.engine.request("thread/start", { model: "cursor:two" }, client);
  const calls = await f.calls(), starts = calls.filter(call => call.method === "session/new");
  assert.notEqual(starts[0].pid, starts[1].pid, "Cursor has a process-global model manager");
  assert.equal((await f.engine.request("thread/read", { threadId: first.thread.id }, client)).thread.reasoningEffort, "low");
  assert.equal((await f.engine.request("thread/read", { threadId: second.thread.id }, client)).thread.model, "cursor:two");
  await f.engine.close();
  const path = join(f.root, "data", `${first.thread.id}.json`);
  const old = JSON.parse(await readFile(path, "utf8"));
  old.model = "cursor:one[context=256k,reasoning=low,fast=true]";
  old.modelCatalog = [{ id: old.model, name: "One High" }];
  for (const key of ["modelConfigValues", "parameterConfigs", "reasoningModels", "reasoningConfig", "fastConfig", "fastModels"]) delete old[key];
  await writeFile(path, JSON.stringify(old));
  const restored = new AcpEngine(f.engineOptions); t.after(() => restored.close());
  const notices: any[] = []; restored.subscribe((method, params) => notices.push({ method, params }));
  const resumed = await restored.request("thread/resume", { threadId: first.thread.id }, client);
  assert.equal(resumed.model, "cursor:one"); assert.equal(resumed.reasoningEffort, "low"); assert.equal(resumed.serviceTier, "fast");
  await restored.request("turn/start", { threadId: first.thread.id, model: "cursor:one", input: [{ type: "text", text: "continue" }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const continued = (await f.calls()).filter(call => call.method === "session/prompt").at(-1);
  assert.deepEqual(continued.settings, { model: "one", effort: "low", fast: true, context: "256k" });
  const catalog = (await restored.request("model/list", {}, client)).data;
  assert.ok(catalog.every((model: any) => !model.id.includes("[")));
  const read = await restored.request("thread/resume", { threadId: first.thread.id }, client);
  assert.equal(read.model, "cursor:one"); assert.equal(read.reasoningEffort, "low"); assert.equal(read.serviceTier, "fast");
  await restored.close();
  const cold = new AcpEngine(f.engineOptions); t.after(() => cold.close());
  const coldResume = await cold.request("thread/resume", { threadId: first.thread.id }, client);
  assert.equal(coldResume.reasoningEffort, "low"); assert.equal(coldResume.serviceTier, "fast");
  assert.equal((cold as any).sessions.get(first.thread.id).parameterConfigs.find((config: any) => config.id === "context").currentValue, "256k");
  await cold.close();
});

test("Codex splits advertised model variants into native model/reasoning and applies Fast before accepting input", async t => {
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_SPLIT_MODEL_CONFIG: "1" } });
  const created = await f.engine.request("thread/start", { model: "codex:one[low]", serviceTier: "fast" }, client);
  assert.equal(created.thread.model, "codex:one[low]"); assert.equal(created.thread.serviceTier, "fast");
  assert.equal(created.modelProvider, "codex"); assert.equal(created.cwd, f.root);
  assert.deepEqual(created.runtimeWorkspaceRoots, [f.root]); assert.equal(created.approvalPolicy, "never");
  assert.deepEqual(created.sandbox, { type: "dangerFullAccess" });
  const resumed = await f.engine.request("thread/resume", { threadId: created.thread.id }, client);
  assert.equal(resumed.modelProvider, "codex"); assert.equal(resumed.model, "codex:one[low]");
  assert.equal(resumed.serviceTier, "fast"); assert.equal(resumed.reasoningEffort, "low");
  const configured = (await f.calls()).filter(call => call.method === "session/set_config_option");
  assert.deepEqual(configured.map(call => [call.configId, call.value]), [["model", "one"], ["reasoning_effort", "low"], ["fast-mode", "on"]]);
  assert.ok(!configured.some(call => call.configId === "model" && call.value.includes("[")), "a model config accepts base IDs, never a combined variant");
  await f.engine.discoverModelCapabilities(created.thread.id);
  const catalog = (await f.engine.request("model/list", {}, client)).data;
  assert.equal(catalog.length, 4, "config-only replies cannot discard the complete concrete catalog");
  assert.deepEqual(catalog.filter((model: any) => model.serviceTiers.length).map((model: any) => model.id), ["codex:one[low]", "codex:one[high]"]);
  const notices: any[] = []; f.engine.subscribe((method, params) => notices.push({ method, params }));
  await f.engine.request("turn/start", { threadId: created.thread.id, model: "codex:one[high]", serviceTier: null, input: [{ type: "text", text: "hello" }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  assert.equal((await f.engine.request("thread/read", { threadId: created.thread.id }, client)).thread.model, "codex:one[high]");
  assert.equal((await f.engine.request("thread/read", { threadId: created.thread.id }, client)).thread.serviceTier, null);
  const prompts = (await f.calls()).filter(call => call.method === "session/prompt").length;
  await assert.rejects(f.engine.request("turn/start", { threadId: created.thread.id, model: "codex:two[high]", serviceTier: "fast", input: [{ type: "text", text: "must not send" }] }, client), /Fast mode is unavailable/);
  await assert.rejects(f.engine.request("turn/start", { threadId: created.thread.id, model: "codex:one[ultra]", input: [{ type: "text", text: "must not send" }] }, client), /model option is unavailable/);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, prompts);
});

test("Codex resumes before applying cold model/reasoning/Fast selection and supports advertised boolean Fast", async t => {
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_SPLIT_MODEL_CONFIG: "1", ACP_TEST_BOOLEAN_FAST: "1" } });
  const created = await f.engine.request("thread/start", {}, client); await f.engine.close();
  const path = join(f.root, "data", `${created.thread.id}.json`);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  for (const key of ["modelConfigValues", "legacyModelCatalog", "reasoningConfig", "fastConfig", "fastModels"]) delete legacy[key];
  await writeFile(path, JSON.stringify(legacy));
  const restored = new AcpEngine(f.engineOptions); t.after(() => restored.close());
  const notices: any[] = []; restored.subscribe((method, params) => notices.push({ method, params }));
  await restored.request("turn/start", { threadId: created.thread.id, model: "codex:one[low]", serviceTier: "fast", input: [{ type: "text", text: "resume" }] }, client);
  await until(() => notices.some(notice => notice.method === "turn/completed"));
  const state = (await restored.request("thread/read", { threadId: created.thread.id }, client)).thread;
  assert.equal(state.model, "codex:one[low]"); assert.equal(state.serviceTier, "fast");
  const calls = await f.calls(), resume = calls.findIndex(call => call.method === "session/resume"), fast = calls.findIndex(call => call.configId === "fast-mode");
  assert.ok(resume >= 0 && fast > resume);
  assert.deepEqual([calls[fast].type, calls[fast].value], ["boolean", true]);
  await restored.close();
});

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


test("native history import preserves identity, survives restart, and resumes only on an explicit request", async t => {
  const id = "11111111-2222-3333-4444-555555555555";
  let projectName = "Original project";
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_IMPORT_SESSIONS: JSON.stringify({ sessions: [{ sessionId: id, cwd: "/workspace", title: "Local conversation", updatedAt: "2026-11-13T01:00:00Z" }], nextCursor: "page-2" }) },
    history: { async projects() { return { available: true, groups: { [id]: { source: "codex", id: "native-project-a", name: projectName, position: 3 } } }; }, async read() { return { data: [{ id: "old-turn", items: [{ id: "old-answer", type: "agentMessage", text: "Previous answer" }] }], nextCursor: null }; } } });
  const page = await f.engine.discoverNativeSessions();
  assert.equal(page.sessions[0].imported, false); assert.equal(page.nextCursor, "page-2");
  assert.equal(page.sessions[0].nativeProject?.name, "Original project");
  const [thread, repeated] = await Promise.all([f.engine.importNativeSession(page.sessions[0]), f.engine.importNativeSession(page.sessions[0])]);
  assert.equal(thread.id, repeated.id);
  assert.equal(thread.name, "Local conversation"); assert.equal(thread.cwd, "/workspace");
  assert.equal((await f.engine.discoverNativeSessions()).sessions[0].imported, true);
  assert.ok(!(await f.calls()).some(call => ["session/new", "session/resume", "session/prompt"].includes(call.method)));
  await f.engine.close();
  const restored = new AcpEngine(f.engineOptions); t.after(() => restored.close());
  const importedPath = join(f.root, "data", `${thread.id}.json`);
  const oldImport = JSON.parse(await readFile(importedPath, "utf8"));
  delete oldImport.nativeProject; delete oldImport.nativeImport;
  await writeFile(importedPath, JSON.stringify(oldImport));
  await restored.refreshNativeProjects();
  const backfilled = await restored.request("thread/read", { threadId: thread.id }, client);
  assert.equal(backfilled.thread.nativeProject.name, "Original project");
  const executionOwner = (restored as any).sessions.get(thread.id);
  projectName = "Renamed original project";
  await restored.refreshNativeProjects();
  assert.equal((restored as any).sessions.get(thread.id), executionOwner, "project backfill preserves the active execution Session owner");
  assert.equal((await restored.request("thread/read", { threadId: thread.id }, client)).thread.nativeProject.name, projectName);
  const listed = await restored.request("thread/list", {}, client); assert.equal(listed.data.length, 1); assert.equal(listed.data[0].id, thread.id);
  const history = await restored.request("thread/turns/list", { threadId: thread.id }, client); assert.equal(history.data[0].id, "old-turn");
  assert.equal(restored.processId, null, "reading imported history does not start the CLI");
  await restored.request("thread/resume", { threadId: thread.id }, client);
  const calls = await f.calls(); assert.equal(calls.filter(call => call.method === "session/resume").at(-1)?.sessionId, id);
  assert.ok(!calls.some(call => call.method === "session/new" || call.method === "session/prompt"));
  let completed = false;
  restored.subscribe(method => { if (method === "turn/completed") completed = true; });
  await restored.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Continue this conversation" }] }, client);
  await until(() => completed);
  const continued = await f.calls();
  assert.equal(continued.find(call => call.method === "session/prompt")?.sessionId, id);
  assert.equal(continued.some(call => call.method === "session/new"), false);
});


test("Codex branches a locked source without resuming or prompting it, persists its independent identity", async t => {
  const nativeId = "01a18abe-a779-7a71-abcc-8cdf8d0d5c6b";
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_SESSION_HANDOFF: "1", ACP_TEST_BUSY_NATIVE: nativeId },
    history: { async read() { return { data: [], nextCursor: null }; } } });
  const source = await f.engine.importNativeSession({ id: nativeId, cwd: f.root, title: "Original", updatedAt: null });
  await assert.rejects(f.engine.request("thread/resume", { threadId: source.id }, client), error => {
    assert.match((error as Error).message, /in use by another/);
    assert.deepEqual((error as any).domainData, { code: "CODEX_SESSION_BUSY", inputNotSent: true });
    return true;
  });
  assert.deepEqual(await f.engine.request("opencraft/agent-session/status", { threadId: source.id }, client), { fork: true, release: true, loaded: false });
  const before = (await f.calls()).length;
  const reply = await f.engine.request("thread/fork", { threadId: source.id, excludeTurns: true }, client);
  assert.notEqual(reply.thread.id, source.id);
  assert.equal(reply.thread.forkedFromId, source.id);
  const calls = (await f.calls()).slice(before);
  assert.deepEqual(calls.map(call => call.method), ["session/fork"]);
  assert.equal(calls[0].sessionId, nativeId);
  const saved = JSON.parse(await readFile(join(f.root, "data", `${reply.thread.id}.json`), "utf8"));
  assert.notEqual(saved.nativeId, nativeId); assert.equal(saved.cwd, f.root);
  assert.equal(saved.name, "Original"); assert.equal(saved.forkedFromId, source.id);
  const original = JSON.parse(await readFile(join(f.root, "data", `${source.id}.json`), "utf8"));
  assert.equal(original.nativeId, nativeId);
  await f.engine.request("turn/start", { threadId: reply.thread.id, input: [{ type: "text", text: "continue" }] }, client);
  await until(() => (f.engine as any).state(reply.thread.id).active?.status === "completed");
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").at(-1)?.sessionId, saved.nativeId);
});

test("Codex explicit release preserves identity, re-resumes before the next turn, and refuses active work", async t => {
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_SESSION_HANDOFF: "1" } });
  const { thread } = await f.engine.request("thread/start", {}, client);
  const id = thread.id;
  await f.engine.request("opencraft/agent-session/release", { threadId: id }, client);
  const status = await f.engine.request("opencraft/agent-session/status", { threadId: id }, client);
  assert.equal(status.loaded, false);
  await f.engine.request("turn/start", { threadId: id, input: [{ type: "text", text: "wait" }] }, client);
  await assert.rejects(f.engine.request("opencraft/agent-session/release", { threadId: id }, client), /finish its current work/);
  await until(() => (f.engine as any).state(id).active?.status === "completed");
  await f.engine.request("opencraft/agent-session/release", { threadId: id }, client);
  const relevant = (await f.calls()).filter(call => ["session/new", "session/resume", "session/close", "session/prompt"].includes(call.method));
  assert.deepEqual(relevant.map(call => call.method), ["session/new", "session/close", "session/resume", "session/prompt", "session/close"]);
  assert.ok(relevant.slice(1).every(call => call.sessionId === "native-1"));
});

test("native branching fails closed for unsupported peers and unsupported fork boundaries", async t => {
  const f = await fixture(t, { id: "codex" });
  const { thread } = await f.engine.request("thread/start", {}, client);
  assert.equal((await f.engine.request("opencraft/agent-session/status", { threadId: thread.id }, client)).fork, false);
  await assert.rejects(f.engine.request("thread/fork", { threadId: thread.id }, client), /unavailable/);
  const supported = await fixture(t, { id: "codex", env: { ACP_TEST_SESSION_HANDOFF: "1" } });
  const source = await supported.engine.request("thread/start", {}, client);
  await assert.rejects(supported.engine.request("thread/fork", { threadId: source.thread.id, lastTurnId: "turn-1" }, client), /full conversation/);
  assert.equal((await supported.calls()).filter(call => call.method === "session/fork").length, 0);
});


test("Codex fork restores the model forwarded by the persisted Host configuration", async t => {
  const f = await fixture(t, { id: "codex", env: { ACP_TEST_SESSION_HANDOFF: "1", ACP_TEST_SPLIT_MODEL_CONFIG: "1" } });
  const { thread } = await f.engine.request("thread/start", {}, client);
  const child = await f.engine.request("thread/fork", { threadId: thread.id, model: "codex:two[low]" }, client);
  assert.equal(child.model, "codex:two[low]");
  const saved = JSON.parse(await readFile(join(f.root, "data", `${child.thread.id}.json`), "utf8"));
  assert.equal(saved.model, "codex:two[low]");
});


test("ACP continuation references reach the selected Agent as user context without changing the user input", async t => {
  const f = await fixture(t, { id: "cursor" }), notices: any[] = [];
  f.engine.subscribe((method, params) => notices.push({ method, params }));
  const { thread } = await f.engine.request("thread/start", {}, client);
  await f.engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Continue the work" }], additionalContext: {
    history: { kind: "untrusted", value: "Read the referenced conversation: /private/synthetic/history.md" },
  } }, client);
  await until(() => notices.some(n => n.method === "turn/completed"));
  const response = notices.filter(n => n.method === "item/agentMessage/delta").map(n => n.params.delta).join("");
  assert.match(response, /synthetic\/history.md/); assert.match(response, /Continue the work/);
  const completed = notices.find(n => n.method === "turn/completed").params.turn;
  assert.equal(completed.items.find((item: any) => item.type === "userMessage").content[0].text, "Continue the work");
  const saved = JSON.parse(await readFile(join(f.root, "data", `${thread.id}.json`), "utf8"));
  assert.equal(saved.name, "Continue the work"); assert.equal(saved.preview, "Continue the work");
});
