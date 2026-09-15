import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  searchQueryFromInput, searchRouteForQuery, ThreadSearchService,
} from "../src/services/thread-search.js";
import { CanonicalTimelineTable } from "../src/services/canonical-timeline.ts";

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

function createCatalogStorage() {
  const storage = sqliteStorage();
  storage.sql.exec(`
    CREATE TABLE do_thread_catalog_records (
      principal_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (principal_id, thread_id)
    )
  `);
  return storage;
}

function createService() {
  const storage = createCatalogStorage();
  const timeline = new CanonicalTimelineTable(storage);
  const service = Object.create(ThreadSearchService.prototype);
  service.storage = storage;
  service.available = true;
  service.initialize();
  return { service, storage, timeline };
}

function threadRecord(name, preview = "") {
  return JSON.stringify({
    thread: { name, preview, updatedAt: 100 },
    archived: false,
  });
}

function ownedThreadRecord(name, ownerPrincipalId, visibility) {
  const record = JSON.parse(threadRecord(name));
  record.ownerPrincipalId = ownerPrincipalId;
  record.visibility = visibility;
  return JSON.stringify(record);
}

function appendCompletedItems(timeline, threadId, turnId, items) {
  for (const item of items) {
    timeline.append(threadId, {
      eventId: `item/completed:${turnId}:${item.id}`,
      type: "item.completed",
      time: 101_000,
      turnId,
      itemId: item.id,
      data: {
        method: "item/completed",
        params: { threadId, turnId, item },
      },
      source: { engine: "test", kind: "execution" },
    });
  }
}

function appendConversation(timeline, threadId, userText, agentText, extraItems = []) {
  appendCompletedItems(timeline, threadId, "turn-1", [
    { id: "user-1", type: "userMessage", content: [{ type: "text", text: userText }] },
    { id: "agent-1", type: "agentMessage", text: agentText },
    ...extraItems,
  ]);
}

test("FTS5 indexes durable history and remains current through catalog triggers", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-1", threadRecord("登录问题"),
  );
  appendConversation(timeline, "thread-1", "帮我排查登录失败", "发现凭据过期");

  assert.deepEqual(
    service.search("登录失败").map(({ role, content }) => ({ role, content })),
    [{ role: "user", content: "帮我排查登录失败" }],
  );
  assert.equal(service.search("凭据")[0].role, "assistant", "two-character queries use the CJK bigram index");

  timeline.reset("thread-1");
  appendConversation(timeline, "thread-1", "帮我排查网络中断", "连接已经恢复");
  assert.equal(service.search("登录失败").length, 0, "an updated Turn removes stale indexed text");
  assert.equal(service.search("网络中断")[0].content, "帮我排查网络中断");
});

test("search excludes private conversation content from every non-owner", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "private-alice", ownedThreadRecord("Alice private", "user:alice", "private"),
  );
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "shared-bob", ownedThreadRecord("Bob shared", "user:bob", "nodeShared"),
  );
  appendConversation(timeline, "private-alice", "unique privacy token", "owner-only answer");
  appendConversation(timeline, "shared-bob", "shared privacy token", "shared answer");

  assert.deepEqual(
    service.search("privacy token", { actorPrincipalId: "user:alice" })
      .map(({ threadId }) => threadId).sort(),
    ["private-alice", "shared-bob"],
  );
  assert.deepEqual(
    service.search("privacy token", { actorPrincipalId: "user:bob" })
      .map(({ threadId }) => threadId),
    ["shared-bob"],
  );
  assert.deepEqual(
    service.search("privacy token", { actorPrincipalId: null })
      .map(({ threadId }) => threadId),
    ["shared-bob"],
  );
});

