import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { LiveDoc } from "@earendil-works/pi-durable";
import { PiEngine, piModel } from "../../plugins/pi-engine/src/index.js";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { assert.ok(Date.now() < deadline, "expected execution did not arrive"); await pause(10); }
}
const client = { notify() {}, async request() { throw new Error("Unexpected browser tool"); } };

test("batched shell continuation retains one execution owner for Host tools and restored history", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-batch-host-"));
  let release!: () => void, entered!: () => void, hostCalls = 0;
  const held = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.1; printf one", yield_time_ms: 0 }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.1; printf two", yield_time_ms: 0 }), { stopReason: "toolUse" }),
    async () => { entered(); await held; return fauxAssistantMessage("main report"); },
    fauxAssistantMessage(fauxToolCall("opencraft_host_check", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("checked"),
  ]);
  const catalog = createModels(); catalog.setProvider(faux.provider);
  const models = Object.assign(catalog, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime;
  const engine = new PiEngine({ directory, cwd: directory, models, sessionCapabilities: {
    tools: () => [{ name: "check", description: "Check", inputSchema: { type: "object", properties: {} } }],
    async call() { hostCalls++; return { success: true, contentItems: [{ type: "inputText", text: "ok" }] }; },
  } });
  t.after(async () => { release(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const { thread } = await engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: directory }, client);
  await engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "run" }] }, client);
  await ready;
  const native = (engine as any).sessions.get(thread.id).native;
  try { await until(async () => (await native.snapshot()).submissions.filter((s: any) => s.requestId?.startsWith("pi-shell:")).length === 2); }
  finally { release(); }
  await until(async () => faux.state.callCount === 5 && !(await native.snapshot()).live.run);
  assert.equal(hostCalls, 1, "the continuation must be authorized to use its installed Host tools");
  const first = await engine.request("thread/read", { threadId: thread.id, includeTurns: true }, client);
  const batch = first.thread.turns.filter((turn: any) => turn.id.startsWith("pi-shell:"));
  assert.equal(batch.length, 1);
  assert.equal(batch[0].items.find((item: any) => item.type === "dynamicToolCall").success, true);
  const liveProjection = (engine as any).sessions.get(thread.id).turns;
  assert.deepEqual(liveProjection.map((turn: any) => turn.id), first.thread.turns.map((turn: any) => turn.id));
});

test("shell admission ahead of snapshot cannot consume a steer whose target just failed", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-steer-admission-race-"));
  let release!: () => void, entered!: () => void, continued = false, obsoleteSeen = false;
  const held = new Promise<void>(r => release = r), ready = new Promise<void>(r => entered = r);
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 20", yield_time_ms: 0 }), { stopReason: "toolUse" }),
    async () => { entered(); await held; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture quota exhausted" }); },
    ctx => { obsoleteSeen = JSON.stringify(ctx.messages).includes("obsolete-steer"); continued = true; return fauxAssistantMessage("background handled"); },
  ]);
  const catalog = createModels(); catalog.setProvider(faux.provider);
  const engine = new PiEngine({ directory, cwd: directory, models: Object.assign(catalog, { getAvailableSnapshot: () => faux.models }) as unknown as ModelRuntime });
  t.after(async () => { release(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const { thread } = await engine.request("thread/start", { model: piModel("faux", "faux-1"), cwd: directory }, client);
  const { turn } = await engine.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "run" }] }, client);
  await ready;
  await engine.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, clientUserMessageId: "obsolete", input: [{ type: "text", text: "obsolete-steer" }] }, client);
  const native = (engine as any).sessions.get(thread.id).native;
  const original = native.snapshot.bind(native);
  const shell = (await original()).shell.records[0];
  let injected = false;
  native.snapshot = async () => {
    const live = await native.root.commit(async (tx: any) => JSON.parse(JSON.stringify(await tx.doc(LiveDoc, native.root.id))), context);
    if (!live.run && !injected) {
      injected = true;
      // Deliver at the real adapter boundary before the watch can reconcile its snapshot.
      await native.shellNotification({ triggerTurn: true, message: { customType: "interactive-shell-transfer",
        details: { sessionId: shell.id, completion: { exitCode: 0 } }, content: "background completed" } });
    }
    return original();
  };
  release();
  await until(async () => continued);
  assert.equal(injected, true);
  assert.equal(obsoleteSeen, false, "expired steering must be withdrawn before admission places inbox inputs");
  await until(async () => !(await original()).live.run);
  const snapshot = await original();
  assert.equal(snapshot.submissions.find((s: any) => s.requestId?.endsWith(":obsolete")).status, "unanswered");
  native.snapshot = original;
});
