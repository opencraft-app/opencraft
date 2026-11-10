import assert from "node:assert/strict";
import test from "node:test";
import { assemble, createAssemblerState } from "../../packages/agent-bridge-assembler/src/index.js";
import { PiBridge, PI_BRIDGE_DECLARATION, BridgeRequestError } from "../../plugins/pi-bridge/src/bridge.js";
import { PiDeltaMapper } from "../../plugins/pi-bridge/src/mapper.js";
import type {
  PiModelInfo,
  PiOwnerCreate,
  PiOwnerFactory,
  PiOwnerPort,
  PiProjectedSnapshot,
  PiSubmissionState,
} from "../../plugins/pi-bridge/src/types.js";

type Value = Record<string, any>;

const SCOPE = { threadId: "thr-pi" };

function user(id: string, text: string, extra: Value = {}): Value {
  return { type: "userMessage", id, clientId: extra.clientId ?? null, content: [{ type: "text", text }], ...extra };
}

function assistant(id: string, text: string): Value {
  return { type: "agentMessage", id, text };
}

function tool(id: string, status: "inProgress" | "completed" | "failed" = "inProgress", output: string | null = null): Value {
  return { type: "dynamicToolCall", id, tool: "read", status, contentItems: output === null ? null : [{ type: "inputText", text: output }] };
}

function turn(id: string, status: string, items: Value[]): Value {
  return { id, status, items };
}

function snapshot(
  turns: Value[],
  submissions: Record<string, PiSubmissionState> = {},
  activeTurnId: string | null = turns.find(candidate => candidate.status === "inProgress")?.id ?? null,
): PiProjectedSnapshot {
  return {
    turns: turns as never,
    submissions: new Map(Object.entries(submissions)),
    activeTurnId,
    usage: {
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      modelContextWindow: 1000,
    },
  };
}

function deltasAt(recorder: Recorder, index: number): Value[] {
  return recorder.deltas()[index] ?? [];
}

test("declaration exposes only the native same-turn path and non-context evidence", () => {
  const steer = PI_BRIDGE_DECLARATION.capabilities.steer;
  assert.deepEqual([...steer.deliveryMethods], ["native-inject"]);
  assert.deepEqual([...steer.evidenceKinds], ["admission", "queue-change"]);
  assert.equal(steer.withdrawal, "none");
  assert.equal(steer.fallbackPolicy, "reject-unknown");
  assert.ok(!steer.evidenceKinds.includes("context-confirmed"), "queue removal must never claim context confirmation");
  assert.ok(!steer.evidenceKinds.includes("native-input-id"), "a durable submission id is not model-context proof");
  assert.equal(steer.contentLimits.allowedContentTypes.length, 1);
  assert.equal(steer.contentLimits.allowedContentTypes[0], "text");
});

test("tool-interleaved steer becomes admission plus queue-change evidence only", () => {
  const mapper = new PiDeltaMapper({ threadId: SCOPE.threadId, nativeSessionId: "native-1", now: () => 1 });
  const initial = snapshot([turn("t1", "inProgress", [user("u1", "do work"), tool("tool-1")])]);
  const first = mapper.diff(initial);
  assert.deepEqual(first.map(delta => delta.op), ["turn.open", "item.open", "item.close", "item.open", "usage"]);

  const registration = { inputId: "in-steer", clientRequestId: "client-1", expectedTurnId: "t1", text: "use the answer 42" };
  assert.deepEqual(mapper.registerSteer(registration), { duplicate: false, conflict: false });
  const accepted = mapper.acceptedDeltas(registration, true);
  assert.deepEqual(accepted.map(delta => delta.op), ["input.accepted", "input.delivery"]);
  const evidence = mapper.evidenceDeltas("in-steer", "admission", "pi-submission:in-steer");
  assert.equal(evidence[0]?.op, "input.evidence");
  assert.equal((evidence[0] as Value).evidenceKind, "admission");

  const placed = snapshot([
    turn("t1", "inProgress", [
      user("u1", "do work"),
      tool("tool-1", "completed", "file body"),
      user("u2", "use the answer 42", { __opencraftMessageKind: "steering" }),
      assistant("a1", "The answer is 42."),
    ]),
  ], { "in-steer": { status: "placed", entry: 9 } });
  const second = mapper.diff(placed);
  const ops = second.map(delta => delta.op);
  assert.ok(ops.includes("item.textDelta"), "assistant text streams");
  const queueEvidence = second.find(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "queue-change");
  assert.ok(queueEvidence, "inbox/entry transition is recorded as queue-change");
  assert.equal((queueEvidence as Value).evidenceRef, "pi-entry:9");
  assert.ok(!JSON.stringify(second).includes("context-confirmed"), "no delta may upgrade queue removal to context confirmation");

  const completed = snapshot([
    turn("t1", "completed", [
      user("u1", "do work"),
      tool("tool-1", "completed", "file body"),
      user("u2", "use the answer 42", { __opencraftMessageKind: "steering" }),
      assistant("a1", "The answer is 42."),
    ]),
  ], { "in-steer": { status: "done", entry: 9 } }, null);
  const third = mapper.diff(completed);
  assert.ok(third.some(delta => delta.op === "turn.close"));
  assert.ok(!third.some(delta => delta.op === "input.outcome"), "a placed steer is not reported as lost");
  assert.equal(mapper.query("in-steer")?.state, "evidence-observed");
});

