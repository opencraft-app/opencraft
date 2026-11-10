import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BRIDGE_SCHEMA_VERSION,
  parseRecordingManifest,
  redactContent,
} from "@opencraft/agent-bridge-protocol";
import {
  buildRecording,
  checkCell,
  checkWriteThenEof,
  FIXTURE_CELLS,
  FIXTURE_CELL_BY_ID,
  RECORDING_FILE_NAMES,
  replayCell,
  type ReplayResult,
} from "@opencraft/agent-bridge-assembler/testing";

const recordingsRoot = fileURLToPath(
  new URL("../../packages/agent-bridge-assembler/recordings/", import.meta.url),
);

function replay(id: string): ReplayResult {
  const cell = FIXTURE_CELL_BY_ID.get(id);
  assert.ok(cell, `missing fixture cell ${id}`);
  return replayCell(cell);
}

function kinds(result: ReplayResult): string[] {
  return result.events.map((event) => event.kind);
}

test("committed two-layer recordings match the generated recording (drift pin)", () => {
  for (const cell of FIXTURE_CELLS) {
    const recording = buildRecording(cell);
    for (const name of RECORDING_FILE_NAMES) {
      assert.equal(
        readFileSync(join(recordingsRoot, cell.id, name), "utf8"),
        recording[name],
        `${cell.id}/${name} drifted from the generated recording`,
      );
    }
  }
});

test("every recording manifest pins the schema version and parses", () => {
  assert.equal(FIXTURE_CELLS.length, 11, "the full P1a fixture matrix must be present");
  for (const cell of FIXTURE_CELLS) {
    const raw = JSON.parse(readFileSync(join(recordingsRoot, cell.id, "manifest.json"), "utf8")) as unknown;
    const parsed = parseRecordingManifest(raw);
    assert.equal(parsed.ok, true, `${cell.id} manifest must parse`);
    assert.equal((raw as { schemaVersion: number }).schemaVersion, BRIDGE_SCHEMA_VERSION);
    assert.equal((raw as { schemaId: string }).schemaId, "opencraft.agent-bridge/1");
  }
});

test("conformance gate passes over the full fixture matrix", () => {
  for (const cell of FIXTURE_CELLS) {
    const result = checkCell(cell);
    assert.equal(result.ok, true, `${cell.id}: ${result.failures.join("; ")}`);
  }
});

test("write-then-EOF settles unknown, requires reconciliation, never replays", () => {
  const result = checkWriteThenEof();
  assert.equal(result.ok, true, result.failures.join("; "));
});

test("duplicate: repeated close is deduped to one started + one completed", () => {
  const result = replay("duplicate");
  assert.equal(kinds(result).filter((kind) => kind === "item.started").length, 1);
  assert.equal(kinds(result).filter((kind) => kind === "item.completed").length, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "duplicate-close"));
});

test("out-of-order: unknown-turn boundary + late text are diagnosed, stream stays deterministic", () => {
  const result = replay("out-of-order");
  const outOfOrder = result.diagnostics.filter((d) => d.code === "out-of-order");
  assert.ok(outOfOrder.length >= 2, "both anomalies must be reported");
  const completed = result.events.filter((event) => event.kind === "item.completed");
  assert.equal(completed.length, 1);
  const text = (completed[0] as { item: { shape: { text?: string } } }).item.shape.text ?? "";
  assert.ok(!text.includes(redactContent("late")), "late text must not pollute the settled item");
});

