import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { ThreadIdentityDatabase } from "../../apps/opencraft-daemon/src/thread-identity-database";
import { ThreadIdentity } from "../../apps/opencraft-daemon/src/thread-identity";
import {
  ThreadParticipantsMetadata,
  createThreadParticipantsMetadata,
  type ThreadParticipantsMetadataOptions,
} from "../../plugins/thread-participants/src/server";
import {
  LEGACY_THREAD_PARTICIPANTS_CHANGED,
  LEGACY_THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_CHANGED,
  THREAD_PARTICIPANTS_LIST,
} from "../../plugins/thread-participants/src/contract";

const employee = (loginName: string) => ({ kind: "employee" as const, loginName });
const context = (name: string | null) => ({ sender: name ? employee(name) : null, validUntil: Date.now() + 60_000 });
type Row = { threadId: string; revision: number; participants: string[]; creator: string | null };

async function fixture(t: { after(callback: () => unknown): void }, options?: ThreadParticipantsMetadataOptions) {
  const root = await mkdtemp(join(tmpdir(), "thread-participants-"));
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  let onNotify: ((method: string, params: Record<string, unknown>) => void) | undefined;
  let owner = new ThreadIdentityDatabase(root);
  const open = () =>
    new ThreadIdentity(owner.database, {
      createMetadata: createThreadParticipantsMetadata(options),
      databasePath: owner.path,
      readMessageIds: async () => [],
      notify: (method, params) => {
        onNotify?.(method, params);
        notifications.push({ method, params });
      },
    });
  let identity = open();
  t.after(async () => {
    await identity.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const metadata = () => identity.metadata as ThreadParticipantsMetadata;
  return {
    notifications,
    owner: () => owner,
    metadata,
    identity: () => identity,
    onNotify: (listener: typeof onNotify) => (onNotify = listener),
    /** A verified sender submits and the native engine accepts the input. */
    send(threadId: string, messageId: string, name: string | null) {
      identity.recordSubmission({ threadId, clientUserMessageId: messageId }, context(name));
      identity.observeResult(
        "turn/start",
        { threadId, clientUserMessageId: messageId },
        { turn: { id: `turn-${messageId}` } },
      );
    },
    create(
      threadId: string,
      name: string | null,
      method: "thread/start" | "thread/fork" = "thread/start",
      params: Record<string, unknown> = {},
    ) {
      identity.observeResult(method, params, { thread: { id: threadId } }, name ? employee(name) : null);
    },
    settled: () => metadata().settled(),
    read: async (threadIds: string[], method = THREAD_PARTICIPANTS_LIST) => {
      await metadata().settled();
      return ((await metadata().request(method, { threadIds })) as { data: Row[] }).data;
    },
    async restart() {
      await identity.close();
      owner.close();
      owner = new ThreadIdentityDatabase(root);
      identity = open();
    },
  };
}
const committed = (path: string, threadId: string) => {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      reader.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id=?").get(threadId)?.revision ?? 0,
    );
  } finally {
    reader.close();
  }
};

/** Any SQLite call on this thread throws while `run` executes. The Worker has its own module instance. */
async function withoutMainThreadSqlite<T>(run: () => Promise<T>): Promise<T> {
  const saved = [
    [DatabaseSync.prototype, "prepare"],
    [DatabaseSync.prototype, "exec"],
    [StatementSync.prototype, "run"],
    [StatementSync.prototype, "get"],
    [StatementSync.prototype, "all"],
    [StatementSync.prototype, "iterate"],
  ].map(([target, key]) => [target, key, (target as any)[key as string]] as const);
  for (const [target, key] of saved)
    (target as any)[key] = () => {
      throw new Error(`SQLite ${String(key)} on the network main thread`);
    };
  try {
    return await run();
  } finally {
    for (const [target, key, value] of saved) (target as any)[key] = value;
  }
}

test("accepted messages from verified senders write presence and participant state in the existing tables", async (t) => {
  const f = await fixture(t);
  f.create("thread", "alice");
  f.send("thread", "m1", "alice");
  f.send("thread", "m2", "bob");
  f.send("thread", "m3", null);
  assert.deepEqual(await f.read(["thread"]), [
    { threadId: "thread", revision: 3, participants: ["alice", "bob"], creator: "alice" },
  ]);
  const db = f.owner().database;
  assert.deepEqual(
    db
      .prepare("SELECT client_message_id, login_name FROM ioa_message_presence ORDER BY rowid")
      .all()
      .map((row) => [row.client_message_id, row.login_name]),
    [
      ["m1", "alice"],
      ["m2", "bob"],
    ],
  );
  assert.equal(db.prepare("SELECT revision FROM ioa_participant_state WHERE thread_id='thread'").get()?.revision, 3);
  assert.equal(
    db.prepare("SELECT login_name FROM ioa_thread_creators WHERE thread_id='thread'").get()?.login_name,
    "alice",
  );
  // The most recently active participant moves last; the badge shows it.
  f.send("thread", "m4", "alice");
  assert.deepEqual((await f.read(["thread"]))[0]!.participants, ["bob", "alice"]);
  await f.restart();
  assert.deepEqual(
    await f.read(["thread"]),
    [{ threadId: "thread", revision: 4, participants: ["bob", "alice"], creator: "alice" }],
    "committed rows survive a Host restart",
  );
});

