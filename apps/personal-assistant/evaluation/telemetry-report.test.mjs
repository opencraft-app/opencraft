import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeTelemetry, profileTelemetry } from "./telemetry-report.mjs";

test("OTLP summary distinguishes inclusive parent/child time, repeated exports and unfinished starts", () => {
  const child = {
    traceId: "one",
    spanId: "child",
    name: "gen_ai.operation",
    startTimeUnixNano: "1000000",
    endTimeUnixNano: "4000000",
    attributes: [
      { key: "app.model_role", value: { stringValue: "memory-verify" } },
    ],
    status: { code: 2 },
  };
  const parent = {
    ...child,
    spanId: "parent",
    name: "memory.prepare",
    endTimeUnixNano: "6000000",
    attributes: [],
    status: { code: 0 },
  };
  const trace = {
    resourceSpans: [{ scopeSpans: [{ spans: [parent, child] }] }],
  };
  const log = (spanId, body) => ({
    traceId: "one",
    spanId,
    body: { stringValue: body },
  });
  const logs = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              log("parent", "memory.prepare.started"),
              log("child", "gen_ai.operation.started"),
              log("missing", "codex.turn.started"),
            ],
          },
        ],
      },
    ],
  };
  const result = summarizeTelemetry([trace, trace], [logs]);
  assert.equal(result.completedSpans, 2);
  assert.equal(result.groups["memory.prepare"].totalInclusiveMs, 5);
  assert.equal(
    result.groups["gen_ai.operation/memory-verify"].totalInclusiveMs,
    3,
  );
  assert.equal(result.groups["gen_ai.operation/memory-verify"].errors, 1);
  assert.deepEqual(result.observedUnfinishedStarts, { "codex.turn": 1 });
  assert.equal(result.wallTimeMs, undefined);
});

test("OTLP report reads rotation and marks malformed/missing data without fabricating zero cost", async () => {
  const path = await mkdtemp(join(tmpdir(), "eval-otel-summary-"));
  try {
    assert.equal((await profileTelemetry(path)).coverage, "no-trace-files");
    await writeFile(
      join(path, "traces.otlp.jsonl.1"),
      JSON.stringify({ resourceSpans: [] }) + '\n{"truncated":',
    );
    const observed = await profileTelemetry(path);
    assert.equal(observed.coverage, "observed-local-window");
    assert.equal(observed.malformedLines, 1);
    assert.equal(observed.files.length, 1);
    assert.equal(observed.files[0].sha256.length, 64);
    assert.equal(observed.costUsd, undefined);
    assert.equal(observed.remoteQueueNetworkAndComputeSeparated, false);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
});
