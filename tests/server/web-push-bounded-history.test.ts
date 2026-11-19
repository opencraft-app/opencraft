import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushStore, TurnPushService, type TurnPushOptions } from "@opencraft/web-push-node";
import { AppServerRpcError } from "@opencraft/appserver-client";
import { serializeHistoryReply } from "../../packages/appserver-client/src/bounded-history";

const authorization = {
  context: { actorId: "human-a", credentialId: null, generation: 1, expiresAt: Date.now() + 86400000 },
};
const tooLarge = () =>
  Object.assign(Error("History response is too large"), { code: "HISTORY_RESPONSE_TOO_LARGE", status: 413 });
const entry = (index: number, input?: string) => ({
  turnId: "turn-a",
  item: input
    ? { id: String(index), type: "userMessage", clientId: input, content: [] }
    : { id: String(index), type: "commandExecution" },
});

function fixture(read: TurnPushOptions["read"], inputs = ["input-a"]) {
  const root = mkdtempSync(join(tmpdir(), "push-bounded-history-")),
    path = join(root, "push.sqlite");
  let store = new PushStore(path);
  store.saveTarget(
    authorization,
    { kind: "im", channelId: "synthetic", senderId: "recipient", label: "Fixture" },
    "https://example.test",
    "",
    "en",
    {},
  );
  for (const input of inputs) store.watch("human-a", "server-a", "local-codex", "thread-a", input);
  let sent = 0;
  const options: TurnPushOptions = {
    authenticate: () => authorization,
    current: () => true,
    trustedOrigin: () => null,
    hosts: [],
    read,
    sendIm: async () => {
      sent++;
    },
  };
  let service = new TurnPushService(store, options);
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    sent: () => sent,
    async restart() {
      await service.close();
      store = new PushStore(path);
      service = new TurnPushService(store, options);
    },
    async close() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("oversized history shrinks at the same cursor, shares reads and deduplicates exact-turn notifications", async () => {
  const calls: any[] = [];
  const items = Array.from({ length: 100 }, (_, i) =>
    entry(i, i === 30 ? "input-a" : i === 31 ? "input-b" : undefined),
  );
  // A realistic tool/diff page crosses the actual 8 MiB response boundary.
  Object.assign(items[65]!.item, { output: "x".repeat(9 * 1024 * 1024) });
  const f = fixture(
    async (_host, method, params) => {
      calls.push({ method, ...params });
      if (method === "thread/read") return { thread: { id: "thread-a", name: "Fixture" } };
      if (method === "thread/turns/list") return { data: [{ id: "turn-a", status: "completed" }], nextCursor: null };
      const start = Number(params.cursor ?? 0),
        limit = Number(params.limit),
        end = Math.min(start + limit, items.length);
      const frame = JSON.parse(
        serializeHistoryReply(
          { id: 1, result: { data: items.slice(start, end), nextCursor: end < items.length ? String(end) : null } },
          method,
        ),
      );
      if (frame.error) throw new AppServerRpcError(frame.error);
      return frame.result;
    },
    ["input-a", "input-b"],
  );
  try {
    await f.service.tick();
    assert.equal(f.sent(), 1);
    assert.equal(f.store.watches().length, 0);
    assert.equal(f.service.health.state, "ready");
    assert.deepEqual(
      calls.filter((c) => c.method === "thread/items/list").map((c) => [c.limit, c.cursor ?? null]),
      [
        [100, null],
        [50, null],
      ],
    );
    await f.service.tick();
    assert.equal(f.sent(), 1, "reads do not replay the terminal notification");
  } finally {
    await f.close();
  }
});

test("oversize after a successful page retains its opaque cursor and never treats in-progress as completed", async () => {
  const itemCalls: any[] = [];
  let completed = false;
  const f = fixture(async (_host, method, p) => {
    if (method === "thread/read") return { thread: { id: "thread-a" } };
    if (method === "thread/turns/list")
      return { data: [{ id: "turn-a", status: completed ? "completed" : "inProgress" }], nextCursor: null };
    itemCalls.push(p);
    if (!p.cursor) return { data: Array.from({ length: 100 }, (_, i) => entry(i)), nextCursor: "opaque:after-first" };
    if (p.limit === 100) throw tooLarge();
    return { data: [entry(100, "input-a")], nextCursor: null };
  });
  try {
    await f.service.tick();
    assert.equal(f.sent(), 0);
    assert.equal(f.store.watches()[0]?.turnId, "turn-a");
    assert.deepEqual(
      itemCalls.map((p) => [p.limit, p.cursor ?? null]),
      [
        [100, null],
        [100, "opaque:after-first"],
        [50, "opaque:after-first"],
      ],
    );
    completed = true;
    await f.service.tick();
    assert.equal(f.sent(), 1);
    assert.equal(itemCalls.length, 3, "bound turn does not rescan items");
  } finally {
    await f.close();
  }
});

test("25-entry pages can still reach the end of the normal 500-entry evidence window", async () => {
  let itemReads = 0;
  const f = fixture(async (_host, method, p) => {
    if (method === "thread/read") return { thread: { id: "thread-a" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn-a", status: "completed" }], nextCursor: null };
    itemReads++;
    if (Number(p.limit) > 25) throw tooLarge();
    const start = Number(p.cursor ?? 0),
      limit = Number(p.limit);
    return {
      data: Array.from({ length: limit }, (_, i) => entry(start + i, start + i === 449 ? "input-a" : undefined)),
      nextCursor: String(start + limit),
    };
  });
  try {
    await f.service.tick();
    assert.equal(f.sent(), 1);
    assert.equal(itemReads, 20);
  } finally {
    await f.close();
  }
});

test("a single oversized item stays unresolved and degraded without weakening the limit", async () => {
  const limits: unknown[] = [];
  const f = fixture(async (_host, method, p) => {
    assert.equal(method, "thread/items/list");
    limits.push(p.limit);
    throw tooLarge();
  });
  try {
    await f.service.tick();
    assert.deepEqual(limits, [100, 50, 25, 12, 6, 3, 1]);
    assert.equal(f.sent(), 0);
    assert.equal(f.store.watches().length, 1);
    assert.equal(f.store.watches()[0]?.turnId, null);
    assert.equal(f.service.health.state, "degraded");
    assert.equal(f.store.due().length, 0);
    assert.equal(f.service.health.reason, "history_response_too_large");
  } finally {
    await f.close();
  }
});

test("unrelated failures are not retried as page-size errors", async () => {
  for (const error of [
    Error("offline"),
    Object.assign(Error("unrelated 413"), { status: 413 }),
    Error("decoded message length too large"),
  ]) {
    let reads = 0;
    const f = fixture(async () => {
      reads++;
      throw error;
    });
    try {
      await f.service.tick();
      assert.equal(reads, 1);
      assert.equal(f.sent(), 0);
      assert.equal(f.service.health.state, "degraded");
    } finally {
      await f.close();
    }
  }
});

test("empty or cyclic pages stay bounded and never manufacture completion evidence", async () => {
  for (const mode of ["empty", "cycle", "small"] as const) {
    let reads = 0;
    const f = fixture(async (_host, _method, p) => {
      reads++;
      if (mode === "small" && Number(p.limit) > 25) throw tooLarge();
      return {
        data: mode === "small" ? Array.from({ length: Number(p.limit) }, (_, i) => entry(i)) : [],
        nextCursor: mode === "cycle" ? (p.cursor === "a" ? "b" : "a") : String(reads),
      };
    });
    try {
      await f.service.tick();
      assert.equal(reads, mode === "cycle" ? 3 : mode === "small" ? 22 : 20);
      assert.equal(f.sent(), 0);
      assert.equal(f.store.watches().length, 1);
      if (mode === "empty") assert.equal(f.service.health.reason, "history_budget_exceeded");
      if (mode === "small")
        assert.equal(f.service.health.state, "ready", "500-entry ceiling is the existing unresolved-input policy");
    } finally {
      await f.close();
    }
  }
});

test("turn metadata pages also shrink without returning item detail", async () => {
  const limits: unknown[] = [];
  const f = fixture(async (_host, method, p) => {
    if (method === "thread/read") return { thread: { id: "thread-a" } };
    if (method === "thread/items/list") return { data: [entry(0, "input-a")], nextCursor: null };
    assert.equal(p.itemsView, "notLoaded");
    limits.push(p.limit);
    if (p.limit === 100) throw tooLarge();
    return { data: [{ id: "turn-a", status: "completed" }], nextCursor: null };
  });
  try {
    await f.service.tick();
    assert.deepEqual(limits, [100, 50]);
    assert.equal(f.sent(), 1);
  } finally {
    await f.close();
  }
});

test("individually readable large diffs can be crossed without skipping any unread item", async () => {
  const calls: any[] = [],
    items = Array.from({ length: 4 }, (_, i) => entry(i, i === 3 ? "input-a" : undefined));
  const output = "x".repeat(6_700_000);
  for (let i = 0; i < 3; i++) Object.assign(items[i]!.item, { type: "fileChange", output });
  const f = fixture(async (_host, method, p) => {
    if (method === "thread/read") return { thread: { id: "thread-a" } };
    if (method === "thread/turns/list") return { data: [{ id: "turn-a", status: "completed" }], nextCursor: null };
    calls.push(p);
    const start = Number(p.cursor ?? 0),
      end = Math.min(start + Number(p.limit), items.length);
    const frame = JSON.parse(
      serializeHistoryReply(
        { id: 1, result: { data: items.slice(start, end), nextCursor: end < items.length ? String(end) : null } },
        method,
      ),
    );
    if (frame.error) throw new AppServerRpcError(frame.error);
    return frame.result;
  });
  try {
    await f.service.tick();
    assert.equal(f.sent(), 1);
    assert.equal(f.service.health.state, "ready");
    assert.deepEqual(
      calls.slice(0, 7).map((p) => p.limit),
      [100, 50, 25, 12, 6, 3, 1],
    );
    assert.deepEqual(
      calls.slice(6).map((p) => p.cursor ?? null),
      [null, "1", "2", "3"],
    );
  } finally {
    await f.close();
  }
});

test("different-page matches share reads and retain per-turn deduplication across restart", async () => {
  for (const sameTurn of [true, false]) {
    const calls: string[] = [];
    const f = fixture(
      async (_host, method, p) => {
        if (method === "thread/read") return { thread: { id: "thread-a" } };
        if (method === "thread/turns/list")
          return {
            data: [
              { id: "turn-a", status: "completed" },
              { id: "turn-b", status: "completed" },
            ],
            nextCursor: null,
          };
        calls.push(JSON.stringify(p));
        if (p.limit === 100 || (p.limit === 50 && p.cursor === "50")) throw tooLarge();
        const start = Number(p.cursor ?? 0),
          limit = Number(p.limit);
        return {
          data: Array.from({ length: limit }, (_, i) => ({
            ...entry(start + i, start + i === 10 ? "input-a" : start + i === 150 ? "input-b" : undefined),
            turnId: start + i === 150 && !sameTurn ? "turn-b" : "turn-a",
          })),
          nextCursor: String(start + limit),
        };
      },
      ["input-a", "input-b"],
    );
    try {
      await f.service.tick();
      assert.equal(f.sent(), sameTurn ? 1 : 2);
      assert.equal(f.store.watches().length, 0);
      assert.equal(new Set(calls).size, calls.length, "shared page request occurs once per sweep");
      await f.restart();
      await f.service.tick();
      assert.equal(f.sent(), sameTurn ? 1 : 2, "restart does not resend settled evidence");
    } finally {
      await f.close();
    }
  }
});
