import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, RunResult } from "@cursor/sdk";
import { ConfigurationError, RateLimitError, AgentBusyError, NetworkError } from "@cursor/sdk";
import { sdkErrorKind } from "../../apps/cursor-bridge/src/sdk-errors.js";
import { CURSOR_KEY_GUIDANCE, hasCursorCredentials } from "../../apps/cursor-bridge/src/credentials.js";
import { CURSOR_DECLARATION } from "../../apps/cursor-bridge/src/declaration.js";
import { CursorBridge, CursorError } from "../../apps/cursor-bridge/src/cursor.js";
import type { CursorRun } from "../../apps/cursor-bridge/src/types.js";
import { localOwnerClose } from "../../apps/cursor-bridge/src/lifecycle.js";
import { InputFiles, parseInput } from "../../apps/cursor-bridge/src/input.js";
import { assemble, createAssemblerState } from "../../packages/agent-bridge-assembler/src/index.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
class Run implements CursorRun {
  id = "run-1";
  terminal = deferred<RunResult>();
  ack = deferred<"complete_delivered" | "revert_to_followup">();
  messages: SDKMessage[] = [];
  texts: string[] = [];
  cancels = 0;
  steer = async (text: string) => { this.texts.push(text); return this.ack.promise; };
  async *stream(): AsyncIterable<SDKMessage> { yield { type: "user", agent_id: "agent-1", run_id: this.id, message: { role: "user", content: [{ type: "text", text: "steer" }] } }; for (const message of this.messages) yield message; await this.terminal.promise; }
  wait() { return this.terminal.promise; }
  async cancel() { this.cancels++; this.finish("cancelled"); }
  finish(status: "finished" | "cancelled" = "finished") { this.terminal.resolve({ id: this.id, status }); }
}
async function setup(t: any, timeout = 80, messages: SDKMessage[] = [], badAttachmentRoot = false) {
  const root = await mkdtemp(join(tmpdir(), "cursor-test-"));
  const control: { rejectCallbacks: boolean; closing?: Promise<void>; sending?: Promise<void>; closes?: number; onSend?: () => void } = { rejectCallbacks: false };
  const runs: Run[] = [], sends: string[] = [], deltas: any[] = [];
  const bridge = new CursorBridge({ attachmentRoot: badAttachmentRoot ? join(root, "missing-parent") : root, steerTimeoutMs: timeout,
    factory: { hasCredentials: async () => true, models: async () => [{ id: "cheap", name: "Cheap" }], create: async () => ({ agentId: "agent-1",
      send: async (text) => { sends.push(text); control.onSend?.(); await control.sending; const run = new Run(); run.id = `run-${runs.length + 1}`; run.messages = messages; runs.push(run); return run; }, close: async () => { control.closes = (control.closes ?? 0) + 1; } }) },
    notify: async (method, p) => { if (control.rejectCallbacks) throw Error("Host disconnected"); if (method === "thread/delta") { deltas.push(...p.deltas as any[]); if ((p.deltas as any[]).some((d) => d.op === "turn.close")) await control.closing; } return {}; } });
  t.after(async () => { for (const run of runs) { run.ack.resolve("revert_to_followup"); run.finish(); } await bridge.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  await bridge.handle("session/create", { threadId: "thread", cwd: root, stateDirectory: root, model: "cheap", permissionMode: "full" });
  const started = await bridge.handle("turn/start", { threadId: "thread", input: { text: "main" } }) as any;
  const params = { threadId: "thread", expectedTurnId: started.nativeTurnId, inputId: "input-1", clientRequestId: "client-1", input: { text: "steer" } };
  return { bridge, root, runs, sends, deltas, params, control };
}
async function until(predicate: () => boolean) { for (let n=0;n<1000;n++) { if (predicate()) return; await tick(); } assert.fail("condition timed out"); }


test("Cursor complete_delivered is SDK admission only through the assembler", async (t) => {
  const x = await setup(t);
  x.runs[0].ack.resolve("complete_delivered");
  assert.deepEqual(await x.bridge.handle("turn/steer", x.params), { deliveryMethod: "native-inject", evidence: "sdk-delivered" });
  assert.equal(x.sends.length, 1); assert.equal(x.runs[0].texts.length, 1);
  const proof = x.deltas.find((d) => d.op === "input.evidence");
  assert.equal(proof.evidenceKind, "admission"); assert.equal(proof.runId, "run-1");
  assert.equal(x.deltas.some((d) => d.evidenceKind === "context-confirmed"), false);
  // Local SDK user/history echo never participates in the evidence state.
  const events = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events;
  assert(events.some((e: any) => e.kind === "input.state" && e.status.admission.value === "accepted"));
  assert.equal(events.some((e: any) => e.kind === "input.state" && e.status.evidence.value === "context-confirmed"), false);
});

test("Cursor revert_to_followup is rejected without creating any followup", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("revert_to_followup");
  const result = await x.bridge.handle("turn/steer", x.params) as any;
  assert.equal(result.state, "rejected"); assert.match(result.message, /not inserted into the current turn/);
  x.runs[0].finish(); await tick(); await tick();
  assert.equal(x.sends.length, 1); assert.equal(x.runs[0].texts.length, 1);
  assert.equal(x.deltas.find((d) => d.op === "input.outcome").state, "rejected");
  assert.equal(x.deltas.some((d) => d.op === "input.delivery"), false);
});

test("Cursor native-only revert is rejected without sending followup", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("revert_to_followup");
  assert.equal((await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } }) as any).state, "rejected");
  assert.deepEqual(await readdir(x.root), []);
  x.runs[0].finish(); await tick(); await tick();
  assert.equal(x.sends.length, 1); assert.equal(x.deltas.some((d) => d.op === "input.delivery"), false);
});

