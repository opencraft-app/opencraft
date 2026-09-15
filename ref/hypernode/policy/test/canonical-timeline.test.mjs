import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  CanonicalTimelineService,
  CanonicalTimelineTable,
  projectAppServerTimeline,
  reduceCanonicalTimeline,
} from "../src/services/canonical-timeline.ts";

function input(type, overrides = {}) {
  return {
    type,
    turnId: overrides.turnId ?? "turn-1",
    itemId: overrides.itemId ?? null,
    data: overrides.data ?? {},
    source: overrides.source ?? { engine: "dsh", kind: "execution" },
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
  };
}

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  const sql = {
    exec(source, ...bindings) {
      const statement = database.prepare(source);
      const rows = statement.columns().length > 0
        ? statement.all(...bindings)
        : (statement.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
  return {
    available: true,
    sql,
    database,
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

test("canonical timeline assigns monotonic sequence and deduplicates explicit event ids", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  const first = table.append("thread-1", input("turn.started", { eventId: "native-1" }));
  const duplicate = table.append("thread-1", input("turn.started", { eventId: "native-1" }));
  const second = table.append("thread-1", input("turn.completed"));

  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  assert.equal(second.event.seq, 1);
  assert.deepEqual(table.entries("thread-1").map((event) => event.seq), [0, 1]);
});

test("canonical timeline batches one Turn prefix in one durable transaction", () => {
  const storage = sqliteStorage();
  let transactions = 0;
  const transactionSync = storage.transactionSync.bind(storage);
  storage.transactionSync = (callback) => {
    transactions += 1;
    return transactionSync(callback);
  };
  const table = new CanonicalTimelineTable(storage, { epochFactory: () => "epoch-a" });

  const results = table.appendBatch("thread-1", [
    input("turn.started", { eventId: "turn-started" }),
    input("item.started", { eventId: "item-started", itemId: "item-1" }),
    input("item.completed", { eventId: "item-completed", itemId: "item-1" }),
  ]);

  assert.equal(transactions, 1);
  assert.deepEqual(results.map((result) => result.event.seq), [0, 1, 2]);
  assert.equal(table.head("thread-1").nextSeq, 3);
});

test("runtime rejects legacy canonical schemas instead of mutating them in place", () => {
  const storage = sqliteStorage();
  storage.database.exec(`
    CREATE TABLE hypernode_canonical_timeline_heads(
      thread_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, next_seq INTEGER NOT NULL,
      min_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE hypernode_canonical_timeline_entries(
      thread_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
      event_id TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY(thread_id, epoch, seq), UNIQUE(thread_id, epoch, event_id)
    );
  `);
  assert.throws(
    () => new CanonicalTimelineTable(storage, { epochFactory: () => "epoch-a" }),
    /requires one-time migration to v2/,
  );
  assert.equal(storage.database.prepare(`
    SELECT count(*) AS value FROM pragma_table_info('hypernode_canonical_timeline_entries')
  `).get().value, 5, "runtime must not ALTER a legacy table before refusing it");
});

test("canonical timeline rejects an event id reused with different canonical content", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  table.append("thread-1", input("turn.started", {
    eventId: "native-1",
    data: { method: "turn/started", params: { value: 1 } },
  }));
  assert.throws(() => table.append("thread-1", input("turn.started", {
    eventId: "native-1",
    data: { method: "turn/started", params: { value: 2 } },
  })), /canonical event id conflict/);
});

test("AppServer projection persistence failures are durable but never block outward delivery", () => {
  const service = Object.create(CanonicalTimelineService.prototype);
  service.table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  service.recordAppServer("turn/started", {
    threadId: "thread-1",
    turn: { id: "turn-1", status: "inProgress", items: [] },
  }, { engine: "dsh", kind: "execution" });

  let result;
  assert.doesNotThrow(() => {
    result = service.recordAppServer("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "inProgress", items: [{ id: "different" }] },
    }, { engine: "dsh", kind: "execution" });
  });
  assert.equal(result.persisted, false);
  assert.match(result.failure.errorMessage, /canonical event id conflict/);
  assert.equal(service.table.failures("thread-1").length, 1);
});

test("large canonical strings are content-addressed and transparently hydrated", () => {
  const storage = sqliteStorage();
  const table = new CanonicalTimelineTable(storage, { epochFactory: () => "epoch-a" });
  const output = "x".repeat(80 * 1024);
  table.append("thread-1", input("item.completed", {
    eventId: "item/completed:turn-1:command-1",
    itemId: "command-1",
    data: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", aggregatedOutput: output },
      },
    },
  }));

  const raw = storage.database.prepare(`
    SELECT event_json FROM hypernode_canonical_timeline_entries
  `).get().event_json;
  assert.ok(raw.length < 8 * 1024, "large content must not remain inline in an event row");
  assert.equal(storage.database.prepare(`
    SELECT count(*) AS value FROM hypernode_canonical_timeline_blobs
  `).get().value, 1);
  assert.equal(table.entries("thread-1")[0].data.params.item.aggregatedOutput, output);
  table.reset("thread-1");
  assert.equal(storage.database.prepare(`
    SELECT count(*) AS value FROM hypernode_canonical_timeline_blobs
  `).get().value, 0, "retired epochs must release unreferenced blobs");
});

