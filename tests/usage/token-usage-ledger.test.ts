import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { OpenCraftTokenUsageLedger, normalizeUsageCounts, type UsageSource } from "../../apps/opencraft-daemon/src/token-usage-ledger.js";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database.js";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index.js";

const key = { threadId: "thread", turnId: "turn" };
const input = (actorId = "A", inputId = actorId) => ({ inputId, actorId, actorKind: "human" as const, mode: "start" as const, admission: "confirmed" as const });
const source = (amount = "100", id = "response", extra: Partial<UsageSource> = {}): UsageSource => ({
  ...key, lineage: "native:epoch", sourceId: id, kind: "response", version: 0, provider: "p", model: "m", counts: { totalTokens: amount }, ...extra,
});
const complete = { executionState: "completed" as const, participantsComplete: true, usageComplete: true, responsesComplete: true };

async function fixture(body: (state: TokenUsageStateDatabase, directory: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "oc-token-usage-"));
  const state = new TokenUsageStateDatabase(directory);
  try { await body(state, directory); } finally { state.close(); await rm(directory, { recursive: true, force: true }); }
}

test("F-01/F-02/F-06: calls accumulate once, successful late input reallocates the entire turn", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input());
  for (const [i, amount] of ["100", "200", "300"].entries()) ledger.recordSource(source(amount, String(i)));
  assert.equal(ledger.readTurn(key)?.observedTokens, "600");
  assert.deepEqual(ledger.readAllocations(key).map(r => r.tokens), ["600"]);
  ledger.recordInput(key, { ...input("B"), mode: "steer" });
  assert.deepEqual(ledger.readAllocations(key).map(r => r.tokens), ["300", "300"]);
  assert.equal(ledger.readTurn(key)?.allocationState, "provisional");
  ledger.reconcile(key, complete);
  assert.equal(ledger.readTurn(key)?.allocationState, "settled");
}));

test("F-04/F-16/F-20: unknown admission holds all known tokens pending; verified late evidence releases allocation", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input()); ledger.recordSource(source("120000"));
  const pending = { inputId: "steer", actorId: null, actorKind: "unknown" as const, mode: "steer" as const, admission: "pending" as const };
  ledger.recordInput(key, pending);
  assert.equal(ledger.readTurn(key)?.participantsComplete, false);
  assert.equal(ledger.readTurn(key)?.observedTokens, "120000");
  assert.equal(ledger.readTurn(key)?.allocationState, "pending"); assert.deepEqual(ledger.readAllocations(key), []);
  ledger.reconcile(key, complete);
  assert.equal(ledger.readTurn(key)?.allocationState, "pending", "terminal does not prove participant completeness");
  ledger.recordInput(key, { ...input("B", "steer"), mode: "steer" });
  assert.equal(ledger.readTurn(key)?.allocationState, "settled");
  assert.deepEqual(ledger.readAllocations(key).map(r => r.tokens), ["60000", "60000"]);
  assert.throws(() => ledger.recordInput(key, { ...input("C", "steer"), mode: "steer" }), /identity/);
}));

test("pending identity can resolve before admission, without prematurely allocating the known amount", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input()); ledger.recordSource(source());
  ledger.recordInput(key, { inputId: "pending", actorId: null, actorKind: "unknown", mode: "steer", admission: "pending" });
  assert.equal(ledger.recordInput(key, { inputId: "pending", actorId: "B", actorKind: "human", mode: "steer", admission: "pending" }), true);
  assert.equal(ledger.readTurn(key)?.allocationState, "pending");
  ledger.recordInput(key, { inputId: "pending", actorId: "B", actorKind: "human", mode: "steer", admission: "confirmed" });
  assert.deepEqual(ledger.readAllocations(key).map(row => row.tokens), ["50", "50"]);
}));

test("metering contention fails immediately and restores the shared owner's busy timeout", () => fixture((state, directory) => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true);
  const blocker = new DatabaseSync(join(directory, "token-usage.sqlite"));
  const before = state.database.prepare("PRAGMA busy_timeout").get()!.timeout;
  blocker.exec("BEGIN IMMEDIATE");
  try {
    const start = performance.now();
    assert.throws(() => ledger.recordSource(source()), /locked/);
    assert.ok(performance.now() - start < 1000, "metering waited for the normal five-second SQLite timeout");
    assert.equal(state.database.prepare("PRAGMA busy_timeout").get()!.timeout, before);
    assert.equal(ledger.readTurn(key)?.observedTokens, null);
  } finally { blocker.exec("ROLLBACK"); blocker.close(); }
  assert.equal(ledger.recordSource(source()), "inserted");
}));

