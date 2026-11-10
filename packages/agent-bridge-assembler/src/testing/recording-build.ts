/**
 * Serialize a cell into the two-layer desensitized recording files. This is
 * pure formatting: the caller decides whether to write the returned strings
 * to disk (tests do), so the package itself stays IO-free. A recording is
 * never rewritten to "make a test pass": when behavior changes, the recording
 * is regenerated deliberately and the diff reviewed.
 */

import type { RecordingLane } from "@opencraft/agent-bridge-protocol";
import type { BridgeFixtureCell } from "./fixture-cells";
import { replayCell } from "./replay";

export interface SerializedRecording {
  readonly "manifest.json": string;
  readonly "nativeToDelta.ndjson": string;
  readonly "deltaToEvent.ndjson": string;
  readonly "events.ndjson": string;
  readonly "diagnostics.json": string;
}

export const RECORDING_FILE_NAMES: readonly (keyof SerializedRecording)[] = Object.freeze([
  "manifest.json",
  "nativeToDelta.ndjson",
  "deltaToEvent.ndjson",
  "events.ndjson",
  "diagnostics.json",
]);

function ndjson(lines: readonly unknown[], lane: RecordingLane, run: string): string {
  if (lines.length === 0) return "";
  return lines
    .map((line, index) => JSON.stringify({
      seq: index + 1,
      run,
      lane,
      line: typeof line === "string" ? line : JSON.stringify(line),
    }))
    .join("\n") + "\n";
}

export function buildRecording(cell: BridgeFixtureCell): SerializedRecording {
  const replay = replayCell(cell);
  const run = cell.manifest.cell;
  return {
    "manifest.json": JSON.stringify(cell.manifest, null, 2) + "\n",
    // Layer 1 input: the desensitized fake-provider wire.
    "nativeToDelta.ndjson": ndjson(cell.nativeLines, "nativeToDelta", run),
    // Layer 1 output / layer 2 input: the semantic deltas.
    "deltaToEvent.ndjson": ndjson(replay.deltas, "deltaToEvent", run),
    // Pinned layer 2 output: canonical events the replay must reproduce.
    "events.ndjson": replay.events.length === 0
      ? ""
      : replay.events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "diagnostics.json": JSON.stringify({
      translator: replay.translatorDiagnostics,
      assembler: replay.diagnostics.map((diagnostic) => diagnostic.code),
    }, null, 2) + "\n",
  };
}