test("retention advances minSeq only at a committed boundary and reports old cursors as gaps", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  for (const turnId of ["turn-1", "turn-2"]) {
    table.append("thread-1", input("turn.started", {
      turnId, eventId: `turn/started:${turnId}`,
    }));
    table.append("thread-1", input("turn.completed", {
      turnId, eventId: `turn/completed:${turnId}`,
    }));
  }
  const head = table.head("thread-1");
  assert.throws(() => table.compactThrough("thread-1", {
    epoch: head.epoch, seq: 0,
  }), /committed turn boundary/);
  const compacted = table.compactThrough("thread-1", { epoch: head.epoch, seq: 1 });
  assert.equal(compacted.minSeq, 2);
  assert.deepEqual(table.entries("thread-1").map((event) => event.seq), [2, 3]);
  assert.equal(table.sync("thread-1", {
    cursor: { epoch: head.epoch, seq: 0 }, direction: "after",
  }).gap, true);
});

test("canonical sync reports epoch reset without interpreting a stale cursor", () => {
  let epoch = 0;
  const table = new CanonicalTimelineTable(null, { epochFactory: () => `epoch-${++epoch}` });
  table.append("thread-1", input("turn.started"));
  const before = table.head("thread-1");
  table.reset("thread-1");
  table.append("thread-1", input("turn.started", { turnId: "turn-2" }));

  const page = table.sync("thread-1", {
    cursor: { epoch: before.epoch, seq: 0 },
    direction: "after",
  });
  assert.equal(page.reset, true);
  assert.equal(page.staleCursor, true);
  assert.equal(page.epoch, "epoch-2");
  assert.equal(page.entries.length, 1);
});

test("canonical facts reduce into ordered AppServer turns and items", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  const append = (event) => table.append("thread-1", event);
  append(input("turn.started", { data: {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  } }));
  append(input("item.completed", { itemId: "user-1", data: {
    method: "item/completed",
    params: {
      threadId: "thread-1", turnId: "turn-1",
      item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "hello" }] },
    },
  } }));
  append(input("item.started", { itemId: "agent-1", data: {
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "" } },
  } }));
  append(input("item.delta", { itemId: "agent-1", data: {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "world" },
  } }));
  append(input("item.completed", { itemId: "agent-1", data: {
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "world" } },
  } }));
  append(input("turn.completed", { data: {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  } }));

  const turns = reduceCanonicalTimeline(table.entries("thread-1"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, "completed");
  assert.deepEqual(turns[0].items.map((item) => item.id), ["user-1", "agent-1"]);
  assert.equal(turns[0].items[1].text, "world");
});