test("durable trusted submissions join native admission targets through a new ledger instance, with unmatched late steer held pending", () => fixture(state => {
  let ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.recordSubmission({threadId:key.threadId,inputId:"start-A",actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000});
  // Native input arrives before its turn lifecycle observation.
  ledger.recordAdmission(key,"start-A");
  ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key,1000,"unknown",true);
  ledger.recordSource(source("1000"));
  assert.equal(ledger.readTurn(key)?.sourceKind,"human");
  assert.deepEqual(ledger.readAllocations(key).map(row=>row.tokens),["1000"]);
  ledger.recordAdmission(key,"steer-B");
  assert.equal(ledger.readTurn(key)?.participantsComplete,false);
  assert.equal(ledger.readTurn(key)?.allocationState,"pending");
  assert.deepEqual(ledger.readAllocations(key),[]);
  ledger.recordSubmission({threadId:key.threadId,inputId:"steer-B",actorId:"B",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:1000});
  assert.deepEqual(ledger.readAllocations(key).map(row=>row.tokens),["500","500"]);
  assert.equal(ledger.recordAdmission(key,"steer-B"),false);
  assert.throws(()=>ledger.recordAdmission({...key,turnId:"other"},"steer-B"),/cannot change target/);
  assert.equal(ledger.recordSubmission({threadId:key.threadId,inputId:"steer-B",actorId:"C",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:1000}),false);
  assert.equal(ledger.readTurn(key)?.allocationState,"pending","conflicting trusted identity holds the entire turn instead of charging the earlier Actor");
  assert.deepEqual(ledger.readAllocations(key),[]);
  const restored=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
  restored.reconcile(key,complete);
  assert.equal(restored.readTurn(key)?.allocationState,"pending","restart and terminal reconciliation do not clear identity ambiguity");
  assert.equal(state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_submissions").get()!.n,2);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_admissions").get()!.n,2);
}));

test("a submission without native admission is excluded, including a rejected steer and an unclaimed queue input",()=>fixture(state=>{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
  ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,input());ledger.recordSource(source("100"));
  ledger.recordSubmission({threadId:key.threadId,inputId:"not-admitted",actorId:"B",actorKind:"human",mode:"steer",sourceKind:"human",submittedAt:1000});
  assert.deepEqual(ledger.readAllocations(key).map(row=>row.actorId),["A"]);
  assert.equal(ledger.readTurn(key)?.participantsComplete,true);
}));

test("persisted source gaps preserve known counts while preventing a complete settlement declaration",()=>fixture(state=>{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
  ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,input());
  ledger.recordSourceBatch([source(),source("100","native-turn",{kind:"turn-snapshot"})]);
  ledger.recordNativeTerminal(key);
  ledger.reconcile(key,{executionState:"completed",participantsComplete:true,...ledger.nativeSettlement(key)});
  assert.equal(ledger.readTurn(key)?.allocationState,"settled");
  ledger.noteGap({id:"offline",...key,reason:"source-offline"});
  assert.equal(ledger.readTurn(key)?.observedTokens,"100");
  assert.equal(ledger.readTurn(key)?.usageComplete,false);
  assert.equal(ledger.nativeSettlement(key).usageComplete,false);
  assert.equal(ledger.gaps()[0]?.endsAt,null);
  ledger.resolveGap("offline");
  assert.equal(ledger.nativeSettlement(key).usageComplete,true);
  assert.equal(ledger.gaps()[0]?.endsAt,1000);
  assert.throws(()=>ledger.noteGap({id:"unsafe",reason:"SENSITIVE_BODY" as never}),/Unknown usage gap category/);
}));

