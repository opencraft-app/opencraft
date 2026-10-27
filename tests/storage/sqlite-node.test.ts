import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openManagedDatabase, SqliteLifecycleError, type Migration } from "@opencraft/sqlite-node";
import { SqliteDocumentStore } from "@opencraft/document-storage/sqlite";

const chain: readonly Migration[] = [
  { version: 1, name: "items", sql: "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT" },
  { version: 2, name: "label", sql: "ALTER TABLE items ADD COLUMN label TEXT" },
  { version: 3, name: "index", sql: "CREATE INDEX items_value ON items(value)" },
];
function fixture(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "oc-sqlite-node-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "data.sqlite");
}
function open(path: string, migrations = chain, keep?: number) {
  return openManagedDatabase({ path, migrations, backup: { keep } });
}
function rejects(kind: string) {
  return (error: unknown) => error instanceof SqliteLifecycleError && error.kind === kind;
}

test("fresh, memory, repeated open, connection baseline and private permissions", t => {
  for (const path of [fixture(t), ":memory:"]) {
    const first = open(path);
    assert.equal(first.outcome.status, "fresh");
    assert.equal(first.outcome.appliedVersion, 3);
    assert.equal(first.outcome.backupPath, undefined);
    assert.equal(first.database.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
    assert.equal(first.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1); // Node's default, runner does not override it.
    assert.equal(first.database.prepare("PRAGMA journal_mode").get()?.journal_mode, path === ":memory:" ? "memory" : "wal");
    first.database.close();
    if (path === ":memory:") continue;
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const again = open(path);
    assert.equal(again.outcome.status, "up-to-date");
    assert.equal(again.outcome.backupPath, undefined);
    again.database.close();
    assert.deepEqual(readdirSync(join(path, "..")), ["data.sqlite"]);
  }
});

test("version chain applies only pending versions and records exact SQL hashes", t => {
  const path = fixture(t);
  open(path, chain.slice(0, 1)).database.close();
  const second = open(path, chain.slice(0, 2));
  assert.equal(second.outcome.status, "migrated");
  second.database.prepare("INSERT INTO items(value,label) VALUES(?,?)").run("v", "l");
  second.database.close();
  const third = open(path);
  assert.equal(third.outcome.status, "migrated");
  assert.equal(third.database.prepare("SELECT value FROM items").get()?.value, "v");
  const rows = third.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  assert.deepEqual(rows.map(row => [row.version, row.name, row.checksum]), chain.map(m => [m.version, m.name, createHash("sha256").update(m.sql).digest("hex")]));
  assert.ok(rows.every(row => typeof row.applied_at === "number" && row.applied_at > 0));
  third.database.close();
});

test("changed checksums, names, gaps and unknown newer versions reject without changing data", t => {
  for (const [sql, kind] of [
    ["UPDATE schema_migrations SET checksum='changed' WHERE version=1", "history-mismatch"],
    ["UPDATE schema_migrations SET name='changed' WHERE version=1", "history-mismatch"],
    ["DELETE FROM schema_migrations WHERE version=2", "history-mismatch"],
    ["INSERT INTO schema_migrations VALUES(4,'future','x',1)", "newer-schema"],
  ]) {
    const path = fixture(t);
    const original = open(path);
    original.database.exec("INSERT INTO items(value) VALUES('preserved')");
    original.database.exec(sql!);
    original.database.close();
    assert.throws(() => openManagedDatabase({ path, migrations: chain, legacyMigration: {
      accepts: () => true,
      migrate: database => database.exec("UPDATE items SET value='must-not-repair-ledger'"),
    } }), rejects(kind!));
    const reader = new DatabaseSync(path);
    assert.equal(reader.prepare("SELECT value FROM items").get()?.value, "preserved");
    reader.close();
    assert.ok(!readdirSync(join(path, "..")).some(name => name.includes("pre-v")));
  }
});

test("invalid manifests are rejected before a connection is created", () => {
  for (const migrations of [[], [chain[1]!], [chain[0]!, chain[0]!]]) {
    assert.throws(() => open(":memory:", migrations), rejects("history-mismatch"));
  }
});

test("failed SQL rolls back both ledger and schema; file can be reopened", t => {
  const path = fixture(t);
  const broken = [{ version: 1, name: "broken", sql: "CREATE TABLE partial(id INTEGER); INSERT INTO missing VALUES(1)" }];
  assert.throws(() => open(path, broken), rejects("migration-failed"));
  const inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('partial','schema_migrations')").get()?.n, 0);
  inspect.close();
  open(path, chain.slice(0, 1)).database.close();
  const failingUpgrade = [...chain.slice(0, 1), { version: 2, name: "broken", sql: "CREATE TABLE partial(id INTEGER); INSERT INTO missing VALUES(1)" }];
  assert.throws(() => open(path, failingUpgrade), rejects("migration-failed"));
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 1);
  assert.equal(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='partial'").get()?.n, 0);
  check.close();
  assert.equal(readdirSync(join(path, "..")).filter(name => name.includes("pre-v")).length, 1, "failed upgrade retains recovery point");
  const recovered = open(path);
  assert.equal(recovered.outcome.status, "migrated");
  recovered.database.close();
});

test("WAL backup includes uncheckpointed committed data and keeps latest N after success", t => {
  const path = fixture(t);
  const writer = open(path, chain.slice(0, 1));
  writer.database.exec("PRAGMA wal_autocheckpoint=0; PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO items(value) VALUES('in-wal')");
  assert.ok(statSync(`${path}-wal`).size > 0);
  const upgraded = open(path, chain.slice(0, 2), 1);
  assert.ok(upgraded.outcome.backupPath);
  const snapshot = new DatabaseSync(upgraded.outcome.backupPath!);
  assert.equal(snapshot.prepare("SELECT value FROM items").get()?.value, "in-wal");
  assert.equal(snapshot.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 1);
  snapshot.close();
  assert.equal(statSync(upgraded.outcome.backupPath!).mode & 0o777, 0o600);
  writer.database.close();
  upgraded.database.close();
  const next = open(path, chain, 1);
  next.database.close();
  assert.deepEqual(readdirSync(join(path, "..")).filter(name => name.includes("pre-v")), [next.outcome.backupPath!.split("/").at(-1)]);
});

test("matching legacy target schema is adopted without rerunning SQL or losing rows", t => {
  const path = fixture(t);
  const legacy = new DatabaseSync(path);
  legacy.exec(chain.map(m => m.sql).join(";"));
  legacy.exec("INSERT INTO items(value,label) VALUES('old','kept')");
  legacy.close();
  const adopted = open(path);
  assert.equal(adopted.outcome.status, "adopted");
  assert.ok(adopted.outcome.backupPath);
  assert.equal(adopted.database.prepare("SELECT label FROM items").get()?.label, "kept");
  assert.equal(adopted.database.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 3);
  adopted.database.close();
  const again = open(path);
  assert.equal(again.outcome.status, "up-to-date");
  again.database.close();
});

test("different legacy tables, columns or index names are backed up and moved aside", t => {
  for (const sql of [chain[0]!.sql, chain[0]!.sql + "; CREATE INDEX other ON items(value)", "CREATE TABLE other(id INTEGER)"]) {
    const path = fixture(t);
    const legacy = new DatabaseSync(path);
    legacy.exec(sql);
    legacy.close();
    const replaced = open(path);
    assert.equal(replaced.outcome.status, "moved-aside");
    assert.ok(replaced.outcome.backupPath);
    assert.ok(replaced.outcome.movedAsidePaths[0]?.includes(".legacy-"));
    assert.ok(statSync(replaced.outcome.movedAsidePaths[0]!).isFile());
    assert.equal(replaced.database.prepare("SELECT count(*) AS n FROM items").get()?.n, 0);
    replaced.database.close();
  }
});

test("owner-declared legacy upgrade backs up original data, commits schema and ledger together, and reopens", t => {
  const path = fixture(t);
  const legacy = new DatabaseSync(path);
  legacy.exec(`${chain[0]!.sql}; INSERT INTO items(value) VALUES('kept')`);
  legacy.close();
  const legacyMigration = {
    accepts: (fingerprint: string) => fingerprint.includes('"name":"items"') && !fingerprint.includes('"name":"label"'),
    migrate: (database: DatabaseSync) => database.exec(`${chain[1]!.sql}; ${chain[2]!.sql}`),
  };
  const upgraded = openManagedDatabase({ path, migrations: chain, legacyMigration });
  assert.equal(upgraded.outcome.status, "migrated");
  assert.equal(upgraded.database.prepare("SELECT value,label FROM items").get()?.value, "kept");
  assert.equal(upgraded.database.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 3);
  const backup = new DatabaseSync(upgraded.outcome.backupPath!);
  try {
    assert.equal(backup.prepare("SELECT value FROM items").get()?.value, "kept");
    assert.equal(backup.prepare("PRAGMA table_info(items)").all().length, 2);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get()?.n, 0);
  } finally { backup.close(); upgraded.database.close(); }
  const again = openManagedDatabase({ path, migrations: chain, legacyMigration });
  assert.equal(again.outcome.status, "up-to-date");
  assert.equal(again.outcome.backupPath, undefined);
  assert.equal(again.database.prepare("SELECT value FROM items").get()?.value, "kept");
  again.database.close();
});

