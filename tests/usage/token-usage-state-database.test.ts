import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { TokenUsageStateDatabase, TOKEN_USAGE_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { openManagedDatabase, createSchemaValidator } from "../../packages/sqlite-node/src/index.js";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { CodexTokenUsageRuntime } from "../../apps/opencraft-daemon/src/token-usage-runtime.js";
import { readTeamUsage } from "../../apps/opencraft-daemon/src/token-usage-team-query.js";

const key = { threadId: "thread", turnId: "turn" };
function seed(state: Pick<OpenCraftHostStateDatabase, "database" | "transaction">, id = "response", tokens = "600") {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true);
  for (const actorId of ["A", "B"]) ledger.recordInput(key, { inputId: actorId, actorId, actorKind: "human", mode: "start", admission: "confirmed" });
  ledger.recordSource({ ...key, lineage: "native", sourceId: id, kind: "response", version: 0, provider: "provider", model: "model", counts: { totalTokens: tokens } });
  ledger.reconcile(key, { executionState: "completed", participantsComplete: true, usageComplete: true, responsesComplete: true });
  ledger.rememberRollout(key.threadId, "/fixture/rollout.jsonl");
  ledger.advanceRollout(key.threadId, "/fixture/rollout.jsonl", "123");
  return ledger;
}
async function fixture(run: (directory: string, legacy: OpenCraftHostStateDatabase) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "oc-token-owner-"));
  const legacy = new OpenCraftHostStateDatabase(directory);
  try { await run(directory, legacy); } finally { legacy.close(); await rm(directory, { recursive: true, force: true }); }
}

test("unchanged native metadata does not rewrite projections; late evidence still reallocates", () => fixture((directory) => {
  const state = new TokenUsageStateDatabase(directory);
  try {
    const ledger = seed(state);
    const complete = { executionState: "completed" as const, participantsComplete: true, usageComplete: true, responsesComplete: true };
    ledger.recordInput(key, { inputId: "late", actorId: null, actorKind: "unknown", mode: "steer", admission: "pending" });
    assert.equal(ledger.readTurn(key)?.allocationState, "pending");
    const before = ledger.readTurn(key);
    const scope = ledger.coverage().revision;
    const changes = () => state.database.prepare("SELECT total_changes() AS n").get()!.n;
    const priorChanges = changes();
    for (let i = 0; i < 100; i++) {
      ledger.reconcile(key, complete);
      ledger.rememberRollout(key.threadId, "/fixture/rollout.jsonl");
      ledger.advanceMetadataCursor(key.threadId, null);
    }
    assert.equal(changes(), priorChanges, "metadata polling must not write or rebuild unchanged state");
    assert.deepEqual(ledger.readTurn(key), before);
    assert.equal(ledger.coverage().revision, scope);
    assert.throws(() => ledger.rememberRollout(key.threadId, "/changed.jsonl"), /source changed/);
    ledger.recordInput(key, { inputId: "late", actorId: "C", actorKind: "human", mode: "steer", admission: "confirmed" });
    assert.equal(ledger.readTurn(key)?.allocationState, "settled");
    assert.deepEqual(ledger.readAllocations(key).map(row => row.tokens), ["200", "200", "200"]);
    ledger.recordSource({ ...key, lineage: "native", sourceId: "late-response", kind: "response", version: 0, provider: "provider", model: "model", counts: { totalTokens: "300" } });
    assert.deepEqual(ledger.readAllocations(key).map(row => row.tokens), ["300", "300", "300"]);
    assert.throws(() => ledger.reconcile(key, { ...complete, executionState: "running" }), /return to running/);
    ledger.advanceMetadataCursor(key.threadId, "next-page");
    assert.equal(ledger.metadataCursor(key.threadId), "next-page");
    ledger.advanceMetadataCursor(key.threadId, null);
    assert.equal(ledger.metadataCursor(key.threadId), null);
  } finally { state.close(); }
}));

