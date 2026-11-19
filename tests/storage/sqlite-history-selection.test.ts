import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  selectMigrationHistory,
  openManagedDatabase,
  acquireProcessWriter,
  type Migration,
} from "../../packages/sqlite-node/src/index.js";
import { beginRecovery } from "../../packages/sqlite-node/src/recovery.js";
import { applyMigrations, prepareMigrations } from "../../packages/sqlite-node/src/migrations.js";

const common: Migration = {
  version: 1,
  name: "base",
  sql: "CREATE TABLE data(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT",
};
const left: readonly Migration[] = [
  common,
  { version: 2, name: "left", sql: "CREATE TABLE left_items(id INTEGER PRIMARY KEY) STRICT" },
  { version: 3, name: "right", sql: "CREATE TABLE right_items(id INTEGER PRIMARY KEY) STRICT" },
];
const right: readonly Migration[] = [
  common,
  { version: 2, name: "right", sql: "CREATE TABLE right_items(id INTEGER PRIMARY KEY) STRICT" },
  { version: 3, name: "left", sql: "CREATE TABLE left_items(id INTEGER PRIMARY KEY) STRICT" },
];
const histories = [
  { id: "left", migrations: left },
  { id: "right", migrations: right },
] as const;

for (const [id, chain] of [
  ["left", left],
  ["right", right],
] as const) {
  for (const count of [2, 3])
    test(`${id} history version ${count} selects the exact append chain`, () => {
      const { database } = openManagedDatabase({ path: ":memory:", migrations: chain.slice(0, count) });
      try {
        database.prepare("INSERT INTO data VALUES (?,?)").run(4, "preserved");
        const before = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
        const selected = selectMigrationHistory(database, histories, id === "left" ? "right" : "left");
        assert.equal(selected.history.id, id);
        assert.equal(selected.appliedVersion, count);
        assert.deepEqual(database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), before);
        assert.equal(database.prepare("SELECT value FROM data WHERE id=4").get()?.value, "preserved");
      } finally {
        database.close();
      }
    });
}

test("a common prefix requires a matching explicit preference", () => {
  const { database } = openManagedDatabase({ path: ":memory:", migrations: [common] });
  try {
    assert.throws(() => selectMigrationHistory(database, histories), /ambiguous/);
    assert.throws(() => selectMigrationHistory(database, histories, "other"), /ambiguous/);
    assert.equal(selectMigrationHistory(database, histories, "right").history.id, "right");
  } finally {
    database.close();
  }
});

test("missing, empty, mixed and corrupted ledgers fail closed", () => {
  const database = new DatabaseSync(":memory:");
  try {
    assert.throws(() => selectMigrationHistory(database, histories), /missing/);
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT",
    );
    assert.throws(() => selectMigrationHistory(database, histories), /Unknown/);
  } finally {
    database.close();
  }
  const managed = openManagedDatabase({ path: ":memory:", migrations: left });
  try {
    managed.database.exec("UPDATE schema_migrations SET checksum='invalid' WHERE version=2");
    const before = managed.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    assert.throws(() => selectMigrationHistory(managed.database, histories), /Unknown/);
    assert.deepEqual(managed.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all(), before);
  } finally {
    managed.database.close();
  }
});

test("a valid ledger cannot hide an unexpected table, index or trigger", () => {
  for (const sql of [
    "CREATE TABLE injected(id INTEGER)",
    "CREATE INDEX injected ON data(value)",
    "CREATE TRIGGER injected AFTER INSERT ON data BEGIN SELECT 1; END",
  ]) {
    const { database } = openManagedDatabase({ path: ":memory:", migrations: left });
    try {
      database.exec(sql);
      assert.throws(() => selectMigrationHistory(database, histories), /Unknown/);
    } finally {
      database.close();
    }
  }
});

test("invalid or duplicate manifests are rejected, including an invalid unused branch", () => {
  const { database } = openManagedDatabase({ path: ":memory:", migrations: left });
  try {
    assert.throws(() => selectMigrationHistory(database, []), /Invalid/);
    assert.throws(() => selectMigrationHistory(database, [histories[0], histories[0]]), /Invalid/);
    assert.throws(
      () => selectMigrationHistory(database, [histories[0], { id: "bad", migrations: [left[1]!] }]),
      /migration|version/i,
    );
  } finally {
    database.close();
  }
});

for (const [id, chain] of [
  ["left", left],
  ["right", right],
] as const)
  test(`${id} selection feeds the real managed append and preserves its published ledger`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "sqlite-history-selection-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "server.sqlite");
    const first = openManagedDatabase({ path, migrations: chain.slice(0, 2) });
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
      assert.deepEqual(
        migrated.database.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(),
        before,
      );
      assert.equal(migrated.database.prepare("SELECT value FROM data WHERE id=4").get()?.value, "preserved");
      assert.deepEqual(migrated.database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.database.close();
    }
  });

