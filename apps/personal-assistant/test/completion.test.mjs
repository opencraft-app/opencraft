import { legacyMemoryFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Runner, request } from "../src/runner.mjs";
import { CompletionContract } from "../src/domain/completion-contract.mjs";
import { ReceptionDecision } from "../src/domain/conversation.mjs";
import { digest } from "../src/domain/values.mjs";
import { profileFor, running, completed, until, publishTestNote, childRunner, nativeEntries } from "./helpers.mjs";
const call = (p, op, params = {}, id = crypto.randomUUID()) => request(p, { op, params, id });
const blocked = (p, workId) =>
  until(async () => {
    const d = await call(p, "work", { workId });
    return d.work.status === "blocked" && d;
  });

test("new work cannot waive note publication or choose a delivery destination", () => {
  const c = CompletionContract.create("goal", {
    origin: "legacy",
    checks: [],
    delivery: { destination: "email", required: false },
  });
  assert.deepEqual(c.checks, [{ id: "note", kind: "note_published" }]);
  assert.equal(c.delivery.destination, "local-mailbox");
  assert.equal(c.origin, "current");
  assert.throws(
    () =>
      CompletionContract.create("g", {
        checks: [{ kind: "shell", command: "any" }],
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      CompletionContract.create("g", {
        checks: [{ kind: "material_read", path: "../outside.md" }],
      }),
    /relative/,
  );
});

test("a final model statement without a published artifact is blocked with a durable failed assessment", (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const work = s.work(s.submit("w", { text: "produce useful work" }).workId);
  const receipt = s.completedExecution(work, "I finished everything successfully");
  assert.equal(receipt.accepted, false);
  assert.equal(s.work(work.id).status, "blocked");
  assert.equal(s.detail(work.id).results.length, 0);
  assert.equal(s.detail(work.id).deliveries.length, 0);
  assert.equal(s.detail(work.id).completion.executions[0].assessment.data.passed, false);
});

test("machine checks pass independently of semantic review and delivery acceptance", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const work = s.work(
    s.submit("w", {
      text: "summary",
      completion: {
        requirements: ["准确概括项目风险"],
        checks: [{ kind: "note_contains", text: "来源：project.md" }],
      },
    }).workId,
  );
  const artifact = await publishTestNote(s, work, "来源：project.md\n项目摘要");
  const receipt = s.completedExecution(work, "a real local result");
  assert.equal(receipt.assessment.passed, true);
  assert.equal(receipt.assessment.semanticReview, "unverified");
  assert.equal(
    receipt.assessment.checks.every((c) => c.evidenceId),
    true,
  );
  assert.equal(s.work(work.id).status, "awaiting_delivery");
  assert.equal(s.detail(work.id).completion.executions[0].evidence[0].data.sha256, artifact.sha256);
  s.deliveryAccepted(s.deliveries()[0]);
  assert.equal(s.work(work.id).status, "completed");
});

test("checking literal content uses published bytes rather than the final model answer", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const work = s.work(
    s.submit("w", {
      text: "summary",
      completion: {
        checks: [{ kind: "note_contains", text: "required-in-artifact" }],
      },
    }).workId,
  );
  await publishTestNote(s, work, "note missing the required content");
  const result = s.completedExecution(work, "required-in-artifact");
  assert.equal(result.accepted, false);
  assert.equal(result.assessment.checks.find((c) => c.kind === "note_contains").passed, false);
  assert.equal(s.deliveries().length, 0);
});

test("source receipts must belong to this execution and match an explicitly requested source hash", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const completion = {
    checks: [
      {
        kind: "material_read",
        path: "project.md",
        sha256: digest("expected source"),
      },
    ],
  };
  const first = s.work(s.submit("a", { text: "one", completion }).workId);
  s.app.completion.materialRead(first, {
    source: "materials",
    path: "project.md",
    sha256: digest("expected source"),
  });
  const second = s.work(s.submit("b", { text: "two", completion }).workId);
  await publishTestNote(s, second, "source path and content claimed by model");
  s.app.completion.materialRead(second, {
    source: "materials",
    path: "project.md",
    sha256: digest("changed source"),
  });
  const result = s.completedExecution(second, "done");
  assert.equal(result.assessment.checks.find((c) => c.kind === "material_read").passed, false);
});