test("delta-first: a stream with no item.open synthesizes item.started and accumulates", () => {
  const result = replay("delta-first");
  assert.deepEqual(kinds(result).slice(0, 2), ["turn.started", "item.started"]);
  const completed = result.events.filter((event) => event.kind === "item.completed");
  assert.equal(completed.length, 1);
  const text = (completed[0] as { item: { shape: { text?: string } } }).item.shape.text ?? "";
  assert.equal((text.match(/\[content:/g) ?? []).length, 2, "both chunks must accumulate");
  assert.ok(result.diagnostics.some((d) => d.code === "delta-first-synthesized"));
});

test("close-without-open: a bare close keeps its whole item", () => {
  const result = replay("close-without-open");
  assert.equal(kinds(result).filter((kind) => kind === "item.started").length, 1);
  assert.equal(kinds(result).filter((kind) => kind === "item.completed").length, 1);
  assert.ok(result.diagnostics.some((d) => d.code === "close-without-open"));
});

test("tool-cross-turn: an item keeps its original turn id across a turn boundary", () => {
  const result = replay("tool-cross-turn");
  const turns = result.events.filter((event) => event.kind === "turn.started");
  assert.equal(turns.length, 2);
  const firstTurnId = (turns[0] as { turnId: string }).turnId;
  const started = result.events.filter((event) => event.kind === "item.started");
  const completed = result.events.filter((event) => event.kind === "item.completed");
  assert.equal(started.length, 1, "no duplicate item.started");
  assert.equal((started[0] as { turnId: string | null }).turnId, firstTurnId);
  assert.equal((completed[0] as { turnId: string | null }).turnId, firstTurnId);
});

test("session-reset: open work is settled and a fresh epoch mints new ids", () => {
  const result = replay("session-reset");
  const turns = result.events.filter((event) => event.kind === "turn.started") as Array<{ turnId: string }>;
  assert.equal(turns.length, 2);
  assert.equal(turns[0].turnId, "t1.1");
  assert.equal(turns[1].turnId, "t2.1", "reset must not overwrite historical ids");
  const interrupted = result.events.filter(
    (event) => event.kind === "turn.completed" && event.status === "interrupted",
  );
  assert.equal(interrupted.length, 1, "open work is settled at reset");
  assert.ok(result.diagnostics.some((d) => d.code === "session-reset-settled"));
  // Historical events remain unchanged at the head of the timeline.
  assert.deepEqual(kinds(result).slice(0, 3), ["turn.started", "item.started", "agentMessage.delta"]);
});

test("orphan-events: item/stream deltas with no turn are dropped, never fabricate a turn", () => {
  const result = replay("orphan-events");
  assert.ok(result.diagnostics.filter((d) => d.code === "orphan-no-turn").length >= 2);
  const started = result.events.filter((event) => event.kind === "item.started") as Array<{ item: { nativeKey: string } }>;
  assert.equal(started.length, 1);
  assert.equal(started[0].item.nativeKey, "k1");
});

test("overlong-frame: one greedy line is isolated and the stream keeps reading", () => {
  const result = replay("overlong-frame");
  assert.ok(result.translatorDiagnostics.includes("frame-too-large"));
  assert.ok(result.events.some((event) => event.kind === "item.completed"), "valid traffic still assembles");
  const second = replay("overlong-frame");
  assert.deepEqual(result.events, second.events, "replay stays deterministic after isolation");
});

test("steer-end-race: an input targeting a settled turn is queued, never lost", () => {
  const result = replay("steer-end-race");
  const states = result.events.filter((event) => event.kind === "input.state");
  assert.ok(states.length >= 1, "the input is not dropped");
  const last = states[states.length - 1] as { status: { disposition: string | null } };
  assert.equal(last.status.disposition, "queued", "must not be falsely labelled steered");
  assert.ok(result.diagnostics.some((d) => d.code === "steer-end-race"));
});

test("withdrawal-claimed-race: withdrawal cannot erase context-confirmed evidence", () => {
  const result = replay("withdrawal-claimed-race");
  const states = result.events.filter((event) => event.kind === "input.state") as Array<{
    status: { inputId: string; outcome: string; evidence: { value: string }; withdrawal: { value: string } };
  }>;
  const in1 = states.filter((event) => event.status.inputId === "in1").at(-1)!;
  assert.equal(in1.status.outcome, "too-late");
  assert.equal(in1.status.evidence.value, "context-confirmed", "evidence must not be erased");
  assert.equal(in1.status.withdrawal.value, "too-late");
  const in2 = states.filter((event) => event.status.inputId === "in2").at(-1)!;
  assert.equal(in2.status.outcome, "withdrawn", "an undelivered withdrawal succeeds");
});

test("write-then-eof: the input stays registered and no replay/fabricated turn occurs", () => {
  const result = replay("write-then-eof");
  assert.ok(result.diagnostics.some((d) => d.code === "recovery-hint"));
  const states = result.events.filter((event) => event.kind === "input.state");
  assert.equal(states.length, 1, "no duplicate or replayed input");
  assert.equal(kinds(result).filter((kind) => kind === "turn.started").length, 1);
});
