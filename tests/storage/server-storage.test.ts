import { SERVER_ALTERNATE_MIGRATIONS } from "../../packages/storage-node/src/server/migrations.generated.js";
import {assertServerDeclaredSchema} from "../support/assert-server-declared-schema.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { openServerDatabase, SERVER_DATA_CONTRACT, SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { importServerData } from "../../packages/storage-node/src/server/import.js";
import { openServerRepository } from "@opencraft/storage-node/server-repository";
import { SERVER_LEGACY_MIGRATIONS } from "@opencraft/storage-node/server-legacy";
import * as schema from "../../packages/storage-node/src/server/schema.js";
import { ThreadAccessStore } from "../../packages/access-control/src/thread-access.js";
import { ThreadNoteStore } from "../../plugins/thread-summary/src/note-store.js";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { MembershipStore } from "@opencraft/access-control";
import { Collaboration } from "../../packages/access-control/src/collaboration.js";
import { CapabilityBindings } from "@opencraft/session-capabilities/bindings";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { createNodePasswordHasher } from "../../plugins/local-account/src/password-hash-node.js";
import { nodeSqlDatabase, openManagedDatabase, createSchemaValidator } from "@opencraft/sqlite-node";
import { accountModelDefaultsMethods } from "../../packages/storage-node/src/server/account-model-defaults.js";
import { conversationCreationReceiptMethods } from "../../packages/storage-node/src/server/conversation-creation-receipts.js";
const serverSource = (managed: { database: import('node:sqlite').DatabaseSync; outcome: import('@opencraft/sqlite-node').DatabaseOutcome }) => ({ database: nodeSqlDatabase(managed.database), outcome: managed.outcome });

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "opencraft-server-storage-"));
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
const execution = { hostId: "test-host", async validate() {}, async receipt() { return null; }, async add() { return null; }, async steer() {}, async cancel() { return false; } };
const password = "Synthetic-password-for-migration-42";
async function seed(root: string) {
  const actors = new ActorStore(join(root, "actors.sqlite"));
  const members = new MembershipStore(join(root, "memberships.sqlite"));
  const accounts = new HumanAccounts(join(root, "human-logins.sqlite"), actors);
  const provider = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher()); accounts.registerLocalAccounts(provider);
  const management = new HumanAccountManagement(join(root, "account-onboarding.sqlite"), accounts, actors, members);
  const principal = await management.initialize({ mode: "web", username: "owner", password });
  const context = actors.resolveHuman(principal)!;
  const session = actors.createSession("Synthetic Agent", context.actorId);
  actors.setGrant(context.actorId, session.id, "read", true, "test");
  const login = accounts.issue(principal);
  const collaboration = new Collaboration(join(root, "actor-collaboration.sqlite"), actors, execution);
  await collaboration.bind(session.id, "native-thread", 0, () => {});
  const bindings = new CapabilityBindings(join(root, "session-capabilities.sqlite"));
  bindings.bind("capability-1", { serverId: "test-host", threadId: "native-thread" });
  const executionSession = { serverId: "test-host", threadId: "native-thread", execution: { inputId: "input-1", executionId: "execution-1" } };
  bindings.prepareExecution("execution-capability-1", { serverId: "test-host", threadId: "native-thread" });
  bindings.bindExecution("execution-capability-1", executionSession);
  const access = new ThreadAccessStore(join(root, "thread-access.sqlite"), actors);
  access.created("test-host", "native-thread", context);
  access.set("test-host", "native-thread", "private", 1, context);
  const notes = new ThreadNoteStore(join(root, "thread-notes.sqlite"));
  notes.exchange("test-host", "native-thread", "", "AA==");
  access.close(); notes.close();
  const authority = actors.authority;
  await collaboration.close(); bindings.close(); management.close(); accounts.close(); members.close(); actors.close();
  return { context, session, login, authority, executionSession, subject: principal.subject };
}

