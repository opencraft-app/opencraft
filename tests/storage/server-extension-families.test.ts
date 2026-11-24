import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { openManagedDatabase, SqliteLifecycleError, type Migration } from "@opencraft/sqlite-node";
import {
  createServerMigrationComposition,
  createServerMigrationRegistry,
  DEFAULT_SERVER_MIGRATION_COMPOSITION as base,
} from "../../packages/storage-node/src/server/migration-composition.js";
import {
  coreSchemaValidator,
  EXTENSION_LEDGER_SQL,
  EXTENSION_LEDGER_TABLE,
  readFamilyLedger,
  verifyExtensionFamilies,
} from "../../packages/storage-node/src/server/extension-families.js";
import { migrationFamilyLedgerSql } from "@opencraft/sql/families";
import {
  composition,
  family,
  FAMILY_ID,
  LATER_CORE,
  PRIVATE_LINEAGE_ID,
  privateLineage,
  type CompositionName,
} from "./fixtures/server-extension-compositions.js";

const runner = fileURLToPath(new URL("./fixtures/server-extension-open.ts", import.meta.url));
const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");
const identities = (chain: readonly Migration[]) =>
  chain.map((m) => ({ version: m.version, name: m.name, checksum: digest(m.sql) }));
type Opened = {
  ok?: { outcome: { status: string; appliedVersion: number; backupPath?: string }; contract: { hash: string } };
  error?: { kind: string; message: string };
};

function open(name: CompositionName, directory: string): Opened {
  const child = spawnSync(process.execPath, ["--import", "tsx", runner, name, directory], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Opened;
}
function opened(name: CompositionName, directory: string) {
  const result = open(name, directory);
  assert.ok(result.ok, JSON.stringify(result.error));
  return result.ok;
}
async function installation(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "server-families-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "opencraft-server.sqlite") };
}
function read<T>(path: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return action(db);
  } finally {
    db.close();
  }
}
const coreLedger = (db: DatabaseSync) =>
  db.prepare("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version").all();
const familyLedger = (db: DatabaseSync) =>
  db
    .prepare("SELECT family,version,name,checksum FROM schema_extension_migrations ORDER BY family,version")
    .all()
    .map((row) => ({ ...row }));
const plain = (rows: readonly object[]) => rows.map((row) => ({ ...row }));
const expectedFamilyLedger = (count = 2) =>
  identities(family(count).migrations).map((m) => ({ family: FAMILY_ID, ...m }));
