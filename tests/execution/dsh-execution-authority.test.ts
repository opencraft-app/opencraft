import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshExecutionAuthority } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
const owner = (id: string) => ({ connectionId: id, identity: { id: "local-user", username: "local" } });

test("connection and epoch fence admission, native start and stale completion", () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    const first = authority.claim("t", a, "request-1");
    assert.throws(() => authority.claim("t", b, "request-2"), /lease/);
    assert.throws(() => authority.claim("t", a, "request-3"), /already/);
    assert.equal(authority.nativeStarted(first, "turn-1", "1"), true);
    assert.throws(() => authority.assertOwner("t", b), /authority/);
    assert.equal(authority.finish(first, "interrupted", "user"), true);
    const second = authority.claim("t", b, "request-4");
    assert.ok(second.epoch > first.epoch);
    assert.equal(authority.nativeStarted(first, "late-turn", "1"), false);
    assert.equal(authority.finish(first, "completed", "late"), false);
    assert.equal(authority.nativeStarted(second, "turn-2", "2"), true);
  } finally { authority.close(); }
});
test("new process boot fences old attempts and preserves monotonic epochs", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-admission-"));
  const path = join(root, "execution.sqlite");
  try {
    const first = new DshExecutionAuthority(path, "boot-a");
    const admitted = first.claim("t", owner("a"), "request");
    first.rememberInput(admitted, "native-token", "original-client-message");
    first.nativeStarted(admitted, "turn-1", "1");
    first.close();
    const second = new DshExecutionAuthority(path, "boot-b");
    try {
      assert.equal(second.recoveredOrphans.length, 1);
      assert.equal(second.recoveredOrphans[0].state, "orphaned");
      assert.equal(second.journal.nativeHistory("t").nativeStarts, 1);
      const input = { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "native-token" }, content: [] } };
      assert.equal((second.projectInput("t", input).data as any).source.rpcId, "original-client-message");
      assert.equal((second.projectInput("different-thread", input).data as any).source.rpcId, "native-token");
      const next = second.claim("t", owner("b"), "next");
      assert.ok(next.epoch > admitted.epoch);
    } finally { second.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queued input survives a Host crash before native acknowledgement and retires on its matching native user message", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-queue-reconcile-"));
  const path = join(root, "execution.sqlite");
  try {
    const first = new DshExecutionAuthority(path, "boot-a");
    const queued = first.queueStore.add("thread-a", "client-queued", "local-user", [{ type: "text", text: "follow up" }]);
    assert.equal(queued.created, true);
    first.queueInput("native-queue-rpc", "thread-a", owner("a"), "request-queue", "client-queued");
    first.close();

    const restarted = new DshExecutionAuthority(path, "boot-b");
    try {
      assert.deepEqual(restarted.queueStore.pending("thread-a").map((item: any) => item.id), [queued.submission.id]);
      assert.equal(restarted.queuedInputs().length, 1);
      const unrelated = { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "native-queue-rpc" }, content: [] } };
      restarted.projectInput("thread-b", unrelated);
      assert.equal(restarted.queueStore.pending("thread-a").length, 1);

      const projected = restarted.projectInput("thread-a", unrelated);
      assert.equal((projected.data as any).source.rpcId, "client-queued");
      assert.deepEqual(restarted.queueStore.pending("thread-a"), []);
      assert.equal(restarted.queueStore.find("thread-a", queued.submission.id)?.state, "dispatched");
      assert.deepEqual(restarted.queuedInputs(), []);
      restarted.projectInput("thread-a", unrelated);
      assert.deepEqual(restarted.queueStore.pending("thread-a"), [], "replayed native input cannot restore the queue row");
    } finally { restarted.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("queue writes cannot bypass a running execution or a concurrent write lease", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    const admission = authority.claim("t", a, "request");
    let writes = 0;
    await assert.rejects(authority.withWriteLease("t", b, async () => { writes++; }), /authority/);
    await authority.withWriteLease("t", a, async () => { writes++; });
    assert.equal(writes, 1);
    authority.finish(admission, "completed", "done");
    let release!: () => void;
    const waiting = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(authority.withWriteLease("t", b, async () => {}), /lease/);
    release(); await waiting;
    await authority.withWriteLease("t", b, async () => { writes++; });
    assert.equal(writes, 2);
  } finally { authority.close(); }
});

