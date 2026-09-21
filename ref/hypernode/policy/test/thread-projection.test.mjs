import assert from "node:assert/strict";
import test from "node:test";

import {
  ThreadManagerService,
  mergeProjectedTurn,
  mergeProjectedTurns,
} from "../src/services/thread-manager.js";
import {
  canonicalThreadTitle,
  cloudThreadName,
} from "../src/services/thread-identity.ts";
import { HYPERNODE_ROUTER_PROVIDER_ID } from "../src/services/model-router.ts";
import {
  registerThreadHistoryProjectionHandlers,
  replayArchivedTombstones,
} from "../src/services/thread-lifecycle.ts";
import {
  isThreadCatalogCheckpoint,
  ThreadTombstoneLedger,
  THREAD_TOMBSTONE_RETENTION_MS,
} from "../src/services/thread-tombstone.ts";

test("connection-relative execution decorations never enter the canonical title", () => {
  assert.equal(
    canonicalThreadTitle("☁️ 🔒 我 · ✅ skipzhang · Locate project details"),
    "Locate project details",
  );
  assert.equal(
    cloudThreadName("✅ 我 · ✅ 我 · Locate project details (2)"),
    "☁️ Locate project details (2)",
  );
});

test("the first user message replaces the default cloud thread title", () => {
  const manager = Object.create(ThreadManagerService.prototype);
  const thread = {
    id: "thread-1",
    name: "☁️ New chat",
    preview: "",
    ephemeral: false,
  };
  manager.ensure = () => thread;
  manager.persistThread = () => {};

  manager.touch("thread-1", [{ type: "text", text: "Investigate startup" }]);

  assert.equal(thread.name, "☁️ Investigate startup");
  assert.equal(thread.preview, "Investigate startup");
});

function turn(id, status, items = []) {
  return { id, status, items };
}

test("a terminal turn cannot regress to inProgress", () => {
  const completed = turn("turn-1", "completed", [{ id: "answer" }]);
  const stale = turn("turn-1", "inProgress", []);

  assert.strictEqual(mergeProjectedTurn(completed, stale), completed);
});

test("a completion advances an inProgress turn", () => {
  const active = turn("turn-1", "inProgress", []);
  const completed = turn("turn-1", "completed", [{ id: "answer" }]);

  assert.deepEqual(mergeProjectedTurn(active, completed), completed);
});

test("the first terminal observation is sticky", () => {
  const failed = turn("turn-1", "failed", [{ id: "failure" }]);
  const conflicting = turn("turn-1", "completed", [{ id: "late-answer" }]);

  assert.deepEqual(mergeProjectedTurn(failed, conflicting), failed);
});

test("a terminal summary is enriched by later authoritative history without changing its outcome", () => {
  const completed = {
    ...turn("turn-1", "completed", [{ id: "answer", type: "agentMessage", text: "done" }]),
    itemsView: "summary",
  };
  const hydrated = {
    ...turn("turn-1", "completed", [
      { id: "question", type: "userMessage", content: [{ type: "text", text: "ship it" }] },
      { id: "history-answer", type: "agentMessage", text: "done" },
    ]),
    itemsView: "full",
  };

  const merged = mergeProjectedTurn(completed, hydrated);
  assert.equal(merged.status, "completed");
  assert.equal(merged.itemsView, "full");
  assert.deepEqual(merged.items.map(({ id }) => id), ["question", "history-answer"]);
});

test("an older snapshot cannot delete already projected turns", () => {
  const current = [
    turn("turn-1", "completed"),
    turn("turn-2", "completed"),
  ];
  const staleSnapshot = [turn("turn-1", "inProgress")];

  assert.deepEqual(mergeProjectedTurns(current, staleSnapshot), current);
});

test("new turns retain snapshot order while locally known history is preserved", () => {
  const current = [turn("turn-1", "completed")];
  const snapshot = [turn("turn-1", "completed"), turn("turn-2", "inProgress")];

  assert.deepEqual(mergeProjectedTurns(current, snapshot).map(({ id, status }) => ({ id, status })), [
    { id: "turn-1", status: "completed" },
    { id: "turn-2", status: "inProgress" },
  ]);
});

