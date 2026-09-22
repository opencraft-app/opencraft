import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexExecutable } from "../apps/workbench-electron/src/codex-executable.js";

test("Codex executable resolution prefers explicit, PATH, then the official user install", () => {
  const executable = new Set(["/custom/codex", "/path/bin/codex", "/Users/test/.local/bin/codex"]);
  const isExecutable = (path: string) => executable.has(path);
  assert.equal(resolveCodexExecutable({ explicit: "/custom/codex", path: "/path/bin", homeDirectory: "/Users/test", isExecutable }), "/custom/codex");
  assert.equal(resolveCodexExecutable({ path: "/path/bin", homeDirectory: "/Users/test", isExecutable }), "/path/bin/codex");
  executable.delete("/path/bin/codex");
  assert.equal(resolveCodexExecutable({ path: "/missing", homeDirectory: "/Users/test", isExecutable }), "/Users/test/.local/bin/codex");
  executable.clear();
  assert.equal(resolveCodexExecutable({ path: "/missing", homeDirectory: "/Users/test", isExecutable }), "codex");
});
