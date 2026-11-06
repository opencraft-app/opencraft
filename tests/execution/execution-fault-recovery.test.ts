import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionFaultRecovery } from "../../apps/codex-core/src/execution-fault-recovery.js";
import { sandboxLifecycleLogger } from "@opencraft/sandbox-node/lifecycle";

test("failed execution recovery persists, backs off and resumes after its owner restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-fault-retry-"));
  let time = 1_000, calls = 0;
  let recovery = new ExecutionFaultRecovery(join(root, "state.json"), () => {}, () => time);
  try {
    const fail = async () => { calls++; throw new Error("synthetic restart failure"); };
    await Promise.all([recovery.recover("one", 1, fail), recovery.recover("one", 1, fail)]);
    assert.equal(calls, 1); assert.equal(recovery.blocked("one"), true);
    await recovery.recover("one", 1, fail); assert.equal(calls, 1);
    await recovery.close();
    recovery = new ExecutionFaultRecovery(join(root, "state.json"), () => {}, () => time);
    await recovery.initialize();
    assert.equal(recovery.blocked("one"), true);
    time = 2_000;
    await recovery.recover("one", 1, fail); assert.equal(calls, 2);
    time = 3_000;
    await recovery.recover("one", 1, fail); assert.equal(calls, 2, "the second failure increases the backoff");
    time = 4_000;
    await recovery.recover("one", 1, async () => { calls++; });
    assert.equal(recovery.blocked("one"), false);
    assert.equal(recovery.snapshot()[0]?.state, "recovered");
    const durable = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.equal(durable[0].state, "recovered");
  } finally { await recovery.close(); await rm(root, {recursive: true, force: true}); }
});

test("execution lifecycle preserves ordered observations without task payloads or unsafe signal text", async () => {
  const root = await mkdtemp(join(tmpdir(), "oc-exec-log-"));
  try {
    const path = join(root, "lifecycle.jsonl"), log = sandboxLifecycleLogger(path);
    log({event: "starting", command: "private-command", env: {TOKEN: "private-token"}} as any);
    log({event: "unit-exited", code: null, exitSignal: 9, signal: "private-signal"});
    log({event: "closed"}); await log.flush();
    const text = await readFile(path, "utf8"), rows = text.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.map(row => row.event), ["starting", "unit-exited", "closed"]);
    assert.equal(rows[1].exitSignal, 9); assert.equal(rows[1].signal, undefined);
    assert.doesNotMatch(text, /private-command|private-token|private-signal|TOKEN/);
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("owned executor exit remains authoritative when Native status is stuck; old owners and partial records are ignored", async () => {
  const {ExecutionLifecycleObserver} = await import("../../apps/codex-core/src/execution-lifecycle-observer.js");
  const {appendFile, writeFile} = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "oc-exit-observation-")), file = join(root, "lifecycle.jsonl");
  try {
    await writeFile(file, JSON.stringify({ownerPid: 10, pid: 20, event: "closed"}) + "\n");
    const observer = new ExecutionLifecycleObserver(file, 10); await observer.initialize();
    assert.equal(await observer.disconnected(), false, "old history does not authorize recovery");
    await appendFile(file, JSON.stringify({ownerPid: 11, pid: 21, event: "started"}) + "\n" + JSON.stringify({ownerPid: 11, pid: 21, event: "closed"}) + "\n");
    assert.equal(await observer.disconnected(), false, "another owner cannot establish this executor's failure");
    await appendFile(file, JSON.stringify({ownerPid: 10, pid: 22, event: "started"}) + "\n" + '{"ownerPid":10,"pid":22,"event":"unit-exited"');
    assert.equal(await observer.disconnected(), false);
    await appendFile(file, ',"exitSignal":9}\n');
    assert.equal(await observer.disconnected(), true, "known unit exit does not need a Native status RPC");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("controller responsibility inspection uses an owned one-shot Worker without main-thread SQLite", async () => {
  const {CodexGenerationRegistry} = await import("../../apps/codex-core/src/generation-registry.js");
  const {readRouterRecoveryEvidence} = await import("../../apps/codex-core/src/router-recovery-evidence.js");
  const {DatabaseSync} = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "oc-router-reader-")), registry = new CodexGenerationRegistry(root);
  registry.setMetadata("router-uncertainty:synthetic", {version: 1, id: "synthetic", generationId: "one", incarnation: 1});
  registry.setMetadata("private-account-not-part-of-recovery", "not-returned");
  const prepare = DatabaseSync.prototype.prepare, exec = DatabaseSync.prototype.exec;
  let timerRan = false;
  const timer = setTimeout(() => {timerRan = true;}, 0);
  try {
    DatabaseSync.prototype.prepare = () => {throw new Error("SQLite on connection loop");};
    DatabaseSync.prototype.exec = () => {throw new Error("SQLite on connection loop");};
    const rows = await readRouterRecoveryEvidence(root);
    assert.equal(timerRan, true);
    assert.deepEqual(rows, [{key: "router-uncertainty:synthetic", value: {version: 1, id: "synthetic", generationId: "one", incarnation: 1}}]);
  } finally {
    clearTimeout(timer); DatabaseSync.prototype.prepare = prepare; DatabaseSync.prototype.exec = exec;
    registry.close(); await rm(root, {recursive: true, force: true});
  }
});