for (const [id, chain] of [
  ["left", left],
  ["right", right],
] as const)
  for (const committed of [false, true])
    test(`${id} history selection resumes a pending upgrade ${committed ? "after" : "before"} commit`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), "sqlite-history-recovery-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const path = join(directory, "server.sqlite"),
        release = acquireProcessWriter(join(directory, "server.lock"));
      try {
        const first = openManagedDatabase({ path, migrations: chain.slice(0, 2) });
        first.database.prepare("INSERT INTO data VALUES (?,?)").run(7, "preserved");
        const prior = first.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
        const prepared = prepareMigrations(chain);
        const recovery = beginRecovery(first.database, path, prepared);
        assert.ok(recovery);
        if (committed) applyMigrations(first.database, prepared);
        first.database.close();
        // Selection and reopening are protected by the same owner writer fence.
        const reader = new DatabaseSync(path, { readOnly: true });
        const selection = selectMigrationHistory(reader, histories);
        assert.throws(
          () => acquireProcessWriter(join(directory, "server.lock")),
          (error) => (error as { code?: string }).code === "ELOCKED",
        );
        reader.close();
        assert.equal(selection.history.id, id);
        const resumed = openManagedDatabase({ path, migrations: selection.history.migrations });
        try {
          assert.equal(resumed.outcome.appliedVersion, 3);
          assert.equal(resumed.database.prepare("SELECT value FROM data WHERE id=7").get()?.value, "preserved");
          assert.deepEqual(
            resumed.database.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(),
            prior,
          );
          assert.ok(existsSync(recovery.backupPath));
          assert.equal(existsSync(path + ".pending-migration.json"), false);
        } finally {
          resumed.database.close();
        }
      } finally {
        release();
      }
    });

test("a noncanonical ledger table cannot be mistaken for a usable history", () => {
  for (const extra of [", extra TEXT NOT NULL", ", extra TEXT"]) {
    const { database } = openManagedDatabase({ path: ":memory:", migrations: left });
    try {
      const rows = database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      database.exec("ALTER TABLE schema_migrations RENAME TO old_ledger");
      database.exec(
        `CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL${extra}) STRICT`,
      );
      const extraColumn = extra.includes("NOT NULL") ? ", 'required'" : ", NULL";
      database.exec(
        `INSERT INTO schema_migrations SELECT version,name,checksum,applied_at${extraColumn} FROM old_ledger; DROP TABLE old_ledger`,
      );
      assert.throws(() => selectMigrationHistory(database, histories), /ledger schema is invalid/);
      assert.equal(database.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, rows.length);
    } finally {
      database.close();
    }
  }
});

test("data-dependent migrations are rejected rather than guessed from an empty schema replay", () => {
  const dependent = [
    ...left.slice(0, 1),
    {
      version: 2,
      name: "requires-live-row",
      sql: "CREATE TABLE verify_row(x INTEGER NOT NULL); INSERT INTO verify_row SELECT NULL WHERE NOT EXISTS(SELECT 1 FROM data WHERE id=42); DROP TABLE verify_row",
    },
  ];
  // This owner deliberately bypasses the ordinary schema replay for a data-dependent history.
  const { database } = openManagedDatabase({ path: ":memory:", migrations: [common] });
  try {
    database.prepare("INSERT INTO data VALUES (?,?)").run(42, "existing");
    applyMigrations(database, prepareMigrations(dependent));
    assert.throws(() => selectMigrationHistory(database, [{ id: "dependent", migrations: dependent }]));
    assert.equal(database.prepare("SELECT value FROM data WHERE id=42").get()?.value, "existing");
  } finally {
    database.close();
  }
});

test("append-only release checks preserve every published branch and exact SQL", async () => {
  const { assertAppendOnlyMigrationHistories } = await import("../../packages/sqlite-node/src/index.js");
  const previous = [{ id: "left", migrations: left }, { id: "right", migrations: right }];
  const future = previous.map((history) => ({
    ...history,
    migrations: [...history.migrations, { version: 4, name: "future", sql: "CREATE TABLE future(id INTEGER) STRICT" }],
  }));
  assert.doesNotThrow(() => assertAppendOnlyMigrationHistories(previous, future));
  assert.doesNotThrow(() => assertAppendOnlyMigrationHistories(previous, previous));
  const reject = (histories: typeof future) => assert.throws(() => assertAppendOnlyMigrationHistories(previous, histories), { kind: "history-mismatch" });
  reject(future.slice(0, 1));
  reject(future.map((h) => h.id === "left" ? { ...h, migrations: h.migrations.slice(0, 2) } : h));
  reject(future.map((h) => h.id === "left" ? { ...h, migrations: h.migrations.map((m) => m.version === 2 ? { ...m, sql: m.sql + " " } : m) } : h));
  reject(future.map((h) => h.id === "left" ? { ...h, migrations: h.migrations.map((m) => m.version === 2 ? { ...m, name: "renamed" } : m) } : h));
  reject(future.map((h) => h.id === "left" ? { ...h, migrations: h.migrations.map((m) => m.version === 2 ? { ...m, version: 7 } : m) } : h));
  reject([...future, future[0]!]);
  const added = [...future, { id: "third", migrations: [common] }];
  reject(added);
  assert.doesNotThrow(() => assertAppendOnlyMigrationHistories(previous, added, { allowNewHistories: true }));
  assert.throws(() => assertAppendOnlyMigrationHistories(previous, added, { allowNewHistories: "true" as unknown as boolean }), { kind: "history-mismatch" });
  assert.throws(() => assertAppendOnlyMigrationHistories([], future), { kind: "history-mismatch" });
  assert.throws(() => assertAppendOnlyMigrationHistories(previous, [{ id: "left", migrations: [] }]), { kind: "history-mismatch" });
});

test("release checks do not mutate histories or reveal SQL on rejection", async () => {
  const { assertAppendOnlyMigrationHistories } = await import("../../packages/sqlite-node/src/index.js");
  const secret = "CREATE TABLE private_fixture (id INTEGER) STRICT";
  const previous = [{ id: "owner", migrations: [{ version: 1, name: "initial", sql: secret }] }];
  const candidate = [{ id: "owner", migrations: [{ version: 1, name: "initial", sql: secret + " " }] }];
  const snapshot = structuredClone({ previous, candidate });
  assert.throws(() => assertAppendOnlyMigrationHistories(previous, candidate), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.deepEqual({ previous, candidate }, snapshot);
});