test("a delayed active snapshot cannot reopen a completed projected turn", () => {
  const manager = Object.create(ThreadManagerService.prototype);
  manager.threads = new Map([[
    "thread-1",
    {
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [turn("turn-1", "inProgress")],
      updatedAt: 1,
      recencyAt: 1,
      ephemeral: true,
    },
  ]]);

  manager.projectTurn("thread-1", {
    ...turn("turn-1", "completed", [{ id: "answer" }]),
    completedAt: 2,
  }, "completed");
  manager.project("thread-1", {
    status: { type: "active", activeFlags: [] },
    turns: [turn("turn-1", "inProgress")],
  });

  assert.equal(manager.get("thread-1").turns[0].status, "completed");
  assert.deepEqual(manager.get("thread-1").status, { type: "idle" });
});

test("startup reconciliation closes persisted in-progress turns", () => {
  const manager = Object.create(ThreadManagerService.prototype);
  manager.threads = new Map([[
    "thread-1",
    {
      id: "thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [{
        id: "turn-1",
        items: [],
        status: "inProgress",
        error: null,
        startedAt: 10,
        completedAt: null,
        durationMs: null,
      }],
      ephemeral: false,
    },
  ]]);
  let persisted = 0;
  manager.persistThread = () => { persisted += 1; };

  const interrupted = manager.reconcileInterruptedRuntime("thread-1", 13);

  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].status, "interrupted");
  assert.equal(interrupted[0].completedAt, 13);
  assert.equal(interrupted[0].durationMs, 3_000);
  assert.equal(interrupted[0].error, null);
  assert.deepEqual(manager.get("thread-1").status, { type: "idle" });
  assert.equal(persisted, 1);
  assert.deepEqual(manager.reconcileInterruptedRuntime("thread-1", 14), []);
  assert.equal(persisted, 1, "reconciliation is idempotent");
});

test("conversation and administrator identities acquire an execution facade exactly once", () => {
  const manager = Object.create(ThreadManagerService.prototype);
  manager.metadata = new Map([
    ["ordinary", { ownerPrincipalId: "node:root", visibility: "private", kind: "conversation" }],
    ["management", { ownerPrincipalId: "node:root", visibility: "nodeShared", kind: "management" }],
  ]);
  let persisted = 0;
  manager.persist = () => { persisted += 1; };

  assert.equal(manager.promoteToTransparentCodex("ordinary"), true);
  assert.equal(manager.isTransparentCodex("ordinary"), true);
  assert.equal(manager.promoteToTransparentCodex("ordinary"), false);
  assert.equal(manager.promoteToTransparentCodex("management"), true);
  assert.equal(manager.isRoot("management"), true, "execution must not erase the root identity");
  assert.equal(manager.isTransparentCodex("management"), true);
  assert.equal(manager.metadataFor("management").executionFacade, "appServer");
  assert.equal(manager.promoteToTransparentCodex("management"), false);
  assert.equal(persisted, 2);
});

function catalogManager() {
  const manager = Object.create(ThreadManagerService.prototype);
  manager.threads = new Map();
  manager.metadata = new Map();
  manager.archivedThreadIds = new Set();
  manager.sectionPositions = new Map();
  manager.catalogRevision = 1;
  manager.catalogCache = new Map();
  for (let index = 1; index <= 5; index += 1) {
    const id = `thread-${index}`;
    manager.threads.set(id, {
      id,
      name: `Thread ${index}`,
      preview: `preview ${index}`,
      createdAt: index,
      updatedAt: index,
      recencyAt: index,
      status: { type: "idle" },
      modelProvider: "openai",
      cwd: "/workspace",
      ephemeral: false,
      projectId: null,
      section: null,
      turns: [turn(`turn-${index}`, "completed")],
    });
    manager.metadata.set(id, { ownerPrincipalId: "node:root", visibility: "private", kind: "conversation" });
  }
  return manager;
}

