import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cases, portfolioState, mentionsCity } from "./butler-cases.mjs";
import { runSuite, summarize, selectCases } from "./butler-suite.mjs";
import { runExtendedCase } from "./butler-extended-cases.mjs";

test("synthetic memory assertions recognize Chinese/English equivalents without accepting other or forgotten cities", () => {
  for (const value of ["我在上海", "User lives in Shanghai", "SHANGHAI."])
    assert.equal(mentionsCity(value, "shanghai"), true);
  for (const value of ["深圳", "User lives in Shenzhen", "shanghaix", "", null])
    assert.equal(mentionsCity(value, "shanghai"), false);
  assert.equal(mentionsCity("Lives in SHENZHEN", "shenzhen"), true);
  assert.equal(mentionsCity("Old Shanghai, new Shenzhen", "shanghai"), true);
  assert.throws(() => mentionsCity("北京", "beijing"), /Unknown/);
});

test("butler scores preserve missing/failing cases and never imply semantic quality", () => {
  const r = summarize(
    [
      { id: cases[0].id, state: "passed" },
      { id: cases[1].id, state: "failed" },
      { id: cases[2].id, state: "timeout" },
    ],
    cases,
  );
  assert.deepEqual(r.counts, {
    passed: 1,
    failed: 1,
    timeout: 1,
    not_run: cases.length - 3,
  });
  assert.equal(r.modelQualityScore, null);
  assert.equal(r.semanticReview, "unverified");
});
test("core remains comparable; extended cases are explicit, disjoint and require real execution", async () => {
  const core = selectCases({ group: "core" }),
    extra = selectCases({ group: "extended" });
  assert.equal(core.length, 6);
  assert.equal(extra.length, 6);
  assert.equal(new Set([...core, ...extra].map((c) => c.id)).size, 12);
  assert.ok(
    extra.every(
      (c) => c.modelOnly && c.inputMode && c.coverage.length && c.review,
    ),
  );
  assert.deepEqual(selectCases({ only: extra[0].id }), [extra[0]]);
  assert.throws(() => selectCases({ group: "unknown" }), /Unknown group/);
  assert.throws(
    () => selectCases({ only: core[0].id, group: "extended" }),
    /either/,
  );
  await assert.rejects(runExtendedCase("unknown", {}, {}), /Unknown scenario/);
});
test("extended fixture cases are retained as not_run, never simulated quality passes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "butler-extended-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "run");
  const r = await runSuite({ output, group: "extended" });
  assert.deepEqual(r.counts, { passed: 0, failed: 0, timeout: 0, not_run: 6 });
  for (const spec of selectCases({ group: "extended" })) {
    const e = JSON.parse(await readFile(join(output, `${spec.id}.json`)));
    assert.equal(e.profileDirectory, undefined);
    assert.equal(e.modelQualityScore, null);
  }
});
test("no-write snapshots allow mixed waiting/queued states but detect cancellation, revisions and new work", () => {
  const works = [
    { id: "a", revision: 1, status: "waiting_input" },
    { id: "b", revision: 1, status: "queued" },
  ];
  const goals = [{ id: "g", revision: 2, state: "active" }];
  const before = portfolioState(works, goals);
  assert.deepEqual(before, portfolioState([...works].reverse(), goals));
  for (const change of [
    { status: "cancelled" },
    { revision: 2 },
    { text: "changed" },
    { active_execution_id: "new" },
  ])
    assert.notDeepEqual(
      before,
      portfolioState([{ ...works[0], ...change }, works[1]], goals),
    );
  assert.notDeepEqual(before, portfolioState([...works, { id: "c" }], goals));
  assert.notDeepEqual(
    before,
    portfolioState(works, [{ ...goals[0], revision: 3 }]),
  );
});
test("butler rejects unknown cases and implicit model credentials before creating outputs", async () => {
  await assert.rejects(
    runSuite({ output: "/unused", only: "not-a-case" }),
    /Unknown case/,
  );
  await assert.rejects(
    runSuite({ output: "/unused", mode: "model" }),
    /model-profile/,
  );
  await assert.rejects(
    runSuite({ output: "/unused", mode: "fixture", modelProfile: "/unused" }),
    /does not accept/,
  );
  await assert.rejects(
    runSuite({ output: "/unused", timeoutMs: 0 }),
    /timeout/,
  );
});
test("real worker fixture has no truthfulness score and refuses output reuse", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "butler-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "run");
  const r = await runSuite({ output, only: "honest-boundary" });
  assert.equal(r.counts.not_run, 1);
  const e = JSON.parse(await readFile(join(output, "honest-boundary.json")));
  assert.equal(e.state, "not_run");
  assert.equal(e.profileDirectory, undefined);
  await assert.rejects(runSuite({ output, only: "honest-boundary" }), /EEXIST/);
});
