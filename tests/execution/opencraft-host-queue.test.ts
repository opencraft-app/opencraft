import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";

test("Host queue claims survive restart as delivery-unknown and never re-enter the pending head", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-host-queue-store-"));
  try {
    const first = new OpenCraftHostQueue(root);
    const item = first.add("thread-1", "message-1", [{ type: "text", text: "hello" }]);
    assert.equal(first.add("thread-1", "message-1", item.input).id, item.id);
    assert.throws(() => first.add("thread-1", "message-1", [{ type: "text", text: "changed" }]));
    assert.equal(first.claim("thread-1", item.id, "turn-1")?.state, "dispatching");
    assert.equal(first.claim("thread-1", item.id, "turn-1"), null);
    assert.throws(() => first.reorder("thread-1", []), /Reconcile in-flight/);
    first.close();

    const recovered = new OpenCraftHostQueue(root);
    assert.equal(recovered.firstUnsettled("thread-1")?.state, "unknown");
    assert.equal(recovered.firstUnsettled("thread-1")?.pausedReason, "steer-delivery-unconfirmed");
    assert.equal(recovered.discardUnknown("thread-1", item.id, "wrong-turn"), false);
    assert.equal(recovered.discardUnknown("thread-1", item.id, "turn-1"), true);
    assert.deepEqual(recovered.list("thread-1"), []);
    recovered.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("accepted steer remains visible for reconciliation without blocking admission of the next queued item", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-host-queue-admission-"));
  try {
    const queue = new OpenCraftHostQueue(root);
    const first = queue.add("thread-1", "message-1", [{ type: "text", text: "first" }]);
    const second = queue.add("thread-1", "message-2", [{ type: "text", text: "second" }]);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, first.id);
    queue.claim("thread-1", first.id, "turn-1");
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.state, "dispatching");
    queue.settle("thread-1", first.id, "steering");
    assert.equal(queue.firstUnsettled("thread-1")?.id, first.id);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, second.id);
    queue.reorder("thread-1", [second.id]);
    queue.claim("thread-1", second.id, "turn-1");
    queue.settle("thread-1", second.id, "unknown", "steer-delivery-unconfirmed");
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.id, second.id);
    assert.equal(queue.firstAwaitingAdmission("thread-1")?.state, "unknown");
    assert.throws(() => queue.reorder("thread-1", []), /Reconcile in-flight/);
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native queued rows migrate before Codex starts and replaying migration is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-host-queue-migrate-"));
  const nativeRoot = join(root, "runtime");
  try {
    await mkdir(nativeRoot);
    const native = new DatabaseSync(join(nativeRoot, "queue_1.sqlite"));
    native.exec("CREATE TABLE queued_items (id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT, queue_order INTEGER, created_at_ms INTEGER, steering_turn_id TEXT)");
    native.prepare("INSERT INTO queued_items VALUES(?,?,?,?,?,?)").run("old-1", "thread-1",
      JSON.stringify({ UserInput: { content: [{ type: "text", text: "old" }], client_id: "client-old" } }), 1, 123, null);
    native.close();

    const queue = new OpenCraftHostQueue(root);
    assert.equal(queue.migrateNativeQueue(nativeRoot), 1);
    assert.equal(queue.migrateNativeQueue(nativeRoot), 0);
    assert.equal(queue.firstUnsettled("thread-1")?.clientUserMessageId, "client-old");
    const after = new DatabaseSync(join(nativeRoot, "queue_1.sqlite"));
    assert.equal((after.prepare("SELECT COUNT(*) AS count FROM queued_items").get() as { count: number }).count, 0);
    after.close();
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("deleting a Thread retires its Host-owned queued inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-host-queue-delete-"));
  try {
    const queue = new OpenCraftHostQueue(root);
    queue.add("thread-1", "message-1", [{ type: "text", text: "one" }]);
    queue.add("thread-1", "message-2", [{ type: "text", text: "two" }]);
    assert.equal(queue.discardThread("thread-1"), 2);
    assert.deepEqual(queue.list("thread-1"), []);
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("input outcomes distinguish a thread whose every input was discarded from one that ever delivered", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-host-queue-outcomes-"));
  try {
    const queue = new OpenCraftHostQueue(root);
    assert.deepEqual(queue.inputOutcomes("thread-1"), { delivered: 0, discarded: 0 });
    const a = queue.add("thread-1", "message-a", [{ type: "text", text: "a" }]);
    queue.claim("thread-1", a.id, "turn-0");
    queue.settle("thread-1", a.id, "discarded");
    assert.deepEqual(queue.inputOutcomes("thread-1"), { delivered: 0, discarded: 1 });
    const b = queue.add("thread-1", "message-b", [{ type: "text", text: "b" }]);
    queue.claim("thread-1", b.id, "turn-1");
    queue.settle("thread-1", b.id, "delivered", null, "turn-1");
    assert.deepEqual(queue.inputOutcomes("thread-1"), { delivered: 1, discarded: 1 });
    assert.deepEqual(queue.inputOutcomes("thread-2"), { delivered: 0, discarded: 0 });
    queue.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const admission of ['accepted','unknown'] as const) test(`terminal receipt releases ${admission} attempt without declaring context adoption or replay`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'input-lifecycle-'));
  try {
    let q=new OpenCraftHostQueue(root);
    const original=q.add('t','m1',[{type:'text',text:'continue'}]);
    q.claim('t',original.id,'turn-a');
    q.settle('t',original.id,admission==='accepted'?'steering':'unknown','steer-delivery-unconfirmed');
    const next=q.add('t','m2',[{type:'text',text:'new intent'}]);
    q.deliveries.finish('t','turn-a','interrupted');
    const receipt=q.find('t',original.id)!.delivery!;
    assert.equal(receipt.custody,'accepted');
    assert.equal(receipt.nativeAdmission,admission);
    assert.equal(receipt.context,'unobserved');
    assert.equal(receipt.execution,'interrupted');
    assert.equal(q.firstAwaitingAdmission('t')!.id,next.id);
    assert.equal(q.list('t',[]).some(r=>r.id===original.id),false,'closed receipt is not active queue work');
    assert.equal(q.list('t',['turn-a']).find(r=>r.id===original.id)!.input[0]!.text,'continue');
    q.close(); q=new OpenCraftHostQueue(root);
    assert.equal(q.find('t',original.id)!.delivery!.execution,'interrupted');
    assert.equal(q.firstAwaitingAdmission('t')!.id,next.id,'restart preserves terminal fence');
    assert.equal(q.claim('t',next.id,'turn-a'),null,'new input cannot bind an already terminal Turn');
    q.claim('t',next.id,'turn-b'); q.settle('t',next.id,'unknown','steer-delivery-unconfirmed');
    assert.equal(q.firstAwaitingAdmission('t')!.id,next.id,'old terminal receipt cannot close a new attempt');
    q.deliveries.admission('t','m1','accepted');
    q.deliveries.admission('t','m1','unknown');
    assert.equal(q.find('t',original.id)!.delivery!.nativeAdmission,'accepted','late timeout cannot undo positive admission');
    assert.equal(q.find('t',original.id)!.delivery!.execution,'interrupted','late ACK cannot reopen execution');
    q.deliveries.recorded('t','m1');
    assert.equal(q.find('t',original.id)!.delivery!.context,'recorded','late positive history refines evidence');
    assert.equal(q.deliveries.finish('t','turn-a','completed'),false,'terminal receipt is immutable');
    q.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('idle inference cannot close an unknown or unbound input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'input-lifecycle-unbound-'));
  try {
    const q=new OpenCraftHostQueue(root),a=q.add('t','a',[{type:'text',text:'a'}]);
    q.claim('t',a.id,'unknown'); q.settle('t',a.id,'unknown');
    assert.equal(q.deliveries.finish('t','unknown','idle'),false);
    assert.equal(q.find('t',a.id)!.delivery!.execution,'unbound');
    assert.equal(q.firstAwaitingAdmission('t')!.id,a.id);
    q.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('queue custody and receipt share caller transaction and rollback together',async()=>{
  const root=await mkdtemp(join(tmpdir(),'input-lifecycle-atomic-'));
  try {
    const {OpenCraftHostStateDatabase}=await import('../../apps/opencraft-daemon/src/opencraft-host-state-database.js');
    const owner=new OpenCraftHostStateDatabase(root),q=new OpenCraftHostQueue(root,owner.database);
    assert.throws(()=>owner.transaction(()=>{q.add('t','atomic',[{type:'text',text:'a'}]);throw new Error('rollback');}));
    assert.equal(q.findByClientId('t','atomic'),null);
    assert.equal(owner.database.prepare("SELECT count(*) n FROM opencraft_input_delivery").get()!.n,0);
    q.close();owner.close();
  } finally {await rm(root,{recursive:true,force:true});}
});

test('v16 upgrade retains message bytes and conservatively reconstructs admission facts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'input-lifecycle-v16-'));
  try {
    const {OPENCRAFT_HOST_STATE_MIGRATIONS}=await import('../../apps/opencraft-daemon/src/opencraft-host-state-database.js');
    const {openManagedDatabase,createSchemaValidator}=await import('@opencraft/sqlite-node');
    const migrations=OPENCRAFT_HOST_STATE_MIGRATIONS.slice(0,16);
    const old=openManagedDatabase({path:join(root,'codex-host-queue.sqlite'),migrations,legacyPolicy:'reject-unknown',validateSchema:createSchemaValidator(migrations.map(m=>m.sql).join('\n'))});
    const input=JSON.stringify([{type:'text',text:'继续'}]);
    old.database.prepare("INSERT INTO opencraft_host_queue VALUES('queue','t','old',?,1,1,1,'unknown','turn-a','steer-delivery-unconfirmed')").run(input);
    old.database.close();
    const upgraded=new OpenCraftHostQueue(root);
    assert.equal(JSON.stringify(upgraded.findByClientId('t','old')!.input),input);
    assert.equal(upgraded.findByClientId('t','old')!.delivery!.nativeAdmission,'unknown');
    assert.equal(upgraded.findByClientId('t','old')!.delivery!.context,'unobserved');
    upgraded.deliveries.finish('t','turn-a','interrupted');
    assert.equal(upgraded.findByClientId('t','old')!.state,'closed');
    assert.equal(upgraded.firstAwaitingAdmission('t'),null);
    upgraded.close();
  } finally {await rm(root,{recursive:true,force:true});}
});