test("Drizzle schema and recorded snapshot have no ungenerated structural changes", async () => {
  const journal = JSON.parse(readFileSync(new URL("../../packages/storage-node/src/server/migrations/meta/_journal.json", import.meta.url), "utf8"));
  const version = String(journal.entries.at(-1).idx).padStart(4, "0");
  const previous = JSON.parse(readFileSync(new URL(`../../packages/storage-node/src/server/migrations/meta/${version}_snapshot.json`, import.meta.url), "utf8"));
  const config=(await import("../../packages/storage-node/drizzle.config.js")).default;
  const configured:Record<string,unknown>={};
  for(const file of Array.isArray(config.schema)?config.schema:[config.schema])Object.assign(configured,await import(new URL(file,new URL("../../packages/storage-node/",import.meta.url)).href));
  const next = await generateSQLiteDrizzleJson(configured, previous.id);
  assert.deepEqual(await generateSQLiteMigration(previous, next), []);
  const empty = await generateSQLiteDrizzleJson({});
  const statements = await generateSQLiteMigration(empty, next);
  const expectedSql = statements.map(statement => /^\s*CREATE TABLE\b/i.test(statement)
    ? statement.replace(/\);\s*$/, ") STRICT;") : statement).join("\n");
  const current = openManagedDatabase({ path: ":memory:", migrations: SERVER_MIGRATIONS });
  const channelMigrations = SERVER_MIGRATIONS.filter(migration => migration.name.endsWith("_native_channels"));
  assert.equal(channelMigrations.length, 1);
  const channelMigration = channelMigrations[0]!.sql;
  assert.notEqual(channelMigration.indexOf("CREATE TRIGGER"), -1);
  const triggers = channelMigration.slice(channelMigration.indexOf("CREATE TRIGGER"));
  try { assertServerDeclaredSchema(current.database,expectedSql + "\n" + triggers); } finally { current.database.close(); }
});

test("published source SQL retains all migration identities and checksums", () => {
  const expected = JSON.parse(readFileSync(new URL("./fixtures/server-legacy-checksums.json", import.meta.url), "utf8"));
  const actual = Object.fromEntries(Object.entries(SERVER_LEGACY_MIGRATIONS).map(([key, chain]) => [key,
    chain.map(m => ({ version: m.version, name: m.name, checksum: createHash("sha256").update(m.sql).digest("hex") }))]));
  assert.deepEqual(actual, expected);
});

