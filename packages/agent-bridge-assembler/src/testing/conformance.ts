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

/** Write-then-EOF settlement: unknown, reconcile, never replay the native mutation. */
export function checkWriteThenEof(): ConformanceResult {
  const failures: string[] = [];
  const record: CommandRecord = {
    commandId: "cmd-1",
    state: "dispatching",
    writeAcked: true,
    replyReceived: false,
    reconnectAfterWrite: true,
  };
  const unknown = settleCommandOutcome(record);
  if (unknown.outcome !== "unknown") failures.push("write-then-EOF must settle as unknown");
  if (!unknown.reconcileRequired) failures.push("write-then-EOF must require reconciliation");
  if (unknown.replayAllowed !== false) failures.push("write-then-EOF must never replay the native request");
  if (!unknown.queryAllowed) failures.push("write-then-EOF must allow querying the same commandId");

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