test("Cursor timeout, late ack and duplicate input never replay a mutation", async (t) => {
  const x = await setup(t, 10);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params }), /unconfirmed/);
  x.runs[0].ack.resolve("revert_to_followup"); x.runs[0].finish(); await tick();
  await assert.rejects(x.bridge.handle("turn/steer", x.params), /unknown/);
  const query = await x.bridge.handle("input/query", { threadId: "thread", inputIds: ["input-1"] }) as any;
  assert.equal(query.inputs[0].state, "unknown"); assert.equal(x.sends.length, 1); assert.equal(x.runs[0].texts.length, 1);
});

test("Cursor rejected SDK promise is unknown with no fallback or replay", async (t) => {
  const x = await setup(t); const request = x.bridge.handle("turn/steer", x.params);
  await until(() => x.runs[0].texts.length === 1); x.runs[0].ack.reject(Error("lost response"));
  await assert.rejects(request, /unconfirmed/); assert.equal(x.sends.length, 1);
});

test("Cursor stop during attachment conversion prevents send and removes late files", async (t) => {
  const x = await setup(t);
  const request = x.bridge.handle("turn/steer", { ...x.params, input: { text: "with file", attachments: [{ data: "YQ==" }] } });
  await x.bridge.handle("turn/stop", { threadId: "thread" }); await request;
  assert.deepEqual(await readdir(x.root), []); assert.equal(x.runs[0].texts.length, 0);
});

test("Cursor stop during dispatched steer marks unknown and cleans attachments", async (t) => {
  const x = await setup(t, 20);
  const request = x.bridge.handle("turn/steer", { ...x.params, input: { text: "with file", attachments: [{ data: "YQ==" }] } });
  const caught = request.catch((e) => e);
  await until(() => x.runs[0].texts.length === 1);
  const stopping = x.bridge.handle("turn/stop", { threadId: "thread" });
  x.runs[0].ack.resolve("complete_delivered");
  await stopping; assert.match(((await caught) as Error).message, /Stop raced/);
  assert.deepEqual(await readdir(x.root), []); assert.equal(x.deltas.some((d) => d.op === "input.delivery"), false);
});

