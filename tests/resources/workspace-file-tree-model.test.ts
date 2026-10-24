import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WORKSPACE_TREE_ROW_HEIGHT,
  projectWorkspaceTree,
  selectWorkspaceDirectoryEntries,
  workspaceTreeAncestors,
  workspaceTreeQueryPaths,
  workspaceTreeWindow,
} from "../../apps/workbench-web/src/panels/workspace-file-tree-model";
const file = (fileName: string) => ({ fileName, isDirectory: false, isFile: true });
const folder = (fileName: string) => ({ fileName, isDirectory: true, isFile: false });

test("sorts directory data naturally without mutating the server snapshot", () => {
  const entries = [file("file-10.ts"), file("file-2.ts"), folder("z"), folder("a")];
  assert.deepEqual(selectWorkspaceDirectoryEntries({ entries }).map(entry => entry.fileName), ["a", "z", "file-2.ts", "file-10.ts"]);
  assert.equal(entries[0]!.fileName, "file-10.ts");
});

test("reveals only exact scoped ancestors, including filesystem and Windows roots", () => {
  assert.deepEqual(workspaceTreeAncestors(["/repo"], "/repo/nested/deep/a.ts"), ["/repo", "/repo/nested", "/repo/nested/deep"]);
  assert.deepEqual(workspaceTreeAncestors(["/repo"], "/repository/secret/a.ts"), ["/repo"]);
  assert.deepEqual(workspaceTreeAncestors(["/"], "/repo/a.ts"), ["/", "/repo"]);
  assert.deepEqual(workspaceTreeAncestors(["C:/"], "C:/repo/a.ts"), ["C:/", "C:/repo"]);
});

test("closing an ancestor releases descendant query observers without erasing their expansion", () => {
  const expanded = new Set(["/repo", "/repo/a", "/repo/a/b", "/other", "/repository"]);
  assert.deepEqual(workspaceTreeQueryPaths(["/repo"], expanded), ["/repo", "/repo/a", "/repo/a/b"]);
  expanded.delete("/repo/a");
  assert.deepEqual(workspaceTreeQueryPaths(["/repo"], expanded), ["/repo"]);
  assert.ok(expanded.has("/repo/a/b"));
  expanded.add("/repo/a");
  assert.deepEqual(new Set(workspaceTreeQueryPaths(["/repo"], expanded)), new Set(["/repo", "/repo/a", "/repo/a/b"]));
});

test("flat projection visits only expanded branches; late collapsed results stay invisible", () => {
  const directories = [{ path: "/repo", entries: [folder("a"), file("z.ts")], failed: false }, { path: "/repo/a", entries: [file("b.ts")], failed: false }];
  const expanded = new Set(["/repo", "/repo/a"]);
  const rows = projectWorkspaceTree(["/repo"], expanded, directories);
  assert.deepEqual(rows.map(row => [row.path, row.depth]), [["/repo", 0], ["/repo/a", 1], ["/repo/a/b.ts", 2], ["/repo/z.ts", 1]]);
  assert.equal(rows[2]!.parent, "/repo/a");
  expanded.delete("/repo/a");
  assert.deepEqual(projectWorkspaceTree(["/repo"], expanded, directories).map(row => row.path), ["/repo", "/repo/a", "/repo/z.ts"]);
});

test("models pending/errors per directory and keeps cached entries during refresh failure", () => {
  const expanded = new Set(["/a", "/b", "/c"]);
  const rows = projectWorkspaceTree(["/a", "/b", "/c"], expanded, [{ path: "/b", entries: undefined, failed: true }, { path: "/c", entries: [file("cached")], failed: true }]);
  assert.deepEqual(rows.map(row => row.kind), ["directory", "loading", "directory", "error", "directory", "file"]);
});

test("10,000 flat rows produce a viewport-sized window at both ends and after shrinking", () => {
  const rows = projectWorkspaceTree(["/repo"], new Set(["/repo"]), [{ path: "/repo", entries: Array.from({ length: 10_000 }, (_, index) => file(`file-${index}`)), failed: false }]);
  assert.equal(rows.length, 10_001);
  for (const top of [0, 12_345, 9_999_999]) {
    const range = workspaceTreeWindow(rows.length, top, 600);
    assert.ok(range.end - range.start <= 41);
    assert.equal(range.height, rows.length * WORKSPACE_TREE_ROW_HEIGHT);
  }
  assert.equal(workspaceTreeWindow(rows.length, 9_999_999, 600).end, rows.length);
  assert.deepEqual(workspaceTreeWindow(2, 9_999_999, 600), { start: 0, end: 2, height: 50 });
  assert.deepEqual(workspaceTreeWindow(0, 9_999_999, 0), { start: 0, end: 0, height: 0 });
});