test("amend preserves criteria, creates an immutable new contract snapshot and does not reuse old evidence", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const original = s.work(
    s.submit("w", {
      text: "first",
      completion: {
        requirements: ["preserve risks"],
        checks: [{ kind: "note_contains", text: "required" }],
      },
    }).workId,
  );
  const oldSnapshot = s.executionContext(original);
  await publishTestNote(s, original, "required");
  s.completedExecution(original, "old");
  s.amend("change", {
    workId: original.id,
    text: "second",
    expectedRevision: 1,
  });
  const revised = s.work(original.id),
    snapshot = s.executionContext(revised);
  assert.equal(snapshot.completion.objective, "second");
  assert.equal(
    snapshot.completion.checks.some((c) => c.text === "required"),
    true,
  );
  assert.equal(oldSnapshot.completion.objective, "first");
  const result = s.completedExecution(revised, "new statement");
  assert.equal(result.accepted, false);
  assert.equal(s.detail(original.id).completion.executions[1].evidence.length, 0);
  assert.equal(s.detail(original.id).completion.executions[0].assessment.data.contract.objective, "first");
});

test("evidence is immutable, replay idempotent, and cannot be submitted through the user protocol", async (t) => {
  const s = new Store(profileFor(t));
  t.after(() => s.close());
  const work = s.work(s.submit("w", { text: "note" }).workId);
  const artifact = await publishTestNote(s, work, "body");
  s.app.completion.publishedNote(work, artifact, "body");
  assert.equal(s.detail(work.id).completion.executions[0].evidence.length, 1);
  assert.throws(
    () => s.app.completion.publishedNote(work, { ...artifact, sha256: "0".repeat(64) }, "body"),
    /does not match/,
  );
  assert.throws(
    () =>
      s.app.dispatch({
        op: "completion.evidence",
        id: "fake",
        params: { passed: true },
      }),
    /Unknown operation/,
  );
  assert.throws(
    () => s.app.completion.publishedNote(work, { ...artifact, path: "a different artifact" }, "body"),
    /Immutable/,
  );
});

test("schema-3 work and its snapshot preserve their original completion semantics on upgrade", async (t) => {
  const p = profileFor(t);
  let s = new Store(p);
  const work = s.work(s.submit("legacy", { text: "legacy goal" }).workId);
  const oldSnapshot = s.executionContext(work);
  delete oldSnapshot.completion;
  s.db.prepare("UPDATE execution SET context_json=? WHERE work_id=?").run(JSON.stringify(oldSnapshot), work.id);
  legacyMemoryFixture(p, s.db);
  s.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE memory_tombstone; DROP TABLE memory_refresh; DROP TABLE memory_learning_control; ALTER TABLE memory_learning DROP COLUMN batch_ids_json; ALTER TABLE memory_learning DROP COLUMN temporal; ALTER TABLE memory_learning DROP COLUMN today; DROP TABLE memory_detail; ALTER TABLE routine DROP COLUMN schedule_json; ALTER TABLE routine DROP COLUMN last_scheduled_at; ALTER TABLE routine DROP COLUMN stop_when; DROP TABLE usage_observation; ALTER TABLE execution DROP COLUMN guard_json; DROP TABLE execution_report; ALTER TABLE execution DROP COLUMN request_json; ALTER TABLE reception DROP COLUMN source_json; ALTER TABLE reception DROP COLUMN attempts; ALTER TABLE reception DROP COLUMN next_at; ALTER TABLE delivery DROP COLUMN message_text; ALTER TABLE delivery DROP COLUMN suppress_notification; ALTER TABLE routine DROP COLUMN resources_json; ALTER TABLE interaction DROP COLUMN kind; ALTER TABLE interaction DROP COLUMN expires_at; ALTER TABLE interaction DROP COLUMN metadata_json; ALTER TABLE work DROP COLUMN origin_json; ALTER TABLE routine DROP COLUMN notify; DROP TABLE trigger_rule; DROP TABLE assistant_event; DROP TABLE trigger_occurrence; DROP TABLE file_observation; DROP TABLE notification; ALTER TABLE reception DROP COLUMN query_scope_json; DROP TABLE completion_assessment; DROP TABLE completion_evidence; ALTER TABLE work DROP COLUMN completion_json; PRAGMA user_version=3",
  );
  s.close();
  s = new Store(p);
  t.after(() => s.close());
  assert.deepEqual(s.executionContext(s.work(work.id)), oldSnapshot);
  assert.equal(s.detail(work.id).completion.contract.origin, "legacy");
  assert.equal(s.completedExecution(s.work(work.id), "old engine result").accepted, true);
  s.amend("new", {
    workId: work.id,
    text: "explicitly revised goal",
    expectedRevision: 1,
  });
  assert.equal(s.completedExecution(s.work(work.id), "statement only").accepted, false);
});