function write(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
/** Both ledgers and the strict structure of core plus the family. */
function assertCurrent(path: string, core: readonly Migration[] = base.canonical, familyCount = 2) {
  read(path, (db) => {
    assert.deepEqual(
      plain(coreLedger(db)).map(({ applied_at: _, ...row }) => row),
      identities(core),
    );
    assert.deepEqual(familyLedger(db), expectedFamilyLedger(familyCount));
    coreSchemaValidator(composition("extension"), core)(db);
  });
}

test("fresh install records core and the family in separate ledgers without renumbering core", async (t) => {
  const { directory, path } = await installation(t);
  const first = opened("extension", directory);
  assert.equal(first.outcome.status, "fresh");
  assert.equal(first.outcome.appliedVersion, base.canonical.length);
  assert.notEqual(first.contract.hash, base.contract.hash, "the family is part of the installation contract");
  assertCurrent(path);
  write(
    path,
    "INSERT INTO fixture_sync_requests VALUES('m1','c1','kept'); INSERT INTO fixture_sync_groups VALUES('s1','c1','{}')",
  );
  const again = opened("extension", directory);
  assert.equal(again.outcome.status, "up-to-date");
  assert.equal(again.outcome.backupPath, undefined);
  read(path, (db) =>
    assert.equal(db.prepare("SELECT reason FROM fixture_sync_requests WHERE message_id='m1'").get()!.reason, "kept"),
  );
});

test("a core-only installation gains the family after core, keeping core rows and data", async (t) => {
  const { directory, path } = await installation(t);
  assert.equal(opened("core", directory).outcome.status, "fresh");
  write(path, "INSERT INTO access_audit VALUES(1,1,'fixture','binding','action')");
  const before = read(path, coreLedger);
  assert.equal(
    read(path, (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_extension_migrations'").get()),
    undefined,
  );
  const upgraded = opened("extension", directory);
  assert.equal(upgraded.outcome.status, "migrated");
  assert.ok(
    upgraded.outcome.backupPath && existsSync(upgraded.outcome.backupPath),
    "a recovery point precedes the family steps",
  );
  assert.deepEqual(read(path, coreLedger), before, "core rows, names and timestamps are untouched");
  assertCurrent(path);
  read(path, (db) => assert.equal(db.prepare("SELECT count(*) n FROM access_audit").get()!.n, 1));
});

test("a family upgrade from its previous version preserves the family's rows", async (t) => {
  const { directory, path } = await installation(t);
  opened("extension-v1", directory);
  assertCurrent(path, base.canonical, 1);
  write(path, "INSERT INTO fixture_sync_requests VALUES('m1','c1','kept')");
  const upgraded = opened("extension", directory);
  assert.equal(upgraded.outcome.status, "migrated");
  assert.ok(upgraded.outcome.backupPath);
  assertCurrent(path);
  read(path, (db) =>
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM fixture_sync_requests").get() },
      { message_id: "m1", channel_id: "c1", reason: "kept" },
    ),
  );
});

/** Seeds a database on the private linear lineage, with distinct timestamps and rows. */
function seedPrivate(path: string, count: number) {
  const seeded = openManagedDatabase({
    path,
    migrations: privateLineage.migrations.slice(0, count),
    legacyPolicy: "reject",
  });
  try {
    seeded.database.exec("UPDATE schema_migrations SET applied_at=1000+version");
    seeded.database.exec("INSERT INTO access_audit VALUES(1,1,'fixture','binding','action')");
    if (count >= 9)
      seeded.database.exec("INSERT INTO thread_access VALUES('server','thread','fixture-owner','private',7,1)");
    if (count >= 14) seeded.database.exec("INSERT INTO fixture_sync_requests VALUES('m1','c1','product row')");
    if (count >= 21)
      seeded.database.exec(
        "INSERT INTO collaboration_spaces(id,name,owner_actor_id,created_at) VALUES('space','Retained space','synthetic-owner',1)",
      );
    return coreLedger(seeded.database);
  } finally {
    seeded.database.close();
  }
}

for (const count of [privateLineage.migrations.length, 15])
  test(`a private interleaved lineage at step ${count} is completed and adopted into the core and family ledgers`, async (t) => {
    const { directory, path } = await installation(t);
    const original = plain(seedPrivate(path, count));
    const result = opened("extension", directory);
    assert.equal(result.outcome.status, count === privateLineage.migrations.length ? "adopted" : "migrated");
    assert.ok(result.outcome.backupPath && existsSync(result.outcome.backupPath));
    assertCurrent(path);
    read(path, (db) => {
      // Each adopted identity keeps the timestamp of the published step that applied it.
      const appliedAt = new Map(plain(coreLedger(db)).map((row) => [row.version, row.applied_at]));
      if (count === privateLineage.migrations.length) {
        assert.equal(appliedAt.get(5), 1021);
        assert.equal(appliedAt.get(21), 1023);
        assert.equal(appliedAt.get(22), 1023);
        assert.equal(appliedAt.get(15), 1016);
      }
      const receipt = db.prepare("SELECT lineage,ledger FROM schema_migration_adoptions").all();
      assert.equal(receipt.length, 1);
      assert.equal(receipt[0]!.lineage, PRIVATE_LINEAGE_ID);
      const ledger = JSON.parse(String(receipt[0]!.ledger)) as object[];
      assert.equal(ledger.length, privateLineage.migrations.length);
      assert.deepEqual(ledger.slice(0, count), original, "the original linear rows are kept as the adoption receipt");
      assert.equal(db.prepare("SELECT count(*) n FROM access_audit").get()!.n, 1);
      assert.equal(
        db.prepare("SELECT access_mode FROM thread_access WHERE thread_id='thread'").get()!.access_mode,
        "private",
      );
      assert.equal(
        db.prepare("SELECT reason FROM fixture_sync_requests WHERE message_id='m1'").get()!.reason,
        "product row",
      );
      if (count === privateLineage.migrations.length)
        assert.equal(
          db.prepare("SELECT name FROM collaboration_spaces WHERE id='space'").get()!.name,
          "Retained space",
        );
    });
    const before = read(path, (db) => ({ core: coreLedger(db), family: familyLedger(db) }));
    assert.equal(opened("extension", directory).outcome.status, "up-to-date", "adoption is not repeated");
    assert.deepEqual(
      read(path, (db) => ({ core: coreLedger(db), family: familyLedger(db) })),
      before,
    );
  });

test("a lineage prefix equal to a canonical prefix stays on core and is not adopted", async (t) => {
  const { directory, path } = await installation(t);
  const original = seedPrivate(path, 2);
  assert.deepEqual(
    plain(original).map(({ applied_at: _, ...row }) => row),
    identities(base.canonical.slice(0, 2)),
  );
  assert.equal(opened("extension", directory).outcome.status, "migrated");
  assertCurrent(path);
  read(path, (db) => {
    assert.deepEqual(coreLedger(db).slice(0, 2), original);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration_adoptions'").get(), undefined);
  });
});

test("a later core migration appends after adoption with its own number", async (t) => {
  const { directory, path } = await installation(t);
  seedPrivate(path, privateLineage.migrations.length);
  opened("extension", directory);
  const family = read(path, familyLedger);
  const later = opened("extension-later-core", directory);
  assert.equal(later.outcome.status, "migrated");
  assert.equal(later.outcome.appliedVersion, LATER_CORE.version);
  assertCurrent(path, [...base.canonical, LATER_CORE]);
  read(path, (db) => {
    assert.deepEqual(
      { ...db.prepare("SELECT version,name FROM schema_migrations WHERE version=?").get(LATER_CORE.version) },
      { version: LATER_CORE.version, name: LATER_CORE.name },
    );
    assert.deepEqual(familyLedger(db), family, "family versions do not move when core grows");
  });
});

for (const damage of ["family-checksum", "lineage-checksum", "lineage-structure", "family-newer"] as const)
  test(`${damage} refuses to open and changes nothing`, async (t) => {
    const { directory, path } = await installation(t);
    if (damage === "lineage-checksum" || damage === "lineage-structure") {
      seedPrivate(path, privateLineage.migrations.length);
      write(
        path,
        damage === "lineage-checksum"
          ? "UPDATE schema_migrations SET checksum='" + "0".repeat(64) + "' WHERE version=14"
          : "ALTER TABLE access_audit ADD COLUMN fixture_drift TEXT",
      );
    } else {
      opened("extension", directory);
      write(
        path,
        damage === "family-checksum"
          ? "UPDATE schema_extension_migrations SET checksum='" + "0".repeat(64) + "' WHERE version=2"
          : `INSERT INTO schema_extension_migrations VALUES('${FAMILY_ID}',3,'future','${"0".repeat(64)}',1)`,
      );
    }
    const snapshot = () =>
      read(path, (db) =>
        db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all().concat(coreLedger(db)),
      );
    const before = snapshot();
    const result = open("extension", directory);
    assert.equal(
      result.error?.kind,
      damage === "family-newer" ? "newer-schema" : "history-mismatch",
      JSON.stringify(result),
    );
    assert.deepEqual(snapshot(), before);
  });

test("an unknown family, or a family the running build does not declare, refuses to open", async (t) => {
  const { directory, path } = await installation(t);
  opened("extension", directory);
  write(path, `INSERT INTO schema_extension_migrations VALUES('other-product',1,'0000_other','${"0".repeat(64)}',1)`);
  const unknown = open("extension", directory);
  assert.equal(unknown.error?.kind, "history-mismatch");
  assert.match(unknown.error!.message, /Unknown Server extension family/);
  write(path, "DELETE FROM schema_extension_migrations WHERE family='other-product'");
  const coreOnly = open("core", directory);
  assert.equal(coreOnly.error?.kind, "history-mismatch", "a core-only build never ignores product objects");
  assert.equal(opened("extension", directory).outcome.status, "up-to-date");
});

test("a family that changes a core-owned table is refused before the installation is touched", async (t) => {
  const { directory } = await installation(t);
  const target = join(directory, "never-created");
  const result = open("touches-core", target);
  assert.equal(result.error?.kind, "migration-failed", JSON.stringify(result));
  assert.equal(existsSync(target), false);
  for (const sql of [
    "INSERT INTO actors(id) VALUES('x')",
    "UPDATE access_audit SET action='x'",
    "DELETE FROM access_audit",
    "CREATE INDEX fixture_sync_on_core ON access_audit(id)",
    "DROP TABLE access_audit",
    "CREATE TABLE other_table(id INTEGER) STRICT",
    "CREATE TABLE fixture_sync_x(id INTEGER) STRICT; CREATE TRIGGER fixture_sync_t AFTER INSERT ON fixture_sync_x BEGIN DELETE FROM access_audit; END",
    "CREATE VIEW fixture_sync_v AS SELECT 1",
    "PRAGMA foreign_keys=OFF",
    "ATTACH DATABASE ':memory:' AS other",
  ]) {
    const bad = createServerMigrationComposition({
      canonical: base.canonical,
      alternates: [],
      extensions: [{ id: "bad", objectPrefix: "fixture_sync_", migrations: [{ version: 1, name: "bad", sql }] }],
      productVersion: "fixture",
    });
    assert.throws(
      () => verifyExtensionFamilies(bad),
      (error: any) => ["migration-failed", "history-mismatch"].includes(error.kind),
      sql,
    );
  }
  verifyExtensionFamilies(composition("extension"));
});

test("composition rejects families and adoption maps that cannot be proven safe", () => {
  const ok = { canonical: base.canonical, alternates: [], productVersion: "fixture" };
  const lineage = (adopts: { family: string; version: number }[][]) => ({
    ...ok,
    extensions: [family()],
    alternates: [{ id: "lineage", migrations: privateLineage.migrations.slice(0, adopts.length), adopts }],
  });
  for (const [label, input] of [
    ["core id", { ...ok, extensions: [{ ...family(), id: "core" }] }],
    ["sqlite prefix", { ...ok, extensions: [{ ...family(), objectPrefix: "sqlite_x_" }] }],
    ["unterminated prefix", { ...ok, extensions: [{ ...family(), objectPrefix: "fixture" }] }],
    ["overlapping prefixes", { ...ok, extensions: [family(), { ...family(), id: "other", objectPrefix: "fixture_" }] }],
    ["duplicate family", { ...ok, extensions: [family(), { ...family(), objectPrefix: "other_" }] }],
    [
      "map length",
      { ...ok, extensions: [family()], alternates: [{ ...privateLineage, adopts: privateLineage.adopts.slice(1) }] },
    ],
    ["SQL differs from its identity", lineage([[{ family: "core", version: 1 }], [{ family: "core", version: 3 }]])],
    [
      "gap in core",
      lineage([[{ family: "core", version: 1 }], [{ family: "core", version: 2 }], [{ family: "core", version: 7 }]]),
    ],
    ["repeated identity", lineage([[{ family: "core", version: 1 }], [{ family: "core", version: 1 }]])],
    ["undeclared family", lineage([[{ family: "core", version: 1 }], [{ family: "missing", version: 1 }]])],
    [
      "merged across families",
      {
        ...ok,
        extensions: [family()],
        alternates: [
          {
            id: "x",
            migrations: [{ version: 1, name: "x", sql: "SELECT 1" }],
            adopts: [
              [
                { family: "core", version: 1 },
                { family: FAMILY_ID, version: 1 },
              ],
            ],
          },
        ],
      },
    ],
  ] as const)
    assert.throws(() => createServerMigrationComposition(input as never), Error, label);
  assert.ok(composition("extension").alternates.find((entry) => entry.id === PRIVATE_LINEAGE_ID)?.adopts);
});

test("a composition with families survives the Worker handoff with the same contract", () => {
  const selected = composition("extension");
  const registry = createServerMigrationRegistry(base);
  registry.install(structuredClone(selected));
  assert.equal(registry.current().contract.hash, selected.contract.hash);
  assert.deepEqual(registry.current().extensions, selected.extensions);
  const single = composition("extension-v1");
  assert.throws(
    () => createServerMigrationRegistry(base).install({ ...structuredClone(single), extensions: [] }),
    /hash mismatch/,
  );
});

test("the family ledger is the shared migration-family primitive under the published table; rows and refusals unchanged", async (t) => {
  // The published definition, byte for byte: existing installations keep their table.
  assert.equal(
    EXTENSION_LEDGER_SQL,
    "CREATE TABLE IF NOT EXISTS schema_extension_migrations (family TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (family, version)) STRICT",
  );
  assert.equal(EXTENSION_LEDGER_SQL, migrationFamilyLedgerSql(EXTENSION_LEDGER_TABLE));
  const { directory, path } = await installation(t);
  opened("extension", directory);
  const rows = read(path, (db) =>
    plain(db.prepare("SELECT * FROM schema_extension_migrations ORDER BY family,version").all()),
  );
  const ledger = () => read(path, (db) => readFamilyLedger(db, composition("extension")));
  const refusal = (kind: string, message: string) => (error: unknown) =>
    error instanceof SqliteLifecycleError && error.kind === kind && error.message === message;
  assert.equal(ledger().get(FAMILY_ID), 2);
  // A changed checksum and a version beyond the build: the Server's own kinds and messages.
  write(path, `UPDATE schema_extension_migrations SET checksum='${"0".repeat(64)}' WHERE version=2`);
  assert.throws(
    ledger,
    refusal("history-mismatch", `Server extension family ${FAMILY_ID} ledger does not match its published migrations`),
  );
  write(path, `UPDATE schema_extension_migrations SET checksum='${String(rows[1]!.checksum)}' WHERE version=2`);
  write(path, `INSERT INTO schema_extension_migrations VALUES('${FAMILY_ID}',3,'later','${"0".repeat(64)}',1)`);
  assert.throws(ledger, refusal("newer-schema", `Unsupported newer Server extension family history: ${FAMILY_ID}`));
  write(path, "DELETE FROM schema_extension_migrations WHERE version=3");
  // Existing rows written before the delegation stay exactly as they were, and the installation opens.
  assert.deepEqual(
    read(path, (db) => plain(db.prepare("SELECT * FROM schema_extension_migrations ORDER BY family,version").all())),
    rows,
  );
  assert.equal(opened("extension", directory).outcome.status, "up-to-date");
});