test("Cursor withdrawing during attachment conversion prevents SDK write and clears files", async (t) => {
  const x = await setup(t);
  const pending = x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  assert.deepEqual(await x.bridge.handle("input/withdraw", { threadId: "thread", inputId: "input-1" }), { state: "withdrawn" });
  await pending; assert.deepEqual(await readdir(x.root), []); assert.equal(x.runs[0].texts.length, 0);
});

test("Cursor run ending before steer ack preserves rejection without a new turn", async (t) => {
  const x = await setup(t); const pending = x.bridge.handle("turn/steer", x.params);
  await until(() => x.runs[0].texts.length === 1); x.runs[0].finish(); await tick();
  x.runs[0].ack.resolve("revert_to_followup"); assert.equal((await pending as any).state, "rejected");
  await tick(); assert.equal(x.sends.length, 1); assert.equal(x.deltas.filter((d) => d.op === "turn.open").length, 1);
});

test("Cursor stale targets, duplicate ids, unsupported modes and unknown fields refuse without SDK write", async (t) => {
  const x = await setup(t);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, expectedTurnId: "stale" }), /mismatch/);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, input: { text: "x", images: [] } }), /invalid/);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, input: { text: "/command" } }), /invalid/);
  x.runs[0].ack.resolve("complete_delivered"); await x.bridge.handle("turn/steer", x.params);
  await assert.rejects(x.bridge.handle("turn/steer", x.params), /registered/);
  assert.equal(x.runs[0].texts.length, 1);
});

test("Cursor attachment owner joins conversion before cleanup and rejects malformed content", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-files-"));
  try {
    const files = new InputFiles(parseInput({ text: "file", attachments: [{ data: "YQ==" }] }), root);
    const prepared = files.prepare(); await files.dispose(); await prepared;
    assert.deepEqual(await readdir(root), []);
    assert.throws(() => parseInput({ text: "file", attachments: [{ data: "!!" }] }));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("Cursor rejects queue and interrupt paths before any SDK write", async (t) => {
  const x = await setup(t);
  for (const delivery of ["next-turn", "interrupt-replace"]) await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, delivery }), /unsupported/);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, fallbackPolicy: "queue-when-explicit" }), /fallbackPolicy/);
  assert.equal(x.runs[0].texts.length, 0); assert.equal(x.runs[0].cancels, 0);
});

test("Cursor rejects a second ambiguous input and missing native steer without writes", async (t) => {
  const x = await setup(t);
  const first = x.bridge.handle("turn/steer", x.params); await until(() => x.runs[0].texts.length === 1);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, inputId: "second", clientRequestId: "second" }), /one unresolved/);
  x.runs[0].ack.resolve("complete_delivered"); await first;
  x.runs[0].steer = undefined as any;
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, inputId: "third", clientRequestId: "third" }), /no steer/);
});

test("Cursor unrecognized SDK outcome fences session without next-turn", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("future-outcome" as any);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params }), /unconfirmed/);
  assert.equal(x.sends.length, 1); assert.equal(x.deltas.some((d) => d.op === "input.delivery"), false);
});

test("Cursor delivered attachments live through run and are removed on completion", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  assert.equal((await readdir(x.root)).length, 1); x.runs[0].finish();
  for (let n=0;n<100;n++) { if (!(await readdir(x.root)).length) break; await tick(); }
  assert.deepEqual(await readdir(x.root), []);
});

test("Cursor SDK user echo cannot create context evidence", async (t) => {
  const x = await setup(t);
  x.runs[0].ack.resolve("complete_delivered"); await x.bridge.handle("turn/steer", x.params);
  assert(x.deltas.filter((d) => d.op === "input.evidence").every((d) => d.evidenceKind === "admission"));
});