test("duplicate text with two stable input ids stays two facts", () => {
  const mapper = new PiDeltaMapper({ threadId: SCOPE.threadId, nativeSessionId: "native-1", now: () => 1 });
  mapper.diff(snapshot([turn("t1", "inProgress", [user("u1", "work")])]));
  const left = { inputId: "in-a", clientRequestId: "client-a", expectedTurnId: "t1", text: "same text" };
  const right = { inputId: "in-b", clientRequestId: "client-b", expectedTurnId: "t1", text: "same text" };
  mapper.registerSteer(left);
  mapper.registerSteer(right);
  mapper.acceptedDeltas(left, true);
  mapper.acceptedDeltas(right, true);
  const placed = snapshot([
    turn("t1", "inProgress", [
      user("u1", "work"),
      user("u2", "same text"),
      user("u3", "same text"),
      assistant("a1", "answer"),
    ]),
  ], {
    "in-a": { status: "placed", entry: 2 },
    "in-b": { status: "placed", entry: 3 },
  });
  const deltas = mapper.diff(placed);
  const evidence = deltas.filter(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "queue-change");
  assert.equal(evidence.length, 2);
  assert.deepEqual(new Set(evidence.map(delta => (delta as Value).inputId)), new Set(["in-a", "in-b"]));
  assert.notEqual((evidence[0] as Value).evidenceRef, (evidence[1] as Value).evidenceRef);
});

test("unconsumed steer at turn end is an explicit failure, not delivery", () => {
  const mapper = new PiDeltaMapper({ threadId: SCOPE.threadId, nativeSessionId: "native-1", now: () => 1 });
  mapper.diff(snapshot([turn("t1", "inProgress", [user("u1", "work")])]));
  const registration = { inputId: "in-late", clientRequestId: "client-late", expectedTurnId: "t1", text: "too late" };
  mapper.registerSteer(registration);
  mapper.acceptedDeltas(registration, true);
  mapper.evidenceDeltas("in-late", "admission", "pi-submission:in-late");
  const raced = snapshot([turn("t1", "completed", [user("u1", "work")])], {
    "in-late": { status: "unanswered", reason: "aborted" },
  }, null);
  const deltas = mapper.diff(raced);
  const outcome = deltas.find(delta => delta.op === "input.outcome");
  assert.ok(outcome);
  assert.equal((outcome as Value).state, "failed");
  assert.equal((outcome as Value).reason, "Pi turn ended before steer was consumed");
  assert.ok(!deltas.some(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "queue-change"));
  assert.equal(mapper.query("in-late")?.state, "failed");
});

class Recorder {
  readonly frames: { method: string; params: Value; id: string }[] = [];
  async send(method: string, params: unknown, id: string): Promise<void> {
    this.frames.push({ method, params: params as Value, id });
  }
  deltas(): Value[][] {
    return this.frames.filter(frame => frame.method === "thread/delta").map(frame => frame.params.deltas as Value[]);
  }
  allDeltas(): Value[] {
    return this.deltas().flat();
  }
}

class FakeOwner implements PiOwnerPort {
  readonly info: PiOwnerCreate;
  private listener?: (snapshot: PiProjectedSnapshot) => void;
  private exit?: (error: Error) => void;
  private turns: Value[] = [];
  private submissions = new Map<string, PiSubmissionState>();
  private active: string | null = null;
  private queued: string[] = [];
  rejectNextSteer = false;
  unknownNextSteer = false;