test("v6 metering sources survive the additive v7/v8 recovery upgrade with their published migration checksum",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"oc-token-v6-upgrade-"));
  try {
    const previous=openManagedDatabase({path:join(directory,"codex-host-queue.sqlite"),legacyPolicy:"reject",migrations:OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0,6)});
    previous.database.prepare("INSERT INTO token_usage_sources VALUES(?,?,?,?,?,?,?,?,?,?)").run("server","thread","turn","native","response","response",0,null,null,JSON.stringify({totalTokens:"123"}));
    const checksum=previous.database.prepare("SELECT checksum FROM schema_migrations WHERE version=6").get()!.checksum;
    previous.database.close();
    const upgraded=new OpenCraftHostStateDatabase(directory);
    try {
      assert.equal(upgraded.outcome.appliedVersion,14);
      assert.equal(upgraded.database.prepare("SELECT checksum FROM schema_migrations WHERE version=6").get()!.checksum,checksum);
      const source=upgraded.database.prepare("SELECT counts_json,observed_ms FROM token_usage_sources").get()!;
      assert.equal(JSON.parse(String(source.counts_json)).totalTokens,"123");
      assert.equal(source.observed_ms,0,"historical observation time remains explicitly unavailable");
    } finally {upgraded.close();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test("a late verified initiator receipt resolves unknown origin without assigning a viewing or steering human as initiator", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "unknown", true); ledger.recordSource(source("10"));
  ledger.recordInput(key, { ...input("B"), mode: "steer" });
  assert.equal(ledger.readTurn(key)?.sourceKind, "unknown"); assert.deepEqual(ledger.readAllocations(key), []);
  ledger.recordInput(key, input("A"));
  assert.equal(ledger.readTurn(key)?.sourceKind, "human");
  assert.deepEqual(ledger.readAllocations(key).map(r => r.tokens), ["5", "5"]);
}));

test("rejected input is excluded, repeated actor inputs do not increase allocation weight", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input());
  ledger.recordInput(key, { ...input("B"), admission: "rejected", mode: "steer" });
  for (let i = 0; i < 5; i++) ledger.recordInput(key, { ...input("A", `A:${i}`), mode: "steer" });
  ledger.recordSource(source("10"));
  assert.deepEqual(ledger.readAllocations(key).map(r => [r.actorId, r.tokens]), [["A", "10"]]);
}));

test("F-09: immutable replay is idempotent; corrections replace facts and responses never add to snapshots", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input());
  assert.equal(ledger.recordSource(source("100")), "inserted");
  const revision = ledger.coverage().revision;
  for (let i = 0; i < 10; i++) assert.equal(ledger.recordSource(source("100")), "duplicate");
  assert.equal(ledger.coverage().revision, revision);
  assert.throws(() => ledger.recordSource(source("999")), /immutable/);
  assert.equal(ledger.recordSource(source("120", "response", { version: 1 })), "corrected");
  ledger.recordSource(source("120", "per-turn-total", { kind: "turn-snapshot" }));
  assert.equal(ledger.readTurn(key)?.observedTokens, "120");
  ledger.reconcile(key, complete);
  assert.equal(ledger.readTurn(key)?.observedTokens, "120");
  assert.equal(state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_sources").get()?.n, 2);
}));

test("F-08: category subsets are never added to totals and missing categories stay null", () => {
  const counts = normalizeUsageCounts({ totalTokens: "1000", inputTokens: 800, cachedInputTokens: 300, outputTokens: 200, reasoningOutputTokens: 100,
    prompt: "synthetic-sensitive-canary", toolOutput: "synthetic-tool-canary" });
  assert.equal(counts.totalTokens, "1000"); assert.equal(counts.cacheWriteInputTokens, null);
  assert.ok(!JSON.stringify(counts).includes("canary"));
  assert.throws(() => normalizeUsageCounts({ totalTokens: "1", inputTokens: 1, cachedInputTokens: 2 }), /subset/);
});

test("F-10: failed and interrupted turns preserve actual incurred counts", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  for (const [turnId, amount, executionState] of [["failed", "300", "failed"], ["interrupted", "200", "interrupted"]] as const) {
    const turn = { ...key, turnId };
    ledger.startTurn(turn, 1000, "human", true); ledger.recordInput(turn, input("A", turnId)); ledger.recordSource(source(amount, turnId, turn));
    ledger.reconcile(turn, { ...complete, executionState });
    assert.equal(ledger.readTurn(turn)?.observedTokens, amount); assert.equal(ledger.readTurn(turn)?.allocationState, "settled");
  }
}));