test("only the same principal may reclaim an explicitly disconnected execution", () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b"), foreign = { connectionId: "foreign", identity: { id: "other", username: "other" } };
    const admitted = authority.claim("t", a, "request");
    authority.nativeStarted(admitted, "turn", "1");
    assert.equal(authority.reconnect("t", b), false, "a still-connected window cannot be displaced");
    authority.disconnect(a);
    assert.equal(authority.reconnect("t", foreign), false);
    assert.equal(authority.reconnect("t", b), true);
    assert.throws(() => authority.assertOwner("t", a), /authority/);
    assert.equal(authority.assertOwner("t", b).epoch, admitted.epoch);
    assert.equal(authority.table.get("t").state, "running");
  } finally { authority.close(); }
});

test("overlapping edits by one owner retain the lease until every edit settles", async () => {
  const authority = new DshExecutionAuthority(":memory:");
  try {
    const a = owner("a"), b = owner("b");
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const first = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { releaseFirst = resolve; }));
    const second = authority.withWriteLease("t", a, () => new Promise<void>(resolve => { releaseSecond = resolve; }));
    releaseFirst(); await first;
    await assert.rejects(authority.withWriteLease("t", b, async () => {}), /lease/);
    releaseSecond(); await second;
    await authority.withWriteLease("t", b, async () => {});
  } finally { authority.close(); }
});

import { DatabaseSync } from "node:sqlite";
import { readdir } from "node:fs/promises";
import { schemaFingerprint, openManagedDatabase } from "@opencraft/sqlite-node";
import { DSH_EXECUTION_BASELINE } from "../../apps/local-agent-host/src/dsh-execution-authority.js";
import { ThreadExecutionJournal } from "../../apps/local-agent-host/src/hypernode/execution-authority.js";
import { ThreadQueueStore } from "../../apps/local-agent-host/src/hypernode/thread-queue.js";

test("baseline migration is sole DDL authority and matches hypernode initializeSchema fingerprint exactly", () => {
  const dbBaseline = openManagedDatabase({
    path: ":memory:",
    migrations: [{ version: 1, name: "executions", sql: DSH_EXECUTION_BASELINE }],
  }).database;

  const dbLegacy = new DatabaseSync(":memory:");
  dbLegacy.exec(`CREATE TABLE opencraft_execution_inputs (
    execution_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, native_rpc_id TEXT NOT NULL UNIQUE,
    client_message_id TEXT, actor_id TEXT NOT NULL
  )`);
  dbLegacy.exec(`CREATE TABLE opencraft_queue_inputs (
    native_rpc_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
    request_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_username TEXT NOT NULL, connection_id TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  )`);
  const storage = {
    available: true,
    sql: {
      exec: (sql: string, ...args: any[]) => {
        const statement = dbLegacy.prepare(sql);
        if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { toArray: () => statement.all(...args) };
        statement.run(...args);
        return { toArray: () => [] };
      },
    },
    transactionSync: (op: () => void) => {
      dbLegacy.exec("BEGIN IMMEDIATE");
      try { op(); dbLegacy.exec("COMMIT"); }
      catch (e) { dbLegacy.exec("ROLLBACK"); throw e; }
    },
  };
  new ThreadExecutionJournal(storage);
  new ThreadQueueStore(storage);

  try {
    assert.equal(schemaFingerprint(dbBaseline), schemaFingerprint(dbLegacy));
  } finally {
    dbBaseline.close();
    dbLegacy.close();
  }
});