test("Cursor cancellation failure stays observable but cleans owned attachments", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  const original = x.runs[0].cancel.bind(x.runs[0]);
  x.runs[0].cancel = async () => { throw Error("native cancellation failed"); };
  await assert.rejects(x.bridge.handle("turn/stop", { threadId: "thread" }), /cancellation failed/);
  assert.deepEqual(await readdir(x.root), []); x.runs[0].cancel = original;
});



test("Cursor callback loss cannot skip attachment cleanup", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  x.control.rejectCallbacks = true; x.runs[0].finish();
  for (let n=0;n<100;n++) { if (!(await readdir(x.root)).length) break; await tick(); }
  assert.deepEqual(await readdir(x.root), []);
  x.control.rejectCallbacks = false;
  await assert.rejects(x.bridge.handle("turn/start", { threadId: "thread", input: { text: "do not replay" } }), /unknown/);
  assert.equal(x.sends.length, 1);
  // Closing remains possible after a failed callback; native writes stay fenced.
  await x.bridge.close().catch(() => {});
});



test("Cursor refuses steer after run end while close callback is pending", async (t) => {
  const x = await setup(t); const gate = deferred<void>(); x.control.closing = gate.promise;
  x.runs[0].finish(); await until(() => x.deltas.some((d) => d.op === "turn.close"));
  try { await assert.rejects(x.bridge.handle("turn/steer", { ...x.params }), /no ready active/); }
  finally { gate.resolve(); }
  assert.equal(x.runs[0].texts.length, 0); assert.equal(x.sends.length, 1);
});



test("Cursor Stop cleans attachments even while initial SDK send remains pending", { timeout: 5000 }, async (t) => {
  const x = await setup(t); x.runs[0].finish();
  await until(() => x.deltas.some((d) => d.op === "turn.close"));
  await tick(); await tick();
  const gate = deferred<void>(); x.control.sending = gate.promise;
  const entered = deferred<void>(); x.control.onSend = () => entered.resolve();
  const starting = x.bridge.handle("turn/start", { threadId: "thread", input: { text: "new task", attachments: [{ data: "YQ==" }] } });
  await entered.promise;
  const stopping = x.bridge.handle("turn/stop", { threadId: "thread" });
  try {
    for (let n=0;n<100;n++) { if (!(await readdir(x.root)).length) break; await tick(); }
    assert.deepEqual(await readdir(x.root), []);
  } finally { gate.resolve(); }
  await starting; await stopping;
  assert.equal(x.runs[1].cancels, 1);
});


test("Cursor Stop cleans attachments before a pending native cancel ack", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  const gate = deferred<void>(); const cancel = x.runs[0].cancel.bind(x.runs[0]);
  x.runs[0].cancel = async () => { await gate.promise; await cancel(); };
  const stopping = x.bridge.handle("turn/stop", { threadId: "thread" });
  try { for (let n=0;n<100;n++) { if (!(await readdir(x.root)).length) break; await tick(); } assert.deepEqual(await readdir(x.root), []); }
  finally { gate.resolve(); }
  await stopping; assert.equal(x.sends.length, 1);
});