test("real Pi records source and note evidence and checks them before a result can be delivered", async (t) => {
  const p = profileFor(t),
    materials = join(p.path, "materials");
  mkdirSync(materials);
  writeFileSync(join(materials, "project.md"), "定量指标：7\n里程碑：已完成导入。");
  // Reuse explicit initialization: no shared material roots or credentials.
  const { initProfile } = await import("../src/profile.mjs");
  const profile = initProfile(join(p.path, "nested"), "local:test-owner", {
    workspace: materials,
  });
  const runner = await Runner.open(profile);
  t.after(() => runner.close());
  const receipt = await call(profile, "submit", {
    text: "整理项目资料",
    completion: {
      requirements: ["忠实概括资料"],
      checks: [
        {
          kind: "material_read",
          path: "project.md",
          sha256: digest("定量指标：7\n里程碑：已完成导入。"),
        },
        { kind: "note_contains", text: "定量指标：7" },
      ],
    },
  });
  const done = await completed(profile, receipt.workId),
    assessment = done.completion.executions[0].assessment.data;
  assert.equal(assessment.passed, true);
  assert.equal(assessment.semanticReview, "unverified");
  assert.equal(done.completion.executions[0].evidence.length, 2);
  assert.equal(done.deliveries[0].status, "accepted");
});

test("Pi completion with an unsatisfied literal check blocks work without a success delivery", async (t) => {
  const { profile } = await running(t);
  const receipt = await call(profile, "submit", {
    text: "整理一份笔记",
    completion: {
      checks: [{ kind: "note_contains", text: "not-present-anywhere-741" }],
    },
  });
  const failed = await blocked(profile, receipt.workId);
  assert.equal(failed.results.length, 0);
  assert.equal(failed.deliveries.length, 0);
  assert.equal(failed.completion.executions[0].assessment.data.passed, false);
  await call(profile, "amend", {
    workId: receipt.workId,
    text: "整理修订笔记",
    expectedRevision: 1,
    completion: { checks: [] },
  });
  const done = await completed(profile, receipt.workId);
  assert.equal(done.work.revision, 2);
  assert.equal(done.completion.executions[0].assessment.data.passed, false);
  assert.equal(done.completion.executions[1].assessment.data.passed, true);
});

test("crash after result persistence preserves the same evidence and assessment while only retrying delivery", async (t) => {
  const profile = profileFor(t);
  const first = await childRunner(t, profile, {
    LAB_TEST_CRASH_AT: "result-saved-before-delivery",
  });
  const receipt = await call(profile, "submit", { text: "整理一份笔记" }, "completion-crash");
  assert.equal((await first.exited).code, 86);
  const second = await childRunner(t, profile);
  const done = await completed(profile, receipt.workId);
  assert.equal(done.completion.executions[0].evidence.length, 1);
  assert.equal(done.completion.executions[0].assessment.data.passed, true);
  assert.equal(done.results.length, 1);
  await second.stop();
  assert.equal(
    (await nativeEntries(profile, receipt.workId)).filter((e) => e.kind === "superapp.work-input").length,
    1,
  );
});

test("reception proposals retain explicit requirements and cannot disable the host default", () => {
  const decision = ReceptionDecision.parse({
    kind: "delegate",
    goal: "goal",
    completion: {
      requirements: ["retain uncertainty"],
      checks: [],
      origin: "legacy",
      tools: ["bash"],
    },
  });
  assert.equal(decision.completion.origin, "current");
  assert.equal(
    decision.completion.checks.some((c) => c.kind === "note_published"),
    true,
  );
  assert.equal("tools" in decision.completion, false);
});