test("the provider runs no SQLite on the main thread: observation, read, write and close all go to its Worker", async (t) => {
  const f = await fixture(t);
  // The Host records the submission on its own (existing) connection first.
  f.identity().recordSubmission({ threadId: "thread", clientUserMessageId: "m1" }, context("alice"));
  f.identity().recordSubmission({ threadId: "thread", clientUserMessageId: "m2" }, context("bob"));
  const metadata = f.metadata();
  await withoutMainThreadSqlite(async () => {
    metadata.observeResult("thread/start", {}, { thread: { id: "thread" } }, employee("alice"));
    metadata.observeResult("turn/start", { threadId: "thread", clientUserMessageId: "m1" }, { turn: { id: "turn" } });
    metadata.observeNotification({
      method: "item/completed",
      params: { threadId: "thread", item: { type: "userMessage", clientId: "m2" } },
    });
    await metadata.settled();
    assert.equal(metadata.unavailable, null);
    assert.deepEqual(await metadata.request(THREAD_PARTICIPANTS_LIST, { threadIds: ["thread", "cold"] }), {
      data: [
        { threadId: "thread", revision: 3, participants: ["alice", "bob"], creator: "alice" },
        { threadId: "cold", revision: 0, participants: [], creator: null },
      ],
      errors: [],
    });
    metadata.observeResult("thread/delete", { threadId: "thread" }, {});
    await metadata.close();
  });
  assert.equal(
    committed(f.owner().path, "thread"),
    4,
    "the Worker committed every write, including the last one before close",
  );
});

test("known messages cost no Worker call and no notification", async (t) => {
  const f = await fixture(t);
  f.send("thread", "m1", "alice");
  await f.settled();
  const notified = f.notifications.length;
  const before = f.owner().database.prepare("SELECT total_changes() AS changes").get()?.changes;
  for (let index = 0; index < 5; index++) {
    f.metadata().observeNotification({
      method: "item/completed",
      params: { threadId: "thread", item: { type: "userMessage", clientId: "m1" } },
    });
  }
  await f.settled();
  assert.equal(f.owner().database.prepare("SELECT total_changes() AS changes").get()?.changes, before);
  assert.equal(f.notifications.length, notified);
  // Recorded but never accepted: no turn result or history item mentions it.
  f.owner()
    .database.prepare("INSERT INTO message_senders VALUES(?,?,?,?)")
    .run("other", "pending", JSON.stringify(employee("carol")), Date.now());
  assert.deepEqual((await f.read(["other"]))[0], { threadId: "other", revision: 0, participants: [], creator: null });
  f.metadata().observeNotification({
    method: "item/completed",
    params: { threadId: "other", item: { type: "agentMessage", clientId: "pending" } },
  });
  assert.deepEqual((await f.read(["other"]))[0]!.participants, [], "non-user items never confer participation");
  f.metadata().observeNotification({
    method: "item/completed",
    params: { threadId: "other", item: { type: "userMessage", clientId: "pending" } },
  });
  assert.deepEqual((await f.read(["other"]))[0]!.participants, ["carol"]);
});

test("each change is announced only after its commit, in the order the writes were posted", async (t) => {
  const f = await fixture(t);
  const seen: [string, number, number][] = [];
  f.onNotify((method, params) => {
    if (method === THREAD_PARTICIPANTS_CHANGED)
      seen.push([String(params.threadId), Number(params.revision), committed(f.owner().path, String(params.threadId))]);
  });
  f.create("one", "alice");
  f.send("one", "m1", "bob");
  f.send("two", "m2", "carol");
  f.send("one", "m3", "dave");
  assert.deepEqual(seen, [], "nothing is announced synchronously");
  await f.settled();
  // Writes are pipelined to the storage Worker, so a later write of the same
  // Thread may already be committed when an earlier one is announced; the
  // announced revision is never ahead of the committed one.
  assert.deepEqual(
    seen.map(([threadId, revision]) => [threadId, revision]),
    [
      ["one", 1],
      ["one", 2],
      ["two", 1],
      ["one", 3],
    ],
  );
  for (const [threadId, revision, stored] of seen)
    assert.ok(stored >= revision, `${threadId} revision ${revision} was announced before its commit (${stored})`);
  assert.deepEqual(
    f.notifications.slice(0, 2),
    [
      { method: THREAD_PARTICIPANTS_CHANGED, params: { threadId: "one", revision: 1 } },
      { method: LEGACY_THREAD_PARTICIPANTS_CHANGED, params: { threadId: "one", revision: 1 } },
    ],
    "the compatibility alias is announced with the core name",
  );
  assert.deepEqual(
    await f.read(["one"], LEGACY_THREAD_PARTICIPANTS_LIST),
    await f.read(["one"]),
    "the alias reads the same rows",
  );
  assert.deepEqual(f.metadata().capabilities, {
    [THREAD_PARTICIPANTS_LIST]: { version: 1 },
    [LEGACY_THREAD_PARTICIPANTS_LIST]: { version: 1 },
  });
});