test("registered populated stores consolidate without changing authority, sessions, credentials, grants or bindings", async t => {
  const root = fixture(t), before = await seed(root);
  const originals = Object.keys(SERVER_LEGACY_MIGRATIONS).map(name => join(root, name + ".sqlite"));
  const bytes = originals.map(path => readFileSync(path));
  const storage = await openServerDatabase(root);
  try {
    assert.equal(storage.outcome.status, "migrated");
    const actors = new ActorStore(storage), accounts = new HumanAccounts(storage, actors), members = new MembershipStore(storage);
    const provider = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher()); accounts.registerLocalAccounts(provider);
    const management = new HumanAccountManagement(storage, accounts, actors, members);
    const collaboration = new Collaboration(storage, actors, execution), bindings = new CapabilityBindings(storage);
    assert.equal(actors.authority, before.authority);
    assert.deepEqual(actors.get(before.session.id), before.session);
    assert.equal(accounts.authenticate(before.login.token)?.context.actorId, before.context.actorId);
    assert.equal((await provider.verify("owner", password))?.subject, before.subject);
    assert.deepEqual(members.actorMembership(before.context.actorId), { role: "admin", enabled: true });
    assert.equal(management.status().state, "complete");
    assert.equal(collaboration.binding(before.session.id)?.threadId, "native-thread");
    assert.deepEqual(bindings.get("capability-1"), { serverId: "test-host", threadId: "native-thread" });
    assert.deepEqual(bindings.execution("execution-capability-1"), { scope: { serverId: "test-host", threadId: "native-thread" }, session: before.executionSession });
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, Object.keys(SERVER_LEGACY_MIGRATIONS).length);
    assert.equal(storage.database.prepare("SELECT contract_hash FROM opencraft_server_installation").get()?.contract_hash, SERVER_DATA_CONTRACT.hash);
    for (const receipt of storage.database.prepare("SELECT backup_path FROM opencraft_server_imports").all()) assert.ok(existsSync(String(receipt.backup_path)));
    const restoredRoot = fixture(t);
    for (const receipt of storage.database.prepare("SELECT source,backup_path FROM opencraft_server_imports").all()) {
      copyFileSync(String(receipt.backup_path), join(restoredRoot, String(receipt.source) + ".sqlite"));
    }
    const restored = await openServerDatabase(restoredRoot);
    try {
      assert.equal(restored.database.prepare("SELECT id FROM actor_authority").get()?.id, before.authority);
      assert.equal(restored.database.prepare("SELECT actor_id FROM human_logins").get()?.actor_id, before.context.actorId);
    } finally { await restored.close(); }
    await collaboration.close(); management.close(); bindings.close(); accounts.close(); members.close(); actors.close();
    assert.throws(() => actors.list(), /closed/);
    assert.throws(() => members.list(), /closed/);
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()?.n, 2, "borrowed repository closes do not close the owner");
    assert.throws(() => new ActorStore(originals[0]!), /consolidated/);
    for (const [i, path] of originals.entries()) assert.deepEqual(readFileSync(path), bytes[i], "original files remain unchanged");
    storage.database.prepare("UPDATE actors SET display_name='New title' WHERE id=?").run(before.session.id);
    const currentOnly = fixture(t);
    storage.database.prepare("VACUUM INTO ?").run(join(currentOnly, "opencraft-server.sqlite"));
    const currentRestored = await openServerDatabase(currentOnly);
    try {
      assert.equal(currentRestored.database.prepare("SELECT id FROM actor_authority").get()?.id, before.authority);
      assert.equal(currentRestored.database.prepare("SELECT display_name FROM actors WHERE id=?").get(before.session.id)?.display_name, "New title");
    } finally { await currentRestored.close(); }
    unlinkSync(join(currentOnly, "opencraft-server.sqlite"));
    await assert.rejects(openServerDatabase(currentOnly), /database is missing/);
    assert.throws(() => new ActorStore(join(currentOnly, "actors.sqlite")), /consolidated/);
  } finally { await storage.close(); }
  const reopened = await openServerDatabase(root);
  try {
    assert.equal(reopened.database.prepare("SELECT display_name FROM actors WHERE id=?").get(before.session.id)?.display_name, "New title");
    assert.equal(reopened.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, Object.keys(SERVER_LEGACY_MIGRATIONS).length);
    assert.equal(reopened.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await reopened.close(); }
});

test("fresh installs have one core file; the writer fence also covers maintenance commands", async t => {
  const root = fixture(t), storage = await openServerDatabase(root);
  try {
    await assert.rejects(openServerDatabase(root), /held/);
    assert.deepEqual(readdirSync(root).filter(f => f.endsWith(".sqlite")), ["opencraft-server.sqlite"]);
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports WHERE source_digest='absent'").get()?.n, Object.keys(SERVER_LEGACY_MIGRATIONS).length);
    const actors = new ActorStore(storage);
    assert.throws(() => storage.database.transaction(() => { actors.createSession("cancelled", "test"); throw new Error("cancel"); }), /cancel/);
    assert.equal(actors.list().length, 0, "nested repository transaction participates in rollback"); actors.close();
    const borrowed = openServerRepository(storage, "actors");
    const statement = borrowed.database.prepare("SELECT count(*) AS n FROM actors");
    borrowed.close();
    assert.throws(() => statement.get(), /closed/);
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()?.n, 0);
  } finally { await storage.close(); }
});

