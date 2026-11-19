import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationKey,
  createDefaultTimelineProjectorRegistry,
  projectTimeline,
  type TimelineSourceTurn,
} from "../../packages/chat-core/src/index";
import { recoverTurnChangeSummary } from "../../packages/chat-core/src/turn-file-changes";

const patch = (id: string, changes: unknown[], status = "completed", extra = {}) => ({
  id,
  type: "fileChange",
  payload: { changes, status, ...extra },
});
const change = (path: string, type: string, diff: string, extra = {}) => ({ path, kind: { type, ...extra }, diff });
const turn = (items: TimelineSourceTurn["items"], extra = {}): TimelineSourceTurn => ({
  id: "turn",
  status: "complete",
  params: { cwd: "/work" },
  items,
  ...extra,
});
const hunk = "@@ -1 +1 @@\n-old\n+new";
const project = (source: TimelineSourceTurn) =>
  projectTimeline(
    { key: createConversationKey("host", "thread"), revision: 1, phase: "live", authoritative: true, turns: [source] },
    createDefaultTimelineProjectorRegistry(),
  );
const summaries = (source: TimelineSourceTurn) =>
  project(source)
    .frames.map((frame) => frame.changeSummary)
    .filter(Boolean);

test("native object kinds, raw add/delete content, empty files and repeated updates survive recovery", () => {
  const block = recoverTurnChangeSummary(
    turn([
      patch("one", [
        change("a.ts", "add", "first\n+literal\n"),
        change("empty", "add", ""),
        change("old.ts", "delete", "one\ntwo"),
      ]),
      patch("two", [change("a.ts", "update", hunk)]),
    ]),
  )!;
  assert.equal(block.id, "turn:turn-diff");
  assert.deepEqual(block.sourceItemIds, []);
  assert.deepEqual(block.files, [
    { path: "/work/a.ts", additions: 3, deletions: 1 },
    { path: "/work/empty", additions: 0, deletions: 0 },
    { path: "/work/old.ts", additions: 0, deletions: 2 },
  ]);
  assert.equal(block.additions, 3);
  assert.equal(block.deletions, 3);
  assert(block.unifiedDiff.includes("++literal"));
  assert(block.unifiedDiff.includes("\\ No newline at end of file"));
});

test("relative paths track command cwd, moves, quoted paths and Windows without filesystem IO", () => {
  const block = recoverTurnChangeSummary(
    turn([
      patch("one", [change("a b.ts", "update", hunk, { move_path: "new\t名.ts" })]),
      { id: "command", type: "commandExecution", payload: { cwd: "/other/sub" } },
      patch("two", [change("../a.ts", "update", "diff --git a/old b/old\n--- a/old\n+++ b/old\n" + hunk)]),
      patch("three", [change("/absolute.ts", "update", "@@ -1 +1 @@\n---literal\n+++literal")]),
    ]),
  )!;
  assert.deepEqual(
    block.files.map((file) => file.path),
    ["/work/new\t名.ts", "/other/a.ts", "/absolute.ts"],
  );
  assert.equal(block.deletions, 3);
  assert.equal(block.additions, 3);
  assert.deepEqual(
    recoverTurnChangeSummary(
      turn([patch("win", [change("..\\a.ts", "update", hunk)])], { params: { cwd: "C:\\repo\\sub" } }),
    )!.files.map((file) => file.path),
    ["C:/repo/a.ts"],
  );
});

test("failed/declined operations and settled pending work never become edited files", () => {
  const items = ["failed", "declined", "pending", "inProgress", "aborted"].map((status) =>
    patch(status, [change(status, "update", hunk)], status),
  );
  assert.equal(recoverTurnChangeSummary(turn(items)), null);
  assert.deepEqual(
    recoverTurnChangeSummary(turn(items, { status: "streaming" }))!.files.map((file) => file.path),
    ["/work/inProgress"],
  );
  const one = patch("same", [change("one", "update", hunk)]);
  assert.equal(recoverTurnChangeSummary(turn([one, one]))!.additions, 1);
});

