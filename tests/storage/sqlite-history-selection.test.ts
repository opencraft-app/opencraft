import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { selectMigrationHistory, openManagedDatabase, type Migration } from "../../packages/sqlite-node/src/index.js";

const common: Migration = { version: 1, name: "base", sql: "CREATE TABLE data(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT" };
const left: readonly Migration[] = [common,
  { version: 2, name: "left", sql: "CREATE TABLE left_items(id INTEGER PRIMARY KEY) STRICT" },
  { version: 3, name: "right", sql: "CREATE TABLE right_items(id INTEGER PRIMARY KEY) STRICT" },
];
const right: readonly Migration[] = [common,
  { version: 2, name: "right", sql: "CREATE TABLE right_items(id INTEGER PRIMARY KEY) STRICT" },
  { version: 3, name: "left", sql: "CREATE TABLE left_items(id INTEGER PRIMARY KEY) STRICT" },
];
const histories = [{ id: "left", migrations: left }, { id: "right", migrations: right }] as const;

for (const [id, chain] of [["left", left], ["right", right]] as const) {
  for (const count of [2, 3]) test(`${id} history version ${count} selects the exact append chain`, () => {
    const { database } = openManagedDatabase({ path: ":memory:", migrations: chain.slice(0, count) });
    try {
      database.prepare("INSERT INTO data VALUES (?,?)").run(4, "preserved");
      const before = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      const selected = selectMigrationHistory(database, histories, id === "left" ? "right" : "left");
      assert.equal(selected.history.id, id);
      assert.equal(selected.appliedVersion, count);
      assert.deepEqual(database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), before);
      assert.equal(database.prepare("SELECT value FROM data WHERE id=4").get()?.value, "preserved");
    } finally { database.close(); }
  });
}

test("a common prefix requires a matching explicit preference", () => {
  const { database } = openManagedDatabase({ path: ":memory:", migrations: [common] });
  try {
    assert.throws(() => selectMigrationHistory(database, histories), /ambiguous/);
    assert.throws(() => selectMigrationHistory(database, histories, "other"), /ambiguous/);
    assert.equal(selectMigrationHistory(database, histories, "right").history.id, "right");
  } finally { database.close(); }
});

test("missing, empty, mixed and corrupted ledgers fail closed", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.throws(() => selectMigrationHistory(database, histories), /missing/);
    database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    assert.throws(() => selectMigrationHistory(database, histories), /Unknown/);
  } finally { database.close(); }
  const managed = openManagedDatabase({ path: ":memory:", migrations: left });
  try {
    managed.database.exec("UPDATE schema_migrations SET checksum='invalid' WHERE version=2");
    const before = managed.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.throws(() => selectMigrationHistory(managed.database, histories), /Unknown/);
    assert.deepEqual(managed.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), before);
  } finally { managed.database.close(); }
});

test("a valid ledger cannot hide an unexpected table, index or trigger", () => {
  for (const sql of ["CREATE TABLE injected(id INTEGER)", "CREATE INDEX injected ON data(value)", "CREATE TRIGGER injected AFTER INSERT ON data BEGIN SELECT 1; END"]) {
    const { database } = openManagedDatabase({ path: ":memory:", migrations: left });
    try { database.exec(sql); assert.throws(() => selectMigrationHistory(database, histories), /Unknown/); }
    finally { database.close(); }
  }
});

test("invalid or duplicate manifests are rejected, including an invalid unused branch", () => {
  const { database } = openManagedDatabase({ path: ":memory:", migrations: left });
  try {
    assert.throws(() => selectMigrationHistory(database, []), /Invalid/);
    assert.throws(() => selectMigrationHistory(database, [histories[0], histories[0]]), /Invalid/);
    assert.throws(() => selectMigrationHistory(database, [histories[0], { id: "bad", migrations: [left[1]!] }]), /migration|version/i);
  } finally { database.close(); }
});

for (const [id, chain] of [["left", left], ["right", right]] as const) test(`${id} selection feeds the real managed append and preserves its published ledger`, t => {
  const directory = mkdtempSync(join(tmpdir(), "sqlite-history-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "server.sqlite");
  let first = openManagedDatabase({ path, migrations: chain.slice(0, 2) });
  first.database.prepare("INSERT INTO data VALUES (?,?)").run(4, "preserved");
  const before = first.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  first.database.close();
  const reader = new DatabaseSync(path, { readOnly: true });
  const selected = selectMigrationHistory(reader, histories);
  reader.close();
  assert.equal(selected.history.id, id);
  const migrated = openManagedDatabase({ path, migrations: selected.history.migrations });
  try {
    assert.equal(migrated.outcome.status, "migrated");
    assert.ok(migrated.outcome.backupPath && existsSync(migrated.outcome.backupPath));
    assert.deepEqual(migrated.database.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(), before);
    assert.equal(migrated.database.prepare("SELECT value FROM data WHERE id=4").get()?.value, "preserved");
    assert.deepEqual(migrated.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { migrated.database.close(); }
});