test("previous membership schema upgrades only its working copy and retains legacy history", async t => {
  for (const ledgered of [true, false]) {
  const root = fixture(t), chain = SERVER_LEGACY_MIGRATIONS.memberships;
  const previous = openManagedDatabase({ path: join(root, "memberships.sqlite"), migrations: chain.slice(0, 1) });
  previous.database.prepare("INSERT INTO members VALUES(?,?,1)").run('["test","legacy"]', "member");
  if (!ledgered) previous.database.exec("DROP TABLE schema_migrations"); previous.database.close();
  const storage = await openServerDatabase(root);
  try {
    assert.equal(storage.database.prepare("SELECT role FROM members").get()?.role, "member");
    const history = JSON.parse(String(storage.database.prepare("SELECT migration_history FROM opencraft_server_imports WHERE source='memberships'").get()?.migration_history));
    assert.equal(history.length, ledgered ? 1 : 0); if (ledgered) assert.equal(history[0].name, "instance-memberships");
    const old = new DatabaseSync(join(root, "memberships.sqlite"), { readOnly: true });
    if (ledgered) assert.equal(old.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 1);
    else assert.equal(old.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_migrations'").get()?.n, 0); old.close();
  } finally { await storage.close(); }
  }
});

test("unknown history, source drift and orphaned recovery files refuse activation", async t => {
  for (const failure of ["checksum", "newer", "structure", "authority"]) {
    const root = fixture(t); await seed(root);
    const old = new DatabaseSync(join(root, "actors.sqlite"));
    old.exec(failure === "authority" ? "DELETE FROM actor_authority" : failure === "checksum" ? "UPDATE schema_migrations SET checksum='modified'" : failure === "newer"
      ? "INSERT INTO schema_migrations VALUES(2,'future','hash',1)" : "CREATE TRIGGER hidden AFTER INSERT ON actors BEGIN SELECT 1; END"); old.close();
    await assert.rejects(openServerDatabase(root));
    const target = new DatabaseSync(join(root, "opencraft-server.sqlite"), { readOnly: true });
    assert.equal(target.prepare("SELECT count(*) AS n FROM opencraft_server_installation").get()?.n, 0);
    assert.equal(target.prepare("SELECT count(*) AS n FROM actors").get()?.n, 0); target.close();
  }
  const root = fixture(t); await seed(root); const storage = await openServerDatabase(root); await storage.close();
  const retired = new DatabaseSync(join(root, "actors.sqlite")); retired.exec("UPDATE actors SET display_name='old writer'"); retired.close();
  await assert.rejects(openServerDatabase(root), /Retired Server source changed/);
  const missing = fixture(t); writeFileSync(join(missing, "actors.sqlite.legacy-interrupted"), "retained");
  await assert.rejects(openServerDatabase(missing), /recovery files/);
});

test("newer consolidated histories and missing business tables cannot open", async t => {
  for (const sql of ["INSERT INTO schema_migrations VALUES(999,'future','hash',1)", "UPDATE schema_migrations SET checksum='modified' WHERE version=1", "DROP TABLE actors"]) {
    const root = fixture(t), storage = await openServerDatabase(root); await storage.close();
    const db = new DatabaseSync(join(root, "opencraft-server.sqlite")); db.exec(sql); db.close();
    await assert.rejects(openServerDatabase(root));
  }
  const root = fixture(t), storage = await openServerDatabase(root); await storage.close();
  unlinkSync(join(root, "opencraft-server.sqlite"));
  await assert.rejects(openServerDatabase(root), /database is missing/);
  assert.equal(existsSync(join(root, "opencraft-server.sqlite")), false);
});

test("process termination during import rolls back; termination after commit resumes without duplicate rows", async t => {
  for (const stage of ["during-import", "after-commit"]) {
    const root = fixture(t); await seed(root);
    const child = spawnSync(process.execPath, ["--import", "tsx", new URL("../fixtures/server-storage-crash.ts", import.meta.url).pathname, root, stage], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const storage = await openServerDatabase(root);
    try {
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()?.n, 2);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM local_accounts").get()?.n, 1);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, Object.keys(SERVER_LEGACY_MIGRATIONS).length);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_installation").get()?.n, 1);
    } finally { await storage.close(); }
  }
});


