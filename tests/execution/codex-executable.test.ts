import assert from "node:assert/strict";
import test from "node:test";

import { resolveCodexExecutable } from "../../apps/desktop/src/codex-executable.js";

test("Codex executable resolution prefers explicit, PATH, then the official user install", async () => {
  const executable = new Set(["/custom/codex", "/path/bin/codex", "/Users/test/.local/bin/codex"]);
  const isExecutable = (path: string) => executable.has(path);
  assert.equal(await resolveCodexExecutable({ explicit: "/custom/codex", path: "/path/bin", homeDirectory: "/Users/test", isExecutable }), "/custom/codex");
  assert.equal(await resolveCodexExecutable({ path: "/path/bin", homeDirectory: "/Users/test", isExecutable }), "/path/bin/codex");
  executable.delete("/path/bin/codex");
  assert.equal(await resolveCodexExecutable({ path: "/missing", homeDirectory: "/Users/test", isExecutable }), "/Users/test/.local/bin/codex");
  executable.clear();
  assert.equal(await resolveCodexExecutable({ path: "/missing", homeDirectory: "/Users/test", isExecutable }), "codex");
});

test("a packaged desktop prefers its bundled Codex over a user install, but not over an explicit override", async () => {
  const executable = new Set(["/app/runtime/codex/bin/codex", "/path/bin/codex"]);
  const isExecutable = (path: string) => executable.has(path);
  const options = { bundled: "/app/runtime/codex/bin/codex", path: "/path/bin", homeDirectory: "/Users/test", isExecutable };
  assert.equal(await resolveCodexExecutable(options), "/app/runtime/codex/bin/codex");
  assert.equal(await resolveCodexExecutable({ ...options, explicit: "/custom/codex" }), "/custom/codex");
  executable.delete("/app/runtime/codex/bin/codex");
  assert.equal(await resolveCodexExecutable(options), "/path/bin/codex");
});
