import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

test("compiled native lifecycle rotates utterances without ending capture, stop fences new tasks", { skip: process.platform !== "darwin" }, async () => {
  const { stdout } = await promisify(execFile)(resolve("apps/workbench-electron/build/native/opencraft-speech-helper"), ["--verify-lifecycle"], { timeout: 10000 });
  assert.equal(JSON.parse(stdout).verifiedTaskLifecycle, true);
});
