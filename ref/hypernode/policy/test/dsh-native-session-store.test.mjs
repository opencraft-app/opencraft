import assert from "node:assert/strict";
import test from "node:test";

import {
  DshNativeSessionTable,
  stableDshSessionId,
} from "../src/services/dsh-native-session-store.ts";

function descriptor(threadId = "thread-1", suffix = "") {
  const sessionId = `${stableDshSessionId(threadId)}${suffix}`;
  return {
    sessionId,
    header: { version: 0, id: sessionId, createdAt: 1, cwd: "/workspace" },
  };
}

test("DSH native session registry round-trips only the native ledger descriptor", () => {
  const table = new DshNativeSessionTable({ available: false });
  const source = descriptor();
  table.remember("thread-1", source, "native");

  const restored = table.load("thread-1");
  assert.deepEqual(restored, {
    threadId: "thread-1",
    ...source,
    provenance: "native",
    updatedAtMs: restored.updatedAtMs,
  });
  assert.equal(Object.hasOwn(restored, "events"), false);
  assert.equal(table.has("thread-1"), true);
  assert.equal(table.currentSessionId("thread-1"), source.sessionId);
});

test("DSH native session pointer may advance to a fresh physical generation", () => {
  const table = new DshNativeSessionTable({ available: false });
  table.remember("thread-1", descriptor(), "native");
  const next = descriptor("thread-1", ".g1");
  table.remember("thread-1", next, "dsh-surface-generation-resume");

  assert.equal(table.currentSessionId("thread-1"), next.sessionId);
  assert.equal(table.load("thread-1").provenance, "dsh-surface-generation-resume");
  assert.equal(Object.hasOwn(table.load("thread-1"), "events"), false);
});

test("DSH native session registry rejects mismatched descriptor identity", () => {
  const table = new DshNativeSessionTable({ available: false });
  const source = descriptor();
  source.header.id = "different-session";
  assert.throws(
    () => table.remember("thread-1", source),
    /header identity mismatch/,
  );
});