test("catalog metadata updates preserve canonical item indexes without rebuilding them", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-1", threadRecord("旧标题"),
  );
  appendConversation(timeline, "thread-1", "保留这条消息", "索引不能重建");
  const itemCount = storage.sql.exec(`
    SELECT count(*) AS value FROM do_thread_search_fts
    WHERE thread_id = ? AND source_type = 'item'
  `, "thread-1").toArray()[0].value;

  storage.sql.exec(
    "UPDATE do_thread_catalog_records SET payload = ? WHERE principal_id = ? AND thread_id = ?",
    threadRecord("新标题"), "node:root", "thread-1",
  );

  assert.equal(storage.sql.exec(`
    SELECT count(*) AS value FROM do_thread_search_fts
    WHERE thread_id = ? AND source_type = 'item'
  `, "thread-1").toArray()[0].value, itemCount);
  assert.equal(service.search("保留这条消息")[0].content, "保留这条消息");
  assert.equal(service.search("新标题")[0].threadName, "新标题");

  const threadIndexRowId = storage.sql.exec(`
    SELECT rowid FROM do_thread_search_fts
    WHERE thread_id = ? AND source_type = 'thread'
  `, "thread-1").toArray()[0].rowid;
  const metadataOnly = JSON.parse(threadRecord("新标题"));
  metadataOnly.thread.updatedAt = 101;
  storage.sql.exec(
    "UPDATE do_thread_catalog_records SET payload = ? WHERE principal_id = ? AND thread_id = ?",
    JSON.stringify(metadataOnly), "node:root", "thread-1",
  );
  assert.equal(storage.sql.exec(`
    SELECT rowid FROM do_thread_search_fts
    WHERE thread_id = ? AND source_type = 'thread'
  `, "thread-1").toArray()[0].rowid, threadIndexRowId);
});

test("historical FTS5 backfill is incremental and writes its completion checkpoint", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-old", threadRecord("历史会话"),
  );
  appendCompletedItems(timeline, "thread-old", "turn-old", [
    { id: "user-old", type: "userMessage", content: [{ type: "text", text: "搜索旧消息" }] },
    { id: "agent-old", type: "agentMessage", text: "已经找到历史" },
  ]);
  storage.sql.exec("DELETE FROM do_thread_search_fts");
  storage.sql.exec("DELETE FROM do_thread_search_fts_trigram");
  storage.sql.exec("DELETE FROM do_thread_search_fts_cjk");
  service.backfillInProgress = true;
  service.backfillScheduled = false;
  service.backfillCancelled = false;
  service.backfillNeedsStart = false;
  service.startBackfill();

  let ticks = 0;
  for (; service.backfillInProgress && ticks < 100; ticks += 1) service.tick();

  assert.equal(service.backfillInProgress, false);
  assert.ok(ticks >= 3, "records, turns, and completion are separate bounded ticks");
  assert.equal(service.search("旧消息")[0].content, "搜索旧消息");
  assert.equal(storage.sql.exec(
    "SELECT count(*) AS value FROM do_thread_search_meta WHERE schema_version = 4",
  ).toArray()[0].value, 1);
});

test("schema v1 is replaced by the canonical tiered v4 indexes before historical backfill", () => {
  const storage = createCatalogStorage();
  new CanonicalTimelineTable(storage);
  storage.sql.exec(`
    CREATE TABLE do_thread_search_meta (
      schema_version INTEGER PRIMARY KEY,
      indexed_at_ms INTEGER NOT NULL
    )
  `);
  storage.sql.exec("INSERT INTO do_thread_search_meta VALUES (1, 1)");
  storage.sql.exec(`
    CREATE VIRTUAL TABLE do_thread_search_fts USING fts5(
      principal_id UNINDEXED,
      source_type UNINDEXED,
      thread_id UNINDEXED,
      turn_id UNINDEXED,
      item_id UNINDEXED,
      role UNINDEXED,
      content,
      occurred_at_ms UNINDEXED,
      tokenize = 'trigram'
    )
  `);
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-v1", threadRecord("旧版中文索引"),
  );

  const service = Object.create(ThreadSearchService.prototype);
  service.storage = storage;
  service.available = true;
  assert.equal(service.initialize(), true);
  assert.deepEqual(
    storage.sql.exec("PRAGMA table_info(do_thread_search_fts)").toArray().map((row) => row.name),
    [
      "principal_id", "source_type", "thread_id", "turn_id", "item_id", "role",
      "search_text", "content", "occurred_at_ms",
    ],
  );
  assert.equal(storage.sql.exec(
    "SELECT count(*) AS value FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)",
    "do_thread_search_fts", "do_thread_search_fts_trigram", "do_thread_search_fts_cjk",
  ).toArray()[0].value, 3);

  service.backfillInProgress = true;
  service.backfillScheduled = false;
  service.backfillCancelled = false;
  service.backfillNeedsStart = false;
  service.startBackfill();
  for (let ticks = 0; service.backfillInProgress && ticks < 100; ticks += 1) service.tick();
  assert.equal(service.search("版中")[0].threadName, "旧版中文索引");
});