test("F-12: coverage survives reopen; disabling freezes current turns and excludes turns started during gaps", () => fixture(state => {
  let now = 1000;
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => now);
  assert.equal(ledger.startTurn(key, 999, "human"), false);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input()); ledger.recordSource(source("10"));
  now = 1500; ledger.setEnabled(false);
  assert.equal(ledger.recordSource(source("100", "late")), "excluded");
  now = 2000; ledger.setEnabled(true);
  assert.equal(ledger.startTurn({ ...key, turnId: "gap" }, 1600, "human"), false);
  assert.equal(ledger.startTurn({ ...key, turnId: "new" }, 2000, "human"), true);
  assert.equal(ledger.readTurn(key)?.observedTokens, "10"); assert.equal(ledger.readTurn(key)?.frozen, true);
  assert.equal(new OpenCraftTokenUsageLedger(state, "server", () => 3000).coverage().enabledAt, 1000);
  assert.deepEqual(ledger.coverage().intervals, [{ startsAt: 1000, endsAt: 1500 }, { startsAt: 2000, endsAt: null }]);
}));

test("F-15/NF-02: projection failure rolls back facts and the recovery cursor atomically", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  ledger.startTurn(key, 1000, "human", true); ledger.recordInput(key, input());
  state.database.exec("CREATE TEMP TRIGGER reject_allocation BEFORE INSERT ON token_usage_allocations BEGIN SELECT RAISE(ABORT,'synthetic allocation failure'); END");
  assert.throws(() => ledger.recordSource(source("100", "response", { cursor: "cursor:1" })), /synthetic/);
  assert.equal(state.database.prepare("SELECT COUNT(*) AS n FROM token_usage_sources").get()?.n, 0);
  assert.equal(ledger.checkpoint("native:epoch"), null);
  assert.equal(ledger.readTurn(key)?.observedTokens, null);
  state.database.exec("DROP TRIGGER reject_allocation");
  ledger.recordSource(source("100", "response", { cursor: "cursor:1" }));
  assert.equal(ledger.checkpoint("native:epoch"), "cursor:1"); assert.equal(ledger.readTurn(key)?.observedTokens, "100");
}));

test("F-16: known system/unknown usage never receives human allocations; an unreported count stays unknown", () => fixture(state => {
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => 1000);
  for (const sourceKind of ["system", "unknown"] as const) {
    const turn = { ...key, turnId: sourceKind }; ledger.startTurn(turn, 1000, sourceKind);
    ledger.recordSource(source("42", sourceKind, turn));
    assert.equal(ledger.readTurn(turn)?.allocationState, sourceKind); assert.deepEqual(ledger.readAllocations(turn), []);
  }
  ledger.startTurn(key, 1000, "human"); ledger.reconcile(key, { ...complete, usageComplete: false });
  assert.equal(ledger.readTurn(key)?.observedTokens, null);
  assert.equal(ledger.readTurn(key)?.allocationState, "pending");
}));

