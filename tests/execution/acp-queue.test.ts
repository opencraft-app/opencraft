import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AcpEngine } from "../../plugins/acp-engine/src/index.js";
import type { ExecutionEngineClient } from "../../packages/appserver-client/src/execution-engine.js";

const client: ExecutionEngineClient = { notify() {}, async request() { throw new Error("No browser tools"); } };
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const text = (text: string) => [{ type: "text", text, text_elements: [] }];
async function until(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Queue condition timed out"); await delay(10); }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "acp-queue-")), trace = join(root, "trace.jsonl");
  const options = { id: "codex" as const, command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: root,
    dataDirectory: join(root, "data"), env: { ACP_TEST_PERMISSIONS: "1", ACP_TEST_TRACE: trace, ACP_TEST_IMAGES: "1" } };
  const engines: AcpEngine[] = [], open = () => { const engine = new AcpEngine(options); engines.push(engine); return engine; };
  t.after(async () => { for (const engine of engines) await engine.close(); await rm(root, { recursive: true, force: true }); });
  const engine = open(), notices: { method: string; params: any }[] = [];
  engine.subscribe((method, params) => notices.push({ method, params }));
  const { thread } = await engine.request("thread/start", {}, client);
  const request = (method: string, params = {}, owner = engine) => owner.request(method, { threadId: thread.id, ...params }, client);
  const list = async (owner = engine) => (await request("thread/queue/list", {}, owner)).data as any[];
  const calls = async () => (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const queue = (id: string, message = id) => request("thread/queue/add", { clientUserMessageId: id, input: text(message) });
  const path = join(options.dataDirectory, `${thread.id}.json`);
  return { root, engine, open, thread, notices, request, list, calls, queue, path };
}

test("connected ACP agents expose a real queue and automatically dispatch exactly once in FIFO order", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.engine.extensions["opencraft/thread-follow-up"], { version: 1, queue: true, steer: true });
  assert.deepEqual(f.engine.extensions["opencraft/thread-queue"], { version: 2, reorder: true, atomicSteer: true, perItemPause: false });
  const cursorEngine = new AcpEngine({ id: "cursor", command: process.execPath, args: [resolve("tests/fixtures/acp-engine-peer.mjs")], cwd: f.root, dataDirectory: join(f.root, "cursor-data") });
  t.after(() => cursorEngine.close());
  assert.deepEqual(cursorEngine.extensions["opencraft/thread-follow-up"], { version: 1, queue: true, steer: false });
  assert.deepEqual(cursorEngine.extensions["opencraft/thread-queue"], { version: 2, reorder: true, atomicSteer: false, perItemPause: false });
  await f.request("turn/start", { input: text("wait:first") });
  const [second, third] = await Promise.all([f.queue("second"), f.queue("third")]);
  assert.deepEqual((await f.list()).map(item => item.clientUserMessageId), ["second", "third"]);
  assert.deepEqual(await f.queue("second"), second, "lost queue ACK returns the same committed admission");
  await assert.rejects(f.queue("second", "changed"), /different content/);
  assert.equal(f.notices.filter(n => n.method === "turn/started").length, 1);
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 3);
  assert.deepEqual((await f.calls()).filter(call => call.method === "session/prompt").map(call => call.prompt[0].text), ["wait:first", "second", "third"]);
  assert.deepEqual(await f.list(), []);
  await f.queue("third"); await delay(30);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 3, "delivered admission never replays");
  assert.notEqual(second.queuedSubmission.id, third.queuedSubmission.id);
});

test("queued screenshots are owned inline, survive source deletion, and keep additional context", async t => {
  const f = await fixture(t), path = join(f.root, "image.png");
  await writeFile(path, Buffer.from(image, "base64"));
  await f.request("turn/start", { input: text("wait:first") });
  const additionalContext = { selection: { kind: "untrusted", value: "Keep this context" } };
  await f.request("thread/queue/add", { clientUserMessageId: "image", input: [...text("Look"), { type: "localImage", path }], additionalContext });
  await rm(path);
  assert.equal((await f.list())[0].input[1].url, `data:image/png;base64,${image}`);
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 2);
  const delivered = (await f.calls()).filter(call => call.method === "session/prompt")[1].prompt;
  assert.deepEqual(delivered[1], { type: "image", mimeType: "image/png", data: image });
  assert.match(delivered[2].text, /Keep this context/);
});

test("accepted queue custody outlives a disconnected viewing client", async t => {
  const f = await fixture(t);
  await f.request("turn/start", { input: text("wait:first") });
  await f.queue("follow-up"); f.engine.disconnect(client);
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 2);
  assert.deepEqual(await f.list(), []);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 2);
});

test("queue validation does not accept malformed input and pending custody prevents generation suspension", async t => {
  const f = await fixture(t);
  const active = await f.request("turn/start", { input: text("wait:first") });
  await assert.rejects(f.request("thread/queue/add", { clientUserMessageId: "bad", input: [{ type: "image", url: "https://example.com/private.png" }] }), /Invalid inline image/);
  assert.deepEqual(await f.list(), []);
  await f.queue("retained");
  await f.request("turn/interrupt", { turnId: active.turn.id });
  await until(() => f.notices.some(n => n.method === "turn/completed"));
  await assert.rejects(f.engine.suspend(), /active work/);
  assert.equal((await f.list()).length, 1);
  await f.request("turn/start", { input: text("new direct input") });
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 3);
  assert.deepEqual((await f.calls()).filter(call => call.method === "session/prompt").map(call => call.prompt[0].text), ["wait:first", "new direct input", "retained"]);
});

