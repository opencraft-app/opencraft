import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OpenCraftHostStateDatabase, OPENCRAFT_HOST_STATE_MIGRATIONS } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { ExecutionLeaseStore, ExecutionLeaseReader, snapshotExecutionSubmission } from "../../apps/opencraft-daemon/src/execution-lease-store.js";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";
import { openManagedDatabase } from "../../packages/sqlite-node/src/index.js";
const A = { principal: { provider: "employee", subject: "staff-A", loginName: "alice" }, ownership: "human" as const };
const B = { principal: { provider: "employee", subject: "staff-B", loginName: "bob" }, ownership: "human" as const };
function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "oc-execution-lease-"));
  let owner = new OpenCraftHostStateDatabase(directory);
  t.after(() => { owner.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, get owner() { return owner; }, get store() { return new ExecutionLeaseStore(owner.database); },
    restart() { owner.close(); owner = new OpenCraftHostStateDatabase(directory); } };
}
test("accepted execution survives Gateway restart; reader requires exact execution", t => {
  const f = fixture(t); f.store.capture("t", "input", A);
  const id = f.store.begin("t", "input"); f.store.started("t", "turn-A", "input", "engine-1"); f.restart();
  const result = new ExecutionLeaseReader(f.owner.database).resolve({ threadId: "t", executionId: id });
  assert.equal(result.status, "active"); if (result.status === "active") assert.deepEqual(result.lease.principal, A.principal);
  assert.equal(f.store.resolve({ threadId: "t", executionId: "other" }).status, "unknown");
  assert.equal(f.store.resolve({ threadId: "t", executionId: id, generation: 2 }).status, "unknown");
});
test("steer and queue editing/start cannot transfer immutable origin", t => {
  const f = fixture(t), queue = new OpenCraftHostQueue(f.directory, f.owner.database);
  const row = queue.add("t", "queued-A", [{ type: "text", text: "first" }], A);
  queue.update("t", row.id, [{ type: "text", text: "edited by B" }]);
  assert.deepEqual(queue.find("t", row.id)?.executionSubmission, A);
  assert.throws(() => queue.add("t", "queued-A", [{ type: "text", text: "edited by B" }], B), /immutable/);
  const id = f.store.begin("t", "queued-A"); f.store.started("t", "turn-A", "queued-A", "engine-1");
  f.store.capture("t", "steer-B", B);
  const result = f.store.resolve({ threadId: "t", executionId: id });
  assert.equal(result.status, "active"); if (result.status === "active") assert.deepEqual(result.lease.principal, A.principal);
  f.restart(); assert.deepEqual(f.store.getSubmission("t", "queued-A"), A);
});
test("finished Turn cannot supply a later schedule, goal or anonymous execution", t => {
  const f = fixture(t); f.store.capture("t", "human", A);
  const old = f.store.begin("t", "human"); f.store.started("t", "one", "human"); f.store.finished("t", "one");
  for (const input of ["schedule:1", "goal:1", "anonymous"]) {
    const id = f.store.begin("t", input); f.store.started("t", input, input);
    const result = f.store.resolve({ threadId: "t", executionId: id });
    assert.equal(result.status, "unowned"); if (result.status === "unowned") assert.equal(result.lease.principal, null);
    f.store.finished("t", input);
  }
  assert.equal(f.store.resolve({ threadId: "t", executionId: old }).status, "expired");
});
test("pre-ACK native tools bind pending origin; late ACK cannot revive completed Turn", t => {
  const f = fixture(t); f.store.capture("t", "in", A); const id = f.store.begin("t", "in");
  assert.equal(f.store.resolve({ threadId: "t", executionId: id }).status, "unknown");
  f.store.started("t", "turn", undefined, "engine"); f.store.finished("t", "turn"); f.store.started("t", "turn", "in", "engine");
  assert.equal(f.store.resolve({ threadId: "t", executionId: id }).status, "expired");
});
test("queued input inserted into a native goal turn cannot become its execution origin", t => {
  const f = fixture(t), queue = new OpenCraftHostQueue(f.directory, f.owner.database);
  f.store.observedStart("t", "goal-turn", "engine");
  const original = f.owner.database.prepare("SELECT execution_id FROM execution_leases WHERE turn_id=?").get("goal-turn")!;
  queue.add("t", "queued-human", [{ type: "text", text: "try Git again" }], A);
  f.store.observedInput("t", "goal-turn", "queued-human");
  const lease = f.owner.database.prepare("SELECT input_id,state FROM execution_leases WHERE execution_id=?").get(original.execution_id!);
  assert.equal(lease?.input_id, "native:goal-turn", "a message inside the turn cannot attest its launch");
  assert.equal(f.store.resolve({ threadId: "t", executionId: String(original.execution_id) }).status, "unknown");
  assert.deepEqual(f.store.getSubmission("t", "queued-human"), A, "the message retains its authenticated sender");
  f.restart();
  f.store.reconcile("t", [{ id: "goal-turn", status: "inProgress", items: [
    { type: "userMessage", clientId: "queued-human" },
  ] }], "engine");
  assert.equal(f.store.resolve({ threadId: "t", executionId: String(original.execution_id) }).status, "unknown");
});
test("a queued input with its own admitted execution still binds before the native acknowledgement", t => {
  const f = fixture(t), queue = new OpenCraftHostQueue(f.directory, f.owner.database);
  queue.add("t", "queued-human", [{ type: "text", text: "start a new reply" }], A);
  const id = f.store.begin("t", "queued-human", "engine");
  f.store.observedStart("t", "new-turn", "engine");
  f.store.observedInput("t", "new-turn", "queued-human");
  const result = f.store.resolve({ threadId: "t", executionId: id });
  assert.equal(result.status, "active");
  if (result.status === "active") assert.deepEqual(result.lease.principal, A.principal);
});
test("a later queue admission cannot claim a native turn that was already running", t => {
  const f = fixture(t), queue = new OpenCraftHostQueue(f.directory, f.owner.database);
  f.store.observedStart("t", "goal-turn", "engine");
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='boot',admitted_at_ms=1000,admitted_at_boot_ms=1000 WHERE turn_id=?").run("goal-turn");
  queue.add("t", "queued-human", [{ type: "text", text: "next reply" }], A);
  const id = f.store.begin("t", "queued-human", "engine");
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='boot',admitted_at_ms=500,admitted_at_boot_ms=2000 WHERE execution_id=?").run(id);
  f.store.observedInput("t", "goal-turn", "queued-human");
  assert.equal(f.store.resolve({ threadId: "t", executionId: id }).status, "unknown");
  assert.equal(f.owner.database.prepare("SELECT input_id FROM execution_leases WHERE turn_id=?").get("goal-turn")?.input_id, "native:goal-turn");
  f.store.started("t", "new-turn", "queued-human", "engine");
  assert.equal(f.store.resolve({ threadId: "t", executionId: id }).status, "active", "the queued input can still start its own turn");
});
test("a later queue admission with tied clocks cannot claim an already observed native turn", t => {
  const f=fixture(t),queue=new OpenCraftHostQueue(f.directory,f.owner.database);
  f.store.observedStart("t","existing-goal","engine");
  queue.add("t","later-input",[{type:"text",text:"next turn only"}],A);
  const id=f.store.begin("t","later-input","engine");
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='same-boot',admitted_at_ms=1000,admitted_at_boot_ms=1000 WHERE thread_id='t'").run();
  f.store.observedInput("t","existing-goal","later-input");
  assert.equal(f.store.resolve({threadId:"t",executionId:id}).status,"unknown");
  assert.equal(f.owner.database.prepare("SELECT input_id FROM execution_leases WHERE turn_id=?").get("existing-goal")?.input_id,"native:existing-goal");
  f.store.started("t","legitimate-next-turn","later-input","engine");
  assert.equal(f.store.resolve({threadId:"t",executionId:id}).status,"active","the next real execution can still claim its own admission");
});
test("an earlier admitted queued execution remains valid when clock samples tie", t => {
  const f=fixture(t),queue=new OpenCraftHostQueue(f.directory,f.owner.database);
  queue.add("t","first-input",[{type:"text",text:"start my turn"}],A);
  const id=f.store.begin("t","first-input","engine");
  f.store.observedStart("t","own-turn","engine");
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='same-boot',admitted_at_ms=1000,admitted_at_boot_ms=1000 WHERE thread_id='t'").run();
  f.store.observedInput("t","own-turn","first-input");
  const result=f.store.resolve({threadId:"t",executionId:id});assert.equal(result.status,"active");
  if(result.status==="active")assert.deepEqual(result.lease.principal,A.principal);
});
test("attested job birth rejects boundaries and incarnation mismatch, never follows next employee", t => {
  const f = fixture(t); f.store.capture("t", "a", A); const a = f.store.begin("t", "a"); f.store.started("t", "a", "a", "engine");
  f.owner.database.prepare("UPDATE execution_leases SET admitted_at_ms=1000 WHERE execution_id=?").run(a);
  const query = (at: number, uncertaintyMs = 10, engineIncarnation = "engine") => f.store.resolveJobOrigin({ threadId: "t", engineIncarnation, startedAtMs: at, uncertaintyMs });
  assert.equal(query(1100).status, "active"); assert.equal(query(1005).status, "unknown"); assert.equal(query(1100, 10, "other").status, "unknown");
  f.store.finished("t", "a"); f.owner.database.prepare("UPDATE execution_leases SET ended_at_ms=2000 WHERE execution_id=?").run(a);
  f.store.capture("t", "b", B); const b = f.store.begin("t", "b"); f.store.started("t", "b", "b", "engine");
  f.owner.database.prepare("UPDATE execution_leases SET admitted_at_ms=2100 WHERE execution_id=?").run(b);
  const old = query(1100); assert.equal(old.status, "expired"); if (old.status === "expired") assert.equal(old.lease.principal?.subject, "staff-A");
  assert.equal(query(2050).status, "unknown"); assert.equal(query(1995).status, "unknown");
  const current = query(2200); assert.equal(current.status, "active"); if (current.status === "active") assert.equal(current.lease.principal?.subject, "staff-B");
});
test("display sender alone is unknown; authenticated snapshot is detached and expires", () => {
  const p = { provider: "employee", subject: "123", loginName: "alice" };
  const snap = snapshotExecutionSubmission({ sender: { kind: "employee", loginName: "alice" }, executionPrincipal: p, validUntil: Date.now() + 10000 });
  p.subject = "456"; assert.equal(snap.principal?.subject, "123"); assert.ok(Object.isFrozen(snap.principal));
  assert.equal(snapshotExecutionSubmission({ sender: { kind: "employee", loginName: "alice" } }).ownership, "unknown");
  assert.throws(() => snapshotExecutionSubmission({ sender: null, executionPrincipal: p, validUntil: 1 }), /expired/);
});
test("execution Actor provenance comes only from the verified Human context", () => {
  const principal = { provider: "fixture", subject: "original", actorId: "human://forged/actor", actorGeneration: 999 };
  const context = { executionPrincipal: principal, validUntil: Date.now() + 60000 };
  assert.deepEqual(snapshotExecutionSubmission(context).principal, { provider: "fixture", subject: "original" });
  const actor = { actorId: "human://fixture/original", generation: 7, credentialId: null, expiresAt: Date.now() + 60000 };
  const snapshot = snapshotExecutionSubmission({ ...context, actorContext: actor });
  assert.deepEqual(snapshot.principal, { provider: "fixture", subject: "original", actorId: actor.actorId, actorGeneration: 7 });
  actor.generation = 8;
  assert.equal(snapshot.principal?.actorGeneration, 7, "later context mutation cannot change the original grant");
  for (const expiresAt of [0, NaN, Infinity])
    assert.throws(() => snapshotExecutionSubmission({ ...context, actorContext: { ...actor, expiresAt } }), /Actor expired/);
  for (const generation of [0, -1, 1.5, NaN])
    assert.throws(() => snapshotExecutionSubmission({ ...context, actorContext: { ...actor, generation } }), /Actor expired/);
  assert.equal(snapshotExecutionSubmission({ ...context, actorContext: { ...actor, credentialId: "agent-credential" } }).principal?.actorId, undefined);
});
test("original Actor identity and generation survive restart and cannot be reassigned", t => {
  const f = fixture(t);
  const original = { principal: { ...A.principal, actorId: "human://fixture/original", actorGeneration: 3 }, ownership: "human" as const };
  f.store.capture("t", "original", original);
  f.restart();
  assert.deepEqual(f.store.getSubmission("t", "original"), original);
  for (const principal of [
    { ...original.principal, actorId: "human://fixture/successor" },
    { ...original.principal, actorGeneration: 4 },
  ]) assert.throws(() => f.store.capture("t", "original", { ...original, principal }), /Actor is immutable/);
  f.store.capture("t", "original", A);
  assert.deepEqual(f.store.getSubmission("t", "original"), original, "a legacy replay cannot remove existing Actor provenance");
  f.store.capture("t", "legacy", A);
  f.store.capture("t", "legacy", original);
  assert.deepEqual(f.store.getSubmission("t", "legacy"), A, "a retry cannot backfill historical Actor authority");
  for (const principal of [
    { ...A.principal, actorId: "human://fixture/original" },
    { ...A.principal, actorGeneration: 3 },
    { ...original.principal, actorGeneration: 0 },
  ]) assert.throws(() => f.store.capture("t", "invalid", { principal, ownership: "human" }), /Invalid execution Actor/);
});
test("v14 upgrades preserving queue and checksums; corrupt published history rejects", t => {
  const dir = mkdtempSync(join(tmpdir(), "oc-execution-v14-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "opencraft-host-state.sqlite");
  const previous = openManagedDatabase({ path, migrations: OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0, 14) });
  previous.database.prepare("INSERT INTO opencraft_host_queue(id,thread_id,client_id,input_json,position,created_at_ms,updated_at_ms,state) VALUES('q','t','old','[{\"type\":\"text\"}]',1,1,1,'queued')").run();
  const history = previous.database.prepare("SELECT version,name,checksum FROM schema_migrations ORDER BY version").all(); previous.database.close();
  const upgraded = new OpenCraftHostStateDatabase(dir);
  assert.equal(upgraded.outcome.status, "migrated");
  assert.equal(upgraded.database.prepare("SELECT client_id FROM opencraft_host_queue").get()?.client_id, "old");
  assert.deepEqual(upgraded.database.prepare("SELECT version,name,checksum FROM schema_migrations WHERE version<=14 ORDER BY version").all(), history);
  assert.equal(new ExecutionLeaseStore(upgraded.database).getSubmission("t", "old"), null); upgraded.close();
  const corrupt = new DatabaseSync(path); corrupt.exec("UPDATE schema_migrations SET checksum='wrong' WHERE version=14"); corrupt.close();
  assert.throws(() => new OpenCraftHostStateDatabase(dir), /history|checksum/i);
});


test("execution lease survives exit of the original Gateway OS process", t => {
  const directory = mkdtempSync(join(tmpdir(), "oc-process-execution-lease-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databaseModule = new URL("../../apps/opencraft-daemon/src/opencraft-host-state-database.ts", import.meta.url).href;
  const leaseModule = new URL("../../apps/opencraft-daemon/src/execution-lease-store.ts", import.meta.url).href;
  const source = `import { OpenCraftHostStateDatabase } from ${JSON.stringify(databaseModule)};
    import { ExecutionLeaseStore } from ${JSON.stringify(leaseModule)};
    const owner = new OpenCraftHostStateDatabase(process.argv[1]), store = new ExecutionLeaseStore(owner.database);
    store.capture("thread", "input", {principal:{provider:"fixture",subject:"staff-A"},ownership:"human"});
    const id=store.begin("thread","input");store.started("thread","turn","input","native");
    owner.close();process.stdout.write(JSON.stringify({id,pid:process.pid}));`;
  const written = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, directory], { encoding: "utf8" }));
  assert.notEqual(written.pid, process.pid);
  const owner = new OpenCraftHostStateDatabase(directory);
  try {
    const store = new ExecutionLeaseStore(owner.database);
    store.suspend(); assert.equal(store.resolve({ threadId: "thread", executionId: written.id }).status, "unknown");
    store.reconcile("thread", [{ id: "turn", status: "inProgress" }], "native");
    const restored = store.resolve({ threadId: "thread", executionId: written.id });
    assert.equal(restored.status, "active"); if (restored.status === "active") assert.equal(restored.lease.principal?.subject, "staff-A");
    store.reconcile("thread", [{ id: "turn", status: "completed" }], "native");
    assert.equal(store.resolve({ threadId: "thread", executionId: written.id }).status, "expired");
  } finally { owner.close(); }
});

