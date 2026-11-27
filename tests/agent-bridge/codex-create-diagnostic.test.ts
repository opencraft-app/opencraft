import assert from "node:assert/strict";
import test from "node:test";
import { nativeCreateDiagnostic } from "../../apps/agent-bridge-host/src/codex-create-diagnostic.js";

const noModels = "No models are available. Set `model` explicitly or check your model catalog configuration.";

test("only the exact native no-default-model startup rejection proves non-allocation", () => {
  assert.deepEqual(nativeCreateDiagnostic(-32600, noModels), {
    code: -32600,
    reason: "model-catalog-unavailable",
    notAllocated: true,
  });
  for (const [code, message] of [
    [-32603, noModels],
    [429, "Too many requests: private-quota"],
    [-32600, "Invalid Request"],
    [-32600, `error creating thread: ${noModels}`],
    [-32600, `${noModels} private-detail`],
  ] as const)
    assert.equal(nativeCreateDiagnostic(code, message).notAllocated, false);
});