test("official account and access commands use the consolidated authority", async t => {
  const root = fixture(t), before = await seed(root);
  const invoke = (script: string, args: string[]) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", new URL("../../scripts/admin/" + script, import.meta.url).pathname, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr); return child.stdout;
  };
  assert.match(invoke("access-admin.ts", [join(root, "memberships.sqlite"), "revoke", "local", before.subject]), /updated/);
  const secret = join(root, "synthetic-password.json"), nextPassword = "Synthetic-replacement-password-42";
  writeFileSync(secret, JSON.stringify({ password: nextPassword }), { mode: 0o600 });
  assert.match(invoke("human-account.ts", [root, "password", "owner", secret]), /Password updated/);
  const storage = await openServerDatabase(root);
  try {
    const actors = new ActorStore(storage), members = new MembershipStore(storage), accounts = new HumanAccounts(storage, actors);
    const provider = new LocalAccountServerPlugin(accounts.localAccountRepository, createNodePasswordHasher()); accounts.registerLocalAccounts(provider);
    assert.equal(members.actorMembership(before.context.actorId)?.enabled, false);
    assert.equal(await provider.verify("owner", password), null);
    assert.equal((await provider.verify("owner", nextPassword))?.subject, before.subject);
    accounts.close(); members.close(); actors.close();
  } finally { await storage.close(); }
});


test("the previous consolidated contract upgrades while preserving actors and ledger checksums", async t => {
  const root = fixture(t);
  const previous = openManagedDatabase({ path: join(root, "opencraft-server.sqlite"), migrations: SERVER_MIGRATIONS.slice(0, 1) });
  importServerData(previous.database, root, { productVersion: "0.1.0", hash: "previous-contract" });
  const actors = new ActorStore(serverSource(previous)), session = actors.createSession("Retained actor", "fixture");
  const authority = actors.authority;
  const history = previous.database.prepare("SELECT * FROM schema_migrations WHERE version=1").get();
  actors.close(); previous.database.close();
  const current = await openServerDatabase(root);
  try {
    assert.equal(current.outcome.status, "migrated");
    assert.deepEqual(current.database.prepare("SELECT * FROM schema_migrations WHERE version=1").get(), history);
    const restored = new ActorStore(serverSource(current)), bindings = new CapabilityBindings(serverSource(current));
    assert.equal(restored.authority, authority); assert.deepEqual(restored.get(session.id), session);
    bindings.prepareExecution("new-execution", { serverId: "test", threadId: "thread" });
    assert.equal(bindings.executionId({ serverId: "test", threadId: "thread" }), "new-execution");
    bindings.close(); restored.close();
  } finally { await current.close(); }
});

test("the published capability v1 upgrades only its working copy", async t => {
  const root = fixture(t), path = join(root, "session-capabilities.sqlite");
  const previous = openManagedDatabase({ path, migrations: SERVER_LEGACY_MIGRATIONS["session-capabilities"].slice(0, 1) });
  previous.database.exec("INSERT INTO capability_bindings VALUES('retained','server','thread',42)");
  previous.database.close(); const bytes = readFileSync(path);
  const current = await openServerDatabase(root);
  try {
    const bindings = new CapabilityBindings(serverSource(current));
    assert.deepEqual(bindings.get("retained"), { serverId: "server", threadId: "thread" });
    bindings.prepareExecution("new", { serverId: "server", threadId: "thread" });
    assert.equal(bindings.executionId({ serverId: "server", threadId: "thread" }), "new");
    bindings.close(); assert.deepEqual(readFileSync(path), bytes);
  } finally { await current.close(); }
});

