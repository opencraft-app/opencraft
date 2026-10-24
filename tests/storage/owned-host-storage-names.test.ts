import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database";
import { OpenCraftMessageAttachments, OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-message-attachments";

const owners = [
  {
    name: "Host state", file: "codex-host-queue.sqlite", previousVersion: 12,
    migrations: OPENCRAFT_HOST_STATE_MIGRATIONS,
    open: (root: string) => new OpenCraftHostStateDatabase(root),
    tables: ["codex_host_queue", "codex_thread_catalog", "codex_catalog_sync", "codex_bot_rooms", "codex_bot_commands", "codex_bot_message_slots"],
    seed: (db: DatabaseSync) => db.exec(`
      INSERT INTO codex_host_queue VALUES('q','t','m','[]',7,1,2,'unknown','turn','unconfirmed');
      INSERT INTO codex_thread_catalog VALUES('t','{"id":"t","cwd":"/retained"}',12,0,13,14,0);
      INSERT INTO codex_catalog_sync VALUES(0,10,11,12,'ready');
      INSERT INTO message_senders VALUES('t','m','{"kind":"employee","loginName":"retained"}',1);
      INSERT INTO codex_bot_rooms VALUES('room',1,'/retained',0,'t');
      INSERT INTO codex_bot_commands VALUES('command','fingerprint','{"accepted":true}');
      INSERT INTO codex_bot_message_slots VALUES('room','turn','agentMessage',0,'native-item');
    `),
  },
  {
    name: "Message attachments", file: "codex-message-attachments.sqlite", previousVersion: 1,
    migrations: OPENCRAFT_MESSAGE_ATTACHMENTS_MIGRATIONS,
    open: (root: string) => new OpenCraftMessageAttachments(root),
    tables: ["codex_message_attachments"],
    seed: (db: DatabaseSync) => db.prepare("INSERT INTO codex_message_attachments VALUES(?,?,?,?,?)")
      .run("t", "m", "a", 3, '{"id":"a","name":"retained.pdf","mimeType":"application/pdf","size":12,"location":{"kind":"host-file","path":"/retained.pdf"}}'),
  },
] as const;

const snapshot = (db: DatabaseSync, tables: readonly string[]) => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
const history = (db: DatabaseSync) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const renamed = (tables: readonly string[]) => tables.map(table => table.replace(/^codex_/, "opencraft_"));

for (const spec of owners) {
  for (const ledgered of [true, false]) test(`${spec.name}: previous ${ledgered ? "ledgered" : "unledgered"} data survives the owned-name migration`, async t => {
    const root = await mkdtemp(join(tmpdir(), "owned-storage-upgrade-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, spec.file);
    const { database: old } = openManagedDatabase({ path, migrations: spec.migrations.slice(0, spec.previousVersion) });
    spec.seed(old);
    const tables = old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
    const before = snapshot(old, tables), ledger = history(old);
    if (!ledgered) old.exec("DROP TABLE schema_migrations");
    old.close();

    const owner = spec.open(root);
    const outcome = owner.outcome;
    assert.equal(outcome.status, "migrated");
    assert.equal(outcome.appliedVersion, spec.migrations.at(-1)!.version);
    assert.deepEqual(outcome.movedAsidePaths, []);
    assert.ok(outcome.backupPath);
    owner.close();
    const read = new DatabaseSync(path, { readOnly: true });
    const currentTables = tables.map(table => spec.tables.some(name => name === table) ? table.replace(/^codex_/, "opencraft_") : table);
    assert.deepEqual(snapshot(read, currentTables), before, "all business rows survive, including preserved Bot and sender tables");
    if (ledgered) assert.deepEqual(history(read).slice(0, spec.previousVersion), ledger, "previous checksums and timestamps are immutable");
    else assert.deepEqual(history(read).slice(0, spec.previousVersion).map(({ applied_at, ...row }) => row), ledger.map(({ applied_at, ...row }) => row));
    for (const table of spec.tables) assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), undefined);
    assert.equal(read.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    assert.ok(read.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().every(row => !spec.tables.some(table => String(row.name).startsWith(table + "_"))));
    read.close();

    const backup = new DatabaseSync(outcome.backupPath!, { readOnly: true });
    assert.deepEqual(snapshot(backup, tables), before, "pre-upgrade backup retains the actual old schema and rows");
    backup.close();
    const reopened = spec.open(root);
    assert.equal(reopened.outcome.status, "up-to-date"); reopened.close();
    assert.throws(() => openManagedDatabase({ path, migrations: spec.migrations.slice(0, spec.previousVersion) }),
      e => e instanceof SqliteLifecycleError && e.kind === "newer-schema", "older readers refuse upgraded data instead of creating another queue");
  });

  test(`${spec.name}: failed rename rolls back schema, rows and ledger, then retries safely`, async t => {
    const root = await mkdtemp(join(tmpdir(), "owned-storage-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, spec.file);
    const { database: old } = openManagedDatabase({ path, migrations: spec.migrations.slice(0, spec.previousVersion) });
    spec.seed(old);
    const before = snapshot(old, spec.tables), ledger = history(old); old.close();
    const exec = DatabaseSync.prototype.exec;
    const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("\nALTER TABLE " + spec.tables[0] + " RENAME")) {
        exec.call(this, sql.slice(0, sql.indexOf(";") + 1));
        throw new Error("synthetic failure after first rename");
      }
      return exec.call(this, sql);
    });
    try { assert.throws(() => spec.open(root), e => e instanceof SqliteLifecycleError && e.kind === "io" && e.cause instanceof Error && e.cause.message === "synthetic failure after first rename"); }
    finally { mock.mock.restore(); }
    const read = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(snapshot(read, spec.tables), before);
    assert.deepEqual(history(read), ledger);
    for (const table of renamed(spec.tables)) assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table), undefined);
    read.close();
    const retried = spec.open(root); assert.equal(retried.outcome.status, "migrated"); retried.close();
  });

  test(`${spec.name}: previous and current checksum mismatches refuse opening without rewriting data`, async t => {
    const root = await mkdtemp(join(tmpdir(), "owned-storage-checksum-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, spec.file);
    const { database: old } = openManagedDatabase({ path, migrations: spec.migrations.slice(0, spec.previousVersion) });
    spec.seed(old);
    const before = snapshot(old, spec.tables), checksum = history(old)[0]!.checksum;
    old.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=1"); old.close();
    const refuses = () => assert.throws(() => spec.open(root), e => e instanceof SqliteLifecycleError && e.kind === "history-mismatch");
    refuses();
    const repair = new DatabaseSync(path);
    assert.deepEqual(snapshot(repair, spec.tables), before);
    repair.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run(checksum); repair.close();
    const owner = spec.open(root); owner.close();
    const tamper = new DatabaseSync(path);
    tamper.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=?").run(spec.migrations.at(-1)!.version); tamper.close();
    refuses();
    const read = new DatabaseSync(path, { readOnly: true });
    assert.deepEqual(snapshot(read, renamed(spec.tables)), before); read.close();
  });
}