test("aliases can be disabled once every consumer moved", async (t) => {
  const f = await fixture(t, { legacyAliases: false });
  assert.deepEqual(f.metadata().methods, [THREAD_PARTICIPANTS_LIST]);
  assert.equal(f.metadata().supports(LEGACY_THREAD_PARTICIPANTS_LIST), false);
  f.send("thread", "m1", "alice");
  await f.settled();
  assert.deepEqual(
    f.notifications.map((row) => row.method),
    [THREAD_PARTICIPANTS_CHANGED],
  );
  await assert.rejects(f.metadata().request(LEGACY_THREAD_PARTICIPANTS_LIST, { threadIds: ["thread"] }));
});

test("creation is recorded once; forks start without copied authors; deletion clears the Thread", async (t) => {
  const f = await fixture(t);
  f.create("parent", "alice");
  f.create("parent", "mallory");
  assert.equal((await f.read(["parent"]))[0]!.creator, "alice", "the first verified creation wins");
  f.send("parent", "m1", "alice");
  f.send("parent", "m2", "bob");
  f.create("child", "carol", "thread/fork", { threadId: "parent" });
  // Copied history items are inherited: their authors did not join the fork.
  f.metadata().observeNotification({
    method: "item/completed",
    params: { threadId: "child", item: { type: "userMessage", clientId: "m2" } },
  });
  assert.deepEqual((await f.read(["child"]))[0], {
    threadId: "child",
    revision: 1,
    participants: [],
    creator: "carol",
  });
  f.send("child", "c1", "dave");
  assert.deepEqual((await f.read(["child"]))[0]!.participants, ["dave"]);
  const revision = (await f.read(["parent"]))[0]!.revision;
  f.metadata().observeResult("thread/delete", { threadId: "parent" }, {});
  assert.deepEqual((await f.read(["parent"]))[0], {
    threadId: "parent",
    revision: revision + 1,
    participants: [],
    creator: null,
  });
  assert.equal(
    f.owner().database.prepare("SELECT COUNT(*) AS n FROM ioa_message_presence WHERE thread_id='parent'").get()?.n,
    0,
  );
  assert.throws(() => f.create("bad", "not a name"), /Invalid creation identity/);
  await f.settled();
  assert.equal(
    f.owner().database.prepare("SELECT COUNT(*) AS n FROM ioa_thread_creators WHERE thread_id='bad'").get()?.n,
    0,
  );
});

test("anonymous creation is durable and cannot be claimed later", async (t) => {
  const f = await fixture(t);
  f.create("thread", null);
  f.create("thread", "alice");
  assert.equal((await f.read(["thread"]))[0]!.creator, null);
  assert.equal(
    f.owner().database.prepare("SELECT COUNT(*) AS n FROM ioa_thread_creators WHERE thread_id='thread'").get()?.n,
    1,
  );
});

test("queries are bounded and validated; a closed provider refuses reads and ignores observations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.metadata().request(THREAD_PARTICIPANTS_LIST, {}), /Invalid participant query/);
  await assert.rejects(
    f.metadata().request(THREAD_PARTICIPANTS_LIST, { threadIds: [""] }),
    /Invalid participant query/,
  );
  await assert.rejects(
    f.metadata().request(THREAD_PARTICIPANTS_LIST, { threadIds: Array.from({ length: 101 }, (_, n) => `t${n}`) }),
  );
  assert.equal((await f.read(["a", "a", "b"])).length, 2, "duplicate IDs produce one outcome each");
  await f.metadata().close();
  await assert.rejects(f.metadata().request(THREAD_PARTICIPANTS_LIST, { threadIds: ["a"] }), /closed/);
  f.send("a", "late", "alice");
  assert.equal(committed(f.owner().path, "a"), 0, "nothing is written after close");
});

