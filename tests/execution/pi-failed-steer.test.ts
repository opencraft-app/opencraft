import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiEngine, piModel } from "../../plugins/pi-engine/src/index.js";
import type { ExecutionEngineClient } from "@opencraft/appserver-client";
import { projectPiSnapshot } from "../../plugins/pi-engine/src/projection.js";

const client: ExecutionEngineClient = { notify() {}, async request() { throw new Error("Unexpected tool"); } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("retry after a pre-response abort keeps its new Turn identity", () => {
  const snapshot: any = {
    entries: [
      { id: 1, kind: "opencraft.input", data: { turnId: "old" }, model: [{ role: "user", content: "first" }] },
      { id: 2, kind: "opencraft.input", data: { turnId: "new" }, model: [{ role: "user", content: "retry" }] },
    ],
    submissions: [
      { id: 10, type: "input", entry: 1, requestId: "old", status: "unanswered", reason: "aborted" },
      { id: 11, type: "input", entry: 2, requestId: "new", status: "placed" },
    ],
    live: { run: { taskId: 20, inputs: [11] } }, inbox: [], tasks: new Map(), agent: {}, usage: {},
  };
  const turns = projectPiSnapshot({ id: "fixture", cwd: "/", tools: [] }, snapshot);
  assert.deepEqual(turns.map(turn => [turn.id, turn.status]), [["old", "interrupted"], ["new", "inProgress"]]);
});
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < deadline, "native execution did not settle"); await pause(10); }
}

test("failed generation retires an unconsumed steer and permits the next input", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-failed-steer-"));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => enter = resolve);
  const held = new Promise<void>(resolve => release = resolve);
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    async () => { enter(); await held; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture quota exhausted" }); },
    fauxAssistantMessage("recovered after changing provider"),
  ]);
  const models = createModels(); models.setProvider(faux.provider);
  const runtimeModels = Object.assign(models, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime;
  let engine = new PiEngine({ directory, cwd: directory, models: runtimeModels });
  t.after(async () => { release(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const events: { method: string; params: any }[] = [];
  engine.subscribe((method, params) => events.push({ method, params }));
  const { thread } = await engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: directory }, client);
  const { turn } = await engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "report" }], clientUserMessageId: "original" }, client);
  await entered;
  await engine.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "are you stuck?" }], clientUserMessageId: "followup" }, client);
  const native = (engine as any).sessions.get(thread.id).native;
  const pending = await native.snapshot();
  release();
  await eventually(async () => !(await native.snapshot()).live.run);
  const read = await engine.request("thread/read", { threadId: thread.id, includeTurns: true }, client);
  assert.equal(read.thread.turns.at(-1).status, "failed", "a queued steer must not keep its failed owner thinking forever");
  assert.match(read.thread.turns.at(-1).error.message, /fixture quota exhausted/);
  assert.equal(read.thread.turns.at(-1).items.find((item: any) => item.clientId === "followup").__opencraftSteeringStatus, "cancelled");
  await eventually(async () => events.some(event => event.method === "turn/completed" && event.params.turn.id === turn.id));
  const snapshot = await native.snapshot();
  assert.equal(snapshot.inbox.length, 0, "the obsolete steer must not leak into a later run");
  assert.ok(snapshot.submissions.every((s: any) => s.status === "unanswered"));
  // Older owners left this exact durable shape behind: no live run, a failed
  // original receipt, and an unplaced steering receipt still in the inbox.
  const pendingSteer = pending.submissions.find((s: any) => s.status === "queued");
  const legacy = { ...snapshot, inbox: pending.inbox,
    submissions: snapshot.submissions.map((s: any) => s.id === pendingSteer.id ? pendingSteer : s) };
  const historical = projectPiSnapshot({ id: thread.id, cwd: directory, tools: [] }, legacy);
  assert.equal(historical.at(-1)!.status, "failed", "read-only history must also project old stuck ledgers correctly");
  assert.equal(historical.at(-1)!.items.find((item: any) => item.clientId === "followup").__opencraftSteeringStatus, "cancelled");
  assert.equal((await engine.request("model/list", {}, client)).data.length, 1);
  await engine.close();
  engine = new PiEngine({ directory, cwd: directory, models: runtimeModels });
  const restored = await engine.request("thread/resume", { threadId: thread.id }, client);
  assert.equal(restored.thread.turns.at(-1).status, "failed");
  assert.equal(faux.state.callCount, 1, "reopening must not execute a cancelled steer");
  await engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "try again" }], clientUserMessageId: "retry" }, client);
  await eventually(async () => faux.state.callCount === 2 && !(await (engine as any).sessions.get(thread.id).native.snapshot()).live.run);
  const recovered = await engine.request("thread/read", { threadId: thread.id, includeTurns: true }, client);
  assert.equal(recovered.thread.turns.at(-1).status, "completed");
  assert.equal(recovered.thread.turns.length, 2);
});