test("Server contract v2 upgrades existing actor messages and refuses a changed migration checksum", async t => {
  const root = fixture(t), path = join(root, "opencraft-server.sqlite");
  const previous = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS.slice(0, 2) });
  importServerData(previous.database, root, { productVersion: "0.1.0", hash: "previous-contract" });
  previous.database.exec(`INSERT INTO actor_messages(id,seq,channel_id,author_id,target_id,content,created_at)
    VALUES('existing-message',1,'dm:retained','alice','bob','retained message',42)`);
  const history = previous.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  previous.database.close();
  const current = await openServerDatabase(root);
  try {
    assert.equal(current.outcome.appliedVersion, SERVER_MIGRATIONS.length);
    assert.deepEqual(current.database.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(), history);
    assert.equal(current.database.prepare("SELECT content FROM actor_messages WHERE id='existing-message'").get()?.content, "retained message");
    assert.equal(current.database.prepare("SELECT peer_id FROM actor_channels WHERE id='dm:retained'").get()?.peer_id, "bob");
    assert.equal(current.database.prepare("SELECT count(*) n FROM actor_channel_changes").get()?.n, 1);
  } finally { await current.close(); }
  const tampered = new DatabaseSync(path);
  tampered.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=3");
  tampered.close();
  await assert.rejects(openServerDatabase(root), { kind: "history-mismatch" });
});

/** Build an actual frozen database. Dropping a few tables from today's schema
 * would leave later columns/indexes behind and cannot represent deployed v8/v13. */
async function reconstructConsolidatedBaseline(root: string, version: number) {
  const lineage = SERVER_ALTERNATE_MIGRATIONS.find(entry => entry.id === "generic-legacy-v13");
  assert.ok(lineage, "published pre-product generic history is declared");
  const historicalMigrations = lineage.migrations.slice(0, version);
  const owner = await openServerDatabase(root);
  const receipts = owner.database.prepare("SELECT * FROM opencraft_server_imports WHERE source NOT IN ('thread-access','thread-notes') ORDER BY source").all();
  const historicalPath=join(root,"historical-fixture.sqlite");
  const old=openManagedDatabase({path:historicalPath,migrations:historicalMigrations,legacyPolicy:"reject"});
  const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
  try {
    const triggers=old.database.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    old.database.exec("BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON");
    try {
      for(const trigger of triggers)old.database.exec("DROP TRIGGER "+quote(String(trigger.name)));
      const tables=old.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'").all();
      for(const {name} of tables) {
        const table=String(name),columns=old.database.prepare("PRAGMA table_info("+quote(table)+")").all().map(c=>String(c.name));
        const fields=columns.map(quote).join(',');
        const rows=owner.database.prepare("SELECT "+fields+" FROM "+quote(table)+(table==="opencraft_server_imports"?" WHERE source NOT IN ('thread-access','thread-notes')":"")).all();
        const insert=old.database.prepare("INSERT INTO "+quote(table)+" ("+fields+") VALUES("+columns.map(()=>'?').join(',')+")");
        for(const row of rows)insert.run(...columns.map(column=>row[column] as any));
      }
      for(const trigger of triggers)old.database.exec(String(trigger.sql));
      old.database.prepare("UPDATE opencraft_server_installation SET contract_hash=?").run(createHash("sha256").update(JSON.stringify(historicalMigrations)).digest("hex"));
      old.database.exec("COMMIT");
    } catch(error) { old.database.exec("ROLLBACK"); throw error; }
  } finally {old.database.close();await owner.close();}
  renameSync(historicalPath,join(root,"opencraft-server.sqlite"));
  return receipts;
}
async function consolidatedBaseline(root: string) {
  const before=await seed(root),receipts=await reconstructConsolidatedBaseline(root,8);
  return {before,receipts};
}

test("a deployed downstream v8 installation imports access/note sources without replaying prior receipts", async t => {
  const root = fixture(t), { before, receipts } = await consolidatedBaseline(root);
  const owner = await openServerDatabase(root);
  try {
    assert.deepEqual(owner.database.prepare("SELECT * FROM opencraft_server_imports WHERE source NOT IN ('thread-access','thread-notes') ORDER BY source").all(), receipts);
    assert.equal(owner.database.prepare("SELECT access_mode FROM thread_access WHERE thread_id='native-thread'").get()?.access_mode, "private");
    assert.equal(owner.database.prepare("SELECT id FROM actor_authority").get()?.id, before.authority);
    assert.equal(owner.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, Object.keys(SERVER_LEGACY_MIGRATIONS).length);
  } finally { await owner.close(); }
  const reopened = await openServerDatabase(root);
  try { assert.equal(reopened.database.prepare("SELECT revision FROM thread_access").get()?.revision, 2); }
  finally { await reopened.close(); }
});

