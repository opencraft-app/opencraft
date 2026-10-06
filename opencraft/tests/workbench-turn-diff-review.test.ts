import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { indexReviewFileDiffs, reviewDiffForFile } from "../apps/workbench-web/src/components/conversation/turn-diff-review";

const diff = [
  "diff --git a/src/one.ts b/src/one.ts",
  "--- a/src/one.ts",
  "+++ b/src/one.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "diff --git a/src/two.ts b/src/two.ts",
  "--- a/src/two.ts",
  "+++ b/src/two.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
].join("\n");

test("review can show the complete turn or a selected file without modifying the turn diff", () => {
  assert.equal(reviewDiffForFile(diff, null), diff);
  const selected = reviewDiffForFile(diff, "src/two.ts");
  assert.match(selected, /\+after/u);
  assert.doesNotMatch(selected, /\+new/u);
  assert.equal(reviewDiffForFile(diff, "missing.ts"), diff);
});

test("review retains repeated changes to the same file", () => {
  const repeated = `${diff}\n${diff.slice(0, diff.indexOf("diff --git a/src/two.ts"))}`;
  assert.equal(reviewDiffForFile(repeated, "src/one.ts").match(/\+new/gu)?.length, 2);
});

test("workbench wires Review and does not advertise an unavailable Undo action", () => {
  const app = readFileSync(new URL("../apps/workbench-web/src/app.tsx", import.meta.url), "utf8");
  const conversation = readFileSync(new URL("../apps/workbench-web/src/components/conversation/turn-diff-resource.tsx", import.meta.url), "utf8");
  assert.match(app, /onReviewTurnDiff: openTurnDiffReview/gu);
  assert.match(app, /<TurnDiffReviewDialog/gu);
  assert.doesNotMatch(conversation, /onApplyTurnDiff|Reapply|Undo2/gu);
  assert.match(conversation, /className="thread-turn-diff__header-target"/gu);
});

test("hover previews index the resource once and retain source order and repeated file hunks", () => {
  const repeated = `${diff}\n${diff.slice(0, diff.indexOf("diff --git a/src/two.ts"))}`;
  const index = indexReviewFileDiffs(repeated);
  assert.deepEqual([...index.keys()], ["src/one.ts", "src/two.ts"]);
  assert.equal(index.get("src/one.ts")!.match(/\+new/gu)?.length, 2);
  assert.equal(index.get("src/two.ts"), reviewDiffForFile(diff, "src/two.ts"));
  assert.equal(indexReviewFileDiffs("").size, 0);
});

test("changed-file basenames yield within their own slot rather than overpainting line counts", () => {
  const styles = readFileSync(new URL("../apps/workbench-web/src/styles/app.scss", import.meta.url), "utf8");
  const pathRules = styles.slice(styles.indexOf("  &__path {", styles.indexOf(".thread-turn-diff {")));
  const basenameRules = pathRules.match(/> b \{([^}]+)\}/u)?.[1] ?? "";
  for (const rule of ["flex: 0 0 auto", "max-width: 100%", "overflow: hidden", "text-overflow: ellipsis", "white-space: nowrap"]) {
    assert.ok(basenameRules.includes(rule), `basename requires ${rule}`);
  }
});
