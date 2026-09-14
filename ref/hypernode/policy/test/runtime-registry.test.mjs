import assert from "node:assert/strict";
import test from "node:test";

import { RuntimeRegistryService } from "../src/services/runtime-registry.ts";

test("runtime registry persists only explicitly started runtimes", () => {
  const previousPolicyStore = globalThis.policyStore;
  const writes = [];
  globalThis.policyStore = {
    set: (namespace, key, value) => writes.push({ namespace, key, value }),
  };
  try {
    const registry = Object.create(RuntimeRegistryService.prototype);
    registry.records = new Map();
    registry.register({
      runtimeId: "thread-a",
      outerThreadId: "thread-a",
      processId: "process-a",
      realm: "workspace",
      viewId: "main",
    });
    registry.register({
      runtimeId: "thread-b",
      outerThreadId: "thread-b",
      processId: "process-b",
      realm: "workspace",
      viewId: "fork-b",
    });

    assert.deepEqual(registry.snapshot().map(({ runtimeId }) => runtimeId), ["thread-a", "thread-b"]);
    assert.equal(registry.clearView("main"), true);
    assert.deepEqual(registry.snapshot().map(({ runtimeId }) => runtimeId), ["thread-b"]);
    assert.equal(registry.unregister("thread-b"), true);
    assert.deepEqual(registry.snapshot(), []);
    const persisted = JSON.parse(writes.at(-1).value);
    assert.deepEqual(persisted, { version: 1, records: [] });
  } finally {
    globalThis.policyStore = previousPolicyStore;
  }
});

test("runtime registry rejects incomplete process records", () => {
  const registry = Object.create(RuntimeRegistryService.prototype);
  registry.records = new Map();
  assert.throws(
    () => registry.register({ runtimeId: "thread-a", viewId: "main" }),
    /invalid runtime registry record/,
  );
});