test("failed owner legacy conversion or wrong final schema rolls back without moving aside or adopting", t => {
  for (const [sql, kind] of [
    ["ALTER TABLE items ADD COLUMN label TEXT; UPDATE items SET value='changed'; INSERT INTO missing VALUES(1)", "migration-failed"],
    ["ALTER TABLE items ADD COLUMN label TEXT; UPDATE items SET value='changed'", "unsupported-legacy"],
  ]) {
    const path = fixture(t);
    const legacy = new DatabaseSync(path);
    legacy.exec(`${chain[0]!.sql}; INSERT INTO items(value) VALUES('original')`);
    legacy.close();
    assert.throws(() => openManagedDatabase({ path, migrations: chain, legacyMigration: {
      accepts: () => true,
      migrate: database => database.exec(sql!),
    } }), rejects(kind!));
    const reader = new DatabaseSync(path);
    try {
      assert.equal(reader.prepare("SELECT value FROM items").get()?.value, "original");
      assert.equal(reader.prepare("PRAGMA table_info(items)").all().length, 2);
      assert.equal(reader.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get()?.n, 0);
    } finally { reader.close(); }
    assert.equal(readdirSync(join(path, "..")).filter(name => name.includes(".legacy-")).length, 0);
    const backups = readdirSync(join(path, "..")).filter(name => name.includes(".pre-v"));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(path, "..", backups[0]!));
    try { assert.equal(backup.prepare("SELECT value FROM items").get()?.value, "original"); }
    finally { backup.close(); }
  }
});