test("canonical fork copies a bounded fact prefix and retargets wire thread identity", () => {
  let epoch = 0;
  const table = new CanonicalTimelineTable(null, { epochFactory: () => `epoch-${++epoch}` });
  for (const turnId of ["turn-1", "turn-2"]) {
    table.append("thread-source", input("turn.started", {
      turnId,
      eventId: `turn/started:${turnId}`,
      data: {
        method: "turn/started",
        params: {
          threadId: "thread-source",
          thread: { id: "thread-source" },
          turn: { id: turnId, status: "inProgress", items: [] },
        },
      },
    }));
    table.append("thread-source", input("turn.completed", {
      turnId,
      eventId: `turn/completed:${turnId}`,
      data: {
        method: "turn/completed",
        params: {
          threadId: "thread-source",
          turn: { id: turnId, status: "completed", items: [] },
        },
      },
    }));
  }

  const result = table.fork("thread-source", "thread-fork", { lastTurnId: "turn-1" });
  const forked = table.entries("thread-fork");
  assert.equal(result.count, 2);
  assert.deepEqual(forked.map((event) => event.turnId), ["turn-1", "turn-1"]);
  assert.deepEqual(forked.map((event) => event.id), [
    "turn/started:turn-1", "turn/completed:turn-1",
  ]);
  assert.equal(forked[0].threadId, "thread-fork");
  assert.equal(forked[0].data.params.threadId, "thread-fork");
  assert.equal(forked[0].data.params.thread.id, "thread-fork");
  assert.equal(table.entries("thread-source").length, 4);
  assert.throws(
    () => table.fork("thread-source", "thread-missing", { lastTurnId: "turn-missing" }),
    /terminal boundary/,
  );
  assert.equal(table.entries("thread-missing").length, 0);
  assert.throws(
    () => table.fork("thread-source", "thread-fork"),
    /already exists/,
  );
});

test("canonical fork persists its copied prefix in one durable transaction", () => {
  const storage = sqliteStorage();
  let transactions = 0;
  let sqlCalls = 0;
  const exec = storage.sql.exec.bind(storage.sql);
  storage.sql.exec = (...args) => {
    sqlCalls += 1;
    return exec(...args);
  };
  const transactionSync = storage.transactionSync.bind(storage);
  storage.transactionSync = (callback) => {
    transactions += 1;
    return transactionSync(callback);
  };
  const table = new CanonicalTimelineTable(storage, { epochFactory: () => "epoch-a" });
  for (let index = 0; index < 20; index += 1) {
    table.append("thread-source", input(index === 19 ? "turn.completed" : "item.delta", {
      eventId: `event-${index}`,
      data: index === 19
        ? {
            method: "turn/completed",
            params: {
              threadId: "thread-source",
              turn: { id: "turn-1", status: "completed", items: [] },
            },
          }
        : {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-source",
              turnId: "turn-1",
              itemId: "agent-1",
              delta: String(index),
            },
          },
    }));
  }

  const beforeFork = transactions;
  const sqlCallsBeforeFork = sqlCalls;
  const result = table.fork("thread-source", "thread-fork");
  assert.equal(result.count, 20);
  assert.equal(transactions - beforeFork, 1);
  assert.ok(sqlCalls - sqlCallsBeforeFork < 20);
  assert.equal(table.entries("thread-fork").length, 20);
});

test("canonical fork accepts an exact source cursor and rejects non-terminal turn anchors", () => {
  let epoch = 0;
  const table = new CanonicalTimelineTable(null, { epochFactory: () => `epoch-${++epoch}` });
  table.append("thread-source", input("turn.started", {
    turnId: "turn-1", eventId: "turn/started:turn-1",
  }));
  const completed = table.append("thread-source", input("turn.completed", {
    turnId: "turn-1", eventId: "turn/completed:turn-1",
  })).event;
  table.append("thread-source", input("turn.started", {
    turnId: "turn-2", eventId: "turn/started:turn-2",
  }));

  const result = table.fork("thread-source", "thread-cursor", {
    cursor: { epoch: completed.epoch, seq: completed.seq },
  });
  assert.equal(result.count, 2);
  assert.deepEqual(table.entries("thread-cursor").map((event) => event.turnId), ["turn-1", "turn-1"]);
  assert.throws(
    () => table.fork("thread-source", "thread-active", { lastTurnId: "turn-2" }),
    /terminal boundary/,
  );
  assert.throws(
    () => table.fork("thread-source", "thread-active-cursor", {
      cursor: { epoch: completed.epoch, seq: completed.seq + 1 },
    }),
    /committed turn boundary/,
  );
  assert.throws(
    () => table.fork("thread-source", "thread-stale", { cursor: { epoch: "stale", seq: 1 } }),
    /stale fork cursor/,
  );
});