test("v1 dedicated store upgrades its thread index without changing facts, allocation or published migration", () => fixture((directory) => {
  const path = join(directory, "token-usage.sqlite");
  const baseline = TOKEN_USAGE_STATE_MIGRATIONS[0];
  const old = openManagedDatabase({ path, legacyPolicy: "reject-unknown", migrations: [baseline], validateSchema: createSchemaValidator(baseline.sql) });
  const owner = { database: old.database, transaction<T>(callback: () => T): T {
    old.database.exec("BEGIN IMMEDIATE");
    try { const value = callback(); old.database.exec("COMMIT"); return value; }
    catch (error) { old.database.exec("ROLLBACK"); throw error; }
  } };
  const ledger = seed(owner);
  const query = { from: "1970-01-01", through: "1970-01-01", scope: "team", view: "turns", threadId: key.threadId };
  const authorize = () => ({ actorId: "admin", administrator: true });
  const before = ledger.query(query, authorize);
  const migration = old.database.prepare("SELECT * FROM schema_migrations WHERE version=1").get();
  const facts = old.database.prepare("SELECT * FROM token_usage_sources").all();
  old.database.close();
  let upgraded = new TokenUsageStateDatabase(directory);
  try {
    assert.equal(upgraded.outcome.appliedVersion, 2);
    assert.equal(upgraded.outcome.status, "migrated");
    assert.ok(upgraded.outcome.backupPath);
    assert.deepEqual(upgraded.database.prepare("SELECT * FROM schema_migrations WHERE version=1").get(), migration);
    assert.deepEqual(upgraded.database.prepare("SELECT * FROM token_usage_sources").all(), facts);
    assert.deepEqual(new OpenCraftTokenUsageLedger(upgraded, "server", () => 1000).query(query, authorize), before);
    const plan = upgraded.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM token_usage_turns WHERE server_id=? AND started_ms>=? AND started_ms<? AND thread_id=?").all("server", 0, 86400000, key.threadId);
    assert.ok(plan.some(row => String(row.detail).includes("token_usage_turns_thread_query")), JSON.stringify(plan));
    const statements: string[] = [];
    const filtered = readTeamUsage({ prepare(sql: string) { statements.push(sql); return upgraded.database.prepare(sql); } },
      { serverId: "server", start: 0, end: 86400000, threadId: key.threadId, view: "turns", after: "", limit: 100 });
    assert.equal(filtered.known, 600n);
    assert.equal(filtered.turnCount, 1);
    for (const sql of statements.filter(sql => sql.startsWith("WITH selected AS"))) {
      const parameters: (string | number)[] = ["server", 0, 86400000, key.threadId];
      if (sql.includes("LIMIT ?")) parameters.push("", 101);
      const actualPlan = upgraded.database.prepare("EXPLAIN QUERY PLAN " + sql).all(...parameters);
      assert.ok(actualPlan.some(row => String(row.detail).includes("token_usage_turns_thread_query")), JSON.stringify(actualPlan));
    }
  } finally { upgraded.close(); }
  upgraded = new TokenUsageStateDatabase(directory);
  try { assert.equal(upgraded.outcome.status, "up-to-date"); assert.equal(upgraded.outcome.backupPath, undefined); }
  finally { upgraded.close(); }
}));

test("thread index upgrade rejects a changed published v1 checksum without changing facts or installing v2", () => fixture((directory) => {
  const path = join(directory, "token-usage.sqlite"), baseline = TOKEN_USAGE_STATE_MIGRATIONS[0];
  const old = openManagedDatabase({ path, legacyPolicy: "reject-unknown", migrations: [baseline], validateSchema: createSchemaValidator(baseline.sql) });
  old.database.prepare("INSERT INTO token_usage_checkpoints VALUES(?,?,?)").run("server", "native", "preserved-cursor");
  old.database.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run("tampered");
  old.database.close();
  assert.throws(() => new TokenUsageStateDatabase(directory), /history|checksum/i);
  const verify = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(verify.prepare("SELECT count(*) AS n FROM schema_migrations").get()!.n, 1);
    assert.equal(verify.prepare("SELECT cursor FROM token_usage_checkpoints WHERE server_id='server' AND lineage='native'").get()!.cursor, "preserved-cursor");
    assert.equal(verify.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='token_usage_turns_thread_query'").get()!.n, 0);
  } finally { verify.close(); }
}));