test("failed additive import preserves prior authority and receipts without committing partial policy rows", async t => {
  const root = fixture(t), { before, receipts } = await consolidatedBaseline(root);
  const notes = new DatabaseSync(join(root, "thread-notes.sqlite"));
  notes.exec("UPDATE schema_migrations SET checksum='invalid'"); notes.close();
  await assert.rejects(openServerDatabase(root));
  const database = new DatabaseSync(join(root, "opencraft-server.sqlite"));
  try {
    assert.deepEqual(database.prepare("SELECT * FROM opencraft_server_imports ORDER BY source").all(), receipts);
    assert.equal(database.prepare("SELECT id FROM actor_authority").get()?.id, before.authority);
    assert.equal(database.prepare("SELECT count(*) AS n FROM thread_access").get()?.n, 0);
  } finally { database.close(); }
});

test("a current installation cannot silently recreate a deleted access import receipt", async t => {
  const root = fixture(t), owner = await openServerDatabase(root);
  owner.database.exec("DELETE FROM opencraft_server_imports WHERE source='thread-access'");
  await owner.close();
  await assert.rejects(openServerDatabase(root), /Incomplete Server import receipts/);
});


test("published v13 six-store receipts acquire absent empty domains atomically and reopen", async t => {
  const root = fixture(t), receipts = await reconstructConsolidatedBaseline(root,13);
  const upgraded = await openServerDatabase(root);
  assert.deepEqual(upgraded.database.prepare("SELECT * FROM opencraft_server_imports WHERE source NOT IN ('thread-access','thread-notes') ORDER BY source").all(), receipts);
  assert.equal(upgraded.database.prepare("SELECT count(*) n FROM opencraft_server_imports").get()?.n, 8);
  await upgraded.close();
  const reopened = await openServerDatabase(root); await reopened.close();
});

test("missing domain receipts cannot reimport over existing canonical policy", async t => {
  const root = fixture(t), owner = await openServerDatabase(root);
  owner.database.exec("DELETE FROM opencraft_server_imports WHERE source IN ('thread-access','thread-notes'); INSERT INTO thread_access VALUES('server','retained',NULL,'shared',1,1)");
  await owner.close();
  await assert.rejects(openServerDatabase(root), /Incomplete Server import receipts/);
});

test("creation receipts upgrade the preceding Server contract and reject a tampered migration checksum", async t => {
  const root = fixture(t), path = join(root, "opencraft-server.sqlite");
  const priorVersion = 21;
  const prior = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS.slice(0, priorVersion) });
  importServerData(prior.database, root, { productVersion: "0.1.0", hash: "previous-crew-contract" });
  const actors = new ActorStore(serverSource(prior));
  const retained = actors.createSession("Retained session", "fixture");
  actors.close();
  const ledger = prior.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  prior.database.close();

  const owner = await openServerDatabase(root);
  try {
    assert.equal(owner.outcome.status, "migrated");
    assert.equal(owner.outcome.appliedVersion, SERVER_MIGRATIONS.length);
    assert.deepEqual(owner.database.prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version").all(priorVersion), ledger);
    const restored = new ActorStore(owner);
    assert.deepEqual(restored.get(retained.id), retained);
    restored.close();
    assert.equal(owner.database.prepare("SELECT count(*) n FROM conversation_creation_receipts").get()?.n, 0);
  } finally { await owner.close(); }

  const changed = new DatabaseSync(path);
  changed.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run("0".repeat(64), priorVersion + 1);
  changed.close();
  await assert.rejects(openServerDatabase(root), { kind: "history-mismatch" });
});

