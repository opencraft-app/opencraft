import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMethodAllowed,
  BRIDGE_ERROR_CODES,
  BRIDGE_GRAMMAR_RANGE,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCHEMA_ID,
  BRIDGE_SCHEMA_VERSION,
  decodeFrame,
  effectiveCapabilities,
  encodeFrame,
  isNotification,
  isRequest,
  negotiateGrammar,
  negotiateHandshake,
  parseDelta,
  parseRecordingManifest,
  redactContent,
  redactPath,
  redactSecrets,
  refuseUndeclaredMethod,
  settleCommandOutcome,
  splitLines,
  stableToken,
  type BridgeDeclaration,
  type DeclaredCapabilities,
} from "@opencraft/agent-bridge-protocol";

const capabilities: DeclaredCapabilities = {
  model: true,
  reasoning: true,
  history: true,
  usage: true,
  approval: true,
  inputContentTypes: ["text"],
  cliExecutable: true,
  forkCheckpoint: false,
  skills: false,
  installation: false,
  steer: {
    deliveryMethods: ["native-inject"],
    evidenceKinds: ["context-confirmed"],
    withdrawal: "before-dispatch",
    contentLimits: { maxBytes: 4096, allowedContentTypes: ["text"] },
    maxPendingWithoutNativeId: 1,
    fallbackPolicy: "reject-unknown",
  },
};

const declaration: BridgeDeclaration = {
  providerId: "fake",
  protocolVersion: BRIDGE_PROTOCOL_VERSION,
  grammarRange: BRIDGE_GRAMMAR_RANGE,
  approvalExecutor: "host",
  capabilities,
  minNativeVersion: "0.0.0",
  probeBasis: "fixture declaration",
};

test("version constants are explicit and the grammar range is fixed", () => {
  assert.equal(BRIDGE_PROTOCOL_VERSION, 1);
  assert.equal(BRIDGE_SCHEMA_VERSION, 1);
  assert.equal(BRIDGE_SCHEMA_ID, "opencraft.agent-bridge/1");
  assert.deepEqual(BRIDGE_GRAMMAR_RANGE, { min: 1, max: 1 });
  assert.equal(negotiateGrammar({ min: 1, max: 1 }, { min: 1, max: 3 }), 1);
  assert.equal(negotiateGrammar({ min: 2, max: 3 }, { min: 1, max: 1 }), null);
});

test("decodeFrame discriminates by method and isolates bad/over-long lines", () => {
  const request = decodeFrame(encodeFrame({ jsonrpc: "2.0", id: "r1", method: "turn/start", params: {} }));
  assert.equal(request.kind, "message");
  if (request.kind === "message") assert.equal(isRequest(request.message), true);

  const notification = decodeFrame(encodeFrame({ jsonrpc: "2.0", method: "thread/delta", params: {} }));
  assert.equal(notification.kind, "message");
  if (notification.kind === "message") assert.equal(isNotification(notification.message), true);

  const malformed = decodeFrame("{not json");
  assert.equal(malformed.kind, "error");
  if (malformed.kind === "error") {
    assert.equal(malformed.error.kind, "invalid");
    assert.equal(malformed.recoverable, true, "a bad line must not wedge the stream");
  }

  const overlong = decodeFrame("x".repeat(BRIDGE_MAX_FRAME_BYTES + 1));
  assert.equal(overlong.kind, "error");
  if (overlong.kind === "error") {
    assert.equal(overlong.error.kind, "frame-too-large");
    assert.equal(overlong.recoverable, true);
  }

  // Lenient edges: unknown fields are tolerated on the envelope.
  const withExtra = decodeFrame(JSON.stringify({ jsonrpc: "2.0", id: "r2", method: "x", params: {}, futureField: 1 }));
  assert.equal(withExtra.kind, "message");
});

test("splitLines keeps an incomplete trailing line for the next chunk", () => {
  const first = splitLines("one\ntwo\nthr");
  assert.deepEqual(first.lines, ["one", "two"]);
  assert.equal(first.carry, "thr");
  assert.equal(first.discarding, false);
  const second = splitLines("ee\nfour\n", { carry: first.carry, discarding: first.discarding });
  assert.deepEqual(second.lines, ["three", "four"]);
  assert.equal(second.carry, "");
});