  constructor(info: PiOwnerCreate) {
    this.info = info;
  }

  private emit(): void {
    this.listener?.(this.snapshotNow());
  }

  private snapshotNow(): PiProjectedSnapshot {
    return {
      turns: structuredClone(this.turns) as never,
      submissions: new Map(this.submissions),
      activeTurnId: this.active,
    };
  }

  async snapshot(): Promise<PiProjectedSnapshot> {
    return this.snapshotNow();
  }

  async submit(content: readonly Record<string, unknown>[], _data: Value, requestId: string): Promise<void> {
    this.turns.push({ id: requestId, status: "inProgress", items: [{ type: "userMessage", id: `${requestId}:user`, content }] });
    this.submissions.set(requestId, { status: "placed", entry: this.turns.length });
    this.active = requestId;
    this.emit();
  }

  async steer(content: readonly Record<string, unknown>[], _data: Value, requestId: string, expectedTurnId: string): Promise<void> {
    if (this.rejectNextSteer) {
      this.rejectNextSteer = false;
      throw new Error("Pi turn identity changed");
    }
    if (this.unknownNextSteer) {
      this.unknownNextSteer = false;
      throw new Error("storage commit failed after admission");
    }
    if (this.active !== expectedTurnId) throw new Error("Pi turn identity changed");
    this.submissions.set(requestId, { status: "queued" });
    this.queued.push(requestId);
    this.emit();
  }

  placeSteers(): void {
    const turn = this.turns.find(candidate => candidate.id === this.active);
    assert.ok(turn);
    for (const id of this.queued.splice(0)) {
      this.submissions.set(id, { status: "placed", entry: turn.items.length + 1 });
      turn.items.push({ type: "userMessage", id: `${id}:user`, content: [{ type: "text", text: "same" }], __opencraftMessageKind: "steering" });
    }
    this.emit();
  }

  finish(status: "completed" | "interrupted" = "completed", settleQueued = "failed"): void {
    const turn = this.turns.find(candidate => candidate.id === this.active);
    if (turn) turn.status = status;
    if (this.active !== null) {
      const current = this.submissions.get(this.active);
      if (current) this.submissions.set(this.active, { status: "done", entry: current.entry ?? 1 });
    }
    for (const id of this.queued.splice(0)) {
      this.submissions.set(id, settleQueued === "failed"
        ? { status: "unanswered", reason: "aborted" }
        : { status: "placed", entry: 99 });
    }
    this.active = null;
    this.emit();
  }

  async execution(requestId: string): Promise<"running" | "completed" | "failed" | null> {
    const record = this.submissions.get(requestId);
    if (!record) return null;
    if (record.status === "done") return "completed";
    if (record.status === "unanswered") return "failed";
    return "running";
  }

  async abort(): Promise<void> {
    this.finish("interrupted");
  }

  async close(): Promise<void> {
    this.listener = undefined;
  }

  setSnapshotListener(listener: (snapshot: PiProjectedSnapshot) => void): void {
    this.listener = listener;
  }

  setExitListener(listener: (error: Error) => void): void {
    this.exit = listener;
  }

  crash(): void {
    this.exit?.(new Error("test owner lost"));
  }
}