test("Cursor missing API key returns actionable auth guidance without creating an agent", async () => {
  let creates = 0;
  const bridge = new CursorBridge({ factory: { hasCredentials: async () => false, models: async () => [], create: async () => { creates++; throw Error("must not create"); } }, notify: async () => ({}) });
  await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  await assert.rejects(bridge.handle("session/create", { threadId: "t", cwd: "/", stateDirectory: "/", model: "cheap", permissionMode: "full" }),
    (e: unknown) => e instanceof CursorError && e.kind === "auth" && e.message === CURSOR_KEY_GUIDANCE
      && /(^|\s)https:\/\/cursor\.com\/dashboard\/api(\s|[.,;)]|$)/.test(e.message) && e.message.includes("CURSOR_API_KEY"));
  assert.equal(creates, 0); await bridge.close();
});
test("Cursor accepts environment API keys or existing SDK credentials without copying key material", async () => {
  let checks = 0;
  assert.equal(await hasCursorCredentials({ CURSOR_API_KEY: "private-synthetic-key" }, async () => { checks++; return { status: "logged-out" }; }), true);
  assert.equal(checks, 0);
  assert.equal(await hasCursorCredentials({}, async () => ({ status: "logged-in" })), true);
  assert.equal(await hasCursorCredentials({ CURSOR_API_KEY: "  " }, async () => ({ status: "logged-out" })), false);
  assert.deepEqual(CURSOR_DECLARATION.capabilities.steer.deliveryMethods, ["native-inject"]);
});
test("Cursor unknown withdrawal preserves unknown in the assembler and never claims too-late", async (t) => {
  const x = await setup(t, 10);
  await assert.rejects(x.bridge.handle("turn/steer", x.params), /unconfirmed/);
  assert.deepEqual(await x.bridge.handle("input/withdraw", { threadId: "thread", inputId: "input-1" }), { state: "unknown" });
  assert.equal((await x.bridge.handle("input/query", { threadId: "thread" }) as any).inputs[0].state, "unknown");
  const events = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events;
  assert.equal(events.filter((e) => e.kind === "input.state").at(-1)?.status.outcome, "unknown");
});

test("Cursor SDK assistant chunks assemble into one complete message", async (t) => {
  const messages: SDKMessage[] = ["Hello", " world"].map((text) => ({ type: "assistant", agent_id: "agent-1", run_id: "run-1", message: { role: "assistant", content: [{ type: "text", text }] } }));
  const x = await setup(t, 80, messages);
  await until(() => x.deltas.filter((d) => d.op === "item.textDelta").length === 2);
  x.runs[0].finish(); await until(() => x.deltas.some((d) => d.op === "turn.close"));
  const events = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events;
  const completed = events.filter((e) => e.kind === "item.completed").map((e) => e.item.shape);
  assert.deepEqual(completed, [{ kind: "agentMessage", text: "Hello world" }]);
});

