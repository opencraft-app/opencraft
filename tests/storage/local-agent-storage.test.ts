import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { acquireLocalAgentStorageOwner } from "../../apps/local-agent-host/src/storage/daemon-storage-owner.js";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLocalAgentStorage } from "../../apps/local-agent-host/src/storage/local-agent-storage.js";
import { DshSessionRouting } from "../../apps/local-agent-host/src/dsh-session-routing.js";
import { ThreadCatalog } from "../../apps/local-agent-host/src/thread-catalog.js";
import { SqliteLifecycleError } from "@opencraft/sqlite-node";
import { seedLegacyHostStorage, seedNewerHostStorage } from "../support/local-agent-storage-fixture.js";

const names = ["session-routing", "threads", "executions", "host-documents", "managed-connectors", "tasks"];
test("fresh Host storage establishes all configured databases and can reopen up-to-date", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-storage-"));
  try {
    const storage = openLocalAgentStorage({ dataDirectory: directory });
    try {
      assert.deepEqual(storage.summaries, names.map(name => ({ name, status: "fresh", appliedVersion: name === "tasks" ? 5 : 1, movedAside: false })));
      for (const name of names) assert.ok((await stat(join(directory, name === "tasks" ? "tasks.sqlite" : `opencraft-${name}.sqlite`))).size > 0);
    } finally { storage.close(); storage.close(); }
    const reopened = openLocalAgentStorage({ dataDirectory: directory });
    try { assert.ok(reopened.summaries.every(item => item.status === "up-to-date")); } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const unknownRouting of [false, true]) test(`legacy Host storage preserves records and backups (${unknownRouting ? "unknown routing" : "known routing"})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-storage-legacy-"));
  try {
    seedLegacyHostStorage(directory);
    if (unknownRouting) {
      const database = new DatabaseSync(join(directory, "opencraft-session-routing.sqlite"));
      try { database.exec("CREATE TABLE unknown_owner_data(id TEXT PRIMARY KEY)"); }
      finally { database.close(); }
    }
    if (unknownRouting) {
      assert.throws(() => openLocalAgentStorage({ dataDirectory: directory }), (error: unknown) => error instanceof SqliteLifecycleError && error.kind === "unsupported-legacy");
      const retained = new DatabaseSync(join(directory, "opencraft-session-routing.sqlite"), { readOnly: true });
      assert.ok(retained.prepare("SELECT name FROM sqlite_master WHERE name='unknown_owner_data'").get()); retained.close();
      assert.equal((await readdir(directory)).some(name => name.includes(".legacy-")), false); return;
    }
    const storage = openLocalAgentStorage({ dataDirectory: directory });
    try {
      assert.deepEqual(storage.summaries.map(item => item.status), ["migrated", "adopted", "fresh", "fresh", "adopted", "fresh"]);
      assert.equal(storage.threads.get("legacy-thread")?.name, "Legacy title");
      for (const item of storage.summaries.filter(item => item.backupPath)) {
        assert.match(item.backupPath!, /\.pre-v1-/);
        assert.ok((await stat(item.backupPath!)).size > 0);
      }
      assert.equal(storage.summaries[0].movedAside, false);
      assert.equal((await readdir(directory)).some(name => name.includes(".legacy-")), false);
    } finally { storage.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("newer schema rejects the entire storage startup and closes earlier handles", async t => {
  const directory = await mkdtemp(join(tmpdir(), "oc-storage-newer-"));
  try {
    seedNewerHostStorage(directory);
    const routingClose = t.mock.method(DshSessionRouting.prototype, "close");
    const threadsClose = t.mock.method(ThreadCatalog.prototype, "close");
    assert.throws(() => openLocalAgentStorage({ dataDirectory: directory }), error => {
      assert.ok(error instanceof SqliteLifecycleError);
      assert.equal(error.kind, "newer-schema"); assert.match(error.message, /executions/); return true;
    });
    assert.equal(routingClose.mock.callCount(), 1); assert.equal(threadsClose.mock.callCount(), 1);
    assert.throws(() => routingClose.mock.calls[0].this.current("test"), /closed|not open/i);
    assert.throws(() => threadsClose.mock.calls[0].this.get("test"), /closed|not open/i);
    assert.ok(!(await readdir(directory)).some(name => name.includes(".legacy-")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("unconfigured Host storage stays in memory", () => {
  const storage = openLocalAgentStorage();
  try { assert.ok(storage.summaries.every(item => item.status === "fresh" && !item.backupPath)); }
  finally { storage.close(); }
});

test("storage ownership rejects a live process and can recover its claim after exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-storage-owner-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let release: (() => Promise<void>) | undefined;
  try {
    assert.ok(child.pid);
    await writeFile(join(directory, ".daemon-storage-owner.json"), JSON.stringify({ pid: child.pid, claim: "previous-owner" }));
    await assert.rejects(acquireLocalAgentStorageOwner(directory), /already owned/);
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
    release = await acquireLocalAgentStorageOwner(directory);
    await assert.rejects(acquireLocalAgentStorageOwner(directory), /already owned/);
    await release(); release = undefined;
    const next = await acquireLocalAgentStorageOwner(directory); await next();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
    await release?.(); await rm(directory, { recursive: true, force: true });
  }
});
