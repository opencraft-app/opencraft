/**
 * Conformance gate. The same recorded input must produce deterministic
 * canonical events; layer-1 output must match the pinned deltas; diagnostics,
 * schema version, legacy projection compatibility and desensitization are all
 * checked here. This is the接入门槛 a provider bridge must pass in later
 * batches; P1a runs it against the fake-provider fixture matrix.
 */

import {
  parseRecordingManifest,
  settleCommandOutcome,
  type CommandRecord,
} from "@opencraft/agent-bridge-protocol";
import {
  EXISTING_APPSERVER_NOTIFICATION_METHODS,
  STEER_EVIDENCE_EXTENSION_METHOD,
} from "../projection";
import type { BridgeFixtureCell } from "./fixture-cells";
import { buildRecording } from "./recording-build";
import { replayCell } from "./replay";

export interface ConformanceResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
}

const SECRET_FIELD = /"(?:apiToken|accessToken|password|secret|authorization|apiKey|privateKey|cookie)"/i;
const EXECUTABLE_METHOD = /"method"\s*:\s*"(?:command\/exec|process\/spawn|shell|runtime\/http\/request)"/;

export function checkCell(cell: BridgeFixtureCell): ConformanceResult {
  const failures: string[] = [];

  const manifest = parseRecordingManifest(cell.manifest);
  if (!manifest.ok) failures.push(`manifest: ${manifest.reason}`);

  const first = replayCell(cell);
  const second = replayCell(cell);
  if (JSON.stringify(first.events) !== JSON.stringify(second.events)) {
    failures.push("canonical events are not deterministic across replays");
  }
  if (JSON.stringify(first.diagnostics) !== JSON.stringify(second.diagnostics)) {
    failures.push("diagnostics are not deterministic across replays");
  }
  if (JSON.stringify(first.projected) !== JSON.stringify(second.projected)) {
    failures.push("AppServer projection is not deterministic across replays");
  }

  if (JSON.stringify(first.deltas) !== JSON.stringify(cell.deltas)) {
    failures.push("translated layer-1 deltas differ from the pinned deltas");
  }

  const codes = new Set(first.diagnostics.map((diagnostic) => diagnostic.code));
  for (const expected of cell.expectedDiagnostics) {
    if (!codes.has(expected)) failures.push(`expected diagnostic ${expected} is missing`);
  }

  const allowedMethods = new Set<string>([
    ...EXISTING_APPSERVER_NOTIFICATION_METHODS,
    STEER_EVIDENCE_EXTENSION_METHOD,
  ]);
  for (const notification of first.projected) {
    if (!allowedMethods.has(notification.method)) {
      failures.push(`projection emitted a non-contract method ${notification.method}`);
    }
  }

  // Desensitization: no secret-bearing fields and no executable commands.
  const recording = buildRecording(cell);
  for (const line of recording["nativeToDelta.ndjson"].split("\n")) {
    if (line.length === 0) continue;
    if (SECRET_FIELD.test(line)) failures.push("recording line contains a secret-like field");
  }
  for (const line of cell.nativeLines) {
    if (EXECUTABLE_METHOD.test(line)) failures.push("recording contains an executable command");
  }

  return { ok: failures.length === 0, failures };
}

/** Rebuild the command ledger facts from a recorded cell (never a fresh literal). */
function deriveCommandRecord(cell: BridgeFixtureCell): CommandRecord {
  const accepted = cell.deltas.find((delta) => delta.op === "input.accepted");
  const outcome = cell.deltas.find((delta) => delta.op === "input.outcome");
  const hasDelivery = cell.deltas.some((delta) => delta.op === "input.delivery");
  return {
    commandId: accepted === undefined ? "unknown" : (accepted as { inputId: string }).inputId,
    state: "dispatching",
    writeAcked: true,
    replyReceived: hasDelivery,
    reconnectAfterWrite: outcome !== undefined && (outcome as { state: string }).state === "unknown",
  };
}

/**
 * Write-then-EOF settlement is driven by the recording: the assembler settles
 * the input to `unknown`, the derived command record agrees, and no second
 * native execution is present. The assembler consults `settleCommandOutcome`
 * while applying `input.outcome`, so the check is not a detached unit test.
 */
export function checkWriteThenEof(cell: BridgeFixtureCell): ConformanceResult {
  const failures: string[] = [];
  const result = replayCell(cell);
  const states = result.events.filter((event) => event.kind === "input.state");
  const last = states[states.length - 1] as
    | { status: { outcome: string; nativeExecutions: number } }
    | undefined;
  if (last === undefined || last.status.outcome !== "unknown") {
    failures.push("write-then-EOF input must settle as unknown through the assembler");
  }
  if (last !== undefined && last.status.nativeExecutions !== 0) {
    failures.push("an unknown outcome must not add a native execution");
  }
  if (!result.diagnostics.some((diagnostic) => diagnostic.code === "reconcile-required")) {
    failures.push("the assembler must surface the command settlement's reconciliation");
  }

  const accepted = cell.deltas.filter((delta) => delta.op === "input.accepted");
  const deliveries = cell.deltas.filter((delta) => delta.op === "input.delivery");
  if (accepted.length !== 1 || deliveries.length !== 0) {
    failures.push("recorded input was replayed / re-executed");
  }

  const record = deriveCommandRecord(cell);
  const unknown = settleCommandOutcome(record);
  if (unknown.outcome !== "unknown") failures.push("derived command settlement must be unknown");
  if (!unknown.reconcileRequired) failures.push("derived command settlement must require reconciliation");
  if (unknown.replayAllowed !== false) failures.push("derived command settlement must never replay");
  if (!unknown.queryAllowed) failures.push("derived command settlement must allow querying");

  const provenAccepted = settleCommandOutcome({ ...record, nativeProof: "accepted" });
  if (provenAccepted.outcome !== "accepted" || provenAccepted.reconcileRequired) {
    failures.push("native admission proof must settle accepted without reconciliation");
  }
  const provenNotSent = settleCommandOutcome({ ...record, nativeProof: "not-sent" });
  if (provenNotSent.outcome !== "not-sent" || provenNotSent.reconcileRequired) {
    failures.push("native not-sent proof must settle not-sent without reconciliation");
  }
  const withReply = settleCommandOutcome({ ...record, replyReceived: true, state: "accepted" });
  if (withReply.outcome !== "accepted" || withReply.reconcileRequired) {
    failures.push("a terminal reply must settle the command");
  }
  return { ok: failures.length === 0, failures };
}