test("Cursor typed SDK create refusals stay rejected; mutation uncertainty stays unknown", () => {
  assert.equal(sdkErrorKind("create", new ConfigurationError("private detail")), "invalid");
  assert.equal(sdkErrorKind("create", new RateLimitError("private detail")), "quota");
  assert.equal(sdkErrorKind("create", new AgentBusyError("private detail")), "explicit-reject");
  assert.equal(sdkErrorKind("create", new NetworkError("private detail")), "unknown-outcome");
  assert.equal(sdkErrorKind("steer", new ConfigurationError("private detail")), "unknown-outcome");
  assert.notEqual(new CursorError("quota", "limit").code, new CursorError("invalid", "invalid").code);
});
test("Cursor rejected and unknown outcomes preserve client request identity before admission", async (t) => {
  const x = await setup(t, 10); x.runs[0].ack.resolve("revert_to_followup");
  await x.bridge.handle("turn/steer", x.params);
  const states = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events.filter((e) => e.kind === "input.state");
  assert.equal(states.at(-1)?.status.clientRequestId, "client-1");
  assert.notEqual(states.at(-1)?.status.registration, null);
  assert.equal(states.at(-1)?.status.targetNativeTurnId, x.params.expectedTurnId);
  assert.equal(states.at(-1)?.status.nativeSession, "agent-1");
  assert.equal(states.at(-1)?.status.admission.value, "rejected");
  const second = { ...x.params, inputId: "input-2", clientRequestId: "client-2" };
  x.runs[0].steer = async () => new Promise(() => {});
  await assert.rejects(x.bridge.handle("turn/steer", second), /unconfirmed/);
  const last = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events.filter((e) => e.kind === "input.state").at(-1)?.status;
  assert.equal(last?.clientRequestId, "client-2"); assert.equal(last?.outcome, "unknown"); assert.notEqual(last?.registration, null);
});
test("Cursor stale Stop cannot cancel or disable the following turn", async (t) => {
  const x = await setup(t); x.runs[0].finish(); await until(() => x.deltas.some((d) => d.op === "turn.close")); await tick(); await tick();
  const next = await x.bridge.handle("turn/start", { threadId: "thread", input: { text: "second" } }) as any;
  await assert.rejects(x.bridge.handle("turn/stop", { threadId: "thread", turnId: x.params.expectedTurnId }), /Stop target/);
  assert.equal(x.runs[1].cancels, 0);
  x.runs[1].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, expectedTurnId: next.nativeTurnId });
  assert.equal(x.runs[1].texts.length, 1);
});
test("Cursor close failure leaves the native session owned and retryable", async (t) => {
  const x = await setup(t); const cancel = x.runs[0].cancel.bind(x.runs[0]);
  x.runs[0].cancel = async () => { throw Error("native cancel failed"); };
  await assert.rejects(x.bridge.handle("session/close", { threadId: "thread" }), (e: unknown) => e instanceof CursorError && e.kind === "explicit-reject");
  assert.equal(x.control.closes ?? 0, 0); assert.equal(x.deltas.some((d) => d.op === "session.ended"), false);
  x.runs[0].cancel = cancel;
  await x.bridge.handle("session/close", { threadId: "thread" });
  assert.equal(x.control.closes, 1); assert.equal(x.deltas.some((d) => d.op === "session.ended"), true);
});
test("Cursor clientRequestId is idempotent even if a retry changes inputId", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered"); await x.bridge.handle("turn/steer", x.params);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, inputId: "different" }), /already registered/);
  assert.equal(x.runs[0].texts.length, 1);
});
test("Cursor attachment preparation failure settles failed without native execution", async (t) => {
  const x = await setup(t, 80, [], true);
  await assert.rejects(x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } }), /nothing was sent/);
  assert.equal((await x.bridge.handle("input/query", { threadId: "thread" }) as any).inputs[0].state, "failed");
  assert.equal(x.runs[0].texts.length, 0);
  x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, inputId: "new", clientRequestId: "new", input: { text: "no file" } });
  assert.equal(x.runs[0].texts.length, 1); assert.deepEqual(await readdir(x.root), []);
});
test("Cursor cleanup failure still cancels native work and retries file disposal", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  const dispose = InputFiles.prototype.dispose; let attempts = 0;
  InputFiles.prototype.dispose = async function () { if (++attempts === 1) throw Error("transient removal failure"); await dispose.call(this); };
  try { await x.bridge.handle("turn/stop", { threadId: "thread", expectedTurnId: x.params.expectedTurnId }); }
  finally { InputFiles.prototype.dispose = dispose; }
  assert.equal(x.runs[0].cancels, 1); assert(attempts > 1); assert.deepEqual(await readdir(x.root), []);
});
test("Cursor cancelled tool is terminal in the canonical projection", async (t) => {
  const x = await setup(t, 80, [{ type: "tool_call", agent_id: "agent-1", run_id: "run-1", call_id: "tool", name: "shell", status: "running" }]);
  await until(() => x.deltas.some((d) => d.op === "item.open" && d.nativeKey === "tool"));
  await x.bridge.handle("turn/stop", { threadId: "thread", turnId: x.params.expectedTurnId });
  const events = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events;
  const completed = events.filter((e) => e.kind === "item.completed").at(-1)?.item.shape;
  assert.deepEqual(completed, { kind: "tool", name: "shell", status: "failed" });
});