test("splitLines drops an over-long incomplete carry as a recoverable frame-too-large", () => {
  const limits = { maxFrameBytes: 64 };
  // A chunk with no newline that grows beyond the limit must be dropped, not
  // buffered without bound, and reported as a recoverable frame-too-large.
  const first = splitLines("x".repeat(40), undefined, limits);
  assert.equal(first.carry.length, 40);
  assert.equal(first.oversized.length, 0);
  const second = splitLines("x".repeat(40), { carry: first.carry, discarding: first.discarding }, limits);
  assert.equal(second.oversized.length, 1);
  assert.equal(second.oversized[0].kind, "frame-too-large");
  assert.equal(second.carry, "", "the over-long line is discarded");
  assert.equal(second.discarding, true, "remainder is dropped until the next newline");
  // The discard state ends at the next newline and the stream resumes.
  const third = splitLines("tail\nclean\n", { carry: second.carry, discarding: second.discarding }, limits);
  assert.deepEqual(third.lines, ["clean"]);
  assert.equal(third.discarding, false);
  assert.equal(third.carry, "");
});

test("splitLines drops a complete over-long line too", () => {
  const limits = { maxFrameBytes: 8 };
  const result = splitLines("ok\n" + "y".repeat(20) + "\nnext\n", undefined, limits);
  assert.deepEqual(result.lines, ["ok", "next"]);
  assert.equal(result.oversized.length, 1);
  assert.equal(result.oversized[0].kind, "frame-too-large");
});

test("parseDelta is strict at the core (unknown op / missing scope / malformed shape)", () => {
  const valid = parseDelta({ op: "turn.open", nativeTurnId: "n1", scope: { threadId: "t" } });
  assert.equal(valid.ok, true);
  assert.equal(parseDelta({ op: "nope", scope: { threadId: "t" } }).ok, false);
  assert.equal(parseDelta({ op: "turn.open", nativeTurnId: "n1" }).ok, false);
  assert.equal(parseDelta({ op: "item.close", nativeKey: "k", scope: { threadId: "t" } }).ok, false);
  assert.equal(parseDelta({ op: "input.outcome", inputId: "i", state: "unknown", reason: "eof", version: 1, scope: { threadId: "t" } }).ok, true);
  assert.equal(parseDelta({ op: "item.open", nativeKey: "k", shape: { kind: "command", command: "ls", cwd: "[path:x]", status: "inProgress" }, scope: { threadId: "t" } }).ok, true);
  assert.equal(parseDelta({ op: "item.open", nativeKey: "k", shape: { kind: "command", command: "ls" }, scope: { threadId: "t" } }).ok, false);
});

test("instance probing can only narrow the declared capabilities", () => {
  const narrowed = effectiveCapabilities(declaration, { disabledCapabilities: ["history"], steerDisabledMethods: ["native-inject"] });
  assert.equal(narrowed.history, false);
  assert.equal(narrowed.steer.deliveryMethods.length, 0);
  assert.equal(narrowed.model, true, "unrelated capability is unchanged");
  // There is no probe field that can widen an undeclared capability.
  assert.equal(effectiveCapabilities(declaration).skills, false);
});

test("handshake refuses a mismatched protocol version or no common grammar", () => {
  const ok = negotiateHandshake({ protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: BRIDGE_GRAMMAR_RANGE }, declaration);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.result.grammarVersion, 1);

  const badVersion = negotiateHandshake({ protocolVersion: 99, grammarRange: BRIDGE_GRAMMAR_RANGE }, declaration);
  assert.equal(badVersion.ok, false);
  const badGrammar = negotiateHandshake({ protocolVersion: BRIDGE_PROTOCOL_VERSION, grammarRange: { min: 5, max: 9 } }, declaration);
  assert.equal(badGrammar.ok, false);
  if (!badGrammar.ok) assert.equal(badGrammar.error.kind, "unsupported");
});

test("capability-gated methods: declared allowed, undeclared refused, core always allowed", () => {
  assert.equal(assertMethodAllowed(capabilities, "turn/steer").ok, true);
  assert.equal(assertMethodAllowed(capabilities, "turn/start").ok, true, "core command needs no capability");

  const withoutSteer: DeclaredCapabilities = {
    ...capabilities,
    steer: { ...capabilities.steer, deliveryMethods: [] },
  };
  const rejected = assertMethodAllowed(withoutSteer, "turn/steer");
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.capability, "steer");
    const failure = refuseUndeclaredMethod("r1", rejected);
    assert.equal(failure.error.kind, "unsupported");
    assert.equal(failure.error.code, BRIDGE_ERROR_CODES.unsupportedCapability);
  }
  // Declared-but-disabled: history probe narrows it away, so history/read is refused.
  const probeNarrowed = effectiveCapabilities(declaration, { disabledCapabilities: ["history"] });
  assert.equal(assertMethodAllowed(probeNarrowed, "history/read").ok, false);
});

