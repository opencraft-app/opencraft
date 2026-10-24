import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_BASELINE, OPENCRAFT_HOST_BOT_STATE } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "oc-bot-owner-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const layouts = [
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL",
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, native_thread_id TEXT, cwd TEXT, draft INTEGER NOT NULL DEFAULT 0",
  "thread_id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, cwd TEXT, draft INTEGER NOT NULL DEFAULT 0, native_thread_id TEXT",
];
for (const [index, columns] of layouts.entries()) test(`known deployed Bot layout ${index} preserves rooms, receipts and slots`, async () => fixture(async root => {
  const path = join(root, "codex-host-queue.sqlite");
  const old = new DatabaseSync(path);
  old.exec(OPENCRAFT_HOST_STATE_BASELINE + OPENCRAFT_HOST_BOT_STATE.replace(/CREATE TABLE codex_bot_rooms \([\s\S]*?\);/, `CREATE TABLE codex_bot_rooms (${columns});`));
  old.prepare("INSERT INTO codex_bot_rooms(thread_id,created_ms) VALUES (?,?)").run("room", 42);
  if (index) old.exec("UPDATE codex_bot_rooms SET native_thread_id='native',cwd='/synthetic',draft=1");
  old.exec("INSERT INTO codex_bot_commands VALUES ('send:room:pending','fp',NULL); INSERT INTO codex_bot_message_slots VALUES('room','turn','agentMessage',0,'item');");
  old.close();
  const owner = new OpenCraftHostStateDatabase(root);
  assert.equal(owner.outcome.status, "migrated");
  assert.equal(owner.outcome.appliedVersion, 14); assert.ok(owner.outcome.backupPath); assert.deepEqual(owner.outcome.movedAsidePaths, []);
  const row = owner.database.prepare("SELECT * FROM opencraft_bot_rooms").get()!;
  assert.equal(row.thread_id, "room"); assert.equal(row.created_ms, 42);
  assert.equal(row.native_thread_id, index ? "native" : null); assert.equal(row.draft, index ? 1 : 0);
  assert.equal(owner.database.prepare("SELECT result_json FROM opencraft_bot_commands").get()?.result_json, null);
  assert.equal(owner.database.prepare("SELECT native_id FROM opencraft_bot_message_slots").get()?.native_id, "item");
  const ledger = owner.database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all();
  assert.equal(ledger.length, 14); assert.equal(ledger[0]?.name, "codex-host-state");
  assert.equal(ledger[0]?.checksum, "c2508ef065ded8821d7c071fab1603b403b4e5e9220569916f1cee53f82025c3", "published v1 checksum is immutable");
  owner.close();
  // The recovery copy preserves the original layout for offline historical reads.
  // Old unguarded writers must not reopen the upgraded store and recreate old tables.
  const historical = new DatabaseSync(owner.outcome.backupPath!, { readOnly: true });
  assert.equal(historical.prepare("SELECT thread_id FROM codex_bot_rooms WHERE thread_id='room'").get()?.thread_id, "room"); historical.close();
  const reopened = new OpenCraftHostStateDatabase(root); assert.equal(reopened.outcome.status, "up-to-date"); reopened.close();
}));

test("unknown Bot schema remains rejected without moving user data", async () => fixture(async root => {
  const path = join(root, "codex-host-queue.sqlite"), db = new DatabaseSync(path);
  db.exec(OPENCRAFT_HOST_STATE_BASELINE + OPENCRAFT_HOST_BOT_STATE + "CREATE INDEX unknown_room_policy ON codex_bot_rooms(cwd)"); db.close();
  assert.throws(() => new OpenCraftHostStateDatabase(root), (e: any) => e.kind === "unsupported-legacy");
  assert.ok(!(await readdir(root)).some(name => name.includes(".legacy-")));
}));

test("known room conversion failure rolls back records and leaves a pre-write snapshot", async t => fixture(async root => {
  const path = join(root, "codex-host-queue.sqlite"), db = new DatabaseSync(path);
  db.exec(OPENCRAFT_HOST_STATE_BASELINE + OPENCRAFT_HOST_BOT_STATE.replace(/CREATE TABLE codex_bot_rooms \([\s\S]*?\);/, `CREATE TABLE codex_bot_rooms (${layouts[0]});`));
  db.exec("INSERT INTO codex_bot_rooms VALUES('room',42)"); db.close();
  const original = DatabaseSync.prototype.exec;
  const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("INSERT INTO codex_bot_rooms(thread_id,created_ms,cwd")) throw new Error("synthetic write failure");
    return original.call(this, sql);
  });
  assert.throws(() => new OpenCraftHostStateDatabase(root)); mock.mock.restore();
  const read = new DatabaseSync(path, { readOnly: true });
  assert.equal(read.prepare("SELECT thread_id FROM codex_bot_rooms").get()?.thread_id, "room");
  assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined); read.close();
  assert.ok((await readdir(root)).some(name => name.includes(".pre-v14-")));
}));
