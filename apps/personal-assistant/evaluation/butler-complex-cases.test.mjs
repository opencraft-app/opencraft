import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  complexCases,
  currentPublishedNote,
  fieldEquals,
  runComplexCase,
} from "./butler-complex-cases.mjs";
import { selectCases, runSuite } from "./butler-suite.mjs";

test("complex cases are separate from unchanged core and extended groups", async () => {
  assert.equal(selectCases({ group: "core" }).length, 6);
  assert.equal(selectCases({ group: "extended" }).length, 6);
  assert.equal(selectCases({ group: "complex" }).length, 6);
  assert.equal(new Set(selectCases().map((x) => x.id)).size, 18);
  assert.deepEqual(selectCases({ group: "complex" }), complexCases);
  assert.ok(
    complexCases.every(
      (c) => c.modelOnly && c.inputMode && c.review && c.coverage.length,
    ),
  );
  await assert.rejects(runComplexCase("unknown", {}, {}), /Unknown complex/);
});

test("current publication grading rejects historical, unrelated, modified, and unfinished artifacts", () => {
  const old = { name: "old.md", text: "desired answer" },
    current = { name: "new.md", text: "incorrect current answer" };
  const receipt = (path, text) => ({
    kind: "note.published",
    data: { path, sha256: createHash("sha256").update(text).digest("hex") },
  });
  const d = {
    work: { active_execution_id: "new" },
    results: [{ execution_id: "old" }, { execution_id: "new" }],
    completion: {
      executions: [
        {
          executionId: "old",
          evidence: [receipt("/artifacts/old.md", old.text)],
        },
        {
          executionId: "new",
          evidence: [receipt("/artifacts/new.md", current.text)],
        },
      ],
    },
  };
  assert.equal(currentPublishedNote(d, [old, current]), current.text);
  assert.throws(
    () => currentPublishedNote(d, [old]),
    /missing or hash mismatch/,
  );
  assert.throws(
    () =>
      currentPublishedNote(d, [old, { ...current, text: "desired answer" }]),
    /hash mismatch/,
  );
  assert.throws(
    () =>
      currentPublishedNote({ ...d, results: [{ execution_id: "old" }] }, [
        old,
        current,
      ]),
    /No current result/,
  );
  assert.throws(
    () =>
      currentPublishedNote(
        { ...d, completion: { executions: [d.completion.executions[0]] } },
        [old, current],
      ),
    /missing/,
  );
});

test("current fields permit obsolete-date explanation but reject duplicated or wrong current values", () => {
  assert.equal(
    fieldEquals(
      "此前 2027-03-08 已作废。\n**date:** 2027-03-09",
      "date",
      "2027-03-09",
    ),
    true,
  );
  assert.equal(
    fieldEquals("date: 2027-03-08\n新建议 2027-03-09", "date", "2027-03-09"),
    false,
  );
  assert.equal(
    fieldEquals("date: 2027-03-09\ndate: 2027-03-08", "date", "2027-03-09"),
    false,
  );
  assert.equal(
    fieldEquals("previous_date: 2027-03-09", "date", "2027-03-09"),
    false,
  );
  assert.equal(
    fieldEquals("date: 2027-03-09\ndate: 2027-03-09", "date", "2027-03-09"),
    false,
  );
  assert.equal(fieldEquals("- equipment：雨具", "equipment", "雨具"), true);
  assert.equal(fieldEquals("owner: 林岚（待确认）", "owner", "林岚"), false);
  assert.throws(() => fieldEquals("", ".*", ""), /Invalid grading/);
});

test("complex fixture execution explicitly skips every real-model case", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "butler-complex-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "run");
  const result = await runSuite({ output, group: "complex" });
  assert.deepEqual(result.counts, {
    passed: 0,
    failed: 0,
    timeout: 0,
    not_run: 6,
  });
  for (const c of complexCases) {
    const evidence = JSON.parse(await readFile(join(output, `${c.id}.json`)));
    assert.equal(evidence.state, "not_run");
    assert.equal(evidence.profileDirectory, undefined);
    assert.equal(evidence.modelQualityScore, null);
  }
});
