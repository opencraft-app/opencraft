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
import { createBridgeInboxStore, createWorkspaceBridgeInboxStore } from "@opencraft/agent-bridge-host/inbox-store";
import { applySqlMigrations, hashSqlMigrations, SqlMigrationError } from "@opencraft/sql/migrations";
import {
  applySqlMigrationFamilies as applyFamilies,
  MIGRATION_FAMILY_LEDGER_TABLE,
  sqlMigrationFamilyRows,
  type SqlMigrationFamily,
  type SqlMigrationFamilyOptions,
} from "@opencraft/sql/families";
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
/** The WorkspaceHost composition: families only, the Durable Object ledger. */
const FAMILIES = { table: MIGRATION_FAMILY_LEDGER_TABLE, composition: "families" } as const;
const applySqlMigrationFamilies = (
  database: Parameters<typeof applyFamilies>[0],
  families: readonly SqlMigrationFamily[],
  options: Partial<SqlMigrationFamilyOptions> = {},
) => applyFamilies(database, families, { ...FAMILIES, ...options });
const readSqlMigrationFamilies = (database: Parameters<typeof applyFamilies>[0]) =>
  sqlMigrationFamilyRows(database, MIGRATION_FAMILY_LEDGER_TABLE);
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
      { id: "notes", status: "fresh", applied: 1, version: 1 },
      { id: "tags", status: "fresh", applied: 1, version: 1 },
    ],
  );
  database.prepare("INSERT INTO notes(id) VALUES ('kept')").run();
  assert.deepEqual(applySqlMigrationFamilies(database, [notes, tags]), [
    { id: "notes", status: "migrated", applied: 1, version: 2 },
    { id: "tags", status: "up-to-date", applied: 0, version: 1 },
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
  const inbox = workspaceHostSqlFamilies().find(({ id }) => id === "workspace-bridge-inbox")!;
  const standaloneInbox = memory();
  applySqlMigrations(standaloneInbox, inbox.migrations);
  expected.push(...objects(standaloneInbox));
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

test("WorkspaceHost upgrades to the Bridge inbox without rewriting existing data and refuses its altered migration", () => {
  const database = memory();
  const previous = workspaceHostSqlFamilies().filter(({ id }) => id !== "workspace-bridge-inbox");
  applySqlMigrationFamilies(database, previous);
  database.prepare("INSERT INTO opencraft_thread_catalog (thread_id,metadata_json,updated_at,archived,observed_at_ms,revision) VALUES ('kept','{}',12,0,13,1)").run();
  const before = readSqlMigrationFamilies(database);
  assert.deepEqual(migrateWorkspaceHostSql(database).at(-1), { id: "workspace-bridge-inbox", status: "fresh", applied: 2, version: 2 });
  const { "workspace-bridge-inbox": bridge, ...after } = readSqlMigrationFamilies(database);
  assert.deepEqual(after, before);
  assert.equal(database.prepare("SELECT thread_id FROM opencraft_thread_catalog").get()?.thread_id, "kept");
  assert.equal(bridge?.length, 2);
  database.prepare("UPDATE schema_family_migrations SET checksum=? WHERE family='workspace-bridge-inbox' AND version=1").run("0".repeat(64));
  assert.throws(() => migrateWorkspaceHostSql(database), refused("history-mismatch"));
});

test("the Bridge placement migration preserves the original inbox and only a verified restore may archive its suffix", () => {
  const database = memory();
  const inbox = workspaceHostSqlFamilies().find(({ id }) => id === "workspace-bridge-inbox")!;
  applySqlMigrationFamilies(database, [{ ...inbox, migrations: inbox.migrations.slice(0, 1) }]);
  const producer = { outboxId: "a".repeat(32), acknowledged: 0, high: 2 };
  const event = { route: '["server","thread"]', generation: "g1", payload: { method: "fixture-event" } };
  const legacy = createBridgeInboxStore(database, "workspace");
  const events = [{ ...event, seq: 1 }, { ...event, seq: 2 }];
  legacy.apply(events, producer);
  assert.deepEqual(applySqlMigrationFamilies(database, [inbox]), [{ id: inbox.id, status: "migrated", applied: 1, version: 2 }]);

  const store = createWorkspaceBridgeInboxStore(database);
  store.adoptPlacement("container-1");
  assert.deepEqual(store.read(), legacy.read());
  assert.equal(store.cursor(), 2);
  const restored = { ...producer, acknowledged: 1, high: 1 };
  assert.throws(() => store.apply("container-1", "snapshot", 1, [], restored), /outside the producer/u);
  assert.throws(() => store.apply("container-2", undefined, 1, [], restored), /outside the producer/u);
  assert.throws(() => store.apply("container-2", "snapshot", 1, [], { ...restored, high: 2 }), /batch does not match/u);
  assert.equal(store.cursor(), 2);
  assert.equal(store.placement(), "container-1");
  assert.deepEqual(database.prepare("SELECT seq FROM bridge_inbox_archive").all(), []);

  assert.deepEqual(store.apply("container-2", "snapshot", 1, [], restored), { cursor: 1, inserted: [] });
  assert.equal(store.placement(), "container-2");
  assert.deepEqual(store.read().map(row => row.seq), [1]);
  assert.deepEqual(database.prepare("SELECT placement,seq,payload FROM bridge_inbox_archive").all().map(row => ({ ...row })),
    [{ placement: "container-1", seq: 2, payload: JSON.stringify(event.payload) }]);
});