test("NF-11: upgrade from the published v5 preserves queue/sender data and rejects a modified published checksum", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-token-v5-"));
  try {
    const path = join(root, "codex-host-queue.sqlite");
    const old = openManagedDatabase({ path, migrations: OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0, 5) });
    old.database.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("old-thread", "old-input", '{"kind":"synthetic"}', 42);
    old.database.close();
    const upgraded = new OpenCraftHostStateDatabase(root);
    assert.equal(upgraded.outcome.status, "migrated"); assert.equal(upgraded.outcome.appliedVersion, 14);
    assert.equal(upgraded.database.prepare("SELECT accepted_at_ms FROM message_senders").get()?.accepted_at_ms, 42);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS n FROM token_usage_sources").get()?.n, 0);
    upgraded.database.exec("UPDATE schema_migrations SET checksum='synthetic-invalid-checksum' WHERE version=5");
    upgraded.close();
    assert.throws(() => new OpenCraftHostStateDatabase(root), (e: unknown) => (e as { kind?: string }).kind === "history-mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the exact unledgered v5 layout accepted before metering remains upgradable without losing data", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-token-legacy-v5-"));
  try {
    const old = new DatabaseSync(join(root, "codex-host-queue.sqlite"));
    old.exec(OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0, 5).map(m => m.sql).join("\n"));
    old.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run("old-thread", "old-input", '{}', 42); old.close();
    const upgraded = new OpenCraftHostStateDatabase(root);
    assert.equal(upgraded.outcome.status, "migrated");
    assert.equal(upgraded.database.prepare("SELECT accepted_at_ms FROM message_senders").get()?.accepted_at_ms, 42);
    assert.equal(upgraded.database.prepare("SELECT COUNT(*) AS n FROM token_usage_sources").get()?.n, 0);
    upgraded.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("successful replay repairs persisted transient gaps across restart without clearing invalid source evidence",()=>fixture(state=>{
 let ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 ledger.noteGap({id:"offline",threadId:"thread",reason:"source-offline"});
 ledger.noteGap({id:"invalid",threadId:"thread",reason:"invalid-source"});
 ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1100);
 ledger.resolveReplayGaps("thread");
 assert.equal(ledger.gaps().find(g=>g.id==="offline")!.endsAt,1100);
 assert.equal(ledger.gaps().find(g=>g.id==="invalid")!.endsAt,null);
}));

test("a proven admission with initially missing identity can resolve from a trusted receipt without becoming a conflict",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 ledger.recordSubmission({threadId:key.threadId,inputId:"late-start",actorId:null,actorKind:"unknown",mode:"start",sourceKind:"unknown",submittedAt:1000});
 ledger.startTurn(key,1000,"unknown",true);ledger.recordAdmission(key,"late-start");ledger.recordSource(source("100"));ledger.reconcile(key,complete);
 assert.deepEqual(ledger.unresolvedInputIds(key.threadId),["late-start"]);
 assert.deepEqual(ledger.readAllocations(key),[]);
 ledger.recordSubmission({threadId:key.threadId,inputId:"late-start",actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000});
 assert.deepEqual(ledger.unresolvedInputIds(key.threadId),[]);assert.equal(ledger.readTurn(key)?.allocationState,"settled");
 assert.equal(ledger.readAllocations(key)[0]!.tokens,"100");
 assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts").get()!.n,0);
}));

test("daily projections preserve missing turns, corrections, frozen turns and bounded restart backfill",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000),db=state.database;
 const daily=()=>db.prepare("SELECT tokens,turns,missing_usage FROM token_usage_daily WHERE server_id='server' AND model_filter=0").all();
 ledger.startTurn(key,1000,"human",true);
 assert.deepEqual(daily().map(r=>[r.tokens,r.turns,r.missing_usage]),[["0",1,1]]);
 ledger.recordSource(source("100"));
 ledger.recordSource(source("160","response",{version:1}));
 assert.deepEqual(daily().map(r=>[r.tokens,r.turns,r.missing_usage]),[["160",1,0]]);
 // Simulate a pre-projection upgrade, retaining all authoritative facts.
 state.transaction(()=>{db.exec("DELETE FROM token_usage_daily; DELETE FROM token_usage_turn_projections");db.prepare("UPDATE token_usage_projection_state SET ready=0,cursor_thread='',cursor_turn='' WHERE server_id='server'").run();});
 assert.equal(ledger.backfillProjectionBatch(1),false);
 const restarted=new OpenCraftTokenUsageLedger(state,"server",()=>1001);
 assert.equal(restarted.projectionReady(),false);
 assert.equal(restarted.backfillProjectionBatch(1),true);
 assert.deepEqual(daily().map(r=>[r.tokens,r.turns,r.missing_usage]),[["160",1,0]]);
 restarted.setEnabled(false);
 assert.deepEqual(daily().map(r=>[r.tokens,r.turns,r.missing_usage]),[["160",1,1]]);
}));

test("daily projection failure cannot commit source facts or advance its cursor",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000),db=state.database;
 ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,input());
 const before=db.prepare("SELECT * FROM token_usage_daily").all();
 db.exec("CREATE TEMP TRIGGER reject_daily BEFORE INSERT ON token_usage_daily BEGIN SELECT RAISE(ABORT,'synthetic daily failure'); END");
 assert.throws(()=>ledger.recordSource(source("100","response",{cursor:"after:1"})),/synthetic daily/);
 assert.equal(db.prepare("SELECT count(*) AS n FROM token_usage_sources").get()!.n,0);
 assert.equal(ledger.checkpoint("native:epoch"),null);
 assert.deepEqual(db.prepare("SELECT * FROM token_usage_daily").all(),before);
 db.exec("DROP TRIGGER reject_daily");
 ledger.recordSource(source("100","response",{cursor:"after:1"}));
 assert.equal(ledger.checkpoint("native:epoch"),"after:1");
}));

