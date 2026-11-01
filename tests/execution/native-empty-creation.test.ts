import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeEmptyCreation } from "../../apps/opencraft-daemon/src/native-empty-creation.js";

test("only a matching native session allocation is empty; content and unknown records remain authoritative", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-empty-proof-")), path = join(root, "native.jsonl");
  const meta = JSON.stringify({ type: "session_meta", payload: { id: "native-id", instructions: "synthetic response_item text is not an event" } });
  try {
    await writeFile(path, meta + "\r\n");
    assert.equal(nativeEmptyCreation("native-id", path), true);
    assert.equal(nativeEmptyCreation("other-id", path), false);
    const bytes = await readFile(path);
    assert.equal(nativeEmptyCreation("native-id", path), true);
    assert.deepEqual(await readFile(path), bytes, "the proof must not change native data");
    for (const record of [
      { type: "response_item", payload: { type: "message", role: "user", content: [] } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "future-native-record", payload: {} },
    ]) {
      await writeFile(path, meta + "\n" + JSON.stringify(record) + "\n");
      assert.equal(nativeEmptyCreation("native-id", path), false);
    }
    for (const body of ["", "{", meta.slice(0, -1), "x".repeat(1024 * 1024 + 1)]) {
      await writeFile(path, body); assert.equal(nativeEmptyCreation("native-id", path), false);
    }
    await writeFile(path, meta + "\n");
    await symlink(path, join(root, "alias.jsonl"));
    assert.equal(nativeEmptyCreation("native-id", join(root, "alias.jsonl")), false);
    assert.equal(nativeEmptyCreation("native-id", join(root, "missing")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
