import assert from "node:assert/strict";
import test from "node:test";

import { ThreadEngineBindingTable } from "../src/services/thread-engine-binding.ts";

test("thread engine binding is stable across ordinary turns", () => {
  const table = new ThreadEngineBindingTable({ available: false });
  const first = table.claim("thread-1", "dsh");
  const second = table.claim("thread-1", "dsh");
  assert.equal(first.engineKind, "dsh");
  assert.equal(first.generation, 1);
  assert.deepEqual(second, first);
});

test("ordinary turn cannot cross an execution-engine boundary", () => {
  const table = new ThreadEngineBindingTable({ available: false });
  table.claim("thread-1", "codex");
  assert.throws(
    () => table.claim("thread-1", "dsh"),
    (error) => error.code === -32084 && error.data?.kind === "engineMigrationRequired",
  );
});

test("legacy evidence is committed before evaluating the requested engine", () => {
  const table = new ThreadEngineBindingTable({ available: false });
  assert.throws(
    () => table.claim("thread-1", "dsh", { inferredEngineKind: "codex" }),
    /requires an explicit migration/,
  );
  assert.equal(table.get("thread-1").engineKind, "codex");
});

test("explicit migration advances generation and records checkpoint provenance", () => {
  const table = new ThreadEngineBindingTable({ available: false });
  table.claim("thread-1", "codex");
  const migrated = table.migrate("thread-1", "codex", "dsh", { checkpointId: "checkpoint-7" });
  assert.equal(migrated.engineKind, "dsh");
  assert.equal(migrated.generation, 2);
  assert.equal(migrated.provenance, "explicit-migration:checkpoint-7");
});