test("rejected steer may become a new start attempt without changing the requester or inventing admission",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 const submission={threadId:key.threadId,inputId:"queued-B",actorId:"B",actorKind:"human" as const,mode:"steer" as const,sourceKind:"human" as const,submittedAt:1000};
 ledger.recordAttempt("steer-attempt",submission);
 ledger.recordAttemptOutcome("steer-attempt","rejected");
 ledger.recordAttempt("start-attempt",{...submission,mode:"start"});
 ledger.recoverSubmission(submission); // Historical queue intent is not dispatch mode.
 assert.equal(ledger.storedSubmission(key.threadId,submission.inputId)?.mode,"start");
 assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts").get()!.n,0);
 ledger.startTurn(key,1000,"unknown",true);ledger.recordSource(source("100"));
 assert.equal(ledger.readAllocations(key).length,0);
 ledger.recordAttemptOutcome("start-attempt","accepted",key.turnId);
 assert.equal(ledger.readAllocations(key).length,0); // Only native admission allocates.
 ledger.recordAdmission(key,submission.inputId);ledger.reconcile(key,complete);
 assert.deepEqual(ledger.readAllocations(key).map(r=>[r.actorId,r.tokens]),[["B","100"]]);
 assert.deepEqual(state.database.prepare("SELECT mode,outcome FROM token_usage_attempts ORDER BY submitted_ms,attempt_id").all().map(r=>[r.mode,r.outcome]),[["start","accepted"],["steer","rejected"]]);
}));

test("uncertain delivery cannot authorize a mode conversion or a different Actor",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 const submission={threadId:key.threadId,inputId:"uncertain",actorId:"B",actorKind:"human" as const,mode:"steer" as const,sourceKind:"human" as const,submittedAt:1000};
 ledger.recordAttempt("unknown-attempt",submission);ledger.recordAttemptOutcome("unknown-attempt","unknown");
 ledger.recordAttempt("unsafe-retry",{...submission,mode:"start"});
 assert.equal(ledger.storedSubmission(key.threadId,submission.inputId)?.mode,"steer");
 assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts").get()!.n,1);
 ledger.recordAttempt("actor-reuse",{...submission,actorId:"C"});
 assert.equal(ledger.storedSubmission(key.threadId,submission.inputId)?.actorId,"B");
 ledger.startTurn(key,1000,"human",true);ledger.recordAdmission(key,submission.inputId);ledger.recordSource(source("100"));ledger.reconcile(key,complete);
 assert.equal(ledger.readTurn(key)?.allocationState,"pending");assert.equal(ledger.readAllocations(key).length,0);
}));

test("pending attempts survive restart as unknown; a verified late ACK may resolve uncertainty",()=>fixture(state=>{
 let ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 ledger.recordAttempt("lost-ack",{threadId:key.threadId,inputId:"A",actorId:"A",actorKind:"human",mode:"start",sourceKind:"human",submittedAt:1000});
 ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1001);
 assert.equal(state.database.prepare("SELECT outcome FROM token_usage_attempts WHERE attempt_id='lost-ack'").get()!.outcome,"unknown");
 assert.equal(state.database.prepare("SELECT reason FROM token_usage_gaps WHERE ends_ms IS NULL").get()!.reason,"source-offline");
 ledger.recordAttemptOutcome("lost-ack","accepted",key.turnId);
 assert.throws(()=>ledger.recordAttemptOutcome("lost-ack","rejected"),/cannot change/);
 assert.equal(state.database.prepare("SELECT outcome FROM token_usage_attempts WHERE attempt_id='lost-ack'").get()!.outcome,"accepted");
}));


test("a queue input rejected for one requester may later be dispatched by another verified requester",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000);
 const original={threadId:key.threadId,inputId:"handoff",actorId:"A",actorKind:"human" as const,mode:"start" as const,sourceKind:"human" as const,submittedAt:1000};
 ledger.recoverSubmission(original);
 const first={...original,actorId:"B",mode:"steer" as const};
 ledger.recordAttempt("B-rejected",first);ledger.recordAttemptOutcome("B-rejected","rejected");
 ledger.recordAttempt("A-accepted",original);ledger.recordAttemptOutcome("A-accepted","accepted",key.turnId);
 ledger.startTurn(key,1000,"unknown",true);ledger.recordAdmission(key,original.inputId);ledger.recordSource(source("101"));ledger.reconcile(key,complete);
 ledger.recordAttempt("B-rejected",first); // replay of an older attempt cannot alter current identity
 assert.equal(ledger.storedSubmission(key.threadId,original.inputId)?.actorId,"A");
 assert.deepEqual(ledger.readAllocations(key).map(r=>[r.actorId,r.tokens]),[["A","101"]]);
 assert.equal(state.database.prepare("SELECT count(*) AS n FROM token_usage_input_conflicts").get()!.n,0);
 assert.throws(()=>ledger.recordAttempt("B-rejected",{...first,actorId:"C"}),/Immutable/);
}));


