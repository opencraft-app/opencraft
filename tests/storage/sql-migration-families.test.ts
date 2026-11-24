// Several published migration chains in one database (`@opencraft/sql/families`)
// and the WorkspaceHost's families (workspace-host-split §4.1): ledger rules,
// upgrade with data kept, checksum and history refusals, and that the
// WorkspaceHost database is exactly the union of what each Node owner's file
// holds today.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { nodeSqlDatabase, resolveStoreMigrations } from "@opencraft/sqlite-node";
import { applySqlMigrations, hashSqlMigrations, SqlMigrationError } from "@opencraft/sql/migrations";
import { applySqlMigrationFamilies, readSqlMigrationFamilies, type SqlMigrationFamily } from "@opencraft/sql/families";
import {
  WORKSPACE_HOST_SQL_STORES,
  migrateWorkspaceHostSql,
  workspaceHostSqlFamilies,
} from "../../apps/headless-server/src/assembly/workspace-host-sql.ts";

const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");
const memory = () => nodeSqlDatabase(new DatabaseSync(":memory:"));
const family = (id: string, ...sql: string[]): SqlMigrationFamily => ({
  id,
  migrations: hashSqlMigrations(
    sql.map((text, index) => ({ version: index + 1, name: `${id}-${index + 1}`, sql: text })),
    sha256Hex,
  ),
});
const refused = (kind: string) => (error: unknown) => error instanceof SqlMigrationError && error.kind === kind;
const objects = (database: ReturnType<typeof memory>) =>
  database
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT IN ('schema_migrations','schema_family_migrations') ORDER BY type,name",
    )
    .all();

test("families keep their own contiguous versions in one ledger and upgrade keeping data", () => {
  const database = memory();
  const notes = family("notes", "CREATE TABLE notes (id TEXT PRIMARY KEY)", "ALTER TABLE notes ADD COLUMN body TEXT");
  const tags = family("tags", "CREATE TABLE tags (name TEXT PRIMARY KEY)");
  // An older build: only the first note migration.
  assert.deepEqual(
    applySqlMigrationFamilies(database, [{ id: "notes", migrations: notes.migrations.slice(0, 1) }, tags]),
    [
      { id: "notes", applied: 1, version: 1 },
      { id: "tags", applied: 1, version: 1 },
    ],
  );
  database.prepare("INSERT INTO notes(id) VALUES ('kept')").run();
  assert.deepEqual(applySqlMigrationFamilies(database, [notes, tags]), [
    { id: "notes", applied: 1, version: 2 },
    { id: "tags", applied: 0, version: 1 },
  ]);
  assert.deepEqual(
    database
      .prepare("SELECT id, body FROM notes")
      .all()
      .map((row) => ({ ...row })),
    [{ id: "kept", body: null }],
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(readSqlMigrationFamilies(database)).map(([id, rows]) => [id, rows.map((row) => row.version)]),
    ),
    { notes: [1, 2], tags: [1] },
  );
  // Again: nothing to apply.
  assert.deepEqual(
    applySqlMigrationFamilies(database, [notes, tags]).map((outcome) => outcome.applied),
    [0, 0],
  );
});

test("a changed, newer, unknown or foreign history is refused, never adopted", () => {
  const notes = family("notes", "CREATE TABLE notes (id TEXT PRIMARY KEY)");
  const tags = family("tags", "CREATE TABLE tags (name TEXT PRIMARY KEY)");
  const database = memory();
  applySqlMigrationFamilies(database, [notes, tags]);
  // This build does not know the `tags` family: written by a newer build.
  assert.throws(() => applySqlMigrationFamilies(database, [notes]), refused("newer-schema"));
  // A version beyond the declared chain.
  assert.throws(() => applySqlMigrationFamilies(beyondDeclared(), [notes, tags]), refused("newer-schema"));
  // A changed published migration.
  const changed = memory();
  applySqlMigrationFamilies(changed, [notes, tags]);
  changed.prepare("UPDATE schema_family_migrations SET checksum=? WHERE family='notes'").run("0".repeat(64));
  assert.throws(() => applySqlMigrationFamilies(changed, [notes, tags]), refused("history-mismatch"));
  // A single-chain database and objects without any ledger.
  const single = memory();
  applySqlMigrations(single, notes.migrations);
  assert.throws(() => applySqlMigrationFamilies(single, [notes]), refused("history-mismatch"));
  const foreign = memory();
  foreign.exec("CREATE TABLE stray (id TEXT)");
  assert.throws(() => applySqlMigrationFamilies(foreign, [notes]), refused("history-mismatch"));
  // A runtime's own objects are not foreign.
  const runtime = memory();
  runtime.exec("CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB)");
  applySqlMigrationFamilies(runtime, [notes], { ownedByRuntime: (name) => name.startsWith("_cf_") });
  // Two chains creating the same object fail, and the failed migration leaves no ledger row.
  const clash = memory();
  assert.throws(() =>
    applySqlMigrationFamilies(clash, [notes, family("other", "CREATE TABLE notes (id TEXT PRIMARY KEY)")]),
  );
  assert.deepEqual(Object.keys(readSqlMigrationFamilies(clash)), ["notes"]);
  // Ids are unique lowercase names.
  assert.throws(() => applySqlMigrationFamilies(memory(), [notes, notes]), refused("history-mismatch"));
  assert.throws(() => applySqlMigrationFamilies(memory(), [{ ...notes, id: "Notes" }]), refused("history-mismatch"));
});

/** A database whose `notes` ledger claims one version more than this build declares. */
function beyondDeclared() {
  const database = memory();
  applySqlMigrationFamilies(database, [
    family("notes", "CREATE TABLE notes (id TEXT PRIMARY KEY)"),
    family("tags", "CREATE TABLE tags (name TEXT PRIMARY KEY)"),
  ]);
  database
    .prepare("INSERT INTO schema_family_migrations(family,version,name,checksum,applied_at) VALUES('notes',2,'x',?,0)")
    .run("0".repeat(64));
  return database;
}

test("the WorkspaceHost database holds exactly what each Node owner's file holds, under one ledger", () => {
  const database = memory();
  const outcome = migrateWorkspaceHostSql(database);
  const expected = [];
  for (const [id, prefix] of WORKSPACE_HOST_SQL_STORES) {
    // The Node owner's own chain on its own file.
    const file = memory();
    applySqlMigrations(file, hashSqlMigrations(resolveStoreMigrations(id, prefix), sha256Hex));
    expected.push(...objects(file));
  }
  const sort = (rows: Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row)).sort();
  assert.deepEqual(sort(objects(database)), sort(expected), "disjoint chains, identical schema");
  assert.deepEqual(
    outcome.map(({ id, version }) => [id, version]),
    workspaceHostSqlFamilies().map((chain) => [chain.id, chain.migrations.length]),
  );
  assert.ok(outcome.every((value) => value.applied === value.version));
  assert.deepEqual(
    migrateWorkspaceHostSql(database).map((value) => value.applied),
    outcome.map(() => 0),
  );
});
