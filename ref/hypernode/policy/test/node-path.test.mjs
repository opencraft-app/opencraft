import assert from "node:assert/strict";
import test from "node:test";

import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "../src/runtime/node-path.ts";

test("the QuickJS path shim preserves the POSIX operations required by DSH", () => {
  assert.equal(isAbsolute("/workspace/project"), true);
  assert.equal(isAbsolute("workspace/project"), false);
  assert.equal(normalize("/workspace/./project/../repo"), "/workspace/repo");
  assert.equal(join("/workspace", "project", "..", "repo"), "/workspace/repo");
  assert.equal(resolve("/workspace", "project", "../repo"), "/workspace/repo");
  assert.equal(dirname("/workspace/repo/file.ts"), "/workspace/repo");
  assert.equal(basename("/workspace/repo/file.ts", ".ts"), "file");
});
