import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, utimesSync, copyFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from "drizzle-kit/api";
import { openServerDatabase, SERVER_DATA_CONTRACT, SERVER_MIGRATIONS } from "@opencraft/storage-node/server";
import { openServerRepository } from "@opencraft/storage-node/server-repository";
import { SERVER_LEGACY_MIGRATIONS } from "@opencraft/storage-node/server-legacy";
import * as schema from "../../packages/storage-node/src/server/schema.js";
import { ActorStore } from "@opencraft/access-control/actors";
import { HumanAccounts } from "@opencraft/access-control/human-accounts";
import { HumanAccountManagement } from "@opencraft/access-control/account-management";
import { MembershipStore } from "@opencraft/access-control";
import { Collaboration } from "../../packages/access-control/src/collaboration.js";
import { CapabilityBindings } from "@opencraft/session-capabilities/bindings";
import { LocalAccountServerPlugin } from "../../plugins/local-account/src/server.js";
import { openManagedDatabase, sqliteTransaction, createSchemaValidator } from "@opencraft/sqlite-node";

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
  const provider = new LocalAccountServerPlugin(accounts.localAccountRepository); accounts.registerLocalAccounts(provider);
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
  const authority = actors.authority;
  await collaboration.close(); bindings.close(); management.close(); accounts.close(); members.close(); actors.close();
  return { context, session, login, authority, subject: principal.subject };
}

test("Drizzle schema and recorded snapshot have no ungenerated structural changes", async () => {
  const previous = JSON.parse(readFileSync(new URL("../../packages/storage-node/src/server/migrations/meta/0000_snapshot.json", import.meta.url), "utf8"));
  const next = await generateSQLiteDrizzleJson(schema, previous.id);
  assert.deepEqual(await generateSQLiteMigration(previous, next), []);
  const empty = await generateSQLiteDrizzleJson({});
  const statements = await generateSQLiteMigration(empty, next);
  const expectedSql = statements.map(statement => /^\s*CREATE TABLE\b/i.test(statement)
    ? statement.replace(/\);\s*$/, ") STRICT;") : statement).join("\n");
  const current = openManagedDatabase({ path: ":memory:", migrations: SERVER_MIGRATIONS });
  try { createSchemaValidator(expectedSql)(current.database); } finally { current.database.close(); }
});

test("published source SQL retains all migration identities and checksums", () => {
  const expected = JSON.parse(readFileSync(new URL("./fixtures/server-legacy-checksums.json", import.meta.url), "utf8"));
  const actual = Object.fromEntries(Object.entries(SERVER_LEGACY_MIGRATIONS).map(([key, chain]) => [key,
    chain.map(m => ({ version: m.version, name: m.name, checksum: createHash("sha256").update(m.sql).digest("hex") }))]));
  assert.deepEqual(actual, expected);
});

test("six populated stores consolidate without changing authority, sessions, credentials, grants or bindings", async t => {
  const root = fixture(t), before = await seed(root);
  const originals = Object.keys(SERVER_LEGACY_MIGRATIONS).map(name => join(root, name + ".sqlite"));
  const bytes = originals.map(path => readFileSync(path));
  const storage = await openServerDatabase(root);
  try {
    assert.equal(storage.outcome.status, "migrated");
    const actors = new ActorStore(storage), accounts = new HumanAccounts(storage, actors), members = new MembershipStore(storage);
    const provider = new LocalAccountServerPlugin(accounts.localAccountRepository); accounts.registerLocalAccounts(provider);
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
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, 6);
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
    assert.equal(reopened.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, 6);
    assert.equal(reopened.database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally { await reopened.close(); }
});

test("fresh installs have one core file; the writer fence also covers maintenance commands", async t => {
  const root = fixture(t), storage = await openServerDatabase(root);
  try {
    await assert.rejects(openServerDatabase(root), /held/);
    assert.deepEqual(readdirSync(root).filter(f => f.endsWith(".sqlite")), ["opencraft-server.sqlite"]);
    assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports WHERE source_digest='absent'").get()?.n, 6);
    const actors = new ActorStore(storage);
    assert.throws(() => sqliteTransaction(storage.database, () => { actors.createSession("cancelled", "test"); throw new Error("cancel"); }), /cancel/);
    assert.equal(actors.list().length, 0, "nested repository transaction participates in rollback"); actors.close();
    const borrowed = openServerRepository(storage, "actors");
    const statement = borrowed.database.prepare("SELECT count(*) AS n FROM actors");
    borrowed.database.close();
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
  for (const sql of ["INSERT INTO schema_migrations VALUES(2,'future','hash',1)", "DROP TABLE actors"]) {
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
    // The child is confirmed dead. Expire only its synthetic proper-lockfile fence.
    utimesSync(join(root, "server.lock"), new Date(0), new Date(0));
    const storage = await openServerDatabase(root);
    try {
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM actors").get()?.n, 2);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM local_accounts").get()?.n, 1);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_imports").get()?.n, 6);
      assert.equal(storage.database.prepare("SELECT count(*) AS n FROM opencraft_server_installation").get()?.n, 1);
    } finally { await storage.close(); }
  }
});


test("official account and access commands use the consolidated authority", async t => {
  const root = fixture(t), before = await seed(root);
  const invoke = (script: string, args: string[]) => {
    const child = spawnSync(process.execPath, ["--import", "tsx", new URL("../../scripts/" + script, import.meta.url).pathname, ...args], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 0, child.stderr); return child.stdout;
  };
  assert.match(invoke("access-admin.ts", [join(root, "memberships.sqlite"), "revoke", "local", before.subject]), /updated/);
  const secret = join(root, "synthetic-password.json"), nextPassword = "Synthetic-replacement-password-42";
  writeFileSync(secret, JSON.stringify({ password: nextPassword }), { mode: 0o600 });
  assert.match(invoke("human-account.ts", [root, "password", "owner", secret]), /Password updated/);
  const storage = await openServerDatabase(root);
  try {
    const actors = new ActorStore(storage), members = new MembershipStore(storage), accounts = new HumanAccounts(storage, actors);
    const provider = new LocalAccountServerPlugin(accounts.localAccountRepository); accounts.registerLocalAccounts(provider);
    assert.equal(members.actorMembership(before.context.actorId)?.enabled, false);
    assert.equal(await provider.verify("owner", password), null);
    assert.equal((await provider.verify("owner", nextPassword))?.subject, before.subject);
    accounts.close(); members.close(); actors.close();
  } finally { await storage.close(); }
});
