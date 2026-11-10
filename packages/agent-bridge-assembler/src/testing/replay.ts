/**
 * Pure replay driver. Layer 1 translates desensitized fake-provider lines into
 * semantic deltas; layer 2 assembles those deltas into canonical events and
 * projects them to existing AppServer notifications. It performs no IO, opens
 * no network connection, runs no real tool, and never executes a recorded
 * shell command: the "native port" is a pure line parser.
 */

import type { AppServerNotification } from "@opencraft/appserver-protocol";
import {
  decodeFrame,
  isNotification,
  parseDelta,
  type BridgeDelta,
  type BridgeFrameLimits,
} from "@opencraft/agent-bridge-protocol";
import { assemble } from "../assembler";
import { createAssemblerState, type AssembleDiagnostic, type CanonicalEvent } from "../canonical";
import { projectToAppServer } from "../projection";
import { FIXTURE_THREAD_ID, type BridgeFixtureCell } from "./fixture-cells";

export interface TranslateResult {
  readonly deltas: readonly BridgeDelta[];
  readonly diagnostics: readonly string[];
}

/** Layer 1: bounded JSONL lines -> validated semantic deltas. */
export function translateFakeNative(
  lines: readonly string[],
  limits?: BridgeFrameLimits,
): TranslateResult {
  const deltas: BridgeDelta[] = [];
  const diagnostics: string[] = [];
  for (const line of lines) {
    const outcome = limits === undefined ? decodeFrame(line) : decodeFrame(line, limits);
    if (outcome.kind === "error") {
      // A single bad/over-long line is isolated; the stream keeps reading.
      diagnostics.push(outcome.error.kind);
      continue;
    }
    const message = outcome.message;
    if (!isNotification(message) || message.method !== "provider/native") {
      diagnostics.push("unexpected-native-frame");
      continue;
    }
    const params = message.params as { payload?: unknown } | undefined;
    const parsed = parseDelta(params?.payload);
    if (!parsed.ok || parsed.delta === undefined) {
      diagnostics.push(parsed.reason ?? "invalid-delta");
      continue;
    }
    deltas.push(parsed.delta);
  }
  return { deltas, diagnostics };
}

export interface ReplayOptions {
  readonly steerEvidenceDeclared?: boolean;
}

export interface ReplayResult {
  /** Layer 1 output (translated from the recorded native wire). */
  readonly deltas: readonly BridgeDelta[];
  readonly translatorDiagnostics: readonly string[];
  /** Layer 2 output (canonical timeline). */
  readonly events: readonly CanonicalEvent[];
  readonly diagnostics: readonly AssembleDiagnostic[];
  readonly projected: readonly AppServerNotification[];
}

/** Layer 1 + layer 2 over one recorded cell. Deterministic by construction. */
export function replayCell(cell: BridgeFixtureCell, options: ReplayOptions = {}): ReplayResult {
  const layer1 = translateFakeNative(
    cell.nativeLines,
    cell.maxFrameBytes === undefined ? undefined : { maxFrameBytes: cell.maxFrameBytes },
  );
  const assembled = assemble(createAssemblerState(cell.manifest.schemaVersion), cell.deltas, {
    threadId: FIXTURE_THREAD_ID,
    clockSeed: cell.manifest.clockSeed,
    atMsStep: 1,
  });
  const projected = projectToAppServer(assembled.events, {
    steerEvidenceDeclared: options.steerEvidenceDeclared ?? true,
    schemaVersion: cell.manifest.schemaVersion,
  });
  return {
    deltas: layer1.deltas,
    translatorDiagnostics: layer1.diagnostics,
    events: assembled.events,
    diagnostics: assembled.diagnostics,
    projected,
  };
}