test("dedicated metering owner copies all facts and recovery state exactly once without sender data or legacy writes", () => fixture((directory, legacy) => {
  const old = seed(legacy);
  legacy.database.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("thread", "body", "SENSITIVE_SYNTHETIC_CANARY", 1000);
  const before = legacy.database.prepare("SELECT * FROM token_usage_sources").all();
  const path = legacy.path;
  let isolated = new TokenUsageStateDatabase(directory, path);
  assert.deepEqual(isolated.database.prepare("SELECT * FROM token_usage_sources").all(), before);
  assert.equal(isolated.database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='message_senders'").get()!.n, 0);
  const ledger = new OpenCraftTokenUsageLedger(isolated, "server", () => 1000);
  assert.equal(ledger.readTurn(key)?.observedTokens, "600");
  assert.deepEqual(ledger.readAllocations(key).map(row => row.tokens), ["300", "300"]);
  assert.equal(ledger.rollout(key.threadId)?.cursor, "123");
  seed(isolated, "new-response", "200");
  isolated.close();
  isolated = new TokenUsageStateDatabase(directory, path);
  try {
    assert.equal(new OpenCraftTokenUsageLedger(isolated, "server", () => 1000).readTurn(key)?.observedTokens, "800");
    assert.equal(isolated.database.prepare("SELECT count(*) AS n FROM token_usage_legacy_import").get()!.n, 1);
    assert.equal(old.readTurn(key)?.observedTokens, "600");
    assert.deepEqual(legacy.database.prepare("SELECT * FROM token_usage_sources").all(), before);
    assert.equal(legacy.database.prepare("SELECT sender_json FROM message_senders").get()!.sender_json, "SENSITIVE_SYNTHETIC_CANARY");
  } finally { isolated.close(); }
}));

test("a failed late import rolls back every copied table and can retry with the same managed destination", () => fixture((directory, legacy) => {
  seed(legacy);
  legacy.database.exec("ALTER TABLE token_usage_turns ADD COLUMN synthetic_extra TEXT");
  assert.throws(() => new TokenUsageStateDatabase(directory, legacy.path), /schema mismatch/);
  const raw = new DatabaseSync(join(directory, "token-usage.sqlite"));
  try {
    assert.equal(raw.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n, 0);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM token_usage_legacy_import").get()!.n, 0);
  } finally { raw.close(); }
  legacy.database.exec("ALTER TABLE token_usage_turns DROP COLUMN synthetic_extra");
  const isolated = new TokenUsageStateDatabase(directory, legacy.path);
  try { assert.equal(isolated.database.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n, 1); }
  finally { isolated.close(); }
}));

test("a metering writer lock cannot lock the Host sender owner, and unwritable gap evidence remains visible in memory", () => fixture((directory, legacy) => {
  const isolated = new TokenUsageStateDatabase(directory, legacy.path);
  const ledger = new OpenCraftTokenUsageLedger(isolated, "server", () => 1000);
  const runtime = new CodexTokenUsageRuntime(ledger, { request: async () => ({}), diagnostic: () => {} });
  const blocker = new DatabaseSync(join(directory, "token-usage.sqlite"));
  blocker.exec("BEGIN IMMEDIATE");
  try {
    legacy.database.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("thread", "input", "{}", 1000);
    runtime.submission({ threadId: "thread", inputId: "input", actorId: "A", actorKind: "human", mode: "start", sourceKind: "human", submittedAt: 1000 });
    assert.equal(runtime.liveGapCount(), 1, "failure remains partial even though the fault could not persist itself");
    assert.equal(legacy.database.prepare("SELECT count(*) AS n FROM message_senders").get()!.n, 1);
  } finally { blocker.exec("ROLLBACK"); blocker.close(); runtime.close(); isolated.close(); }
}));

test("a legacy writer after cutover is rejected without overwriting either history", () => fixture((directory, legacy) => {
  seed(legacy);
  const path = legacy.path;
  const isolated = new TokenUsageStateDatabase(directory, path);
  seed(isolated, "new-owner", "200");
  isolated.close();
  seed(legacy, "legacy-writer", "300");
  assert.throws(() => new TokenUsageStateDatabase(directory, path), /changed after cutover/);
  const raw = new DatabaseSync(join(directory, "token-usage.sqlite"), { readOnly: true });
  try { assert.equal(raw.prepare("SELECT observed_tokens FROM token_usage_turns").get()!.observed_tokens, "800"); }
  finally { raw.close(); }
  assert.equal(new OpenCraftTokenUsageLedger(legacy, "server", () => 1000).readTurn(key)?.observedTokens, "900");
}));