test("replaying the same accepted input never opens a second execution interval", t=>{
  const f=fixture(t);f.store.capture("t","input",A);const id=f.store.begin("t","input");
  f.store.started("t","turn","input","native");assert.equal(f.store.begin("t","input"),id);
  f.store.finished("t","turn");assert.equal(f.store.begin("t","input"),id);
  assert.equal(f.owner.database.prepare("SELECT count(*) AS n FROM execution_leases").get()!.n,1);
  assert.equal(f.store.resolve({threadId:"t",executionId:id}).status,"expired");
});

test('boot clock origin survives realtime jumps without moving an old job to a new employee', t=>{
  const f=fixture(t);f.store.capture('t','A',A);const a=f.store.begin('t','A','engine');f.store.started('t','one','A');f.store.finished('t','one');
  f.store.capture('t','B',B);const b=f.store.begin('t','B','engine');f.store.started('t','two','B');
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='boot',admitted_at_boot_ms=1000,ended_at_boot_ms=2000,admitted_at_ms=100000,ended_at_ms=110000 WHERE execution_id=?").run(a);
  f.owner.database.prepare("UPDATE execution_leases SET boot_id='boot',admitted_at_boot_ms=2100,admitted_at_ms=90000 WHERE execution_id=?").run(b);
  const query=(startedAtBootMs:number,startedAtMs:number,bootId='boot')=>f.store.resolveJobOrigin({threadId:'t',engineIncarnation:'engine',startedAtBootMs,startedAtMs,bootId,uncertaintyMs:20});
  const old=query(1100,90100);assert.equal(old.status,'expired');if(old.status==='expired')assert.equal(old.lease.executionId,a);
  const next=query(2200,100100);assert.equal(next.status,'active');if(next.status==='active')assert.equal(next.lease.principal?.subject,'staff-B');
  assert.equal(query(2105,100105).status,'unknown');assert.equal(query(2200,100100,'another-boot').status,'unknown');
  assert.equal(f.store.originClock,'boot-monotonic-v1');
  f.owner.database.prepare('UPDATE execution_leases SET boot_id=NULL,admitted_at_boot_ms=NULL WHERE execution_id=?').run(b);
  assert.equal(query(2200,90100).status,'unknown','old clock records cannot fall back to epoch');
});