test("actor daily projection replaces corrections, distinct people and frozen contributions atomically",()=>fixture(state=>{
 const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1000),db=state.database;
 const rows=()=>db.prepare("SELECT actor_id,tokens,turns FROM token_usage_actor_daily WHERE server_id='server' AND model_filter=0 ORDER BY actor_id").all().map(r=>[r.actor_id,r.tokens,r.turns]);
 ledger.startTurn(key,1000,"human",true);ledger.recordInput(key,input());ledger.recordSource(source("101"));
 assert.deepEqual(rows(),[["A","101",1]]);
 ledger.recordInput(key,{...input("B"),mode:"steer"});
 assert.deepEqual(rows(),[["A","51",1],["B","50",1]]);
 ledger.recordInput(key,{...input("A","second-device"),mode:"steer"});
 assert.deepEqual(rows(),[["A","51",1],["B","50",1]]);
 db.exec("CREATE TEMP TRIGGER reject_actor BEFORE INSERT ON token_usage_actor_daily BEGIN SELECT RAISE(ABORT,'actor projection failure'); END");
 assert.throws(()=>ledger.recordSource(source("201","response",{version:1,cursor:"actor:1"})),/actor projection failure/);
 assert.equal(ledger.readTurn(key)?.observedTokens,"101");assert.equal(ledger.checkpoint("native:epoch"),null);
 assert.deepEqual(rows(),[["A","51",1],["B","50",1]]);
 db.exec("DROP TRIGGER reject_actor");ledger.recordSource(source("201","response",{version:1,cursor:"actor:1"}));
 assert.deepEqual(rows(),[["A","101",1],["B","100",1]]);
 state.transaction(()=>{db.exec("DELETE FROM token_usage_actor_daily; DELETE FROM token_usage_turn_actor_projections");db.prepare("UPDATE token_usage_projection_state SET ready=0,cursor_thread='',cursor_turn='' WHERE server_id='server'").run();});
 assert.equal(ledger.backfillProjectionBatch(1),false);assert.equal(ledger.backfillProjectionBatch(1),true);
 assert.deepEqual(rows(),[["A","101",1],["B","100",1]]);
 ledger.setEnabled(false);assert.deepEqual(rows(),[["A","101",1],["B","100",1]]);
}));


test("v10 upgrade resets only the rebuild cursor and adds actor summaries without duplicating day totals",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"oc-usage-v10-upgrade-"));
 const previous=openManagedDatabase({path:join(directory,"codex-host-queue.sqlite"),legacyPolicy:"reject",migrations:OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0,10)});
 const db=previous.database;
 db.prepare("INSERT INTO token_usage_scopes VALUES('server',1000,1,7)").run();
 db.prepare("INSERT INTO token_usage_turns VALUES('server','thread','turn',1000,'completed','human',1,1,1,0,'17','settled',1,0)").run();
 db.prepare("INSERT INTO token_usage_buckets VALUES('server','thread','turn','[\"p\",\"m\"]','p','m','17')").run();
 db.prepare("INSERT INTO token_usage_allocations VALUES('server','thread','turn','[\"p\",\"m\"]','p','m','A','17')").run();
 db.prepare("INSERT INTO token_usage_projection_state VALUES('server',1,'z','z')").run();
 const contributions=[{day:"1970-01-01",modelFilter:0,modelKey:"",state:"settled",tokens:"17",turns:1,missing:0,unknown:0},{day:"1970-01-01",modelFilter:1,modelKey:JSON.stringify(["p","m"]),state:"settled",tokens:"17",turns:1,missing:0,unknown:0}];
 for(const c of contributions)db.prepare("INSERT INTO token_usage_daily VALUES('server',?,?,?,?,?,?,?,?)").run(c.day,c.modelFilter,c.modelKey,c.state,c.tokens,c.turns,c.missing,c.unknown);
 db.prepare("INSERT INTO token_usage_turn_projections VALUES('server','thread','turn',?)").run(JSON.stringify(contributions));
 db.close();
 const state=new OpenCraftHostStateDatabase(directory);
 try{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1001);
  assert.equal(ledger.projectionReady(),false);
  assert.equal(ledger.backfillProjectionBatch(1),false);assert.equal(ledger.backfillProjectionBatch(1),true);
  const day=state.database.prepare("SELECT tokens,turns FROM token_usage_daily WHERE model_filter=0").get();
  const actor=state.database.prepare("SELECT tokens,turns FROM token_usage_actor_daily WHERE model_filter=0").get();
  assert.equal(day?.tokens,"17");assert.equal(day?.turns,1);assert.equal(actor?.tokens,"17");assert.equal(actor?.turns,1);
 }finally{state.close();await rm(directory,{recursive:true,force:true});}
});