test("private catalog threads are visible only to their owner", () => {
  const manager = catalogManager();
  manager.metadata.get("thread-1").ownerPrincipalId = "user:alice";
  manager.metadata.get("thread-2").ownerPrincipalId = "user:bob";
  manager.metadata.get("thread-2").visibility = "nodeShared";

  assert.deepEqual(
    manager.listPage({ limit: 10 }, "user:alice").data.map(({ id }) => id),
    ["thread-2", "thread-1"],
  );
  assert.deepEqual(
    manager.listPage({ limit: 10 }, "user:bob").data.map(({ id }) => id),
    ["thread-2"],
  );
  assert.deepEqual(manager.listPage({ limit: 10 }, null).data.map(({ id }) => id), ["thread-2"]);

  manager.persistThread = () => manager.invalidateCatalog();
  manager.setVisibility("thread-2", "private");
  assert.deepEqual(manager.listPage({ limit: 10 }, "user:alice").data.map(({ id }) => id), ["thread-1"]);
  assert.deepEqual(manager.listPage({ limit: 10 }, "user:bob").data.map(({ id }) => id), ["thread-2"]);
});

test("a hot thread update persists only that catalog row", () => {
  const manager = catalogManager();
  const writes = [];
  manager.principal = { id: "node:root" };
  manager.persistedRecords = new Map();
  manager.ctx = {
    storage: {
      sql: {
        exec: (query, ...params) => writes.push({ query, params }),
      },
    },
  };

  manager.persistThread("thread-3");

  assert.equal(writes.length, 1);
  assert.equal(writes[0].params[0], "node:root");
  assert.equal(writes[0].params[1], "thread-3");
  const payload = JSON.parse(writes[0].params[2]);
  assert.equal(payload.thread.id, "thread-3");
  assert.equal("turns" in payload.thread, false);
  assert.equal(manager.persistedRecords.size, 1);
  manager.persistThread("thread-3");
  assert.equal(writes.length, 1, "an unchanged row is not written twice");
});

test("the outer router provider is a wildcard over concrete rollout providers", () => {
  const manager = catalogManager();
  manager.threads.get("thread-1").modelProvider = "private-a";
  manager.threads.get("thread-2").modelProvider = "public-a";

  assert.equal(manager.list({ modelProviders: [HYPERNODE_ROUTER_PROVIDER_ID] }).length, 5);
  assert.deepEqual(
    manager.list({ modelProviders: ["private-a"] }).map((thread) => thread.id),
    ["thread-1"],
  );
});

test("thread sections persist membership and server-owned ordering", () => {
  const manager = catalogManager();
  manager.persist = () => manager.invalidateCatalog();
  const section = { id: "section-1", name: "Project A", appearance: null };

  manager.moveToSection("thread-1", section);
  manager.moveToSection("thread-2", section, "thread-1");
  manager.moveToSection("thread-3", section, "thread-1");

  assert.deepEqual(
    manager.list({ sectionId: section.id, sortKey: "section_position", sortDirection: "asc" }).map(({ id }) => id),
    ["thread-2", "thread-3", "thread-1"],
  );
  assert.deepEqual(manager.get("thread-3").section, section);
  assert.ok(manager.get("thread-3").sectionEnteredAt);

  manager.moveToSection("thread-3", null);
  assert.equal(manager.get("thread-3").section, null);
  assert.equal(manager.sectionPositions.has("thread-3"), false);
});

