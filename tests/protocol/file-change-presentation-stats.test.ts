import assert from "node:assert/strict";
import test from "node:test";
import { presentationItem } from "../../packages/native-history-node/src/transcript-cache-storage";

for (const kind of ["add", "delete", "update"]) test(`trimmed ${kind} carries accurate versioned statistics`, () => {
  const diff = kind === "update" ? "--- a/a\n+++ b/a\n@@ -1 +1 @@\n---literal\n+++literal\n " + "context".repeat(200)
    : "literal\n".repeat(200);
  const item = presentationItem({ id: "x", type: "fileChange", status: "completed",
    changes: [{ path: "a", kind: { type: kind }, diff }] }, "cursor")!;
  const c = (item.changes as any[])[0];
  assert.equal(c.diff, undefined); assert.equal(c.diffStatsVersion, 1);
  assert.equal(c.additions, kind === "add" ? 200 : kind === "update" ? 1 : 0);
  assert.equal(c.deletions, kind === "delete" ? 200 : kind === "update" ? 1 : 0);
  assert.equal(item.historyDetail?.cursor, "cursor");
});