test("v12 repairs formerly hidden frozen usage using preserved authoritative allocations",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"oc-usage-v11-frozen-"));
 const previous=openManagedDatabase({path:join(directory,"codex-host-queue.sqlite"),legacyPolicy:"reject",migrations:OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0,11)});
 const db=previous.database;
 db.prepare("INSERT INTO token_usage_scopes VALUES('server',1000,0,7)").run();
 db.prepare("INSERT INTO token_usage_turns VALUES('server','thread','turn',1000,'running','human',1,0,0,1,'17','provisional',1,0)").run();
 db.prepare("INSERT INTO token_usage_buckets VALUES('server','thread','turn',?,'p','m','17')").run(JSON.stringify(["p","m"]));
 db.prepare("INSERT INTO token_usage_allocations VALUES('server','thread','turn',?,'p','m','A','17')").run(JSON.stringify(["p","m"]));
 db.prepare("INSERT INTO token_usage_projection_state VALUES('server',1,'z','z')").run();
 db.prepare("INSERT INTO token_usage_turn_projections VALUES('server','thread','turn','[]')").run();
 db.prepare("INSERT INTO token_usage_turn_actor_projections VALUES('server','thread','turn','[]')").run();
 db.close();
 const state=new OpenCraftHostStateDatabase(directory);
 try{
  const ledger=new OpenCraftTokenUsageLedger(state,"server",()=>1001);
  assert.equal(ledger.projectionReady(),false);
  while(!ledger.backfillProjectionBatch(1)){}
  const day=state.database.prepare("SELECT tokens,turns,missing_usage FROM token_usage_daily WHERE model_filter=0").get();
  const actor=state.database.prepare("SELECT tokens,turns FROM token_usage_actor_daily WHERE model_filter=0").get();
  assert.equal(day?.tokens,"17");assert.equal(day?.turns,1);assert.equal(day?.missing_usage,1);
  assert.equal(actor?.tokens,"17");assert.equal(actor?.turns,1);
  assert.equal(ledger.readTurn(key)?.frozen,true);assert.equal(ledger.readTurn(key)?.observedTokens,"17");
 }finally{state.close();await rm(directory,{recursive:true,force:true});}
});

test("repeated source corrections reuse native SQL statements without retaining per-source keys", () => fixture(state => {
  let preparations = 0;
  const prepare = state.database.prepare.bind(state.database);
  state.database.prepare = ((sql: string) => { preparations++; return prepare(sql); }) as typeof state.database.prepare;
  const ledger = new OpenCraftTokenUsageLedger(state, "statement-owner", () => 1000);
  ledger.startTurn(key, 1000, "human", true);
  ledger.recordInput(key, input());
  for (let version = 0; version < 3; version++) ledger.recordSource(source(String(100 + version), "corrected", { version }));
  const warmed = preparations;
  for (let version = 3; version < 203; version++) ledger.recordSource(source(String(100 + version), "corrected", { version }));
  assert.equal(preparations, warmed, "steady-state corrections must not allocate new native statements");
  assert.equal(ledger.readTurn(key)?.observedTokens, "302");
  ledger.recordInput(key, { ...input("B"), mode: "steer" });
  ledger.reconcile(key, complete);
  assert.deepEqual(ledger.readAllocations(key).map(row => row.tokens), ["151", "151"]);
  assert.equal(ledger.readTurn(key)?.allocationState, "settled");
}));