test("thread/list uses opaque stable pagination and strips turns", () => {
  const manager = catalogManager();
  const first = manager.listPage({ limit: 2 });
  assert.deepEqual(first.data.map(({ id }) => id), ["thread-5", "thread-4"]);
  assert.ok(first.nextCursor);
  assert.ok(first.backwardsCursor);
  assert.deepEqual(first.data.map(({ turns }) => turns), [[], []]);

  const second = manager.listPage({ limit: 2, cursor: first.nextCursor });
  const third = manager.listPage({ limit: 2, cursor: second.nextCursor });
  assert.deepEqual(second.data.map(({ id }) => id), ["thread-3", "thread-2"]);
  assert.deepEqual(third.data.map(({ id }) => id), ["thread-1"]);
  assert.equal(third.nextCursor, null);

  const backwards = manager.listPage({
    limit: 2,
    cursor: second.backwardsCursor,
    sortDirection: "asc",
  });
  assert.deepEqual(backwards.data.map(({ id }) => id), ["thread-4", "thread-5"]);
});

test("thread/list catalog projection is cached until invalidated", () => {
  const manager = catalogManager();
  const first = manager.listPage({ limit: 2 });
  const second = manager.listPage({ limit: 2 });
  assert.strictEqual(first.data[0], second.data[0]);
  assert.equal(manager.catalogCache.size, 1);

  manager.threads.get("thread-5").name = "Changed";
  manager.invalidateCatalog();
  const afterChange = manager.listPage({ limit: 2 });
  assert.notStrictEqual(first.data[0], afterChange.data[0]);
  assert.equal(afterChange.data[0].name, "Changed");
});

test("thread/list rejects a cursor from a different filter", () => {
  const manager = catalogManager();
  const first = manager.listPage({ limit: 2 });
  assert.throws(
    () => manager.listPage({ limit: 2, cursor: first.nextCursor, searchTerm: "Thread" }),
    /cursor does not match/,
  );
});

test("archive state persists and partitions active from archived catalog pages", () => {
  const saved = new Map();
  const previousPolicyStore = globalThis.policyStore;
  globalThis.policyStore = {
    get: (key, principalId) => saved.get(`${principalId}:${key}`) ?? null,
    set: (key, principalId, value) => saved.set(`${principalId}:${key}`, value),
  };
  try {
    const manager = catalogManager();
    manager.principal = { id: "node:root" };
    manager.archive("thread-5");

    assert.equal(manager.listPage({ archived: false, limit: 10 }).data.some(({ id }) => id === "thread-5"), false);
    assert.equal(manager.listPage({ archived: true, limit: 10 }).data.some(({ id }) => id === "thread-5"), true);

    const restored = Object.create(ThreadManagerService.prototype);
    restored.principal = { id: "node:root" };
    restored.threads = new Map();
    restored.archivedThreadIds = new Set();
    restored.metadata = new Map();
    restored.catalogRevision = 0;
    restored.catalogCache = new Map();
    restored.load();

    assert.equal(restored.archivedThreadIds.has("thread-5"), true);
    assert.equal(restored.listPage({ archived: true, limit: 10 }).data[0]?.id, "thread-5");

    restored.unarchive("thread-5");
    assert.equal(restored.archivedThreadIds.has("thread-5"), false);
    assert.equal(restored.listPage({ archived: false, limit: 10 }).data.some(({ id }) => id === "thread-5"), true);
  } finally {
    globalThis.policyStore = previousPolicyStore;
  }
});

test("archive lifecycle hooks cover every thread-manager caller", () => {
  const manager = catalogManager();
  manager.persist = () => manager.invalidateCatalog();
  const events = [];
  const stopArchive = manager.onArchive((threadId) => events.push(["archived", threadId]));
  const stopUnarchive = manager.onUnarchive((threadId) => events.push(["unarchived", threadId]));

  manager.archive("thread-5");
  manager.unarchive("thread-5");
  stopArchive();
  stopUnarchive();
  manager.archive("thread-4");

  assert.deepEqual(events, [
    ["archived", "thread-5"],
    ["unarchived", "thread-5"],
  ]);
});

test("reconnect replays durable archive tombstones without thread payloads", () => {
  const queued = [];
  replayArchivedTombstones({
    threadTombstone: {
      replay: (connection) => {
        for (const threadId of ["old-a", "old-b"]) {
          queued.push({ connection, method: "thread/archived", params: { threadId } });
        }
      },
    },
  }, {});
  assert.deepEqual(queued.map(({ method, params }) => ({ method, params })), [
    { method: "thread/archived", params: { threadId: "old-a" } },
    { method: "thread/archived", params: { threadId: "old-b" } },
  ]);
});

