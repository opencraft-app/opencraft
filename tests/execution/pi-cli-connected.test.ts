import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpEngine } from "../../plugins/acp-engine/src/index.js";
import { ConnectedAgentHistory } from "../../apps/local-agent-host/src/connected-agent-history.js";
import { readPiCliHistory } from "../../apps/local-agent-host/src/pi-cli-history.js";
const client = { notify() {}, async request() { throw new Error("Unexpected platform callback"); } };
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
async function fixture(t: test.TestContext, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-cli-connected-")), native = join(root, "native"); await mkdir(native);
  const trace = join(root, "trace");
  const options = { id: "pi-cli" as const, protocol: "pi-rpc" as const, threadNamespace: "picli_", label: "Pi", permission: "allow-once" as const,
    command: process.execPath, args: [resolve("tests/fixtures/pi-cli-peer.mjs"), "--mode", "rpc", "--session-dir", native],
    cwd: root, dataDirectory: join(root, "data"), env: { PI_TEST_TRACE: trace, ...env } };
  const create = () => new AcpEngine({ ...options, history: new ConnectedAgentHistory("pi-cli", native) });
  const engine = create(); t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  const calls = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, engine, create, calls };
}
async function completed(engine: AcpEngine, threadId: string, input: unknown[], options = {}) {
  let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
  const unsubscribe = engine.subscribe((method, params) => { if (method === "turn/completed" && params.threadId === threadId) finish(); });
  try { const result = await engine.request("turn/start", { threadId, input, ...options }, client); await done; return result; }
  finally { unsubscribe(); }
}
test("connected Pi uses its declared models, images and thinking; reload reads native history without a new prompt", async t => {
  const f = await fixture(t), { thread } = await f.engine.request("thread/start", {}, client);
  assert.match(thread.id, /^picli_/u);
  const catalog = (await f.engine.request("model/list", { threadId: thread.id }, client)).data;
  assert.deepEqual(catalog.map((m: any) => m.inputModalities), [["text", "image"], ["text"]]);
  await completed(f.engine, thread.id, [{ type: "text", text: "tool" }, { type: "image", url: image }], { model: "pi-cli:fixture:vision", effort: "low" });
  const page = await f.engine.request("thread/turns/list", { threadId: thread.id, limit: 10, itemsView: "full", sortDirection: "asc" }, client);
  assert.equal(page.data[0].items[0].content[1].url, image);
  assert.ok(page.data[0].items.some((item: any) => item.type === "agentMessage" && item.text === "PI_OK:tool"));
  assert.ok(page.data[0].items.some((item: any) => item.type === "mcpToolCall" && item.result.content[0].text === "full tool output"));
  assert.equal((await f.calls()).filter(c => c.type === "prompt").length, 1);
  const before = (await f.calls()).length; await f.engine.close();
  const cold = f.create(); t.after(() => cold.close());
  await cold.request("thread/read", { threadId: thread.id, initialTurnsPage: { limit: 1, itemsView: "full", sortDirection: "desc" } }, client);
  assert.equal((await f.calls()).slice(before).some(c => c.type === "get_state" || c.type === "prompt"), false);
  await completed(cold, thread.id, [{ type: "text", text: "again" }]);
  assert.equal((await f.calls()).filter(c => c.type === "prompt").length, 2);
  await cold.close();
});
test("Pi sessions keep separate native cwd/model state; a text-only model rejects an image before native prompt", async t => {
  const f = await fixture(t), cwd = join(f.root, "project"); await mkdir(cwd);
  const a = await f.engine.request("thread/start", { cwd, model: "pi-cli:fixture:vision" }, client);
  const b = await f.engine.request("thread/start", { model: "pi-cli:fixture:text" }, client);
  assert.notEqual((f.engine as any).executionObservation(a.thread.id).pid, (f.engine as any).executionObservation(b.thread.id).pid);
  await assert.rejects(completed(f.engine, b.thread.id, [{ type: "image", url: image }]), /does not support image/);
  assert.equal((await f.calls()).some(c => c.type === "prompt"), false);
  await completed(f.engine, a.thread.id, [{ type: "text", text: "cwd" }]);
  const prompt = (await f.calls()).find(c => c.type === "prompt"); assert.equal(prompt.cwd, await realpath(cwd));
});
test("Pi stops an active run and settles after retries and a completion preceding its prompt ACK", async t => {
  for (const env of [{}, { PI_TEST_ACK_LAST: "1" }]) {
    const f = await fixture(t, env), { thread } = await f.engine.request("thread/start", {}, client);
    await completed(f.engine, thread.id, [{ type: "text", text: "retry" }]);
    await completed(f.engine, thread.id, [{ type: "text", text: "/handled" }]);
  }
  const f = await fixture(t), { thread } = await f.engine.request("thread/start", {}, client);
  const done = completed(f.engine, thread.id, [{ type: "text", text: "wait" }]);
  for (let i = 0; i < 100 && !(await f.calls()).some(c => c.type === "prompt"); i++) await new Promise(resolve => setTimeout(resolve, 10));
  await f.engine.request("turn/interrupt", { threadId: thread.id }, client); await done;
  assert.equal((await f.engine.request("thread/read", { threadId: thread.id }, client)).thread.status.type, "idle");
});
test("Pi history follows the selected branch, preserves tool output and rejects broken graph identities", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-history-")); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "session.jsonl"), header = { type: "session", version: 3, id: "native", cwd: root };
  const entry = (id: string, parentId: string | null, role: string, content: unknown) => ({ type: "message", id, parentId, message: { role, content } });
  await writeFile(path, [header, entry("u", null, "user", "question"), entry("discarded", "u", "assistant", [{ type: "text", text: "wrong branch" }]), entry("selected", "u", "assistant", [{ type: "text", text: "right branch" }])].map(v => JSON.stringify(v)).join("\n") + "\n");
  const turns = await readPiCliHistory(path, "native"); assert.deepEqual(turns[0].items.map(item => item.text).filter(Boolean), ["right branch"]);
  await assert.rejects(readPiCliHistory(path, "other"), /Invalid Pi session/);
  await writeFile(path, [header, entry("broken", "missing", "user", "question")].map(v => JSON.stringify(v)).join("\n") + "\n");
  await assert.rejects(readPiCliHistory(path, "native"), /parent is missing/);
});
test("a Pi connection loss after prompt ACK cannot automatically continue or replay an unknown result", async t => {
  const f = await fixture(t), { thread } = await f.engine.request("thread/start", {}, client);
  await completed(f.engine, thread.id, [{ type: "text", text: "disconnect" }]);
  assert.equal(f.engine.occupancy.nativeOutcomeUnknown, 1);
  await assert.rejects(f.engine.request("turn/start", { threadId: thread.id, input: [] }, client), /cannot be continued/);
  assert.equal((await f.calls()).filter(c => c.type === "prompt").length, 1);
});
test("a selected invalid execution sandbox cannot fall back to a bare Pi process", async t => {
  const original = process.env.OPENCRAFT_SANDBOX_CONFIG;
  const f = await fixture(t);
  process.env.OPENCRAFT_SANDBOX_CONFIG = join(f.root, "missing-sandbox.json");
  try {
    await assert.rejects(f.engine.request("thread/start", {}, client));
    assert.equal(f.engine.processId, null);
    await assert.rejects(readFile(join(f.root, "trace")), /ENOENT/);
  } finally {
    if (original === undefined) delete process.env.OPENCRAFT_SANDBOX_CONFIG; else process.env.OPENCRAFT_SANDBOX_CONFIG = original;
  }
});
test("a newly created empty Pi session can resume after restart before its first native transcript exists", async t => {
  const f = await fixture(t), { thread } = await f.engine.request("thread/start", {}, client);
  await f.engine.close();
  const cold = f.create(); t.after(() => cold.close());
  await cold.request("thread/resume", { threadId: thread.id }, client);
  await completed(cold, thread.id, [{ type: "text", text: "first input" }]);
  assert.equal((await f.calls()).filter(call => call.type === "prompt").length, 1);
  await cold.close();
});
