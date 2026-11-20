import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { MemoryFileStore } from "../src/adapters/memory/file-store.mjs";
import { MEMORY_FILE_SYNC_MS } from "../src/runtime/local-runner.mjs";
import { running, until } from "./helpers.mjs";

// Every unit of work rescans the memory files twice (enter and prepare). An idle
// runner pumps every 50ms, so phases must not open one when nothing is due.
test("an idle runner does not rescan memory files on every pump", async (t) => {
  const original = MemoryFileStore.prototype.scan;
  let scans = 0;
  MemoryFileStore.prototype.scan = function (...args) { scans++; return original.apply(this, args); };
  t.after(() => { MemoryFileStore.prototype.scan = original; });
  await running(t);
  await delay(500);
  scans = 0;
  await delay(2000);
  // Previously ~3 units of work per 50ms pump (~240 scans in 2s).
  assert.ok(scans <= 6, `idle scans in 2s: ${scans}`);
});

test("an external memory file edit is still noticed without user activity", async (t) => {
  const { profile, runner, call } = await running(t);
  await call("memory.set", { key: "city", value: "Lives in Shanghai" }, "city");
  const db = new DatabaseSync(join(profile.path, "assistant.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const changes = () => db.prepare("SELECT count(*) AS n FROM event WHERE kind='memory.files.changed'").get().n;
  await delay(MEMORY_FILE_SYNC_MS + 200);
  const before = changes();
  writeFileSync(join(runner.app.memory.files.locations().user, "profile.md"),
    "# User\n\n- (2026-11-03) Lives in Shenzhen\n");
  const noticed = await until(() => changes() > before, MEMORY_FILE_SYNC_MS * 2 + 1000);
  assert.ok(noticed);
});
