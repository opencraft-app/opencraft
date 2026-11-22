import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxLifecycleLogger } from "@opencraft/sandbox-node/lifecycle";

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