test("steer stays declared when any delivery path survives narrowing", () => {
  // A bridge that only offers next-turn (or interrupt-replace) is still steer-capable.
  const onlyNextTurn: DeclaredCapabilities = {
    ...capabilities,
    steer: { ...capabilities.steer, deliveryMethods: ["next-turn"] },
  };
  assert.equal(assertMethodAllowed(onlyNextTurn, "turn/steer").ok, true);
  const onlyInterrupt: DeclaredCapabilities = {
    ...capabilities,
    steer: { ...capabilities.steer, deliveryMethods: ["interrupt-replace"] },
  };
  assert.equal(assertMethodAllowed(onlyInterrupt, "turn/steer").ok, true);

  // Probing away native-inject while a queue path remains must not disable steer.
  const both: BridgeDeclaration = {
    ...declaration,
    capabilities: { ...capabilities, steer: { ...capabilities.steer, deliveryMethods: ["native-inject", "next-turn"] } },
  };
  const narrowed = effectiveCapabilities(both, { steerDisabledMethods: ["native-inject"] });
  assert.deepEqual(narrowed.steer.deliveryMethods, ["next-turn"]);
  assert.equal(assertMethodAllowed(narrowed, "turn/steer").ok, true);
  const allDisabled = effectiveCapabilities(both, { steerDisabledMethods: ["native-inject", "next-turn"] });
  assert.equal(assertMethodAllowed(allDisabled, "turn/steer").ok, false);
});

test("recording manifest refuses a schema version it cannot reproduce", () => {
  const valid = {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    schemaId: BRIDGE_SCHEMA_ID,
    protocolVersion: 1, grammarVersion: 1,
    providerId: "fake", providerVersion: "0", pluginDigest: "d",
    permissionMode: "read-only", mapperVersion: 1,
    clockSeed: 0, sequenceSeed: 0, cell: "c",
    redaction: { secretsRemoved: true, contentRedacted: true, pathsRedacted: true, correlationIdsKept: true },
  };
  assert.equal(parseRecordingManifest(valid).ok, true);
  assert.equal(parseRecordingManifest({ ...valid, schemaVersion: 99 }).ok, false);
  assert.equal(parseRecordingManifest({ ...valid, schemaId: "other" }).ok, false);
});

test("desensitization removes secrets, redacts content/paths, keeps correlation ids", () => {
  assert.deepEqual(
    redactSecrets({ apiToken: "secret", inputId: "in1", nested: { password: "p", text: "keep" } }),
    { inputId: "in1", nested: { text: "keep" } },
  );
  assert.ok(!redactContent("real secret text").includes("real secret text"));
  assert.equal(redactContent("x"), redactContent("x"), "redaction is deterministic");
  assert.equal(stableToken("abc"), stableToken("abc"));
  const path = redactPath("/home/user/notes.txt");
  assert.ok(!path.includes("notes"), "path content is not exposed");
  assert.ok(path.endsWith(".txt]"), "a harmless extension is kept for correlation");
});

test("outcome settlement is unknown without native proof and never replays", () => {
  const base = {
    commandId: "c1", state: "dispatching" as const, writeAcked: true,
    replyReceived: false, reconnectAfterWrite: true,
  };
  const unknown = settleCommandOutcome(base);
  assert.equal(unknown.outcome, "unknown");
  assert.equal(unknown.reconcileRequired, true);
  assert.equal(unknown.replayAllowed, false);
  assert.equal(unknown.queryAllowed, true);
  assert.equal(settleCommandOutcome({ ...base, nativeProof: "accepted" }).outcome, "accepted");
  assert.equal(settleCommandOutcome({ ...base, nativeProof: "not-sent" }).outcome, "not-sent");
  assert.equal(settleCommandOutcome({ ...base, replyReceived: true, state: "accepted" }).outcome, "accepted");
});

test('input evidence status parsing rejects malformed facets and isolates transport-owned data', async () => {
  const { parseSteerStatusResult } = await import('@opencraft/appserver-protocol');
  assert.equal(parseSteerStatusResult({ schemaVersion: 2, inputs: [] }), null);
  assert.equal(parseSteerStatusResult({ schemaVersion: 1, inputs: [{ inputId: 'x', admission: { value: 'accepted', version: -1 } }] }), null);
  assert.deepEqual(parseSteerStatusResult({ schemaVersion: 1, inputs: [] }), { schemaVersion: 1, inputs: [] });
  const input = { inputId: 'input', clientRequestId: 'client', expectedTurnId: 'turn', disposition: 'steered', nativeExecutions: 1,
    registration: null, admission: { value: 'accepted', version: 1 }, delivery: { value: 'native-inject', version: 1 },
    evidence: { value: 'none', version: 0 }, withdrawal: { value: 'none', version: 0 }, outcome: 'pending' };
  const parsed = parseSteerStatusResult({ schemaVersion: 1, inputs: [input] }); assert(parsed);
  input.admission.value = 'rejected';
  assert.equal(parsed.inputs[0]!.admission.value, 'accepted');
});