test("Cursor preparing withdrawal settles before a persistent cleanup failure and close can retry", async (t) => {
  const x = await setup(t);
  const dispose = InputFiles.prototype.dispose;
  InputFiles.prototype.dispose = async () => { throw Error("disk removal blocked"); };
  try {
    const pending = x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
    await assert.rejects(x.bridge.handle("turn/stop", { threadId: "thread" }), (e: unknown) => e instanceof CursorError && e.kind === "explicit-reject");
    await pending;
    assert.equal(x.deltas.some((d) => d.op === "input.withdrawal" && d.state === "withdrawn"), true);
    assert.equal(x.runs[0].cancels, 1);
    const states = assemble(createAssemblerState(1), x.deltas, { threadId: "thread", clockSeed: 1 }).events.filter((e) => e.kind === "input.state");
    assert.equal(states.at(-1)?.status.outcome, "withdrawn");
  } finally { InputFiles.prototype.dispose = dispose; }
  await x.bridge.handle("session/close", { threadId: "thread" });
  assert.deepEqual(await readdir(x.root), []);
});
test("Cursor consume cleanup failure retains files for close without rejecting the finished run", async (t) => {
  const x = await setup(t); x.runs[0].ack.resolve("complete_delivered");
  await x.bridge.handle("turn/steer", { ...x.params, input: { text: "file", attachments: [{ data: "YQ==" }] } });
  const dispose = InputFiles.prototype.dispose; let attempts = 0;
  InputFiles.prototype.dispose = async () => { attempts++; throw Error("disk removal blocked"); };
  try {
    x.runs[0].finish(); await until(() => attempts > 0); await tick(); await tick();
    await assert.rejects(x.bridge.handle("session/close", { threadId: "thread" }), (e: unknown) => e instanceof CursorError && e.kind === "explicit-reject");
    assert.equal(x.control.closes ?? 0, 0);
  } finally { InputFiles.prototype.dispose = dispose; }
  await x.bridge.handle("session/close", { threadId: "thread" });
  assert.deepEqual(await readdir(x.root), []);
});
test("Cursor factory close refusal is retryable and preserves the session", async () => {
  let calls = 0;
  const bridge = new CursorBridge({ factory: { hasCredentials: async () => true, models: async () => [], create: async () => ({ agentId: "agent", send: async () => { throw Error("unused"); }, close: async () => { if (++calls === 1) throw Error("termination failed"); } }) }, notify: async () => ({}) });
  await bridge.handle("initialize", { protocolVersion: 1, grammarRange: { min: 1, max: 1 } });
  await bridge.handle("session/create", { threadId: "t", cwd: "/", stateDirectory: "/", model: "cheap", permissionMode: "full" });
  await assert.rejects(bridge.handle("session/close", { threadId: "t" }), (e: unknown) => e instanceof CursorError && e.kind === "explicit-reject");
  assert.deepEqual(await bridge.handle("session/close", { threadId: "t" }), { closed: true });
  assert.equal(calls, 2); await bridge.close();
});
test("Cursor local close terminates after SDK disposal failure and retries only failed termination", async () => {
  let disposals = 0, terminations = 0;
  const close = localOwnerClose(async () => { disposals++; throw Error("SDK dispose failed"); }, async () => { if (++terminations === 1) throw Error("worker termination failed"); });
  await assert.rejects(close(), /termination failed/);
  await close(); await close();
  assert.equal(disposals, 1); assert.equal(terminations, 2);
});

test("Cursor local withdrawal cleanup failure stays definitive and close retries its files", async (t) => {
  const x = await setup(t); const dispose = InputFiles.prototype.dispose;
  InputFiles.prototype.dispose = async () => { throw Error("removal blocked"); };
  try {
    const pending = x.bridge.handle("turn/steer", x.params);
    await assert.rejects(x.bridge.handle("input/withdraw", { threadId: "thread", inputId: "input-1" }), (e: unknown) => e instanceof CursorError && e.kind === "explicit-reject");
    await pending;
    assert.equal(x.runs[0].texts.length, 0);
    assert.equal(x.deltas.some((d) => d.op === "input.withdrawal" && d.state === "withdrawn"), true);
  } finally { InputFiles.prototype.dispose = dispose; }
  await x.bridge.handle("session/close", { threadId: "thread" });
});
