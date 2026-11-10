import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { AcpBridge, profileFromEnv } from "../../packages/agent-bridge-acp/src/index.js";

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const value = await read(); if (accept(value)) return value; await wait(10); }
  throw new Error("fixture condition timed out");
}
async function fixture(t: any, scenario = "success") {
  const frames: { direction: string; frame: any }[] = [];
  const deltas: any[] = [];
  const bridge = new AcpBridge({
    profile: profileFromEnv({
      AGENT_BRIDGE_ACP_DIALECT: "codebuddy", AGENT_BRIDGE_ACP_COMMAND: process.execPath,
      AGENT_BRIDGE_ACP_ARGS: JSON.stringify([resolve("tests/agent-bridge/fixtures/codebuddy-agent.mjs")]),
      AGENT_BRIDGE_ACP_CWD: process.cwd(), AGENT_BRIDGE_ACP_ENV: JSON.stringify({ CODEBUDDY_FIXTURE: scenario }),
    }),
    requestCallback: async (method, params) => { if (method === "thread/delta") deltas.push(...params.deltas as any[]); return {}; },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
  });
  t.after(() => bridge.close());
  const initialized = await bridge.initialize({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  const call = (method: string, params: Record<string, unknown> = {}) => bridge.handle(method, { threadId: "thread", executionEpoch: 1, ...params }) as Promise<any>;
  await call("session/create");
  const start = async () => {
    const count = frames.filter((f) => f.frame.method === "session/prompt").length;
    const result = await call("turn/start", { input: { text: "minimal task" } });
    await until(() => frames.filter((f) => f.direction === "in" && f.frame.params?.update?.messageId === `initial-${count + 1}`).length, (n) => n > 0);
    return result.nativeTurnId;
  };
  const steer = (turn: string, input: unknown = { text: "follow up" }, inputId = "steer") => call("turn/steer", {
    expectedTurnId: turn, inputId, clientRequestId: `client-${inputId}`, delivery: "native-inject", input,
  });
  const status = async () => (await call("input/query")).inputs[0];
  return { bridge, initialized, frames, deltas, call, start, steer, status };
}

for (const scenario of ["success", "echo-first", "meta-id"]) {
  test(`CodeBuddy double receipt: ${scenario}`, async (t) => {
    const f = await fixture(t, scenario);
    assert(f.initialized.effectiveCapabilities.steer.evidenceKinds.includes("native-input-id"));
    const turn = await f.start();
    await f.steer(turn);
    const state = await until(f.status, (s) => s.outcome === "delivered");
    assert.equal(state.evidence.kind, "native-input-id");
    assert.equal(state.evidence.runId, "owner-1");
    assert.equal(typeof state.evidence.nativeInputId, "string");
    const wire = f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/steer" && f.frame.params.sessionId);
    assert.equal(wire.length, 1);
    assert.equal(wire[0].frame.params.expectedRequestId, "owner-1");
    assert.equal(typeof wire[0].frame.params.clientUserMessageId, "string");
    assert.equal(f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/prompt").length, 1);
  });
}
for (const scenario of ["missing-admission", "missing-insertion", "wrong-admission-owner", "wrong-insertion-owner", "wrong-id", "wrong-session"]) {
  test(`CodeBuddy ${scenario}: unknown, never replay`, async (t) => {
    const f = await fixture(t, scenario);
    const turn = await f.start();
    await f.steer(turn);
    const state = await until(f.status, (s) => s.outcome === "unknown");
    assert.equal(state.delivery.value, "none");
    assert.equal(state.evidence.value, "none");
    const before = f.frames.filter((f) => f.direction === "out" && ["session/prompt", "session/steer"].includes(f.frame.method)).length;
    await f.call("input/query");
    await wait(20);
    assert.equal(f.frames.filter((f) => f.direction === "out" && ["session/prompt", "session/steer"].includes(f.frame.method)).length, before);
    assert.equal(f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/cancel").length, 0);
    assert(!f.deltas.some((d) => d.op === "input.delivery" && d.inputId === "steer" && d.admitted === true));
  });
}

test("CodeBuddy probe text drift never declares steering even with generic metadata", async (t) => {
  const f = await fixture(t, "probe-drift");
  assert(!f.initialized.effectiveCapabilities.steer.deliveryMethods.includes("native-inject"));
  assert(!f.initialized.effectiveCapabilities.steer.evidenceKinds.includes("native-input-id"));
  assert.equal(f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/prompt").length, 0);
});

test("CodeBuddy rejects slash, image and unknown content before dispatch; explicit queue remains available", async (t) => {
  const f = await fixture(t);
  const turn = await f.start();
  for (const input of [{ text: "  /help" }, { text: "image", images: [{ mimeType: "image/png", data: "YQ==" }] }, { text: "resource", resource: "file" }]) {
    await assert.rejects(f.steer(turn, input), /plain text/);
  }
  assert.equal(f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/steer" && f.frame.params.sessionId).length, 0);
  const queued = await f.call("turn/steer", { inputId: "queued", clientRequestId: "queued", delivery: "next-turn", input: { text: "/help" } });
  assert.equal(queued.queued, true);
  await f.call("turn/stop");
});


test("CodeBuddy admission alone stays pending until run end, then becomes unknown", async (t) => {
  const f = await fixture(t, "hold-missing-insertion");
  const turn = await f.start();
  await f.steer(turn);
  await until(() => f.frames.some((f) => f.direction === "in" && f.frame.result?.steered === true), Boolean);
  assert.equal((await f.status()).outcome, "pending");
  assert.equal((await f.status()).evidence.value, "none");
  await f.call("turn/stop");
  assert.equal((await until(f.status, (s) => s.outcome === "unknown")).delivery.value, "none");
});

test("CodeBuddy late old-run insertion cannot settle unknown or bind the next run", async (t) => {
  const f = await fixture(t, "late-receipts");
  const turn = await f.start();
  await f.steer(turn);
  await until(f.status, (s) => s.outcome === "unknown");
  const next = await f.start();
  assert.equal((await f.status()).outcome, "unknown");
  await f.steer(next, { text: "new follow up" }, "new-steer");
  const last = f.frames.filter((f) => f.direction === "out" && f.frame.method === "session/steer" && f.frame.params.sessionId).at(-1)!;
  assert.equal(last.frame.params.expectedRequestId, "owner-2");
});
