import { ensureBrowserProcessEnv } from "../../apps/workbench-web/src/runtime/browser-process-env";
import assert from "node:assert/strict";
import test from "node:test";

test("standalone Web installs process.env without replacing a host-owned process", () => {
  const emptyTarget: { process?: { env?: Record<string, unknown> } } = {};
  ensureBrowserProcessEnv(emptyTarget);
  assert.deepEqual(emptyTarget.process, { env: {} });

  const existingProcess = { env: { HOST_VALUE: "kept" } };
  const existingTarget = { process: existingProcess };
  ensureBrowserProcessEnv(existingTarget);
  assert.equal(existingTarget.process, existingProcess);
  assert.equal(existingTarget.process.env.HOST_VALUE, "kept");
});