test('published v15 upgrades append-only and leaves old execution clock unknown', t=>{
  const dir=mkdtempSync(join(tmpdir(),'oc-v15-clock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const prior=openManagedDatabase({path:join(dir,'opencraft-host-state.sqlite'),migrations:OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0,15)});
  prior.database.exec("INSERT INTO execution_submissions(thread_id,input_id,principal_json,ownership,submitted_at_ms) VALUES('t','A','{\"provider\":\"employee\",\"subject\":\"A\"}','human',1);");
  prior.database.exec("INSERT INTO execution_leases(execution_id,thread_id,input_id,generation,turn_id,engine_incarnation,state,admitted_at_ms) VALUES('old','t','A',1,'one','engine','active',1000);");
  const original=prior.database.prepare('SELECT * FROM schema_migrations WHERE version=15').get();prior.database.close();
  const next=new OpenCraftHostStateDatabase(dir);try{
    assert.equal(next.outcome.appliedVersion,17);assert.deepEqual(next.database.prepare('SELECT * FROM schema_migrations WHERE version=15').get(),original);
    const reader=new ExecutionLeaseReader(next.database);
    assert.equal(reader.resolveJobOrigin({threadId:'t',engineIncarnation:'engine',startedAtMs:1100,uncertaintyMs:20,bootId:'boot',startedAtBootMs:1100}).status,'unknown');
  }finally{next.close();}
});