test("live aggregate wins once; null/empty history recovers but never resurrects stale compatibility Items", () => {
  const items = [
    patch("patch", [change("historical", "update", hunk)]),
    { id: "old", type: "turnDiff", payload: { diff: "diff --git a/stale b/stale\n+x" } },
  ];
  const aggregate = "diff --git a/net b/net\n@@ -0,0 +1 @@\n+net";
  assert.deepEqual(
    summaries(turn(items, { unifiedDiff: aggregate }))[0]!.files.map((file) => file.path),
    ["net"],
  );
  for (const unifiedDiff of [undefined, null, "", " \n"]) {
    const summary = summaries(turn(items, { unifiedDiff }));
    assert.equal(summary.length, 1);
    assert.deepEqual(
      summary[0]!.files.map((file) => file.path),
      ["/work/historical"],
    );
  }
  assert.equal(summaries(turn(items.slice(1), { unifiedDiff: null })).length, 0);
});

test("two independent tabs and a fresh projector rebuild identical 14-file history without an aggregate", () => {
  const source = turn([
    patch(
      "first",
      Array.from({ length: 14 }, (_, index) => change(`src/file-${index}.ts`, "add", `content-${index}\n`)),
    ),
    patch("later", [change("src/file-0.ts", "update", hunk)]),
    { id: "answer", type: "agentMessage", payload: { text: "Done", phase: "final_answer", completed: true } },
  ]);
  const firstTab = project(source);
  const secondTab = project(JSON.parse(JSON.stringify(source)));
  const refreshed = project(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(firstTab, secondTab);
  assert.deepEqual(refreshed, firstTab);
  assert.equal(firstTab.frames.at(-1)!.changeSummary!.files.length, 14);
  assert.equal(firstTab.frames.at(-1)!.changeSummary!.id, "turn:turn-diff");
  assert.equal(
    firstTab.frames.flatMap((frame) => frame.blocks).filter((block) => block.type === "turn-diff").length,
    0,
  );
});

test("presentation history retains all paths but hides incomplete statistics until existing details hydrate", () => {
  const partial = turn([
    patch("large", [{ path: "large.ts", kind: { type: "add" }, additions: 0, deletions: 0 }], "completed", {
      historyDetail: { cursor: "opaque" },
    }),
    patch("small", [change("small.ts", "update", hunk)]),
  ]);
  const block = summaries(partial)[0]!;
  assert.equal(block.files.length, 2);
  assert.equal(block.contentAvailable, false);
  assert.equal(block.statsAvailable, false);
  assert.deepEqual(block.detailItemIds, ["large"]);
  assert.deepEqual(block.sourceItemIds, []);
  const full = summaries(turn([patch("large", [change("large.ts", "add", "x\n".repeat(600))]), partial.items[1]!]))[0]!;
  assert.equal(full.id, block.id);
  assert.equal(full.contentAvailable, undefined);
  assert.equal(full.additions, 601);
  assert.equal(full.files.length, 2);
});

test("versioned presentation counts are immediate without hydrating diff bodies", () => {
  const block = recoverTurnChangeSummary(
    turn([
      patch(
        "large",
        [{ path: "large.ts", kind: { type: "add" }, additions: 600, deletions: 0, diffStatsVersion: 1 }],
        "completed",
        { historyDetail: { cursor: "opaque" } },
      ),
      patch("small", [change("small.ts", "update", hunk)]),
    ]),
  )!;
  assert.equal(block.contentAvailable, false);
  assert.notEqual(block.statsAvailable, false);
  assert.equal(block.additions, 601);
  assert.equal(block.deletions, 1);
  assert.equal(block.files[0]!.additions, 600);
  assert.deepEqual(block.detailItemIds, ["large"]);
  assert.ok(!block.unifiedDiff.includes("+" + "x".repeat(600)));
});

test("invalid or old unversioned statistics never become authoritative", () => {
  for (const additions of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const block = recoverTurnChangeSummary(
      turn([patch("bad", [{ path: "a", additions, deletions: 0, diffStatsVersion: 1 }])]),
    )!;
    assert.equal(block.statsAvailable, false);
  }
});