test("Stop pauses pending input before cancelling and permits edit, reorder, removal and explicit resume", async t => {
  const f = await fixture(t);
  const active = await f.request("turn/start", { input: text("wait:first") });
  const a = (await f.queue("a")).queuedSubmission, b = (await f.queue("b")).queuedSubmission;
  await assert.rejects(f.request("turn/interrupt", { turnId: "stale" }), /turn changed/);
  await f.request("turn/interrupt", { turnId: active.turn.id });
  await until(() => f.notices.some(n => n.method === "turn/completed"));
  assert.ok((await f.list()).every(item => item.pausedReason === "user-stopped"));
  await f.request("thread/queue/update", { queuedSubmissionId: a.id, input: text("edited") });
  await f.request("thread/queue/reorder", { queuedSubmissionIds: [b.id, a.id] });
  await assert.rejects(f.request("thread/queue/reorder", { queuedSubmissionIds: [a.id] }), /Queue changed/);
  await f.request("thread/queue/delete", { queuedSubmissionId: b.id });
  await assert.rejects(f.queue("b"), /removed/);
  await delay(40);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 1);
  await f.request("thread/queue/start");
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 2);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt")[1].prompt[0].text, "edited");
});

test("provider failures pause the queue and cold reads never start or resume an Agent", async t => {
  const f = await fixture(t);
  // Queue admission is serialized ahead of the controlled provider rejection.
  await f.request("turn/start", { input: text("wait:first") });
  await f.queue("fail", "fail:response"); await f.queue("retained");
  await until(() => f.notices.filter(n => n.method === "turn/completed").length === 2);
  assert.equal((await f.list())[0].pausedReason, "delivery-failed");
  await f.engine.close();
  const restored = f.open();
  assert.equal((await f.list(restored))[0].clientUserMessageId, "retained");
  assert.equal(restored.processId, null);
  await f.request("thread/queue/start", {}, restored);
  await until(async () => (await f.list(restored)).length === 0);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 3);
});

test("restart recovers claims without replaying a prompt committed before lost ACK", async t => {
  const f = await fixture(t);
  const active = await f.request("turn/start", { input: text("wait:first") });
  const a = (await f.queue("a")).queuedSubmission;
  await f.request("turn/interrupt", { turnId: active.turn.id });
  await until(() => f.notices.some(n => n.method === "turn/completed"));
  await f.engine.close();
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  saved.queue.items[0].state = "dispatching";
  saved.receipts.a = { state: "unknown", turnId: null };
  saved.lastTurn = { id: "committed-turn", status: "inProgress", clientUserMessageId: "a" };
  await writeFile(f.path, JSON.stringify(saved));
  const restored = f.open();
  assert.deepEqual(await f.list(restored), []);
  assert.deepEqual(await restored.inputs.receipt(f.thread.id, "a"), { state: "delivered", turnId: "committed-turn" });
  assert.equal(restored.processId, null);
  assert.equal((await f.request("thread/queue/add", { clientUserMessageId: "a", input: text("a") }, restored)).queuedSubmission.id, a.id);
  assert.equal(restored.processId, null);
});

test("restart before prompt commit retains editable custody and requires explicit resume", async t => {
  const f = await fixture(t);
  const active = await f.request("turn/start", { input: text("wait:first") });
  await f.queue("a");
  await f.request("turn/interrupt", { turnId: active.turn.id });
  await until(() => f.notices.some(n => n.method === "turn/completed"));
  await f.engine.close();
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  saved.queue.items[0].state = "dispatching"; saved.queue.pausedReason = null;
  saved.receipts.a = { state: "unknown", turnId: null };
  await writeFile(f.path, JSON.stringify(saved));
  const restored = f.open();
  assert.equal((await f.list(restored))[0].pausedReason, "user-stopped");
  assert.equal(await restored.inputs.receipt(f.thread.id, "a"), null);
  assert.equal(restored.processId, null);
  await f.request("thread/queue/start", {}, restored);
  await until(async () => (await f.list(restored)).length === 0);
  assert.equal((await f.calls()).filter(call => call.method === "session/prompt").length, 2);
});

test("Codex ACP supports direct turn/steer and atomic thread/queue/steer via _session/steering", async t => {
  const f = await fixture(t);
  const started = await f.request("turn/start", { input: text("wait:long-task") });
  const activeTurnId = started.turn.id as string;

  // 1. Direct turn/steer
  const direct = await f.request("turn/steer", {
    expectedTurnId: activeTurnId,
    clientUserMessageId: "direct-steer-1",
    input: text("先看第二个文件"),
  });
  assert.equal(direct.turnId, activeTurnId);

  // 2. Queued message steered into the active turn via thread/queue/steer
  const queued = await f.queue("queued-steer-1", "顺便加上单测");
  await assert.rejects(
    f.request("thread/queue/steer", { queuedSubmissionId: queued.queuedSubmission.id, expectedTurnId: "stale-turn-id" }),
    (err: any) => err?.data?.code === "EXPECTED_TURN_MISMATCH" && err?.data?.actualTurnId === activeTurnId,
  );
  const steered = await f.request("thread/queue/steer", {
    queuedSubmissionId: queued.queuedSubmission.id,
    expectedTurnId: activeTurnId,
  });
  assert.equal(steered.turnId, activeTurnId);
  assert.deepEqual(await f.list(), []);

  const steerCalls = (await f.calls()).filter(call => call.method === "_session/steering");
  assert.deepEqual(steerCalls.map(call => call.prompt[0].text), ["先看第二个文件", "顺便加上单测"]);

  await f.request("turn/interrupt", { turnId: activeTurnId });
  await until(() => f.notices.some(n => n.method === "turn/completed"));
});
