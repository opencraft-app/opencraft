import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltinTimelineProjectors } from "../../packages/chat-core/src/builtin-projectors";
import type { TimelineItemProjector, TimelineSourceTurn } from "../../packages/chat-core/src/projection";

const makeProjector = () => createBuiltinTimelineProjectors().find(p => p.name === "file-change")!;
function project(projector: TimelineItemProjector, changes: unknown, overrides: Record<string, unknown> = {}, turnStatus: TimelineSourceTurn["status"] = "streaming") {
  const item = { id: "patch", type: "fileChange", payload: { changes, status: "inProgress", ...overrides } };
  const turn: TimelineSourceTurn = { id: "turn", status: turnStatus, items: [item] };
  const result = projector.project(item, { turn, itemIndex: 0 });
  assert.equal(result?.block.type, "patch");
  if (result?.block.type !== "patch") throw new Error("Expected patch");
  return result.block;
}

test("file counts preserve split-newline semantics for headers, empty and malformed diffs", () => {
  const projector = makeProjector();
  const cases = ["", "+", "-", "++", "--", "+++", "---", "++++", "----", "+++ x\n--- x\n+a\n-b", "+a\r\n-b\r\n", "+a\r-b", "\n\n+\n-\n", "\r+a\n -b\n\\ No newline", "@@ -1 +1 @@\n-old\n+新😀", "+\n++\n+++\n+\n-\n--\n---"];
  // Deterministic combinations exercise prefixes at every kind of boundary.
  const parts = ["+", "-", "++", "--", "+++", "---", " x", "", "\r", "😀"];
  for (const left of parts) for (const right of parts) for (const separator of ["\n", "\r\n", "\r", ""]) cases.push(left + separator + right);
  for (const diff of cases) {
    const change = project(projector, [{ diff, additions: 99, deletions: 99 }]).changes[0]!;
    assert.equal(change.additions, diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length, JSON.stringify(diff));
    assert.equal(change.deletions, diff.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length, JSON.stringify(diff));
    assert.equal(change.unifiedDiff, diff);
  }
});

test("stable immutable changes reuse metadata across active-tail replacements", () => {
  let reads = 0;
  const changes = Object.freeze([Object.freeze({ path: "a.ts", get diff() { reads++; return "+a\n-b"; } })]);
  const p = makeProjector();
  const first = project(p, changes);
  assert.equal(reads, 1);
  for (const title of ["streaming", "done", "next output"]) {
    const next = project(p, changes, { title });
    assert.equal(next.changes, first.changes);
    assert.equal(next.title, title);
  }
  assert.equal(reads, 1, "active-tail replacement must not reread completed diffs");
});

test("replacement change arrays invalidate metadata, including empty arrays", () => {
  const p = makeProjector();
  const first = project(p, Object.freeze([{ path: "a", diff: "+old" }]));
  const next = project(p, Object.freeze([{ path: "b", diff: "+one\n+two", movePath: "c" }]));
  assert.notEqual(next.changes, first.changes);
  assert.equal(next.changes[0]?.path, "b");
  assert.equal(next.changes[0]?.additions, 2);
  assert.equal(next.changes[0]?.movePath, "c");
  assert.deepEqual(project(p, []).changes, []);
  assert.deepEqual(project(p, null).changes, []);
  assert.deepEqual(project(p, {}).changes, []);
});

test("metadata reuse never caches status, item identity or contextual approval reviews", () => {
  const changes = Object.freeze([Object.freeze({ path: "a", diff: "+a" })]);
  const p = makeProjector();
  const reviews = [{ reviewId: "review", startedAtMs: 1, status: "inProgress", rationale: "checking" }];
  const first = project(p, changes, { automaticApprovalReviews: reviews });
  const interrupted = project(p, changes, { status: "failed", automaticApprovalReviews: reviews }, "interrupted");
  assert.equal(interrupted.changes, first.changes);
  assert.equal(first.automaticApprovalReviews[0]?.status, "inProgress");
  assert.equal(interrupted.automaticApprovalReviews[0]?.status, "aborted");
  assert.equal(interrupted.status, "failed");
  const approved = project(p, changes, { status: "completed", automaticApprovalReviews: [{ ...reviews[0], status: "approved" }] });
  assert.equal(approved.status, "complete");
  assert.deepEqual(approved.automaticApprovalReviews, []);
  const item = { id: "other-item", type: "fileChange", payload: { changes } };
  const result = p.project(item, { turn: { id: "other-turn", status: "complete", items: [item] }, itemIndex: 0 });
  assert.notEqual(result?.block.id, first.id);
});

test("file metadata cache belongs to one projector registry, not a global string store", () => {
  const changes = Object.freeze([Object.freeze({ diff: "+same" })]);
  const first = project(makeProjector(), changes);
  const other = project(makeProjector(), changes);
  assert.notEqual(first.changes, other.changes);
  assert.deepEqual(first.changes, other.changes);
});

test("aliases, finite numeric fallbacks and invalid entries retain compatibility", () => {
  const changes = project(makeProjector(), [
    { file: "a", type: "added", unifiedDiff: "+x", move_path: "b" },
    { path: "b", status: "updated", unified_diff: "-x" },
    { path: "c", kind: "deleted", additions: 3, deletions: 4 },
    { path: "d", additions: Infinity, deletions: NaN },
    null, "invalid",
  ]).changes;
  assert.deepEqual(changes[0], { path: "a", kind: "add", unifiedDiff: "+x", additions: 1, deletions: 0, movePath: "b" });
  assert.equal(changes[1]?.kind, "modify");
  assert.equal(changes[1]?.deletions, 1);
  assert.equal(changes[2]?.kind, "delete");
  assert.equal(changes[2]?.additions, 3);
  assert.equal(changes[2]?.deletions, 4);
  assert.equal(changes[3]?.additions, null);
  assert.equal(changes[3]?.deletions, null);
  assert.equal(changes[4]?.path, "Unknown file");
  assert.deepEqual(changes[4], changes[5]);
});