test("close drains every write posted before it", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) f.send(`thread-${index % 3}`, `m${index}`, `user${index}`);
  const closing = f.metadata().close();
  assert.equal(f.metadata().close(), closing, "close is idempotent");
  await closing;
  const total = f.owner().database.prepare("SELECT COUNT(*) AS n FROM ioa_message_presence").get()?.n;
  assert.equal(total, 20);
  assert.equal(
    f.notifications.filter((row) => row.method === THREAD_PARTICIPANTS_CHANGED).length,
    20,
    "every drained commit was announced before close resolved",
  );
});

test("a failed Worker fails closed: no main-thread fallback, reads reject and nothing more is written", async (t) => {
  const f = await fixture(t, {
    workerEntry: new URL("../fixtures/thread-participants/crashing.worker.ts", import.meta.url),
  });
  f.identity().recordSubmission({ threadId: "thread", clientUserMessageId: "m1" }, context("alice"));
  const metadata = f.metadata();
  await withoutMainThreadSqlite(async () => {
    metadata.observeResult("turn/start", { threadId: "thread", clientUserMessageId: "m1" }, { turn: { id: "turn" } });
    await metadata.settled();
    assert.ok(metadata.unavailable, "the provider records its failure");
    await assert.rejects(metadata.request(THREAD_PARTICIPANTS_LIST, { threadIds: ["thread"] }), /unavailable/);
    metadata.observeNotification({
      method: "item/completed",
      params: { threadId: "thread", item: { type: "userMessage", clientId: "m1" } },
    });
    await metadata.close();
  });
  assert.equal(f.notifications.length, 0, "an unacknowledged write is never announced");
  assert.equal(committed(f.owner().path, "thread"), 0);
  assert.equal(f.owner().database.prepare("SELECT COUNT(*) AS n FROM ioa_message_presence").get()?.n, 0);
});

test("a Host database without a file cannot start the provider", () => {
  assert.throws(
    () =>
      new ThreadParticipantsMetadata({
        getSender: () => null,
        hasSenders: () => false,
        readMessageIds: async () => [],
        notify: () => {},
      }),
    /database file/,
  );
});

test("a bounded projection reloads evicted Threads from storage without losing writes", async (t) => {
  const f = await fixture(t, { cacheLimit: 1 });
  f.send("one", "m1", "alice");
  f.send("two", "m2", "bob");
  f.send("one", "m3", "carol");
  assert.deepEqual(
    (await f.read(["one", "two"])).map((row) => [row.threadId, row.revision, row.participants]),
    [
      ["one", 2, ["alice", "carol"]],
      ["two", 1, ["bob"]],
    ],
  );
});

test("a failed write rolls back, announces nothing and is retried on its next observation", async (t) => {
  const f = await fixture(t);
  f.send("thread", "m1", "alice");
  await f.settled();
  const db = f.owner().database;
  db.exec(
    "CREATE TRIGGER reject_presence BEFORE INSERT ON ioa_message_presence BEGIN SELECT RAISE(ABORT, 'disk'); END",
  );
  const notified = f.notifications.length;
  f.send("thread", "m2", "bob");
  await f.settled();
  assert.equal(f.notifications.length, notified, "nothing is announced without a commit");
  assert.equal(f.metadata().unavailable, null, "a rolled-back write does not stop the owner");
  db.exec("DROP TRIGGER reject_presence");
  assert.deepEqual((await f.read(["thread"]))[0], {
    threadId: "thread",
    revision: 1,
    participants: ["alice"],
    creator: null,
  });
  f.metadata().observeNotification({
    method: "item/completed",
    params: { threadId: "thread", item: { type: "userMessage", clientId: "m2" } },
  });
  assert.deepEqual((await f.read(["thread"]))[0]!.participants, ["alice", "bob"]);
});

test("the local Host state database carries the same published tables", async (t) => {
  const { OpenCraftHostStateDatabase } = await import("../../apps/opencraft-daemon/src/opencraft-host-state-database");
  const root = await mkdtemp(join(tmpdir(), "thread-participants-host-"));
  const owner = new OpenCraftHostStateDatabase(root);
  const identity = new ThreadIdentity(owner.database, {
    createMetadata: createThreadParticipantsMetadata(),
    databasePath: owner.path,
    readMessageIds: async () => [],
    notify: () => {},
  });
  t.after(async () => {
    await identity.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  });
  identity.observeResult("thread/start", {}, { thread: { id: "local" } }, employee("alice"));
  identity.recordSubmission({ threadId: "local", clientUserMessageId: "m1" }, context("bob"));
  identity.observeResult("turn/start", { threadId: "local", clientUserMessageId: "m1" }, { turn: { id: "turn" } });
  const metadata = identity.metadata as ThreadParticipantsMetadata;
  await metadata.settled();
  assert.deepEqual(await metadata.request(THREAD_PARTICIPANTS_LIST, { threadIds: ["local"] }), {
    data: [{ threadId: "local", revision: 2, participants: ["bob"], creator: "alice" }],
    errors: [],
  });
});