test("thread/timeline/list uses the current Codex shape and stable latest-first cursor", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  table.append("thread-1", input("turn.started", { data: {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  } }));
  table.append("thread-1", input("turn.completed", { data: {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } },
  } }));

  const events = table.entries("thread-1");
  const first = projectAppServerTimeline(events, "epoch-a", { limit: 1 });
  const second = projectAppServerTimeline(events, "epoch-a", { limit: 1, cursor: first.nextCursor });
  assert.deepEqual(Object.keys(first), ["data", "nextCursor", "activeRealtimeSessionAtPageStart"]);
  assert.equal(first.data[0].type, "turnCompleted");
  assert.equal(second.data[0].type, "turnStarted");
  assert.equal(second.nextCursor, null);
});

test("SQLite timeline pagination is bounded and does not hydrate the full event ledger", () => {
  const storage = sqliteStorage();
  const table = new CanonicalTimelineTable(storage, { epochFactory: () => "epoch-a" });
  for (let index = 0; index < 80; index += 1) {
    const turnId = `turn-${index}`;
    table.append("thread-1", input("turn.started", {
      turnId,
      eventId: `turn/started:${turnId}`,
      data: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: turnId, status: "inProgress", items: [], startedAt: index },
        },
      },
    }));
    table.append("thread-1", input("turn.completed", {
      turnId,
      eventId: `turn/completed:${turnId}`,
      data: {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: turnId, status: "completed", items: [], completedAt: index + 1 },
        },
      },
    }));
  }
  table.entries = () => { throw new Error("full ledger hydration is forbidden"); };
  const first = table.timeline("thread-1", { limit: 3 });
  const second = table.timeline("thread-1", { limit: 3, cursor: first.nextCursor });
  assert.equal(first.data.length, 3);
  assert.equal(second.data.length, 3);
  assert.ok(first.data.every((row, index, rows) => index === 0 || rows[index - 1].position > row.position));
  assert.ok(first.data.at(-1).position > second.data[0].position);
});

test("projected item position is its stable seqStart while seqEnd grows through completion", () => {
  const table = new CanonicalTimelineTable(null, { epochFactory: () => "epoch-a" });
  table.append("thread-1", input("turn.started", { data: {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress", items: [] } },
  } }));
  table.append("thread-1", input("item.started", { itemId: "agent-1", data: {
    method: "item/started",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "" } },
  } }));
  const before = projectAppServerTimeline(table.entries("thread-1"), "epoch-a", { limit: 20 })
    .data.find((entry) => entry.type === "item");
  table.append("thread-1", input("item.delta", { itemId: "agent-1", data: {
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "hello" },
  } }));
  table.append("thread-1", input("item.completed", { itemId: "agent-1", data: {
    method: "item/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "hello" } },
  } }));
  const after = projectAppServerTimeline(table.entries("thread-1"), "epoch-a", { limit: 20 })
    .data.find((entry) => entry.type === "item");

  assert.equal(after.position, before.position);
  assert.equal(after.seqStart, before.position);
  assert.ok(after.seqEnd > after.seqStart);
  assert.deepEqual(after.sourceSeqRanges, [{ startSeq: after.seqStart, endSeq: after.seqEnd }]);
  assert.deepEqual(after.collapsed, ["assistant_merge"]);
});

