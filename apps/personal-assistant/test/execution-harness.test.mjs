import { legacyCoordinationFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initProfile, loadProfile } from "../src/adapters/local/profile.mjs";
import { Store } from "../src/store.mjs";
import { LocalRunner } from "../src/runtime/local-runner.mjs";
import { ExecutionRouter } from "../src/runtime/execution-router.mjs";
import { inspectLocalConfiguration } from "../src/runtime/local-diagnostics.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const codex = {
  binary: "/explicit/codex",
  modelId: "explicit-model",
  baseUrl: "http://127.0.0.1:1/v1",
};
const profile = (options) =>
  initProfile(mkdtempSync(join(tmpdir(), "sa-execution-owner-")), "test-owner", {
    memoryPolicy: { enabled: false },
    ...options,
  });

test("schema17 upgrade preserves snapshots and pins all historical executions to Pi, with a private pre-upgrade backup", async () => {
  const p = profile();
  let store = new Store(p);
  try {
    const id = store.submit("old", { text: "legacy work" }).workId;
    const work = store.app.workRecord(id),
      snapshot = store.app.executions.snapshot(work);
    legacyCoordinationFixture(store.db);
    store.db.exec(
      "DROP TABLE execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; PRAGMA user_version=17",
    );
    store.close();
    p.config.harnesses = { assistant: "pi", execution: "codex", codex };
    writeFileSync(join(p.path, "profile.json"), JSON.stringify(p.config));
    store = new Store(loadProfile(p.path));
    assert.equal(store.app.detail(id).executions[0].harness, "pi");
    assert.deepEqual(store.app.executions.snapshot(store.app.workRecord(id)), snapshot);
    const backup = join(p.path, "backups", "schema17-before-coordination.sqlite");
    assert.ok(existsSync(backup));
    assert.equal(statSync(backup).mode & 0o077, 0);
    const old = new DatabaseSync(backup, { readOnly: true });
    assert.equal(old.prepare("PRAGMA user_version").get().user_version, 17);
    assert.ok(
      !old
        .prepare("PRAGMA table_info(execution)")
        .all()
        .some((c) => c.name === "harness"),
    );
    old.close();
    const next = store.submit("new", { text: "new work" }).workId;
    assert.equal(store.app.detail(next).executions[0].harness, "codex");
    assert.equal(store.app.detail(id).executions[0].harness, "pi");
  } finally {
    store.close();
    await rm(p.path, { recursive: true, force: true });
  }
});

test("native receipts bind intent to one execution and reject changed outcomes or stale revisions", async () => {
  const p = profile({
      harnesses: { assistant: "pi", execution: "codex", codex },
    }),
    store = new Store(p);
  try {
    const id = store.submit("a", { text: "first" }).workId,
      work = store.app.workRecord(id),
      service = store.app.executions;
    const row = service.prepareNativeCall(work, "tool:one", "publish_note", {
      body: "first",
    });
    assert.equal(row.state, "pending");
    assert.throws(
      () =>
        service.prepareNativeCall(work, "tool:one", "publish_note", {
          body: "different",
        }),
      /intent/,
    );
    service.nativeOutcome(work, "tool:one", "completed", { success: true });
    assert.throws(
      () =>
        service.nativeOutcome(work, "tool:one", "completed", {
          success: false,
        }),
      /Immutable/,
    );
    const other = store.app.workRecord(store.submit("b", { text: "second" }).workId);
    assert.equal(
      service.prepareNativeCall(other, "tool:one", "publish_note", {
        body: "other",
      }).state,
      "pending",
    );
    store.app.works.amend("amend", {
      workId: id,
      expectedRevision: 1,
      text: "changed",
    });
    assert.throws(
      () =>
        service.prepareNativeCall(work, "tool:late", "publish_note", {
          body: "late",
        }),
      /revision|superseded|current/i,
    );
    assert.throws(() => service.bound(store.app.workRecord(id), 7, 8), /engine/);
  } finally {
    store.close();
    await rm(p.path, { recursive: true, force: true });
  }
});

test("router does not create a replacement engine when a factory fails, and still closes cleanly", async () => {
  let other = 0;
  const router = new ExecutionRouter({
    executions: { execution: () => ({ harness: "pi" }) },
    factories: {
      pi: async () => {
        throw new Error("explicit config missing");
      },
      codex: () => {
        other++;
      },
    },
  });
  await assert.rejects(router.run({}), /config missing/);
  await router.suspendAll();
  assert.equal(other, 0);
  assert.equal(router.activeSessionCount(), 0);
});

test("missing Codex configuration cannot silently migrate or block a previously queued Codex execution", async () => {
  const p = profile({
    harnesses: { assistant: "pi", execution: "codex", codex },
  });
  let store = new Store(p);
  try {
    const id = store.submit("codex", { text: "pending native work" }).workId;
    store.close();
    p.config.harnesses = { assistant: "pi", execution: "pi" };
    writeFileSync(join(p.path, "profile.json"), JSON.stringify(p.config));
    await assert.rejects(LocalRunner.open(loadProfile(p.path)), /Pending Codex/);
    store = new Store(loadProfile(p.path));
    const d = store.app.detail(id);
    assert.equal(d.work.status, "queued");
    assert.equal(d.executions[0].harness, "codex");
    assert.equal(d.executions[0].conversation_id, null);
  } finally {
    store.close();
    await rm(p.path, { recursive: true, force: true });
  }
});