test("DshExecutionAuthority manages SQLite lifecycle: fresh, up-to-date, adopted, and moved-aside", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-execution-lifecycle-"));
  const path = join(root, "execution.sqlite");
  try {
    // 1. Fresh
    const fresh = new DshExecutionAuthority(path, "boot-fresh");
    assert.equal(fresh.outcome.status, "fresh");
    const admitted = fresh.claim("t1", owner("c1"), "req-1");
    fresh.rememberInput(admitted, "rpc-1", "msg-1");
    fresh.close();

    // 2. Up-to-date
    const reopened = new DshExecutionAuthority(path, "boot-reopen");
    assert.equal(reopened.outcome.status, "up-to-date");
    const projected = reopened.projectInput("t1", { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "rpc-1" } } });
    assert.equal((projected.data as any).source.rpcId, "msg-1");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DshExecutionAuthority adopts legacy matching database and moves aside mismatched legacy database", async () => {
  for (const matching of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), `opencraft-execution-legacy-${matching ? "match" : "mismatch"}-`));
    const path = join(root, "execution.sqlite");
    try {
      const raw = new DatabaseSync(path);
      // Create legacy structure
      raw.exec(`CREATE TABLE opencraft_execution_inputs (
        execution_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, native_rpc_id TEXT NOT NULL UNIQUE,
        client_message_id TEXT, actor_id TEXT NOT NULL
      )`);
      raw.exec(`CREATE TABLE opencraft_queue_inputs (
        native_rpc_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
        request_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_username TEXT NOT NULL, connection_id TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      )`);
      const storage = {
        available: true,
        sql: {
          exec: (sql: string, ...args: any[]) => {
            const statement = raw.prepare(sql);
            if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { toArray: () => statement.all(...args) };
            statement.run(...args);
            return { toArray: () => [] };
          },
        },
        transactionSync: (op: () => void) => {
          raw.exec("BEGIN IMMEDIATE");
          try { op(); raw.exec("COMMIT"); }
          catch (e) { raw.exec("ROLLBACK"); throw e; }
        },
      };
      new ThreadExecutionJournal(storage);
      new ThreadQueueStore(storage);

      if (matching) {
        raw.prepare("INSERT INTO opencraft_execution_inputs VALUES (?, ?, ?, ?, ?)").run("exec-legacy", "t-legacy", "rpc-legacy", "msg-legacy", "user-1");
      } else {
        raw.exec("CREATE TABLE extra_table (id TEXT PRIMARY KEY)");
      }
      raw.close();

      const authority = new DshExecutionAuthority(path, "boot-legacy");
      try {
        assert.equal(authority.outcome.status, matching ? "adopted" : "moved-aside");
        assert.ok(authority.outcome.backupPath);
        const files = await readdir(root);
        assert.ok(files.some(f => f.includes(".pre-v1-")));
        assert.equal(files.some(f => f.includes(".legacy-")), !matching);

        if (matching) {
          const projected = authority.projectInput("t-legacy", { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "rpc-legacy" } } });
          assert.equal((projected.data as any).source.rpcId, "msg-legacy");
        }
      } finally {
        authority.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("known missing execution objects preserve inputs, queue, epochs and previous-boot fencing", async () => {
  for (const missing of ["table", "index"] as const) {
    const root = await mkdtemp(join(tmpdir(), "opencraft-execution-missing-"));
    const path = join(root, "execution.sqlite");
    try {
      const first = new DshExecutionAuthority(path, "old-boot");
      const admitted = first.claim("thread", owner("old"), "request");
      first.rememberInput(admitted, "rpc", "client-message");
      first.nativeStarted(admitted, "turn", "native-turn");
      const queued = first.queueStore.add("thread", "queued-message", "local-user", [{ type: "text", text: "pending input" }]).submission;
      first.queueInput("queued-rpc", "thread", owner("old"), "queued-request", "queued-message");
      first.queueStore.pauseAfterInterruption("thread");
      first.close();
      const legacy = new DatabaseSync(path);
      legacy.exec(`DROP TABLE schema_migrations; ${missing === "table" ? "DROP TABLE hypernode_thread_queue_state" : "DROP INDEX hypernode_thread_queue_actor"}`);
      legacy.close();

      const recovered = new DshExecutionAuthority(path, "new-boot");
      try {
        assert.equal(recovered.outcome.status, "migrated");
        assert.ok(recovered.outcome.backupPath);
        assert.deepEqual(recovered.outcome.movedAsidePaths, []);
        const input = { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user", rpcId: "rpc" } } };
        assert.equal((recovered.projectInput("thread", input).data as any).source.rpcId, "client-message");
        assert.deepEqual(recovered.queueStore.pending("thread"), [queued]);
        assert.equal(recovered.queueStore.isPaused("thread"), missing === "index");
        assert.equal(recovered.queuedInputs().length, 1);
        assert.equal(recovered.queuedInputs()[0].clientMessageId, "queued-message");
        assert.equal(recovered.recoveredOrphans.length, 1);
        assert.equal(recovered.recoveredOrphans[0].state, "orphaned");
        const next = recovered.claim("thread", owner("new"), "next-request");
        assert.ok(next.epoch > admitted.epoch);
        recovered.finish(next, "completed", "done");
      } finally { recovered.close(); }
      const again = new DshExecutionAuthority(path, "new-boot");
      try {
        assert.equal(again.outcome.status, "up-to-date");
        assert.equal(again.outcome.backupPath, undefined);
        assert.deepEqual(again.queueStore.pending("thread"), [queued]);
        assert.equal(again.queuedInputs().length, 1);
        assert.equal(again.recoveredOrphans.length, 0);
      } finally { again.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