test("sqlite_sequence alone does not make an empty database a legacy database", t => {
  const path = fixture(t);
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE removed(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE removed");
  legacy.close();
  const fresh = open(path);
  assert.equal(fresh.outcome.status, "fresh");
  assert.equal(fresh.outcome.backupPath, undefined);
  fresh.database.close();
});

const DOCUMENT_BASELINE = "CREATE TABLE extension_records (scope TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, data_version INTEGER NOT NULL, value_json TEXT NOT NULL) STRICT";
const DOCUMENT_HASH = "31e65ecf5383ca13381fd1a7cc766cc257893fc5e5a063ccf104c1f7d0bb3fb1";
test("both document database identities reopen the previous baseline as up-to-date", t => {
  assert.equal(createHash("sha256").update(DOCUMENT_BASELINE).digest("hex"), DOCUMENT_HASH);
  const root = join(fixture(t), "..");
  for (const filename of ["opencraft-extensions.sqlite", "host-documents.sqlite"]) {
    const path = join(root, filename);
    // Exact pre-refactor constructor ledger and baseline, independent of the new runner.
    const previous = new DatabaseSync(path);
    previous.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT");
    previous.exec(DOCUMENT_BASELINE);
    previous.prepare("INSERT INTO schema_migrations VALUES(1,'extension-records',?,?)").run(DOCUMENT_HASH, 1);
    previous.exec(`INSERT INTO extension_records VALUES('test',1,1,'{"kept":true}')`);
    previous.close();
    const managed = open(path, [{ version: 1, name: "extension-records", sql: DOCUMENT_BASELINE }]);
    assert.equal(managed.outcome.status, "up-to-date");
    assert.equal(managed.outcome.backupPath, undefined);
    managed.database.close();
    const store = new SqliteDocumentStore(path);
    assert.deepEqual(store.read("test"), { revision: 1, version: 1, value: { kept: true } });
    store.close();
    const check = new DatabaseSync(path);
    assert.equal(check.prepare("SELECT checksum FROM schema_migrations").get()?.checksum, DOCUMENT_HASH);
    check.close();
    assert.ok(!readdirSync(root).some(name => name.includes("pre-v")));
  }
});


test("default retention keeps three backups; failed migration does not prune them", t => {
  const path = fixture(t);
  const versions = [...chain,
    { version: 4, name: "extra", sql: "ALTER TABLE items ADD COLUMN extra TEXT" },
    { version: 5, name: "more", sql: "ALTER TABLE items ADD COLUMN more TEXT" },
  ];
  for (let length = 1; length <= versions.length; length++) open(path, versions.slice(0, length)).database.close();
  const backupNames = () => readdirSync(join(path, "..")).filter(name => name.includes("pre-v"));
  assert.equal(backupNames().length, 3);
  assert.ok(!backupNames().some(name => name.includes("pre-v2-")));
  const failing = [...versions, { version: 6, name: "broken", sql: "INSERT INTO missing VALUES(1)" }];
  assert.throws(() => open(path, failing, 1), rejects("migration-failed"));
  assert.equal(backupNames().length, 4, "failed disposal keeps older successful recovery points");
});

test("locked databases and filesystem failures are classified without replacing files", t => {
  const path = fixture(t);
  const writer = open(path, chain.slice(0, 1));
  writer.database.exec("BEGIN IMMEDIATE");
  try { assert.throws(() => open(path, chain.slice(0, 2)), rejects("busy")); }
  finally { writer.database.exec("ROLLBACK"); writer.database.close(); }
  assert.throws(() => open(join(path, "..")), rejects("io"));
  const again = open(path, chain.slice(0, 1));
  assert.equal(again.outcome.status, "up-to-date");
  again.database.close();
});


test("document store still rejects a current ledger whose domain table is missing", t => {
  const path = fixture(t);
  new SqliteDocumentStore(path).close();
  const tamper = new DatabaseSync(path);
  tamper.exec("DROP TABLE extension_records");
  tamper.close();
  assert.throws(() => new SqliteDocumentStore(path), /no such table/);
});


test("retention always preserves this upgrade's snapshot even with future-dated older backups", t => {
  const path = fixture(t);
  open(path, chain.slice(0, 1)).database.close();
  const second = open(path, chain.slice(0, 2));
  second.database.exec("INSERT INTO items(value) VALUES('after-old-backup')");
  second.database.close();
  const futurePath = `${path}.pre-v2-2099-01-01T00-00-00.000Z.sqlite`;
  renameSync(second.outcome.backupPath!, futurePath);
  const third = open(path, chain, 1);
  third.database.close();
  assert.ok(statSync(third.outcome.backupPath!).isFile());
  const snapshot = new DatabaseSync(third.outcome.backupPath!);
  assert.equal(snapshot.prepare("SELECT value FROM items").get()?.value, "after-old-backup");
  snapshot.close();
  assert.deepEqual(readdirSync(join(path, "..")).filter(name => name.includes("pre-v")), [third.outcome.backupPath!.split("/").at(-1)]);
});
