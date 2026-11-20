import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sampleRows,
  stratum,
  judgePrompt,
  pool,
  validateRecovery,
  decodeRecoveryRecord,
  publishRecord,
  exclusionIds,
} from "./benchmark.mjs";
import { scoreRecords } from "./benchmark-report.mjs";
import {
  recoveryAction,
  recordVerdict,
  serviceStatus,
} from "./benchmark-failures.mjs";

test("recovery identifies truncated publications without converting recorded model failures into retries", () => {
  const interrupted = decodeRecoveryRecord(
    Buffer.from('{"status":'),
    "old/records/case.json",
  );
  assert.equal(interrupted.record, undefined);
  assert.equal(interrupted.incomplete.reason, "incomplete-record-publication");
  assert.equal(interrupted.incomplete.bytes, 10);
  const failed = {
    status: "failed",
    error: "The operation was aborted due to timeout",
    judge: { correct: false },
  };
  assert.equal(
    recoveryAction(
      decodeRecoveryRecord(Buffer.from(JSON.stringify(failed)), "old.json")
        .record,
    ),
    "reuse",
  );
});

test("record publication is complete and atomic and cannot replace an existing judgment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-publish-"));
  try {
    await mkdir(join(directory, "records"));
    const file = join(directory, "records", "case.json");
    await publishRecord(file, { judge: { correct: false } });
    await assert.rejects(publishRecord(file, { judge: { correct: true } }), {
      code: "EEXIST",
    });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      judge: { correct: false },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("quota failures remain unscored, while malformed model JSON remains wrong", () => {
  const unavailable = {
    status: "failed",
    error: '402: {"code":"401008"}',
    judge: { correct: false },
  };
  const broken = {
    status: "failed",
    error: "Bad control character in JSON",
    judge: { correct: false },
  };
  const score = scoreRecords([unavailable, broken], 2);
  assert.equal(score.accuracy, null);
  assert.equal(score.infrastructureFailures, 1);
  assert.equal(score.answerFailures, 1);
  assert.equal(score.upperBound, 0.5);
  assert.equal(recordVerdict(unavailable), null);
  assert.equal(recordVerdict(broken), false);
  assert.equal(serviceStatus("Benchmark model HTTP 402"), 402);
  assert.equal(serviceStatus("Expected property at position 402"), null);
  assert.equal(recoveryAction(unavailable), "retry-answer");
  assert.equal(recoveryAction(broken), "reuse");
  assert.equal(
    recoveryAction({
      status: "completed",
      hypothesis: "original answer",
      judge: { correct: null },
    }),
    "judge-only",
  );
});

test("fatal service circuit stops scheduling and still awaits in-flight tasks", async () => {
  const called = [];
  await pool([1, 2, 3, 4, 5], 2, async (i) => {
    called.push(i);
    await new Promise((r) => setTimeout(r, 5));
    return false;
  });
  assert.deepEqual(called, [1, 2]);
});

test("recovery permits harness fixes but rejects changed assistant/model/selection", () => {
  const files = [
    { file: "src/a.mjs", sha256: "product" },
    { file: "evaluation/a.mjs", sha256: "harness" },
  ];
  const identity = {
    sourceSha256: "dataset",
    selectedIds: ["a"],
    seed: "seed",
    model: { modelId: "model" },
    sourceCodeSha256: "old",
    timeoutMs: 1000,
    officialScorerSha256: "scorer",
  };
  const previous = { identity, sourceFiles: files };
  const updated = { ...identity, sourceCodeSha256: "new" };
  assert.equal(
    validateRecovery(previous, updated, [
      files[0],
      { ...files[1], sha256: "fixed" },
    ]).productSourceUnchanged,
    true,
  );
  assert.throws(
    () => validateRecovery(previous, { ...updated, seed: "another" }, files),
    /differs/,
  );
  assert.throws(
    () =>
      validateRecovery(
        previous,
        { ...updated, assistantHarness: { assistant: "codex" } },
        files,
      ),
    /differs/,
  );
  assert.throws(
    () =>
      validateRecovery(previous, updated, [
        { ...files[0], sha256: "changed" },
        files[1],
      ]),
    /product source differs/,
  );
});

test("stratified selection is deterministic, ignores answers/length, and excludes pilots", () => {
  const types = [
    "temporal-reasoning",
    "multi-session",
    "knowledge-update",
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "abstention",
  ];
  const rows = types.flatMap((type) =>
    Array.from({ length: 8 }, (_, i) => ({
      question_id: type + "-" + i + (type === "abstention" ? "_abs" : ""),
      question_type: type === "abstention" ? "temporal-reasoning" : type,
      answer: "secret",
      haystack_sessions: [],
    })),
  );
  rows.push({ question_id: "c8c3f81d", question_type: "single-session-user" });
  const a = sampleRows(rows, 3, "seed");
  const b = sampleRows(
    [...rows]
      .reverse()
      .map((r) => ({ ...r, answer: "changed", haystack_sessions: [[{}, {}]] })),
    3,
    "seed",
  );
  assert.deepEqual(
    a.map((r) => r.question_id),
    b.map((r) => r.question_id),
  );
  assert.equal(a.length, 21);
  assert.equal(
    a.some((r) => r.question_id === "c8c3f81d"),
    false,
  );
  for (const type of types)
    assert.equal(a.filter((r) => stratum(r) === type).length, 3);
});

test("official prompt substitution never treats braces in answers as placeholders", () => {
  const templates = Array.from({ length: 5 }, (_, i) => `${i}: {} | {} | {}`);
  assert.equal(
    judgePrompt(
      templates,
      {
        question_id: "id_abs",
        question_type: "temporal-reasoning",
        question: "Q{}",
        answer: "A{}",
      },
      "H{}",
    ),
    "4: Q{} | A{} | H{}",
  );
});

test("held-out selection excludes all prior-plan IDs before ranking, independent of history and answers", () => {
  const types = [
    "single-session-user",
    "single-session-assistant",
    "single-session-preference",
    "knowledge-update",
    "temporal-reasoning",
    "multi-session",
    "abstention",
  ];
  const rows = types.flatMap((type) =>
    Array.from({ length: 6 }, (_, i) => ({
      question_id: type + i + (type === "abstention" ? "_abs" : ""),
      question_type: type === "abstention" ? "multi-session" : type,
    })),
  );
  const old = sampleRows(rows, 2, "old").map((r) => r.question_id);
  const excluded = exclusionIds({ identity: { selectedIds: old } });
  const fresh = sampleRows(rows, 2, "new", excluded);
  assert.equal(fresh.length, 14);
  assert.ok(fresh.every((row) => !old.includes(row.question_id)));
  assert.deepEqual(fresh, sampleRows([...rows].reverse(), 2, "new", excluded));
  assert.throws(
    () => exclusionIds({ identity: { selectedIds: [] } }),
    /Exclusion plan/,
  );
  assert.throws(
    () => exclusionIds({ identity: { selectedIds: [7] } }),
    /Exclusion plan/,
  );
  assert.throws(() => sampleRows(rows, 5, "new", excluded), /Insufficient/);
});

test("changed long-history variant or failure gate cannot reuse old answers", () => {
  const identity = {
    variant: "s",
    selectedIds: ["x"],
    scheduling: { concurrency: 1, nativeFailureLimit: 2 },
    sourceCodeSha256: "one",
  };
  const previous = { identity, sourceFiles: [] };
  assert.throws(
    () => validateRecovery(previous, { ...identity, variant: "oracle" }, []),
    /differs/,
  );
  assert.throws(
    () =>
      validateRecovery(
        previous,
        { ...identity, scheduling: { concurrency: 2, nativeFailureLimit: 2 } },
        [],
      ),
    /differs/,
  );
});

test("scoring retains answer failures and unresolved judgments in denominator", () => {
  const rows = [
    { status: "completed", judge: { correct: true } },
    { status: "failed", judge: { correct: false } },
    { status: "completed", judge: { correct: null } },
  ];
  const s = scoreRecords(rows, 4);
  assert.equal(s.accuracy, null);
  assert.equal(s.conservativeLowerBound, 0.25);
  assert.equal(s.upperBound, 0.75);
  assert.equal(s.answerFailures, 1);
  assert.equal(s.judgeFailures, 1);
  assert.equal(s.pending, 1);
  const done = scoreRecords(rows.slice(0, 2), 2);
  assert.equal(done.accuracy, 0.5);
  assert.ok(done.wilson95.low < 0.5 && done.wilson95.high > 0.5);
});

test("bounded pool awaits all tasks and never exceeds its concurrency", async () => {
  let active = 0,
    max = 0;
  const done = [];
  await pool([1, 2, 3, 4, 5], 2, async (i) => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    done.push(i);
    active--;
  });
  assert.equal(max, 2);
  assert.deepEqual(done.sort(), [1, 2, 3, 4, 5]);
});


test("workspace dependency changes cannot reuse a previous benchmark answer", () => {
  const identity = { selectedIds: ["synthetic"], sourceCodeSha256: "old" };
  const source = { file: "src/runtime.mjs", sha256: "same-source" };
  const dependency = { file: "installation/package-lock.json", kind: "dependency", sha256: "old-lock" };
  const previous = { identity, sourceFiles: [source, dependency] };
  for (const files of [[source], [source, { ...dependency, sha256: "new-lock" }], [source, { ...dependency, file: "installation/package.json" }]])
    assert.throws(() => validateRecovery(previous, { ...identity, sourceCodeSha256: "new-harness" }, files), /product source differs/);
  assert.equal(validateRecovery(previous, { ...identity, sourceCodeSha256: "new-harness" }, [source, dependency]).productSourceUnchanged, true);
});