test("Chinese search routes long and two-character substrings through the CJK bigram projection", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-cjk", threadRecord("中文检索"),
  );
  appendCompletedItems(timeline, "thread-cjk", "turn-cjk", [
    { id: "user-cjk", type: "userMessage", content: [{ type: "text", text: "帮我排查登录失败" }] },
    { id: "agent-cjk", type: "agentMessage", text: "已经定位凭据过期" },
  ]);

  assert.equal(searchRouteForQuery("登录失败"), "cjk");
  assert.equal(searchRouteForQuery("录失"), "cjk");
  assert.equal(searchRouteForQuery("录"), "like");
  assert.equal(service.search("录失")[0].content, "帮我排查登录失败");
  assert.equal(service.search("录")[0].content, "帮我排查登录失败");
});

test("tool output stays in ordinary FTS but is excluded from expensive CJK and trigram indexes", () => {
  const { service, storage, timeline } = createService();
  storage.sql.exec(
    "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
    "node:root", "thread-tool", threadRecord("工具诊断"),
  );
  appendConversation(timeline, "thread-tool", "运行诊断", "我来检查", [{
      id: "command-1", type: "commandExecution", command: "deploy --check",
      aggregatedOutput: "fatal kernel panic 部署失败", status: "failed",
    }]);

  assert.equal(service.search("kernel panic")[0].role, "tool");
  assert.equal(service.search("部署失败")[0].role, "tool");
  for (const table of ["do_thread_search_fts_trigram", "do_thread_search_fts_cjk"]) {
    assert.equal(storage.sql.exec(
      `SELECT count(*) AS value FROM ${table} WHERE role = 'tool'`,
    ).toArray()[0].value, 0);
  }
  assert.equal(storage.sql.exec(
    "SELECT count(*) AS value FROM do_thread_search_fts WHERE role = 'tool'",
  ).toArray()[0].value, 1);
});

test("search skill invocation is removed from the actual FTS query", () => {
  assert.equal(searchQueryFromInput([{
    type: "text",
    text: "[$search](/workspace/.codex/skills/search-conversations/SKILL.md) 登录失败",
  }]), "登录失败");
  assert.equal(searchQueryFromInput([{ type: "text", text: "$search 凭据" }]), "凭据");
});

test("search excludes the authoritative current thread before ranking", () => {
  const { service, storage, timeline } = createService();
  for (const [threadId, name] of [["thread-admin", "管理员"], ["thread-other", "普通会话"]]) {
    storage.sql.exec(
      "INSERT INTO do_thread_catalog_records VALUES (?, ?, ?)",
      "node:root", threadId, threadRecord(name),
    );
    appendConversation(timeline, threadId, "查找循环搜索", `${name}的结果`);
  }

  const results = service.search("循环搜索", {
    limit: 1,
    excludeThreadId: "thread-admin",
  });
  assert.deepEqual(results.map((result) => result.threadId), ["thread-other"]);
});