test("one-time migration emits only canonical facts and never deletes its source", () => {
  const directory = mkdtempSync(join(tmpdir(), "hypernode-timeline-"));
  const databasePath = join(directory, "hypernode.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE do_thread_catalog_turns(
      principal_id TEXT NOT NULL, thread_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      position INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(principal_id, thread_id, turn_id)
    )
  `);
  database.prepare(`INSERT INTO do_thread_catalog_turns VALUES(?, ?, ?, ?, ?)`).run(
    "root", "thread-1", "turn-1", 0,
    JSON.stringify({
      id: "turn-1", status: "completed",
      items: [{
        id: "command-1", type: "commandExecution",
        command: "generate output", aggregatedOutput: "m".repeat(80 * 1024),
      }],
    }),
  );
  database.close();

  const script = resolve("scripts/migrate-canonical-timeline.mjs");
  execFileSync(process.execPath, [script, "--db", databasePath, "--dry-run"]);
  const afterDryRun = new DatabaseSync(databasePath);
  assert.equal(afterDryRun.prepare(`
    SELECT count(*) AS value FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'hypernode_canonical_timeline_%'
  `).get().value, 0, "dry-run must not create canonical tables");
  afterDryRun.close();
  execFileSync(process.execPath, [script, "--db", databasePath]);
  execFileSync(process.execPath, [script, "--db", databasePath]);

  const migrated = new DatabaseSync(databasePath);
  assert.equal(migrated.prepare(`SELECT count(*) AS value FROM do_thread_catalog_turns`).get().value, 1);
  assert.equal(migrated.prepare(`SELECT count(*) AS value FROM hypernode_canonical_timeline_entries`).get().value, 3);
  assert.equal(migrated.prepare(`SELECT next_seq FROM hypernode_canonical_timeline_heads`).get().next_seq, 3);
  assert.equal(migrated.prepare(`
    SELECT schema_version FROM hypernode_canonical_timeline_meta WHERE singleton = 1
  `).get().schema_version, 2);
  assert.equal(migrated.prepare(`SELECT count(*) AS value FROM hypernode_canonical_timeline_blobs`).get().value, 1);
  assert.ok(migrated.prepare(`
    SELECT max(length(event_json)) AS value FROM hypernode_canonical_timeline_entries
  `).get().value < 8 * 1024);
  assert.deepEqual(
    migrated.prepare(`SELECT event_json FROM hypernode_canonical_timeline_entries ORDER BY seq`).all()
      .map(({ event_json }) => JSON.parse(event_json).type),
    ["turn.started", "item.completed", "turn.completed"],
  );
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});

test("one-time migration upgrades an existing canonical-only database", () => {
  const directory = mkdtempSync(join(tmpdir(), "hypernode-timeline-upgrade-"));
  const databasePath = join(directory, "hypernode.sqlite");
  const database = new DatabaseSync(databasePath);
  const largeOutput = "z".repeat(80 * 1024);
  const event = {
    id: "item/completed:turn-1:command-1",
    threadId: "thread-1",
    epoch: "epoch-old",
    seq: 0,
    type: "item.completed",
    time: 1_700_000_000_000,
    turnId: "turn-1",
    itemId: "command-1",
    data: {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "command-1", type: "commandExecution", aggregatedOutput: largeOutput },
      },
    },
    source: { engine: "dsh" },
  };
  database.exec(`
    CREATE TABLE hypernode_canonical_timeline_heads(
      thread_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, next_seq INTEGER NOT NULL,
      min_seq INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE hypernode_canonical_timeline_entries(
      thread_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
      event_id TEXT NOT NULL, event_json TEXT NOT NULL,
      PRIMARY KEY(thread_id, epoch, seq), UNIQUE(thread_id, epoch, event_id)
    );
  `);
  database.prepare(`INSERT INTO hypernode_canonical_timeline_heads VALUES(?, ?, ?, ?, ?)`)
    .run("thread-1", "epoch-old", 1, 0, Date.now());
  database.prepare(`INSERT INTO hypernode_canonical_timeline_entries VALUES(?, ?, ?, ?, ?)`)
    .run("thread-1", "epoch-old", 0, event.id, JSON.stringify(event));
  database.close();

  const script = resolve("scripts/migrate-canonical-timeline.mjs");
  execFileSync(process.execPath, [script, "--db", databasePath]);
  execFileSync(process.execPath, [script, "--db", databasePath]);

  const migrated = new DatabaseSync(databasePath);
  const row = migrated.prepare(`
    SELECT schema_version, event_type, source_engine, source_kind, payload_hash,
           item_type, search_role, search_text, event_json
    FROM hypernode_canonical_timeline_entries
  `).get();
  assert.equal(row.schema_version, 2);
  assert.equal(row.event_type, "item.completed");
  assert.equal(row.source_engine, "dsh");
  assert.equal(row.source_kind, "execution");
  assert.equal(row.item_type, "commandExecution");
  assert.equal(row.search_role, "tool");
  assert.ok(row.payload_hash);
  assert.ok(row.event_json.length < 8 * 1024);
  assert.equal(migrated.prepare(`
    SELECT count(*) AS value FROM hypernode_canonical_timeline_blobs
  `).get().value, 1);
  assert.equal(migrated.prepare(`
    SELECT count(*) AS value FROM hypernode_canonical_timeline_blob_refs
  `).get().value, 1);
  assert.equal(migrated.prepare(`
    SELECT schema_version FROM hypernode_canonical_timeline_meta WHERE singleton = 1
  `).get().schema_version, 2);
  migrated.close();
  rmSync(directory, { recursive: true, force: true });
});
