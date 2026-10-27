import assert from "node:assert/strict";
import test from "node:test";
import gitCases from "../fixtures/turn-diff-git-cases.json";
import { spawnSync } from "node:child_process";
import { createTurnChangeSummary, summarizeTurnDiff } from "../../packages/chat-core/src/turn-diff";

const git = (path: string, body: string) => `diff --git a/${path} b/${path}\n${body}`;

test("file observations preserve first appearance, repeated paths and binary sections", () => {
  const diff = [git("one.ts", "+added\n-removed"), git("binary.png", "Binary files differ"),
    git("one.ts", "@@ -1 +1 @@\n+again")].join("\n");
  assert.deepEqual(summarizeTurnDiff(diff), {
    files: [{ path: "one.ts", additions: 2, deletions: 1 }, { path: "binary.png", additions: 0, deletions: 0 }],
    additions: 2, deletions: 1,
  });
});

test("git destination owns rename/deletion identity; metadata is not changed-line content", () => {
  assert.deepEqual(summarizeTurnDiff('diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ /dev/null\n-old\n+new'), {
    files: [{ path: "new.ts", additions: 1, deletions: 1 }], additions: 1, deletions: 1,
  });
  assert.deepEqual(summarizeTurnDiff('--- a/old\n+++ b/new\n-old\n+new'), { files: [], additions: 0, deletions: 0 });
  assert.deepEqual(summarizeTurnDiff(git("partial.ts", '++++value\n----value\n+one')), {
    files: [{ path: "partial.ts", additions: 1, deletions: 0 }], additions: 1, deletions: 0,
  });
});

test("quoted paths decode Git C escapes to repository file identity", () => {
  for (const [wire, expected] of [['a b', 'a b'], ['a\\tname', 'a\tname'],
    ['a\\303\\251', 'aé'], ['a\\"name', 'a"name'], ['a\\\\name', 'a\\name']]) {
    assert.equal(summarizeTurnDiff(`diff --git "a/old" "b/${wire}"\n+x`).files[0]?.path, expected);
  }
  assert.deepEqual(summarizeTurnDiff('diff --git a/a b/a   \n+x').files, []);
  assert.deepEqual(summarizeTurnDiff('diff --git a/a b b/a b\n+x').files, [{ path: 'a b', additions: 1, deletions: 0 }]);
});

test("card identity, raw diff and execution state retain the public projection contract", () => {
  for (const diff of [null, "", " \n\t "]) assert.equal(createTurnChangeSummary("turn", "complete", diff), null);
  const diff = git("a", "+x\n-y");
  for (const [status, expected] of [["pending", "running"], ["streaming", "running"],
    ["complete", "complete"], ["failed", "failed"], ["interrupted", "interrupted"]] as const) {
    assert.deepEqual(createTurnChangeSummary("turn", status, diff), {
      type: "turn-diff", id: "turn:turn-diff", sourceItemIds: [], unifiedDiff: diff,
      files: [{ path: "a", additions: 1, deletions: 1 }], additions: 1, deletions: 1, status: expected,
    });
  }
  assert.equal(createTurnChangeSummary("turn", "complete", "plain text")?.unifiedDiff, "plain text");
  assert.deepEqual(summarizeTurnDiff(diff.replaceAll("\n", "\r\n")), summarizeTurnDiff(diff));
});


test("adversarial quoted headers complete within an isolated process budget", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", String.raw`
    import { summarizeTurnDiff } from './packages/chat-core/src/turn-diff.ts';
    for (const slashCount of [1, 2]) {
      const fragment = String.fromCharCode(92).repeat(slashCount) + '"';
      summarizeTurnDiff('diff --git "' + fragment.repeat(100_000) + '\n+x');
    }
  `], { cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

// These patches were produced by local Git; expected paths/counts come from its
// independent --numstat -z output, including rename and binary observations.
for (const entry of gitCases) test(`real Git summary: ${entry.name}`, () => {
  assert.deepEqual(summarizeTurnDiff(entry.diff), entry.expected);
});