test("synthetic threads expose the paginated history RPCs advertised by resume", () => {
  const handlers = new Map();
  const thread = {
    id: "thread-1",
    turns: [{
      id: "turn-1",
      status: "completed",
      items: [{ id: "item-1", type: "agentMessage", text: "hello" }],
    }],
  };
  const dispose = registerThreadHistoryProjectionHandlers({
    appServer: {
      register(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
    },
    appServerProjection: {
      historyResult(method, projectedThread, params) {
        if (method === "thread/turns/list") {
          const turns = projectedThread.turns ?? [];
          return { data: turns.slice(0, params.limit ?? turns.length) };
        }
        const items = (projectedThread.turns ?? [])
          .filter((candidate) => params.turnId == null || candidate.id === params.turnId)
          .flatMap((candidate) => (candidate.items ?? []).map((item) => ({
            turnId: candidate.id,
            item,
          })));
        return { data: items };
      },
    },
    threadManager: { get: (threadId) => {
      assert.equal(threadId, thread.id);
      return thread;
    } },
    canonicalTimeline: { turns: (threadId) => {
      assert.equal(threadId, thread.id);
      return thread.turns;
    } },
  });
  const connection = { activeThreadId: null };

  assert.deepEqual(
    handlers.get("thread/turns/list")({ threadId: thread.id, limit: 5 }, connection).data,
    thread.turns,
  );
  assert.deepEqual(
    handlers.get("thread/items/list")({ threadId: thread.id, turnId: "turn-1" }, connection).data,
    [{ turnId: "turn-1", item: thread.turns[0].items[0] }],
  );
  assert.equal(connection.activeThreadId, thread.id);

  dispose();
  assert.equal(handlers.size, 0);
});

test("thread tombstones migrate once and expire independently of archived threads", () => {
  const now = 1_000_000;
  const migrated = new ThreadTombstoneLedger(null, ["old-a", "old-b"], now);
  assert.deepEqual(migrated.replayable(now).map(({ threadId }) => threadId), ["old-a", "old-b"]);

  const expiredSnapshot = migrated.snapshot();
  const restored = new ThreadTombstoneLedger(
    expiredSnapshot,
    ["old-a", "old-b"],
    now + THREAD_TOMBSTONE_RETENTION_MS,
  );
  assert.deepEqual(restored.replayable(now + THREAD_TOMBSTONE_RETENTION_MS), []);
  assert.equal(restored.nextSeq, migrated.nextSeq);
});

test("unarchive cancels a tombstone and rearchive receives a new sequence", () => {
  const ledger = new ThreadTombstoneLedger(null, [], 100);
  const first = ledger.record("thread-1", 100);
  assert.equal(ledger.record("thread-1", 200).seq, first.seq);
  assert.equal(ledger.cancel("thread-1"), true);
  const second = ledger.record("thread-1", 300);
  assert.ok(second.seq > first.seq);
});

test("only an unfiltered first active catalog page is an implicit checkpoint", () => {
  assert.equal(isThreadCatalogCheckpoint({ archived: false, cursor: null, limit: 50 }), true);
  assert.equal(isThreadCatalogCheckpoint({ archived: true, cursor: null }), false);
  assert.equal(isThreadCatalogCheckpoint({ archived: false, cursor: "next" }), false);
  assert.equal(isThreadCatalogCheckpoint({ archived: false, projectId: null }), false);
  assert.equal(isThreadCatalogCheckpoint({ archived: false, sectionId: "pinned" }), false);
  assert.equal(isThreadCatalogCheckpoint({ archived: false, ancestorThreadId: "parent" }), false);
  assert.equal(isThreadCatalogCheckpoint({ archived: false, searchTerm: "hello" }), false);
});