test("account model defaults upgrade the preceding Server contract, keep its data and reject a tampered checksum", async t => {
  const root = fixture(t), path = join(root, "opencraft-server.sqlite");
  const priorVersion = 22;
  assert.equal(SERVER_MIGRATIONS[priorVersion]?.name, "0022_account_model_defaults");
  const prior = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS.slice(0, priorVersion) });
  importServerData(prior.database, root, { productVersion: "0.1.0", hash: "previous-creation-receipts-contract" });
  const actors = new ActorStore(serverSource(prior));
  const person = actors.resolveHuman({ provider: "local", subject: "retained-person", displayName: "Retained", expiresAt: Date.now() + 60_000 });
  actors.close();
  assert.ok(person);
  const receipt = { actorId: person.actorId, operationKey: "retained", serverId: "server", fingerprint: "hash" };
  conversationCreationReceiptMethods(nodeSqlDatabase(prior.database)).claimConversationCreation(receipt);
  const ledger = prior.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  prior.database.close();

  const owner = await openServerDatabase(root);
  try {
    assert.equal(owner.outcome.status, "migrated");
    assert.equal(owner.outcome.appliedVersion, SERVER_MIGRATIONS.length);
    assert.deepEqual(owner.database.prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version").all(priorVersion), ledger);
    const restored = new ActorStore(owner);
    assert.equal(restored.findHuman({ provider: "local", subject: "retained-person" })?.id, person.actorId);
    restored.close();
    assert.deepEqual(conversationCreationReceiptMethods(owner.database).readConversationCreation(receipt), { state: "claimed" });
    const defaults = accountModelDefaultsMethods(owner.database);
    assert.deepEqual(defaults.readAccountModelDefaults(person.actorId, "host"), { revision: 0, selection: null });
    assert.equal(defaults.compareAndSetAccountModelDefaults(person.actorId, "host", 0, { model: "upgraded", effort: null }).updated, true);
  } finally { await owner.close(); }

  const changed = new DatabaseSync(path);
  changed.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run("0".repeat(64), priorVersion + 1);
  changed.close();
  await assert.rejects(openServerDatabase(root), { kind: "history-mismatch" });
});

test("conversation resources upgrade the preceding Server contract, keep its data, and reject a tampered checksum", async t => {
  const root = fixture(t), path = join(root, "opencraft-server.sqlite");
  const priorVersion = 23;
  assert.equal(SERVER_MIGRATIONS[priorVersion]?.name, "0023_conversation_resources");
  const prior = openManagedDatabase({ path, migrations: SERVER_MIGRATIONS.slice(0, priorVersion) });
  importServerData(prior.database, root, { productVersion: "0.1.0", hash: "previous-account-model-defaults-contract" });
  const actors = new ActorStore(serverSource(prior));
  const retained = actors.createSession("Retained session", "fixture");
  actors.close();
  prior.database.prepare("INSERT INTO conversation_creation_receipts(actor_id, operation_key, server_id, fingerprint, state) VALUES('a', 'k', 's', 'f', 'claimed')").run();
  const ledger = prior.database.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  prior.database.close();

  const owner = await openServerDatabase(root);
  try {
    assert.equal(owner.outcome.status, "migrated");
    assert.equal(owner.outcome.appliedVersion, SERVER_MIGRATIONS.length);
    assert.deepEqual(owner.database.prepare("SELECT * FROM schema_migrations WHERE version<=? ORDER BY version").all(priorVersion), ledger);
    const restored = new ActorStore(owner);
    assert.deepEqual(restored.get(retained.id), retained);
    restored.close();
    assert.equal(owner.database.prepare("SELECT state FROM conversation_creation_receipts WHERE actor_id='a'").get()?.state, "claimed");
    assert.equal(owner.database.prepare("SELECT count(*) n FROM conversation_resources").get()?.n, 0);
    assert.throws(() => owner.database.prepare("INSERT INTO conversation_resources VALUES('h', 't', 'closed', 1, '[]')").run(), /CHECK/);
    assert.throws(() => owner.database.prepare("INSERT INTO conversation_resources VALUES('h', 't', 'archived', 1, '{}')").run(), /CHECK/);
  } finally { await owner.close(); }

  const changed = new DatabaseSync(path);
  changed.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run("0".repeat(64), priorVersion + 1);
  changed.close();
  await assert.rejects(openServerDatabase(root), { kind: "history-mismatch" });
});