class FakeFactory implements PiOwnerFactory {
  readonly owners = new Map<string, FakeOwner>();
  creates = 0;
  resumes = 0;
  async models(): Promise<readonly PiModelInfo[]> {
    return [{ id: "pi:test:model", provider: "test", modelId: "model", displayName: "Test", contextWindow: 1000,
      inputModalities: ["text"], supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium", cost: null }];
  }
  async create(input: { routeId: string; cwd: string; model: string | { provider: string; modelId: string } }): Promise<PiOwnerPort> {
    this.creates++;
    const info: PiOwnerCreate = {
      routeId: input.routeId,
      ownerThreadId: `owner-${this.creates}`,
      nativeSessionId: `native-${this.creates}`,
      cwd: input.cwd,
      model: typeof input.model === "string" ? { provider: "test", modelId: "model" } : input.model,
      thinkingLevel: "medium",
    };
    const owner = new FakeOwner(info);
    this.owners.set(input.routeId, owner);
    return owner;
  }
  async resume(input: { routeId: string }): Promise<PiOwnerPort> {
    this.resumes++;
    const owner = this.owners.get(input.routeId);
    if (!owner) throw new Error("No bridge-owned Pi session to resume");
    return owner;
  }
  async close(owner: PiOwnerPort): Promise<void> {
    await owner.close();
  }
}

async function settle(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function setup() {
  const recorder = new Recorder();
  const factory = new FakeFactory();
  const bridge = new PiBridge({ factory, send: (method, params, id) => recorder.send(method, params, id) });
  assert.ok(bridge.initialize({ protocolVersion: 1, grammarRange: { min: 1, max: 1 } }));
  await bridge.command("session/create", { threadId: SCOPE.threadId, cwd: "/tmp", model: "pi:test:model" });
  await bridge.command("turn/start", { threadId: SCOPE.threadId, inputId: "in-1", clientRequestId: "client-1", input: "work" });
  await settle(() => recorder.allDeltas().some(delta => delta.op === "turn.open"), "turn open");
  return { recorder, factory, bridge, owner: factory.owners.get(SCOPE.threadId)! };
}

test("bridge steer reports admission immediately and queue-change later, without waiting for consumption", async () => {
  const { recorder, bridge, owner } = await setup();
  await bridge.command("turn/steer", {
    threadId: SCOPE.threadId,
    inputId: "in-2",
    clientRequestId: "client-2",
    expectedTurnId: "in-1",
    input: "same text",
  });
  const afterSteer = recorder.allDeltas();
  assert.ok(afterSteer.some(delta => delta.op === "input.accepted" && (delta as Value).inputId === "in-2"));
  assert.ok(afterSteer.some(delta => delta.op === "input.delivery" && (delta as Value).admitted === true));
  assert.ok(afterSteer.some(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "admission"));
  assert.ok(!afterSteer.some(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "queue-change"));
  assert.equal((await owner.snapshot()).submissions.get("in-2")?.status, "queued");

  owner.placeSteers();
  await settle(() => recorder.allDeltas().some(delta => delta.op === "input.evidence" && (delta as Value).evidenceKind === "queue-change"), "queue-change");
  assert.ok(!JSON.stringify(recorder.allDeltas()).includes("context-confirmed"));

  owner.finish("completed");
  await settle(() => recorder.allDeltas().some(delta => delta.op === "turn.close"), "turn close");
  assert.ok(!recorder.allDeltas().some(delta => delta.op === "input.outcome"));
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("bridge duplicate text uses distinct native ids and idempotent retry", async () => {
  const { recorder, bridge, owner } = await setup();
  await bridge.command("turn/steer", { threadId: SCOPE.threadId, inputId: "in-a", clientRequestId: "client-a", expectedTurnId: "in-1", input: "same" });
  await bridge.command("turn/steer", { threadId: SCOPE.threadId, inputId: "in-b", clientRequestId: "client-b", expectedTurnId: "in-1", input: "same" });
  const accepted = recorder.allDeltas().filter(delta => delta.op === "input.accepted");
  assert.equal(accepted.length, 2);
  assert.deepEqual(new Set(accepted.map(delta => (delta as Value).inputId)), new Set(["in-a", "in-b"]));
  const before = recorder.allDeltas().length;
  const repeat = await bridge.command("turn/steer", { threadId: SCOPE.threadId, inputId: "in-a", clientRequestId: "client-a", expectedTurnId: "in-1", input: "same" });
  assert.ok(deepEqualSafe(repeat, { threadId: SCOPE.threadId, inputId: "in-a", duplicate: true, state: "admitted" }));
  assert.equal(recorder.allDeltas().length, before, "an idempotent retry must not increment native executions");
  await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

function deepEqualSafe(actual: unknown, expected: unknown): boolean {
  try { assert.deepEqual(actual, expected); return true; } catch { return false; }
}

test("stale steer is rejected explicitly and never marked delivered", async () => {
  const { recorder, bridge, owner } = await setup();
  owner.rejectNextSteer = true;
  await assert.rejects(
    bridge.command("turn/steer", { threadId: SCOPE.threadId, inputId: "in-stale", clientRequestId: "client-stale", expectedTurnId: "in-1", input: "late" }),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "stale-target",
  );
  const deltas = recorder.allDeltas();
  assert.ok(deltas.some(delta => delta.op === "input.delivery" && (delta as Value).inputId === "in-stale" && (delta as Value).admitted === false));
  assert.ok(!deltas.some(delta => delta.op === "input.evidence" && (delta as Value).inputId === "in-stale"));
  assert.equal((await owner.snapshot()).submissions.get("in-stale"), undefined);
  await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("turn end before steer consumption emits an explicit failed outcome", async () => {
  const { recorder, bridge, owner } = await setup();
  await bridge.command("turn/steer", { threadId: SCOPE.threadId, inputId: "in-late", clientRequestId: "client-late", expectedTurnId: "in-1", input: "late" });
  owner.finish("completed", "failed");
  await settle(() => recorder.allDeltas().some(delta => delta.op === "input.outcome" && (delta as Value).inputId === "in-late"), "input outcome");
  const outcome = recorder.allDeltas().find(delta => delta.op === "input.outcome" && (delta as Value).inputId === "in-late") as Value;
  assert.equal(outcome.state, "failed");
  assert.equal(outcome.reason, "Pi turn ended before steer was consumed");
  assert.ok(!recorder.allDeltas().some(delta => delta.op === "input.evidence" && (delta as Value).inputId === "in-late" && (delta as Value).evidenceKind === "queue-change"));
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("session/create is idempotent in-process and does not open a second writer", async () => {
  const { factory, bridge } = await setup();
  assert.equal(factory.creates, 1);
  const again = await bridge.command("session/create", { threadId: SCOPE.threadId, cwd: "/tmp", model: "pi:test:model" }) as Value;
  assert.equal(again.providerThreadId, "native-1");
  assert.equal(factory.creates, 1, "a second create must not open another native owner");
  const stopped = await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  assert.deepEqual(stopped, { threadId: SCOPE.threadId, stopped: true });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
  const resumed = await bridge.command("session/resume", { threadId: SCOPE.threadId });
  assert.equal((resumed as Value).providerThreadId, "native-1");
  assert.equal(factory.resumes, 1);
  await bridge.close();
});

test("turn/start retry after completion is idempotent and does not create a second native run", async () => {
  const { recorder, bridge, owner } = await setup();
  owner.finish("completed");
  await settle(() => recorder.allDeltas().some(delta => delta.op === "turn.close"), "turn close");
  const before = recorder.allDeltas().length;
  const again = await bridge.command("turn/start", { threadId: SCOPE.threadId, inputId: "in-1", clientRequestId: "client-1", input: "work" }) as Value;
  assert.equal(again.duplicate, true);
  assert.equal(recorder.allDeltas().length, before, "a completed start retry must not emit or execute again");
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("owner crash surfaces a typed recovery callback and fences commands", async () => {
  const { recorder, bridge, owner } = await setup();
  owner.crash();
  await settle(() => recorder.frames.some(frame => frame.method === "provider/recovery"), "recovery");
  await assert.rejects(
    bridge.command("turn/start", { threadId: SCOPE.threadId, inputId: "in-2", clientRequestId: "client-2", input: "work" }),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "internal",
  );
  await bridge.close();
});


test("assembler keeps an admission-only steer failed when the turn ends unconsumed", () => {
  const scope = { threadId: SCOPE.threadId };
  const state = createAssemblerState(1);
  const deltas = [
    { op: "turn.open", nativeTurnId: "t1", scope },
    { op: "input.accepted", inputId: "in-1", clientRequestId: "client-1", expectedTurnId: "t1", scope },
    { op: "input.delivery", inputId: "in-1", deliveryMethod: "native-inject", admitted: true, version: 1, scope },
    { op: "input.evidence", inputId: "in-1", evidenceKind: "admission", evidenceRef: "pi-submission:in-1", version: 2, scope },
    { op: "input.outcome", inputId: "in-1", state: "failed", reason: "Pi turn ended before steer was consumed", version: 3, scope },
    { op: "turn.boundary", nativeTurnId: "t1", status: "completed", scope },
  ] as never;
  const result = assemble(state, deltas, { threadId: SCOPE.threadId, clockSeed: 1 });
  const states = result.events.filter(event => event.kind === "input.state");
  const last = states.at(-1) as { status: { outcome: string; evidence: { value: string }; evidenceKind?: string } };
  assert.equal(last.status.evidence.value, "evidence-observed");
  assert.equal(last.status.outcome, "failed", "admission-only evidence cannot mask an unconsumed steer");

  const resolved = assemble(createAssemblerState(1), [
    { op: "turn.open", nativeTurnId: "t1", scope },
    { op: "input.accepted", inputId: "in-2", clientRequestId: "client-2", expectedTurnId: "t1", scope },
    { op: "input.delivery", inputId: "in-2", deliveryMethod: "native-inject", admitted: true, version: 1, scope },
    { op: "input.outcome", inputId: "in-2", state: "unknown", reason: "ambiguous write", version: 2, scope },
    { op: "input.evidence", inputId: "in-2", evidenceKind: "queue-change", evidenceRef: "pi-entry:9", version: 3, scope },
    { op: "turn.boundary", nativeTurnId: "t1", status: "completed", scope },
  ] as never, { threadId: SCOPE.threadId, clockSeed: 1 });
  const resolvedStates = resolved.events.filter(event => event.kind === "input.state");
  const reconciled = resolvedStates.at(-1) as { status: { outcome: string; admission: { value: string } } };
  assert.equal(reconciled.status.outcome, "evidence-observed",
    "a native queue/entry transition reconciles an earlier unknown");
  assert.equal(reconciled.status.admission.value, "accepted",
    "placement evidence also resolves the unknown admission facet for Host release");
});


test("a retry of a stale steer repeats the refusal instead of reporting success", async () => {
  const { bridge, owner } = await setup();
  owner.rejectNextSteer = true;
  const request = { threadId: SCOPE.threadId, inputId: "in-stale", clientRequestId: "client-stale", expectedTurnId: "in-1", input: "late" };
  await assert.rejects(bridge.command("turn/steer", request),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "stale-target");
  await assert.rejects(bridge.command("turn/steer", request),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "stale-target",
    "the same input id must not turn a stale refusal into a successful duplicate");
  await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("a retry of an unknown steer stays unknown", async () => {
  const { bridge, owner } = await setup();
  owner.unknownNextSteer = true;
  const request = { threadId: SCOPE.threadId, inputId: "in-unknown", clientRequestId: "client-unknown", expectedTurnId: "in-1", input: "maybe" };
  await assert.rejects(bridge.command("turn/steer", request),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "unknown-outcome");
  await assert.rejects(bridge.command("turn/steer", request),
    (error: unknown) => error instanceof BridgeRequestError && error.kind === "unknown-outcome",
    "an ambiguous write must never become an idempotent success");
  await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("resume seeds the native snapshot and does not replay completed turns", async () => {
  const { recorder, bridge, owner } = await setup();
  owner.finish("completed");
  await settle(() => recorder.allDeltas().some(delta => delta.op === "turn.close"), "turn close");
  await bridge.command("session/close", { threadId: SCOPE.threadId });
  const beforeResume = recorder.frames.length;
  await bridge.command("session/resume", { threadId: SCOPE.threadId });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(recorder.frames.filter(frame => frame.method === "thread/delta").length,
    recorder.frames.slice(0, beforeResume).filter(frame => frame.method === "thread/delta").length,
    "resume must not replay an already settled native turn");

  await bridge.command("turn/start", { threadId: SCOPE.threadId, inputId: "in-2", clientRequestId: "client-2", input: "again" });
  await settle(() => recorder.allDeltas().some(delta => delta.op === "turn.open" && (delta as Value).nativeTurnId === "in-2"), "new turn");
  const ids = recorder.frames.filter(frame => frame.method === "thread/delta").map(frame => frame.id);
  assert.equal(new Set(ids).size, ids.length, "callback ids must be unique across close/resume");
  await bridge.command("turn/stop", { threadId: SCOPE.threadId });
  await bridge.command("session/close", { threadId: SCOPE.threadId });
});

test("mapper seed suppresses historical deltas but keeps streaming an active turn", () => {
  const mapper = new PiDeltaMapper({ threadId: SCOPE.threadId, nativeSessionId: "native-1", now: () => 1 });
  const completed = snapshot([turn("t1", "completed", [user("u1", "old"), assistant("a1", "done")])], { }, null);
  mapper.seed(completed);
  assert.deepEqual(mapper.diff(completed), []);
  const active = snapshot([turn("t2", "inProgress", [user("u2", "work"), assistant("a2", "partial")])]);
  mapper.seed(active);
  assert.deepEqual(mapper.diff(active), []);
  const grown = snapshot([turn("t2", "inProgress", [user("u2", "work"), assistant("a2", "partial plus")])]);
  const deltas = mapper.diff(grown);
  assert.deepEqual(deltas.map(delta => delta.op), ["item.textDelta"]);
  assert.equal((deltas[0] as Value).text, " plus");
  assert.ok(!deltas.some(delta => delta.op === "turn.open"));
});
