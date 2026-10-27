import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteDebugReader } from "../../apps/workbench-electron/src/sqlite-debug-reader";

test("SQLite debugger reads only fixed OpenCraft databases with bounded pages", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencraft-sqlite-debug-"));
  try {
    const path = join(directory, "opencraft-threads.sqlite");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, payload BLOB)");
    database.prepare("INSERT INTO threads(id,title,payload) VALUES(?,?,?)").run("one", "A".repeat(2_100), new Uint8Array([1, 2, 3]));
    database.close();

    const reader = new SqliteDebugReader(directory);
    const listed = reader.list();
    assert.equal(listed.find((item) => item.id === "thread-catalog")?.exists, true);
    assert.equal(listed.find((item) => item.id === "session-routing")?.exists, false);
    assert.deepEqual(reader.tables("thread-catalog").map(({ name, rowCount }) => [name, rowCount]), [["threads", 1]]);
    const page = reader.rows("thread-catalog", "threads", 0, 50);
    assert.equal(page.total, 1);
    assert.equal(page.rows[0]?.payload, "[Blob · 3 bytes]");
    assert.match(String(page.rows[0]?.title), /…$/u);
    assert.throws(() => reader.rows("thread-catalog", "sqlite_schema", 0, 50), /Unknown OpenCraft database table/u);
    assert.throws(() => reader.rows("../../foreign", "threads", 0, 50), /Unknown OpenCraft database/u);
    assert.throws(() => reader.rows("thread-catalog", "threads; DELETE FROM threads", 0, 50), /Unknown OpenCraft database table/u);
    const verify = new DatabaseSync(path, { readOnly: true });
    assert.equal((verify.prepare("SELECT COUNT(*) AS count FROM threads").get() as { count: number }).count, 1);
    verify.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SQLite inspector is Electron-only and internal-developer gated", () => {
  const source = readFileSync(new URL("../../apps/workbench-web/src/components/settings-page.tsx", import.meta.url), "utf8");
  assert.match(source, /internalDeveloperMode \? \(/u);
  assert.match(source, /internalDeveloperMode && currentPlatform\(\) === "electron"/u);
  assert.match(source, /section === "sqlite-debug" && internalDeveloperMode && platform === "electron"/u);
  assert.doesNotMatch(source, /query\s*\(sql|execute\s*\(sql/iu);
});
