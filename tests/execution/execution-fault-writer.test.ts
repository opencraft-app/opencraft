import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InterruptedTurnRecovery, ProviderTurnRetry } from "@opencraft/host-recovery";
import { ExecutionFaultWriter } from "../../apps/opencraft-daemon/src/execution-fault-writer.js";
import { OpenCraftHostStateDatabase } from "../../apps/opencraft-daemon/src/opencraft-host-state-database.js";
import { OpenCraftHostQueue } from "../../apps/opencraft-daemon/src/opencraft-host-queue.js";
import { ExecutionLeaseStore } from "../../apps/opencraft-daemon/src/execution-lease-store.js";

const dormant = {serialize: async <T>(_id: string, work: () => Promise<T>) => work(),
  inspect: async () => "unknown" as const, continue: async () => null, changed: () => {}};

test("fault commits stay off the connection loop during lock contention, drain on close and retain receipts across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-fault-writer-"));
  const state = new OpenCraftHostStateDatabase(root), queue = new OpenCraftHostQueue(root, state.database);
  const recovery = new InterruptedTurnRecovery(root, dormant, 500, () => false), retry = new ProviderTurnRetry(root, dormant);
  let writer = new ExecutionFaultWriter(root);
  const leases = new ExecutionLeaseStore(state.database);
  const old = queue.add("one", "old", [{type: "text", text: "old input"}]);
  queue.claim("one", old.id, null); leases.begin("one", "old"); recovery.started("one", "old-turn");
  const newInput = queue.add("one", "new", [{type: "text", text: "explicit new input"}]);
  const unaffected = queue.add("two", "other", [{type: "text", text: "unaffected"}]);
  queue.claim("two", unaffected.id, null);
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  let timerRan = false;
  try {
    state.database.exec("BEGIN IMMEDIATE");
    DatabaseSync.prototype.prepare = () => { throw new Error("SQL on connection loop"); };
    DatabaseSync.prototype.exec = () => { throw new Error("SQL on connection loop"); };
    const interrupted = writer.write({recoveryId: "fault-one", threadIds: ["one"], recovered: false});
    const unlock = setTimeout(() => { timerRan = true; exec.call(state.database, "COMMIT"); }, 80);
    try { await interrupted; } finally { clearTimeout(unlock); }
    assert.equal(timerRan, true, "lock waiting must leave timers responsive");
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec;
    assert.equal(queue.find("one", old.id)?.state, "unknown");
    assert.equal(queue.firstAwaitingAdmission("one")?.id, old.id, "unknown stays blocked until source exit");
    assert.equal(recovery.snapshot("one")?.handledReason, "execution_fault");
    assert.deepEqual(leases.unsettledTargets("one"), [{turnId: null, inputId: "old"}]);
    const recovered = writer.write({recoveryId: "fault-one", threadIds: ["one"], recovered: true});
    await writer.close(); await recovered;
    assert.equal(queue.find("one", old.id)?.pausedReason, "execution-interrupted");
    assert.equal(queue.firstAwaitingAdmission("one")?.id, newInput.id);
    assert.equal(queue.find("two", unaffected.id)?.state, "dispatching", "other instance work untouched");
    queue.claim("one", newInput.id, null); recovery.started("one", "new-turn");
    writer = new ExecutionFaultWriter(root);
    await writer.write({recoveryId: "fault-one", threadIds: ["one"], recovered: true});
    assert.equal(queue.find("one", newInput.id)?.state, "dispatching", "replayed receipt must not interrupt new work");
    assert.equal(recovery.snapshot("one")?.turnId, "new-turn");
    assert.equal(recovery.snapshot("one")?.state, "running");
  } finally {
    DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec;
    await writer.close(); await retry.close(); await recovery.close(); state.close();
    await rm(root, {recursive: true, force: true});
  }
});

test("a recovered snapshot seals unknown execution even if Host missed the failure notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-fault-missed-"));
  const queue = new OpenCraftHostQueue(root), writer = new ExecutionFaultWriter(root);
  try {
    const old = queue.add("one", "old", [{type: "text", text: "old"}]); queue.claim("one", old.id, null);
    const next = queue.add("one", "next", [{type: "text", text: "new"}]);
    await writer.write({recoveryId: "missed", threadIds: ["one"], recovered: true});
    assert.equal(queue.find("one", old.id)?.state, "unknown");
    assert.equal(queue.firstAwaitingAdmission("one")?.id, next.id);
    assert.equal(queue.claim("one", old.id, null), null, "never replay old unknown input");
  } finally { await writer.close(); queue.close(); await rm(root, {recursive: true, force: true}); }
});
