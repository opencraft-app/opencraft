import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { sqliteTable, text, primaryKey, index } from "drizzle-orm/sqlite-core";
import { openManagedDatabase, resolveMigrationContract, type Migration } from "../../packages/sqlite-node/src/index";
import {
  assertSchemaCurrent,
  compileStore,
  freezeStore,
  readJournal,
  retainTableOptions,
} from "../../scripts/storage-migration-tools.mjs";
import { readOwnerMigrations } from "../../scripts/storage-owner-source.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = join(root, "packages/storage-node/src/stores/provider-retry");
const tag = "0001_adopt_note";
const oldName = "published-retry-note";
// Intentional old spelling/newlines: the executor must hash exactly these bytes.
const oldSql =
  "ALTER TABLE provider_retries ADD COLUMN note TEXT; CREATE INDEX published_note_lookup ON provider_retries(note);";
const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const identity = () => ({ tag, version: 2, name: oldName, checksum: digest(oldSql) });
function schema(marker = false) {
  const provider = sqliteTable(
    "provider_retries",
    {
      thread_id: text("thread_id").notNull(),
      value: text("value").notNull(),
      note: text("note"),
      ...(marker ? { marker: text("marker") } : {}),
    },
    (table) => [primaryKey({ columns: [table.thread_id] }), index("published_note_lookup").on(table.note)],
  );
  return { provider };
}
async function fixture(t: test.TestContext, future = false) {
  const temporary = mkdtempSync(join(tmpdir(), "oc-ledger-adoption-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const directory = join(temporary, "store");
  cpSync(source, directory, { recursive: true });
  const previous = json(join(directory, "migrations/meta/0000_snapshot.json"));
  const next = await generateSQLiteDrizzleJson(schema(), previous.id);
  const generated = await generateSQLiteMigration(previous, next);
  assert.match(generated.join("\n"), /ADD `note` text/);
  assert.match(generated.join("\n"), /CREATE INDEX `published_note_lookup`/);
  const journal = readJournal(join(directory, "migrations"));
  writeFileSync(join(directory, "migrations", tag + ".sql"), oldSql);
  writeJson(join(directory, "migrations/meta/0001_snapshot.json"), next);
  journal.entries.push({ idx: 1, version: "6", when: journal.entries[0].when + 1, tag, breakpoints: true });
  if (future) {
    const last = await generateSQLiteDrizzleJson(schema(true), next.id);
    const sql = (await generateSQLiteMigration(next, last)).join("\n");
    assert.match(sql, /ADD `marker` text/);
    writeFileSync(join(directory, "migrations/0002_future_marker.sql"), sql);
    writeJson(join(directory, "migrations/meta/0002_snapshot.json"), last);
    journal.entries.push({
      idx: 2,
      version: "6",
      when: journal.entries[1].when + 1,
      tag: "0002_future_marker",
      breakpoints: true,
    });
  }
  writeJson(join(directory, "migrations/meta/_journal.json"), journal);
  writeJson(join(directory, "adopted-identities.json"), [identity()]);
  // Check that the declared model matches the generated snapshots too.
  writeFileSync(
    join(directory, "schema.ts"),
    `import { sqliteTable, text, primaryKey, index } from ${JSON.stringify(join(root, "node_modules/drizzle-orm/sqlite-core/index.js"))};
export const provider = sqliteTable('provider_retries', { thread_id: text('thread_id').notNull(), value: text('value').notNull(), note: text('note')${future ? ", marker: text('marker')" : ""} }, table => [primaryKey({columns:[table.thread_id]}), index('published_note_lookup').on(table.note)]);\n`,
  );
  const stores = json(join(root, "packages/storage-node/stores.json"));
  const legacy: Migration[] = await readOwnerMigrations(
    root,
    stores.find((s: { id: string }) => s.id === "provider-retry"),
  );
  assert.equal(legacy.length, 1);
  return { temporary, directory, legacy };
}

test("adoption appends a frozen old ledger identity without changing the frozen baseline", async (t) => {
  const { directory, legacy } = await fixture(t);
  const unchanged = ["baseline.json", "migrations/0000_legacy_baseline.sql", "migrations/meta/0000_snapshot.json"].map(
    (file) => [file, readFileSync(join(directory, file))] as const,
  );
  const publishedBefore = json(join(directory, "published.json"));
  const contract = compileStore(directory);
  assert.deepEqual(contract.migrations, [{ version: 2, name: oldName, sql: oldSql }]);
  assert.deepEqual(
    contract.baseline,
    legacy.map((m) => ({ version: m.version, name: m.name, checksum: digest(m.sql) })),
  );
  assert.throws(() => compileStore(directory, { requirePublished: true }), /Unfrozen migration/);
  freezeStore(directory);
  assert.deepEqual(json(join(directory, "published.json")).slice(0, publishedBefore.length), publishedBefore);
  assert.equal(json(join(directory, "published.json"))[1].ledgerName, oldName);
  assert.equal(json(join(directory, "published.json"))[1].compiledChecksum, digest(oldSql));
  assert.deepEqual(compileStore(directory, { requirePublished: true }), contract);
  for (const [file, bytes] of unchanged) assert.deepEqual(readFileSync(join(directory, file)), bytes);
  await assertSchemaCurrent(directory);
});

for (const existingVersion of [0, 1, 2])
  test(`adopted version and a later generated migration preserve ledger/data from version ${existingVersion}`, async (t) => {
    const { temporary, directory, legacy } = await fixture(t, true);
    freezeStore(directory);
    const complete = resolveMigrationContract(
      "provider-retry",
      legacy,
      compileStore(directory, { requirePublished: true }),
    );
    const original = [...legacy, { version: 2, name: oldName, sql: oldSql }];
    const path = join(temporary, "live.sqlite");
    let prefix: unknown[] = [];
    if (existingVersion) {
      const db = openManagedDatabase({ path, migrations: original.slice(0, existingVersion) }).database;
      try {
        db.prepare("INSERT INTO provider_retries(thread_id,value) VALUES(?,?)").run("thread", "preserved");
        if (existingVersion === 2) db.prepare("UPDATE provider_retries SET note=?").run("old-note");
        prefix = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
      } finally {
        db.close();
      }
    }
    const options = { path, migrations: complete, legacyVersion: legacy.length };
    let opened = openManagedDatabase(options);
    try {
      assert.equal(opened.outcome.status, existingVersion ? "migrated" : "fresh");
      assert.equal(opened.outcome.appliedVersion, 3);
      assert.deepEqual(
        opened.database
          .prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version")
          .all(existingVersion),
        prefix,
      );
      if (existingVersion) {
        assert.deepEqual(
          { ...opened.database.prepare("SELECT * FROM provider_retries").get() },
          { thread_id: "thread", value: "preserved", note: existingVersion === 2 ? "old-note" : null, marker: null },
        );
        const backup = new DatabaseSync(opened.outcome.backupPath!, { readOnly: true });
        try {
          assert.equal(backup.prepare("SELECT value FROM provider_retries").get()?.value, "preserved");
        } finally {
          backup.close();
        }
      }
      assert.deepEqual(
        opened.database
          .prepare("SELECT version,name FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => [row.version, row.name]),
        complete.map((m) => [m.version, m.name]),
      );
    } finally {
      opened.database.close();
    }
    opened = openManagedDatabase(options);
    assert.equal(opened.outcome.status, "up-to-date");
    opened.database.close();
    assert.throws(
      () => openManagedDatabase({ path, migrations: original }),
      (e: unknown) => (e as { kind?: string }).kind === "newer-schema",
    );
    await assertSchemaCurrent(directory);
  });

for (const oldTail of [false, true])
  test(`known unledgered ${oldTail ? "adopted tail" : "baseline"} schema keeps data and uses the same identity`, async (t) => {
    const { temporary, directory, legacy } = await fixture(t);
    freezeStore(directory);
    const complete = resolveMigrationContract(
      "provider-retry",
      legacy,
      compileStore(directory, { requirePublished: true }),
    );
    const path = join(temporary, "legacy.sqlite"),
      old = new DatabaseSync(path);
    for (const migration of oldTail ? complete : legacy) old.exec(migration.sql);
    old.prepare("INSERT INTO provider_retries(thread_id,value) VALUES(?,?)").run("thread", "unledgered-data");
    old.close();
    const opened = openManagedDatabase({ path, migrations: complete, legacyVersion: legacy.length });
    try {
      assert.equal(opened.outcome.status, oldTail ? "adopted" : "migrated");
      assert.equal(opened.database.prepare("SELECT value FROM provider_retries").get()?.value, "unledgered-data");
      assert.equal(opened.database.prepare("SELECT name FROM schema_migrations WHERE version=2").get()?.name, oldName);
    } finally {
      opened.database.close();
    }
  });

test("adoption refuses unknown tags, versions, duplicate maps, malformed names/checksums and ignored fields", async (t) => {
  const { directory } = await fixture(t);
  const invalid = [
    null,
    {},
    [null],
    [{ ...identity(), tag: "0000_legacy_baseline" }],
    [{ ...identity(), tag: "0002_orphan" }],
    [identity(), identity()],
    [{ ...identity(), version: 3 }],
    [{ ...identity(), name: "" }],
    [{ ...identity(), name: " old " }],
    [{ ...identity(), name: "x\n" }],
    [{ ...identity(), name: "x".repeat(129) }],
    [{ ...identity(), name: tag }],
    [{ ...identity(), checksum: "bad" }],
    [{ ...identity(), checksum: "0".repeat(64) }],
    [{ ...identity(), unexpected: true }],
  ];
  for (const entries of invalid) {
    writeJson(join(directory, "adopted-identities.json"), entries);
    assert.throws(() => compileStore(directory), /Invalid adopted migration identit|Adopted migration SQL differs/);
    assert.throws(() => freezeStore(directory), /Invalid adopted migration identit|Adopted migration SQL differs/);
  }
});

test("frozen adoption cannot rename, rewrite, remove or silently normalize a published identity", async (t) => {
  const { directory, temporary } = await fixture(t);
  freezeStore(directory);
  const mutations = [
    (d: string) => writeJson(join(d, "adopted-identities.json"), [{ ...identity(), name: "renamed-ledger" }]),
    (d: string) => writeJson(join(d, "adopted-identities.json"), []),
    (d: string) => rmSync(join(d, "adopted-identities.json")),
    (d: string) => writeFileSync(join(d, "migrations", tag + ".sql"), oldSql + "\n"),
    (d: string) => {
      writeFileSync(join(d, "migrations", tag + ".sql"), oldSql + "\n");
      writeJson(join(d, "adopted-identities.json"), [{ ...identity(), checksum: digest(oldSql + "\n") }]);
    },
    (d: string) => {
      const p = join(d, "migrations/meta/0001_snapshot.json");
      writeFileSync(p, readFileSync(p, "utf8") + "\n");
    },
    (d: string) => {
      const p = join(d, "migrations/meta/_journal.json");
      const journal = json(p);
      journal.entries[1].when++;
      writeJson(p, journal);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const copy = join(temporary, String(index));
    cpSync(directory, copy, { recursive: true });
    mutate(copy);
    assert.throws(() => compileStore(copy), /Published migration changed|Adopted migration SQL differs/);
    assert.throws(() => freezeStore(copy), /Published migration changed|Adopted migration SQL differs/);
  }
});

test("ledger SQL/name/checksum tampering is still refused by the unchanged runtime", async (t) => {
  const { directory, temporary, legacy } = await fixture(t);
  freezeStore(directory);
  const complete = resolveMigrationContract("provider-retry", legacy, compileStore(directory));
  for (const field of ["name", "checksum"]) {
    const path = join(temporary, field + ".sqlite");
    const db = openManagedDatabase({ path, migrations: complete }).database;
    db.prepare(`UPDATE schema_migrations SET ${field}=? WHERE version=2`).run("tampered");
    db.close();
    assert.throws(
      () => openManagedDatabase({ path, migrations: complete }),
      (e: unknown) => (e as { kind?: string }).kind === "history-mismatch",
    );
  }
  const path = join(temporary, "renamed.sqlite");
  openManagedDatabase({ path, migrations: complete }).database.close();
  assert.throws(
    () => openManagedDatabase({ path, migrations: [legacy[0]!, { ...complete[1]!, name: tag }] }),
    (e: unknown) => (e as { kind?: string }).kind === "history-mismatch",
  );
});

test("adopted SQL cannot disable transactional or STRICT protections even with a matching source checksum", async (t) => {
  const { directory } = await fixture(t);
  for (const sql of [
    oldSql + " PRAGMA foreign_keys=OFF;",
    oldSql + " PRAGMA journal_mode=WAL;",
    oldSql + " DROP INDEX legacy_unique_note;",
    oldSql + " CREATE TABLE extra_note (id TEXT);",
  ]) {
    writeFileSync(join(directory, "migrations", tag + ".sql"), sql);
    writeJson(join(directory, "adopted-identities.json"), [{ ...identity(), checksum: digest(sql) }]);
    assert.throws(() => compileStore(directory), /transactional|UNIQUE constraint|Adopted migration SQL differs/);
    assert.throws(() => freezeStore(directory), /transactional|UNIQUE constraint|Adopted migration SQL differs/);
  }
});

test("table-option retention preserves already-STRICT SQL and cannot consume the following index", () => {
  const sql =
    "CREATE TABLE exact (id TEXT PRIMARY KEY, state TEXT CHECK(state IN ('queued','closed'))) STRICT;\nCREATE INDEX exact_state ON exact(state);\nCREATE TABLE second (id INTEGER PRIMARY KEY) STRICT;";
  assert.equal(retainTableOptions(sql, {}), sql);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(retainTableOptions(sql, {}));
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='exact_state'").get()?.n,
      1,
    );
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='second'").get()?.strict, 1);
  } finally {
    db.close();
  }
});

test("DDL option retention respects strings, comments, identifier quoting and existing WITHOUT ROWID", () => {
  const prefix =
    "-- CREATE TABLE ignored (id TEXT);\nSELECT 'CREATE TABLE quoted (id TEXT);';\n/* CREATE TABLE comment (id TEXT); */\n";
  const sql =
    prefix +
    "CREATE TABLE [first] (id TEXT PRIMARY KEY, body TEXT CHECK(body != ');')) /* ); CREATE TABLE not_a_table(x); */;\nCREATE TABLE `__new_second` (id INTEGER PRIMARY KEY) WITHOUT ROWID;";
  const result = retainTableOptions(sql, {
    first: { strict: true, withoutRowid: true },
    second: { strict: true, withoutRowid: true },
  });
  assert.ok(result.startsWith(prefix));
  assert.match(result, /\) STRICT, WITHOUT ROWID \/\* \); CREATE TABLE/);
  assert.match(result, /WITHOUT ROWID, STRICT;/);
  assert.equal(
    retainTableOptions(result, {
      first: { strict: true, withoutRowid: true },
      second: { strict: true, withoutRowid: true },
    }),
    result,
  );
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(result);
    for (const name of ["first", "__new_second"]) {
      const row = db.prepare("SELECT strict, wr FROM pragma_table_list WHERE name=?").get(name);
      assert.equal(row?.strict, 1);
      assert.equal(row?.wr, 1);
    }
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('ignored','quoted','comment','not_a_table')")
        .get()?.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("schema checks compose declared extension sources without dropping tables or accepting duplicate owners", async (t) => {
  const { directory, temporary } = await fixture(t);
  const previous = json(join(directory, "migrations/meta/0001_snapshot.json"));
  const extensionNotes = sqliteTable("extension_notes", {
    id: text("id").primaryKey(),
    body: text("body").notNull(),
  });
  const next = await generateSQLiteDrizzleJson({ ...schema(), extensionNotes }, previous.id);
  const sql = (await generateSQLiteMigration(previous, next)).join("\n");
  assert.match(sql, /CREATE TABLE `extension_notes`/);
  assert.doesNotMatch(sql, /DROP|ALTER/);
  const journal = readJournal(join(directory, "migrations"));
  journal.entries.push({
    idx: 2,
    version: "6",
    when: journal.entries[1].when + 1,
    tag: "0002_extension_notes",
    breakpoints: true,
  });
  writeFileSync(join(directory, "migrations/0002_extension_notes.sql"), sql);
  writeJson(join(directory, "migrations/meta/0002_snapshot.json"), next);
  writeJson(join(directory, "migrations/meta/_journal.json"), journal);
  freezeStore(directory);
  const core = join(directory, "schema.ts"),
    extension = join(temporary, "extension-schema.ts");
  writeFileSync(
    extension,
    `import {sqliteTable,text} from ${JSON.stringify(join(root, "node_modules/drizzle-orm/sqlite-core/index.js"))};\nexport const extensionNotes=sqliteTable('extension_notes',{id:text('id').primaryKey(),body:text('body').notNull()});\n`,
  );
  await assert.rejects(assertSchemaCurrent(directory), /Ungenerated schema changes/);
  await assertSchemaCurrent(directory, { schemaFiles: [core, extension] });
  await assert.rejects(assertSchemaCurrent(directory, { schemaFiles: [] }), /concrete source files/);
  await assert.rejects(assertSchemaCurrent(directory, { schemaFiles: [core, core] }), /Duplicate schema source/);
  const duplicate = join(temporary, "duplicate-schema.ts");
  writeFileSync(duplicate, `export {provider} from ${JSON.stringify(core)};\n`);
  await assert.rejects(
    assertSchemaCurrent(directory, { schemaFiles: [core, duplicate] }),
    /Duplicate schema export: provider/,
  );
  writeFileSync(duplicate, `export {provider as anotherOwner} from ${JSON.stringify(core)};\n`);
  await assert.rejects(
    assertSchemaCurrent(directory, { schemaFiles: [core, duplicate] }),
    /Duplicate schema table owner: provider_retries/,
  );
});