test("an error while stopping a coordinator still closes the database and releases the profile lock", async () => {
  const p = profile();
  let runner = await LocalRunner.open(p);
  try {
    const stop = runner.work.suspend.bind(runner.work);
    runner.work.suspend = async () => {
      await stop();
      throw new Error("stop observer failed");
    };
    await assert.rejects(runner.close(), AggregateError);
    assert.throws(() => runner.uow.db.prepare("SELECT 1"), /not open|closed/i);
    runner = await LocalRunner.open(p);
    assert.equal(runner.stopping, false);
  } finally {
    await runner.close().catch(() => {});
    await rm(p.path, { recursive: true, force: true });
  }
});

test("fully native Codex configuration and offline doctor do not require a Pi model account", async () => {
  const p = profile({
    mode: "model",
    harnesses: { assistant: "codex", execution: "codex", codex },
  });
  let runner;
  try {
    const d = await inspectLocalConfiguration(p);
    assert.equal(d.harnesses.execution, "codex");
    assert.equal(d.executionModel.provider, "codex-responses");
    assert.equal(d.model.provider, "codex-responses");
    assert.equal(d.actualModelRequestPerformed, false);
    runner = await LocalRunner.open(p);
    assert.equal(runner.work.executor.activeSessionCount(), 0);
  } finally {
    await runner?.close();
    await rm(p.path, { recursive: true, force: true });
  }
});

test("CLI selects the independent execution harness and doctor does not initialize its database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sa-harness-cli-")),
    file = join(dir, "config.json"),
    path = join(dir, "profile");
  writeFileSync(file, JSON.stringify(codex), { mode: 0o600 });
  try {
    const r = JSON.parse(
      (
        await exec(process.execPath, [
          "bin/assistant.mjs",
          "init",
          "--profile",
          path,
          "--owner",
          "test",
          "--assistant-harness",
          "pi",
          "--execution-harness",
          "codex",
          "--codex-config",
          file,
        ])
      ).stdout,
    );
    assert.equal(r.harnesses.execution, "codex");
    const d = JSON.parse((await exec(process.execPath, ["bin/assistant.mjs", "doctor", "--profile", path])).stdout);
    assert.match(d.executionCheckpoint, /Codex/);
    assert.equal(existsSync(join(path, "assistant.sqlite")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changing a native backend is rejected before a queued execution can be reported as failed", async () => {
  const p = profile({
    harnesses: { assistant: "pi", execution: "codex", codex },
  });
  let store = new Store(p);
  try {
    const id = store.submit("bound", { text: "already bound" }).workId,
      work = store.app.workRecord(id),
      execution = store.app.executions.execution(work);
    store.app.executions.bound(
      work,
      {
        engine: "codex",
        threadId: "native-owned",
        modelId: codex.modelId,
        baseUrl: codex.baseUrl,
      },
      execution.id,
    );
    const binding = store.app.detail(id).executions[0].conversation_id;
    store.close();
    p.config.harnesses.codex = { ...codex, modelId: "different-model" };
    writeFileSync(join(p.path, "profile.json"), JSON.stringify(p.config));
    await assert.rejects(LocalRunner.open(loadProfile(p.path)), /backend differs/);
    store = new Store(loadProfile(p.path));
    assert.equal(store.app.detail(id).executions[0].conversation_id, binding);
    assert.equal(store.app.detail(id).work.status, "queued");
  } finally {
    store.close();
    await rm(p.path, { recursive: true, force: true });
  }
});

test("schema18 preserves native receipts, report/result foreign keys and original session roots", async () => {
  const p = profile({
    harnesses: { assistant: "pi", execution: "codex", codex },
  });
  let store = new Store(p);
  try {
    const receipt = store.app.works.submit("legacy18", {
      text: "legacy result",
      completion: { output: "text" },
    });
    const work = store.app.workRecord(receipt.workId),
      snapshot = store.app.executions.snapshot(work);
    store.app.executions.bound(
      work,
      {
        engine: "codex",
        threadId: "original",
        modelId: codex.modelId,
        baseUrl: codex.baseUrl,
      },
      { engine: "codex", requestId: receipt.executionId },
    );
    store.app.executions.prepareNativeCall(work, "call1", "publish_note", {
      body: "note",
    });
    store.app.executions.nativeOutcome(work, "call1", "completed", {
      success: true,
    });
    store.app.executions.report(work, "legacy report");
    store.app.outcomes.record(work, "legacy report");
    const before = store.app.detail(work.id);
    legacyCoordinationFixture(store.db);
    store.db.exec("PRAGMA user_version=18");
    store.close();
    store = new Store(loadProfile(p.path));
    const after = store.app.detail(work.id);
    assert.equal(after.work.active_execution_id, receipt.executionId);
    assert.equal(after.executions[0].session_root, receipt.executionId);
    assert.equal(after.executions[0].conversation_id, before.executions[0].conversation_id);
    assert.deepEqual(JSON.parse(after.executions[0].context_json), snapshot);
    assert.deepEqual(after.results, before.results);
    assert.deepEqual(after.reports, before.reports);
    assert.equal(store.app.executions.nativeCalls(after.work)[0].state, "completed");
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 21);
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(store.app.goals.list(), []);
    store.app.works.continue("next", {
      workId: work.id,
      expectedRevision: 1,
      text: "next step",
    });
    const next = store.app.detail(work.id);
    assert.equal(next.executions.length, 2);
    assert.equal(next.executions[1].revision, 1);
    assert.equal(next.executions[1].session_root, receipt.executionId);
    assert.ok(existsSync(join(p.path, "backups", "schema18-before-coordination.sqlite")));
  } finally {
    store.close();
    await rm(p.path, { recursive: true, force: true });
  }
});
