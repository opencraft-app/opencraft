/**
 * Deterministic, desensitized fixture matrix for the P1a conformance gate.
 *
 * There is no real provider in P1a: the "native transcript" is a fake provider
 * port whose lines are JSON-RPC notifications carrying one semantic delta each.
 * All content is already redacted to correlation tokens; no account token,
 * secret, real path, or shell command appears anywhere. A real provider's
 * native transcript fixture joins in the provider batches (P2+).
 *
 * Each cell pins its versions, artifact digest, permission mode, mapper, and
 * clock/sequence seeds through the recording manifest.
 */

import {
  BRIDGE_GRAMMAR_RANGE,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_REDACTION_POLICY,
  BRIDGE_SCHEMA_ID,
  BRIDGE_SCHEMA_VERSION,
  encodeFrame,
  redactContent,
  stableToken,
  type BridgeDelta,
  type BridgeRecordingManifest,
  type DeltaScope,
} from "@opencraft/agent-bridge-protocol";
import type { DiagnosticCode } from "../canonical";

export const FIXTURE_THREAD_ID = "thr-fixture";
const S: DeltaScope = { threadId: FIXTURE_THREAD_ID };
const CLOCK_SEED = 1_700_000_000_000;

/** All user-visible text in recordings is a stable, content-free correlation token. */
const HELLO = redactContent("Hello");
const WORLD = redactContent("world");
const DONE = redactContent("done");
const LATE = redactContent("late");
const ORPHAN = redactContent("orphan");
const X = redactContent("x");
const Y = redactContent("y");

function manifest(cell: string): BridgeRecordingManifest {
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    schemaId: BRIDGE_SCHEMA_ID,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    grammarVersion: BRIDGE_GRAMMAR_RANGE.max,
    providerId: "fake-provider",
    providerVersion: "0.0.0-p1a-fixture",
    pluginDigest: "fixture-digest-p1a",
    permissionMode: "read-only",
    mapperVersion: 1,
    clockSeed: CLOCK_SEED,
    sequenceSeed: 0,
    cell,
    redaction: BRIDGE_REDACTION_POLICY,
  };
}

/**
 * Wrap the semantic deltas in fake-provider JSON-RPC lines. An optional index
 * injects one over-long line to exercise frame isolation (the translator drops
 * that single line and keeps reading).
 */
export function toNativeLines(
  deltas: readonly BridgeDelta[],
  overlong?: { readonly at: number; readonly limit: number },
): string[] {
  const lines = deltas.map((delta, index) => encodeFrame({
    jsonrpc: "2.0",
    method: "provider/native",
    params: {
      seq: index + 1,
      correlationId: stableToken(JSON.stringify(delta)),
      payload: delta,
    },
  }));
  if (overlong !== undefined) {
    lines.splice(overlong.at, 0, "x".repeat(overlong.limit + 1));
  }
  return lines;
}

export interface BridgeFixtureCell {
  readonly id: string;
  readonly manifest: BridgeRecordingManifest;
  /** Layer 1 input: desensitized fake-provider wire. */
  readonly nativeLines: readonly string[];
  /** Layer 1 output / layer 2 input: semantic deltas. */
  readonly deltas: readonly BridgeDelta[];
  /** Diagnostic codes that must appear in the assembled result. */
  readonly expectedDiagnostics: readonly DiagnosticCode[];
  /** Optional tighter frame limit so an over-long-line fixture stays small. */
  readonly maxFrameBytes?: number;
}

/** A deliberately small limit keeps the over-long-line recording compact. */
const FIXTURE_OVERLONG_FRAME_LIMIT = 2048;

function cell(
  id: string,
  deltas: readonly BridgeDelta[],
  expectedDiagnostics: readonly DiagnosticCode[],
  overlongAt?: number,
): BridgeFixtureCell {
  const overlong = overlongAt === undefined
    ? undefined
    : { at: overlongAt, limit: FIXTURE_OVERLONG_FRAME_LIMIT };
  return {
    id,
    manifest: manifest(id),
    nativeLines: toNativeLines(deltas, overlong),
    deltas,
    expectedDiagnostics,
    ...(overlong === undefined ? {} : { maxFrameBytes: FIXTURE_OVERLONG_FRAME_LIMIT }),
  };
}

const toolPending = { kind: "tool", name: "fake.tool", status: "inProgress" } as const;
const toolDone = { kind: "tool", name: "fake.tool", status: "completed", output: DONE } as const;

