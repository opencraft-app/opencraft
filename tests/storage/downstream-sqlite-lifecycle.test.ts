import { CodexEngineAdapter } from "../../apps/opencraft-daemon/src/codex-engine-adapter";
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue";
import { OpenCraftMessageSenders } from "../../apps/opencraft-daemon/src/opencraft-message-senders";
import { OpenCraftMessageAttachments } from "../../apps/opencraft-daemon/src/opencraft-message-attachments";
import { TasksSqliteStore } from "../../plugins/tasks/src/sqlite";
import { SshConnectionStore } from "../../apps/opencraft-daemon/src/ssh-connection-store";
import { openLocalAgentStorage } from "../../apps/local-agent-host/src/storage/local-agent-storage";
import { SqliteLifecycleError } from "@opencraft/sqlite-node";
import { legacyQueueSql, legacySenderSql, legacyParticipantsSql, legacyAttachmentsSql, legacyTasksSql, legacySshSql } from "../fixtures/downstream-sqlite-legacy";
const ledger = "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT";
const hash = (sql: string) => createHash("sha256").update(sql).digest("hex");
const fault = (kind: SqliteLifecycleError["kind"]) => (e: unknown) => e instanceof SqliteLifecycleError && e.kind === kind;

for (const partial of [false, true]) test(`old shared Codex DB keeps queue, verified author and enterprise identity data (${partial ? "missing auxiliary object" : "complete"})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-state-"));
  const path = join(root, "codex-host-queue.sqlite");
  try {
    const old = new DatabaseSync(path);
    old.exec(legacyQueueSql + legacySenderSql + legacyParticipantsSql);
    old.prepare("INSERT INTO codex_host_queue VALUES(?,?,?,?,?,?,?,?,?,?)").run("q", "t", "m", '[{"type":"text","text":"retained"}]', 4, 1, 1, "dispatching", "turn", null);
    old.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("t", "m", '{"kind":"employee","loginName":"fixture"}', 1);
    old.prepare("INSERT INTO ioa_message_presence VALUES(?,?,?)").run("t", "m", "fixture");
    old.prepare("INSERT INTO ioa_participant_state VALUES(?,?)").run("t", 7);
    if (partial) old.exec("DROP INDEX ioa_presence_names");
    old.close();
    let owner = new OpenCraftHostStateDatabase(root);
    assert.equal(owner.outcome.status, "migrated", "Bot v2 tables are additive; the old queue/sender/enterprise identity rows remain");
    assert.ok(owner.outcome.backupPath); assert.deepEqual(owner.outcome.movedAsidePaths, []);
    const queue = new OpenCraftHostQueue(root, owner.database);
    assert.equal(queue.find("t", "q")?.state, "unknown", "existing recovery keeps uncertain delivery fenced");
    assert.equal(queue.find("t", "q")?.position, 4);
    assert.deepEqual(new OpenCraftMessageSenders(owner.database).get("t", "m"), { kind: "employee", loginName: "fixture" });
    assert.equal(owner.database.prepare("SELECT revision FROM ioa_participant_state").get()?.revision, 7);
    assert.equal(owner.database.prepare("SELECT login_name FROM ioa_message_presence").get()?.login_name, "fixture");
    const backup = new DatabaseSync(owner.outcome.backupPath!, { readOnly: true });
    assert.equal(backup.prepare("SELECT state FROM codex_host_queue").get()?.state, "dispatching"); backup.close();
    queue.close(); owner.close(); owner = new OpenCraftHostStateDatabase(root);
    assert.equal(owner.outcome.status, "up-to-date");
    assert.equal(owner.database.prepare("SELECT revision FROM ioa_participant_state").get()?.revision, 7); owner.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial legacy shared DB failure rolls back and keeps source and pre-write backup", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-rollback-")), path = join(root, "codex-host-queue.sqlite");
  try {
    const old = new DatabaseSync(path); old.exec(legacySenderSql);
    old.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("t", "m", "null", 1); old.close();
    const exec = DatabaseSync.prototype.exec;
    const mock = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS codex_host_queue")) throw new Error("synthetic conversion failure");
      return exec.call(this, sql);
    });
    assert.throws(() => new OpenCraftHostStateDatabase(root), fault("io")); mock.mock.restore();
    const read = new DatabaseSync(path, { readOnly: true });
    assert.equal(read.prepare("SELECT client_message_id FROM message_senders").get()?.client_message_id, "m");
    assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined); read.close();
    const snapshots = (await readdir(root)).filter(name => /^codex-host-queue\.sqlite\.pre-v\d+-.*\.sqlite$/u.test(name));
    assert.equal(snapshots.length, 1, "failed conversion retains its original recovery point");
    const snapshot = new DatabaseSync(join(root, snapshots[0]!), { readOnly: true });
    try {
      assert.equal(snapshot.prepare("SELECT client_message_id FROM message_senders").get()?.client_message_id, "m");
      assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(), undefined);
    } finally { snapshot.close(); }
    assert.ok(!(await readdir(root)).some(name => name.includes(".legacy-")));
    const retry = new OpenCraftHostStateDatabase(root); assert.equal(retry.outcome.status, "migrated"); retry.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("attachment legacy index completion retains actual refs and rejects rewritten/newer history", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-attachments-")), path = join(root, "codex-message-attachments.sqlite");
  try {
    const old = new DatabaseSync(path); old.exec(legacyAttachmentsSql); old.exec("DROP INDEX codex_message_attachments_message");
    old.prepare("INSERT INTO codex_message_attachments VALUES(?,?,?,?,?)").run("t", "m", "a", 1, '{"id":"a","name":"retained"}'); old.close();
    let store = new OpenCraftMessageAttachments(root); assert.equal(store.outcome.status, "migrated");
    assert.equal(store.list("t", "m")[0].name, "retained"); store.close();
    store = new OpenCraftMessageAttachments(root); assert.equal(store.outcome.status, "up-to-date"); store.close();
    const tamper = new DatabaseSync(path); tamper.exec("UPDATE schema_migrations SET checksum='wrong'"); tamper.close();
    assert.throws(() => new OpenCraftMessageAttachments(root), fault("history-mismatch"));
    const newer = new DatabaseSync(path); newer.exec("UPDATE schema_migrations SET version=99 WHERE version=2"); newer.close();
    assert.throws(() => new OpenCraftMessageAttachments(root), fault("newer-schema"));
    const read = new DatabaseSync(path); assert.equal(read.prepare("SELECT attachment_id FROM opencraft_message_attachments").get()?.attachment_id, "a"); read.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("published Tasks v1 SQL/hash and linked rows remain unchanged; configured startup rejects bad Tasks history", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-tasks-")), path = join(root, "tasks.sqlite");
  try {
    const old = new DatabaseSync(path); old.exec(ledger + ";" + legacyTasksSql);
    old.prepare("INSERT INTO schema_migrations VALUES(1,'tasks-rows',?,1)").run(hash(legacyTasksSql));
    old.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("t", "Retained", "body", "in_progress", "server", "project", 8, 6, 1, 2, null);
    old.prepare("INSERT INTO task_conversations VALUES(?,?,?,?)").run("t", "server", "thread", 3); old.close();
    const store = new TasksSqliteStore(path); assert.equal(store.outcome.status, "migrated");
    assert.equal(store.read("t").revision, 6); assert.equal(store.forConversation("server", "thread").tasks[0].title, "Retained"); store.close();
    const tamper = new DatabaseSync(path); tamper.exec("UPDATE schema_migrations SET checksum='bad'"); tamper.close();
    assert.throws(() => openLocalAgentStorage({ dataDirectory: root }), e => e instanceof SqliteLifecycleError && e.kind === "history-mismatch" && /tasks/.test(e.message));
    const read = new DatabaseSync(path); assert.equal(read.prepare("SELECT revision FROM tasks").get()?.revision, 6); read.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SSH published v1 upgrades with a backup, keeps encrypted rows/key and CAS; reopen is stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-ssh-")), path = join(root, "connections.sqlite");
  try {
    await writeFile(join(root, "credential.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    const old = new DatabaseSync(path); old.exec(ledger + ";" + legacySshSql + ";PRAGMA user_version=1");
    old.prepare("INSERT INTO schema_migrations VALUES(1,'ssh-connections',?,1)").run(hash(legacySshSql));
    // Ciphertext is opaque to schema migration; no credential replacement is allowed.
    old.prepare("INSERT INTO ssh_connections VALUES(?,?,?,?,?)").run("ssh:retained", 9,
      '{"displayName":"Retained","hostname":"fixture.invalid","port":22,"username":"test","enabled":false,"workspaceBrowseRoots":[]}',
      'fixture.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', Buffer.from([1,2,3])); old.close();
    await chmod(path, 0o600);
    let store = new SshConnectionStore(root); assert.equal(store.outcome.status, "migrated"); assert.equal(store.outcome.appliedVersion, 2);
    assert.ok(store.outcome.backupPath); assert.equal(store.get("ssh:retained").revision, 9);
    assert.throws(() => store.remove("ssh:retained", 8), /conflict/); store.close();
    const read = new DatabaseSync(path); assert.deepEqual([...read.prepare("SELECT credential FROM ssh_connections").get()!.credential as Uint8Array], [1,2,3]);
    assert.equal(read.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get()?.checksum, hash(legacySshSql)); read.close();
    store = new SshConnectionStore(root); assert.equal(store.outcome.status, "up-to-date"); store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("ledgered shared state with missing domain objects fails without recreating them", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-domain-")), path = join(root, "opencraft-host-state.sqlite");
  try {
    const owner = new OpenCraftHostStateDatabase(root);
    new OpenCraftMessageSenders(owner.database).record("t", "m", { kind: "employee", loginName: "retained" }); owner.close();
    const edit = new DatabaseSync(path); edit.exec("DROP TABLE ioa_participant_state"); edit.close();
    assert.throws(() => new OpenCraftHostStateDatabase(root), fault("history-mismatch"));
    const read = new DatabaseSync(path); assert.equal(read.prepare("SELECT client_message_id FROM message_senders").get()?.client_message_id, "m");
    assert.equal(read.prepare("SELECT name FROM sqlite_master WHERE name='ioa_participant_state'").get(), undefined); read.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const owner of ["state", "attachments", "tasks"]) test(`unknown unledgered ${owner} storage rejects without replacing the active file`, async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-unknown-"));
  const path = join(root, owner === "state" ? "codex-host-queue.sqlite" : owner === "attachments" ? "codex-message-attachments.sqlite" : "tasks.sqlite");
  try {
    const old = new DatabaseSync(path); old.exec("CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES('retained')"); old.close();
    assert.throws(() => owner === "state" ? new OpenCraftHostStateDatabase(root) : owner === "attachments" ? new OpenCraftMessageAttachments(root) : new TasksSqliteStore(path), fault("unsupported-legacy"));
    const read = new DatabaseSync(path); assert.equal(read.prepare("SELECT value FROM foreign_data").get()?.value, "retained"); read.close();
    assert.ok(!(await readdir(root)).some(name => name.includes(".legacy-")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SSH final migration failure keeps published v1 rows/history and recovery snapshot", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-ssh-rollback-")), path = join(root, "connections.sqlite");
  try {
    await writeFile(join(root, "credential.key"), Buffer.alloc(32, 7), { mode: 0o600 });
    const old = new DatabaseSync(path); old.exec(ledger + ";" + legacySshSql + ";PRAGMA user_version=1");
    old.prepare("INSERT INTO schema_migrations VALUES(1,'ssh-connections',?,1)").run(hash(legacySshSql)); old.close(); await chmod(path, 0o600);
    const exec = DatabaseSync.prototype.exec;
    const mock = t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA user_version=1") throw new Error("synthetic final migration failure");
      return exec.call(this, sql);
    });
    assert.throws(() => new SshConnectionStore(root), fault("io")); mock.mock.restore();
    const read = new DatabaseSync(path); assert.equal(read.prepare("SELECT count(*) AS n FROM schema_migrations").get()?.n, 1); read.close();
    assert.ok((await readdir(root)).some(name => name.includes(".pre-v2-")));
    const retry = new SshConnectionStore(root); assert.equal(retry.outcome.status, "migrated"); retry.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("fresh SSH interrupted after published v1 resumes the final metadata migration", async t => {
  const root = await mkdtemp(join(tmpdir(), "oc-downstream-ssh-fresh-failure-")), path=join(root,"connections.sqlite");
  try {
    const exec=DatabaseSync.prototype.exec;
    const mock=t.mock.method(DatabaseSync.prototype,"exec",function(this:DatabaseSync,sql:string){
      if(sql==="PRAGMA user_version=1")throw new Error("synthetic v2 failure");return exec.call(this,sql);
    });
    assert.throws(()=>new SshConnectionStore(root),fault("io"));mock.mock.restore();
    const read=new DatabaseSync(path);assert.equal(read.prepare("SELECT max(version) AS n FROM schema_migrations").get()?.n,1);read.close();
    const retry=new SshConnectionStore(root);assert.equal(retry.outcome.status,"migrated");assert.equal(retry.outcome.appliedVersion,2);retry.close();
  }finally{await rm(root,{recursive:true,force:true});}
});


test("required Codex state failure prevents native process/open status; unused Tasks do not gate engine connect", async () => {
  const root=await mkdtemp(join(tmpdir(),"oc-downstream-codex-startup-"));
  let spawned=0;
  try {
    const state=new OpenCraftHostStateDatabase(root);new OpenCraftMessageSenders(state.database).record("t","m",null);state.close();
    const bad=new DatabaseSync(join(root,"opencraft-host-state.sqlite"));bad.exec("UPDATE schema_migrations SET version=99 WHERE version=2");bad.close();
    // Private Host Tasks is unopened until a consumer actually uses the feature.
    const tasks=new DatabaseSync(join(root,"tasks.sqlite"));tasks.exec("CREATE TABLE unused_feature(value TEXT)");tasks.close();
    const adapter=new CodexEngineAdapter({executable:"unused",runtimeDirectory:root,dataDirectory:root,nativeCodexHomeDirectory:join(root,"native"),spawnAppServer:()=>{spawned++;throw new Error("unexpected spawn");}});
    await assert.rejects(adapter.connect(),fault("newer-schema"));
    assert.equal(spawned,0);assert.equal(adapter.status.state,"failed");assert.deepEqual(adapter.storageOutcomes,[]);
    const read=new DatabaseSync(join(root,"opencraft-host-state.sqlite"));assert.equal(read.prepare("SELECT client_message_id FROM message_senders").get()?.client_message_id,"m");read.close();await adapter.close();
    const repair=new DatabaseSync(join(root,"opencraft-host-state.sqlite"));repair.exec("UPDATE schema_migrations SET version=2 WHERE version=99");repair.close();
    const retry=new CodexEngineAdapter({executable:"unused",runtimeDirectory:root,dataDirectory:root,nativeCodexHomeDirectory:join(root,"native"),spawnAppServer:()=>{spawned++;throw new Error("synthetic spawn boundary");}});
    await assert.rejects(retry.connect(),/synthetic spawn boundary/);assert.equal(spawned,1,"unused corrupt Tasks never opens during engine connection");await retry.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
