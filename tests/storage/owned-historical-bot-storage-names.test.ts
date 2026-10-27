import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openManagedDatabase, SqliteLifecycleError } from "@opencraft/sqlite-node";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";

const temporaryDirectory = realpathSync(tmpdir());
const currentVersion = OPENCRAFT_HOST_STATE_MIGRATIONS.at(-1)!.version;
const oldTables = ["codex_bot_rooms", "codex_bot_commands", "codex_bot_message_slots"];
const currentName = (name: string) => oldTables.includes(name) ? name.replace(/^codex_/, "opencraft_") : name;
const history = (db: DatabaseSync) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const tables = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations' ORDER BY name").all().map(row => String(row.name));
const snapshot = (db: DatabaseSync, names: string[]) => names.map(name => db.prepare(`SELECT * FROM ${name}`).all());
async function fixture(t: TestContext, ledgered = true) {
  const root = await mkdtemp(join(temporaryDirectory, "opencraft-historical-bot-")), path = join(root, "opencraft-host-state.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { database: db } = openManagedDatabase({ path, migrations: OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0, 13) });
  db.exec(`
    INSERT INTO codex_bot_rooms VALUES('room',42,'/retained',1,'native-thread');
    INSERT INTO codex_bot_rooms VALUES('draft',43,NULL,0,NULL);
    INSERT INTO codex_bot_commands VALUES('pending','fp-pending',NULL);
    INSERT INTO codex_bot_commands VALUES('complete','fp-complete','{"result":"retained"}');
    INSERT INTO codex_bot_message_slots VALUES('room','turn','agentMessage',0,'native-item');
    INSERT INTO codex_bot_message_slots VALUES('room','turn','agentMessage',1,'native-item-2');
    INSERT INTO opencraft_host_queue VALUES('q','room','input','[]',7,1,2,'unknown','turn','unconfirmed');
    INSERT INTO message_senders VALUES('room','input','{}',1);
  `);
  const names = tables(db), before = snapshot(db, names), ledger = history(db);
  if (!ledgered) db.exec("DROP TABLE schema_migrations");
  db.close();
  return { root, path, names, before, ledger };
}

for (const ledgered of [true, false]) test(`complete v13 ${ledgered ? "ledgered" : "unledgered"} store preserves all records and historical receipts`, async t => {
  const { root, path, names, before, ledger } = await fixture(t, ledgered);
  const owner = new OpenCraftHostStateDatabase(root);
  assert.equal(owner.outcome.appliedVersion, currentVersion); assert.equal(owner.outcome.status, "migrated");
  assert.deepEqual(owner.outcome.movedAsidePaths, []);
  assert.deepEqual(snapshot(owner.database, names.map(currentName)), before, "every business table survives, including unrelated queue and sender rows");
  for (const name of oldTables) assert.equal(owner.database.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name), undefined);
  if (ledgered) assert.deepEqual(history(owner.database).slice(0, 13), ledger);
  else assert.deepEqual(history(owner.database).slice(0, 13).map(({ applied_at, ...row }) => row), ledger.map(({ applied_at, ...row }) => row));
  assert.equal(owner.database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  assert.throws(() => owner.database.exec("INSERT INTO opencraft_bot_message_slots VALUES('room','turn','agentMessage',2,'native-item')"), /UNIQUE/);
  assert.throws(() => owner.database.exec("INSERT INTO opencraft_bot_commands VALUES('pending','other',NULL)"), /UNIQUE/);
  const backup = new DatabaseSync(owner.outcome.backupPath!, { readOnly: true });
  assert.deepEqual(snapshot(backup, names), before); backup.close(); owner.close();
  assert.throws(() => openManagedDatabase({ path, migrations: OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0, 13) }), e => e instanceof SqliteLifecycleError && e.kind === "newer-schema");
  const reopened = new OpenCraftHostStateDatabase(root); assert.equal(reopened.outcome.status, "up-to-date");
  assert.deepEqual(snapshot(reopened.database, names.map(currentName)), before); reopened.close();
});

test("fresh store creates only owned table names while retaining all published migration identities", async t => {
  const root = await mkdtemp(join(temporaryDirectory, "opencraft-owned-bot-fresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = new OpenCraftHostStateDatabase(root);
  assert.equal(owner.outcome.status, "fresh"); assert.equal(owner.outcome.appliedVersion, currentVersion);
  assert.equal(tables(owner.database).some(name => /^codex_/u.test(name)), false);
  assert.equal(history(owner.database)[1]?.name, "codex-bot-state");
  assert.equal(history(owner.database)[13]?.name, "opencraft-host-bot-owned-names"); owner.close();
});

for (const ledgered of [true, false]) test(`failed v14 rename rolls back ${ledgered ? "ledgered" : "unledgered"} schema and data, then retries`, async t => {
  const { root, path, names, before, ledger } = await fixture(t, ledgered);
  const exec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("\nALTER TABLE codex_bot_rooms RENAME") && this.prepare("PRAGMA database_list").all().some(row => row.name === "main" && row.file === path)) {
      exec.call(this, sql.slice(0, sql.indexOf(";") + 1));
      throw new Error("synthetic failure after first Bot rename");
    }
    return exec.call(this, sql);
  });
  try { assert.throws(() => new OpenCraftHostStateDatabase(root), e => e instanceof SqliteLifecycleError && e.kind === "io" && e.cause instanceof Error && e.cause.message === "synthetic failure after first Bot rename"); }
  finally { mock.mock.restore(); }
  const read = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(tables(read), names); assert.deepEqual(snapshot(read, names), before);
  if (ledgered) assert.deepEqual(history(read), ledger);
  else assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='schema_migrations'").get(), undefined);
  read.close();
  assert.ok((await readdir(root)).some(name => name.includes(`.pre-v${currentVersion}-`)));
  const retried = new OpenCraftHostStateDatabase(root); assert.equal(retried.outcome.status, "migrated");
  assert.deepEqual(snapshot(retried.database, names.map(currentName)), before); retried.close();
});

test("v13 and v14 checksum mismatches reject opening without discarding Bot records", async t => {
  const { root, path, names, before, ledger } = await fixture(t);
  const tamper = new DatabaseSync(path);
  tamper.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=13"); tamper.close();
  const refuses = () => assert.throws(() => new OpenCraftHostStateDatabase(root), e => e instanceof SqliteLifecycleError && e.kind === "history-mismatch");
  refuses();
  const repair = new DatabaseSync(path); assert.deepEqual(snapshot(repair, names), before);
  repair.prepare("UPDATE schema_migrations SET checksum=? WHERE version=13").run(ledger[12]!.checksum); repair.close();
  const owner = new OpenCraftHostStateDatabase(root); owner.close();
  const current = new DatabaseSync(path); current.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=14"); current.close();
  refuses();
  const read = new DatabaseSync(path, { readOnly: true }); assert.deepEqual(snapshot(read, names.map(currentName)), before); read.close();
});

test("unledgered v13 with an unknown object is rejected rather than adopted or renamed", async t => {
  const { root, path, names, before } = await fixture(t, false);
  const db = new DatabaseSync(path); db.exec("CREATE INDEX unknown_bot_policy ON codex_bot_rooms(cwd)"); db.close();
  assert.throws(() => new OpenCraftHostStateDatabase(root), e => e instanceof SqliteLifecycleError && e.kind === "unsupported-legacy");
  const read = new DatabaseSync(path, { readOnly: true }); assert.deepEqual(snapshot(read, names), before);
  assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='opencraft_bot_rooms'").get(), undefined); read.close();
});