/** The full P1a matrix. Each entry's settlement is asserted in the test suite. */
export const FIXTURE_CELLS: readonly BridgeFixtureCell[] = Object.freeze([
  // 1. duplicate: repeated close is deduped, one started + one completed.
  cell("duplicate", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.open", nativeKey: "k1", shape: toolPending, scope: S },
    { op: "item.close", nativeKey: "k1", shape: toolDone, scope: S },
    { op: "item.close", nativeKey: "k1", shape: toolDone, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["duplicate-close"]),

  // 2. out-of-order: unknown-turn boundary and late text after a closed stream.
  cell("out-of-order", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "turn.boundary", nativeTurnId: "ghost", status: "completed", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: HELLO, scope: S },
    { op: "item.textClose", nativeKey: "s1", channel: "agentMessage", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: LATE, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["out-of-order"]),

  // 3. delta-first: a text stream with no preceding item.open synthesizes one.
  cell("delta-first", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: HELLO, scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: WORLD, scope: S },
    { op: "item.textClose", nativeKey: "s1", channel: "agentMessage", scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["delta-first-synthesized"]),

  // 4. close-without-open: a bare close carries its whole item and is kept.
  cell("close-without-open", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.close", nativeKey: "k1", shape: { kind: "agentMessage", text: DONE }, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["close-without-open"]),

  // 5. tool-cross-turn: a tool opened in turn A completes in turn B under its
  //    original turn id; turn settlement never force-closes an open item.
  cell("tool-cross-turn", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.open", nativeKey: "k1", shape: toolPending, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
    { op: "turn.open", nativeTurnId: "n2", scope: S },
    { op: "item.close", nativeKey: "k1", shape: toolDone, scope: S },
    { op: "turn.boundary", nativeTurnId: "n2", status: "completed", scope: S },
  ] satisfies BridgeDelta[], []),

  // 6. session-reset: open work is settled, then a fresh epoch mints new ids
  //    without overwriting historical ones.
  cell("session-reset", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: X, scope: S },
    { op: "session.reset", scope: S },
    { op: "turn.open", nativeTurnId: "n2", scope: S },
    { op: "item.textDelta", nativeKey: "s2", channel: "agentMessage", text: Y, scope: S },
    { op: "turn.boundary", nativeTurnId: "n2", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["session-reset-settled"]),

  // 7. orphan-events: item/stream deltas with no open turn are diagnosed and
  //    dropped; they never fabricate a turn.
  cell("orphan-events", [
    { op: "item.textDelta", nativeKey: "orph1", channel: "agentMessage", text: ORPHAN, scope: S },
    { op: "item.open", nativeKey: "orph2", shape: toolPending, scope: S },
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.open", nativeKey: "k1", shape: toolPending, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], ["orphan-no-turn"]),

  // 8. overlong-frame: one over-long line is isolated by the framing layer;
  //    the stream continues and the valid deltas still assemble.
  cell("overlong-frame", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "item.textDelta", nativeKey: "s1", channel: "agentMessage", text: HELLO + WORLD, scope: S },
    { op: "item.textClose", nativeKey: "s1", channel: "agentMessage", scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], [], 2),

  // 9. steer-end-race: an input addressed to an already-settled turn is queued,
  //    never dropped and never falsely labelled "steered".
  cell("steer-end-race", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
    { op: "input.accepted", inputId: "in1", clientRequestId: "cr1", expectedTurnId: "n1", scope: S },
    { op: "input.delivery", inputId: "in1", deliveryMethod: "next-turn", admitted: true, version: 1, scope: S },
  ] satisfies BridgeDelta[], ["steer-end-race"]),

  // 10. withdrawal-claimed-race: a withdrawal cannot erase content that already
  //     reached a native context path; an undelivered withdrawal succeeds.
  cell("withdrawal-claimed-race", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "input.accepted", inputId: "in1", clientRequestId: "cr1", scope: S },
    { op: "input.withdrawal", inputId: "in1", state: "withdraw-requested", version: 1, scope: S },
    { op: "input.evidence", inputId: "in1", evidenceKind: "context-confirmed", evidenceRef: "ref1", nativeInputId: "ni1", runId: "run1", version: 2, scope: S },
    { op: "input.withdrawal", inputId: "in1", state: "withdrawn", version: 3, scope: S },
    { op: "input.accepted", inputId: "in2", clientRequestId: "cr2", scope: S },
    { op: "input.withdrawal", inputId: "in2", state: "withdrawn", version: 1, scope: S },
    { op: "turn.boundary", nativeTurnId: "n1", status: "completed", scope: S },
  ] satisfies BridgeDelta[], []),

  // 11. write-then-eof: a command written before EOF stays registered/unknown,
  //     no turn is fabricated and the input is not replayed. The explicit
  //     `settleCommandOutcome` assertion lives in the conformance test.
  cell("write-then-eof", [
    { op: "turn.open", nativeTurnId: "n1", scope: S },
    { op: "input.accepted", inputId: "in1", clientRequestId: "cr1", fallbackPolicy: "reject-unknown", scope: S },
    { op: "provider.recovery", kind: "restartRecommended", message: redactContent("connection EOF after write"), retryable: false, scope: S },
  ] satisfies BridgeDelta[], ["recovery-hint"]),
]);

export const FIXTURE_CELL_BY_ID: ReadonlyMap<string, BridgeFixtureCell> =
  new Map(FIXTURE_CELLS.map((entry) => [entry.id, entry]));
