import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadIdentityDatabase } from "../../apps/opencraft-daemon/src/thread-identity-database";
import { ThreadIdentity } from "../../apps/opencraft-daemon/src/thread-identity";
import {
  ThreadParticipantsMetadata,
  createThreadParticipantsMetadata,
} from "../../plugins/thread-participants/src/server";
import {
  LEGACY_THREAD_PARTICIPANTS_CHANGED,
  LEGACY_THREAD_PARTICIPANTS_LIST,
  THREAD_PARTICIPANTS_CHANGED,
  THREAD_PARTICIPANTS_LIST,
} from "../../plugins/thread-participants/src/contract";

const employee = (loginName: string) => ({ kind: "employee" as const, loginName });
const context = (name: string | null) => ({ sender: name ? employee(name) : null, validUntil: Date.now() + 60_000 });

async function fixture(
  t: { after(callback: () => unknown): void },
  options?: Parameters<typeof createThreadParticipantsMetadata>[0],
) {
  const root = await mkdtemp(join(tmpdir(), "thread-participants-"));
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  let owner = new ThreadIdentityDatabase(root);
  const open = () =>
    new ThreadIdentity(owner.database, {
      createMetadata: createThreadParticipantsMetadata(options),
      readMessageIds: async () => [],
      notify: (method, params) => notifications.push({ method, params }),
    });
  let identity = open();
  t.after(async () => {
    identity.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const metadata = () => identity.metadata as ThreadParticipantsMetadata;
  return {
    notifications,
    owner: () => owner,
    metadata,
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
    read: async (threadIds: string[], method = THREAD_PARTICIPANTS_LIST) =>
      (
        (await metadata().request(method, { threadIds })) as {
          data: { threadId: string; revision: number; participants: string[]; creator: string | null }[];
        }
      ).data,
    restart() {
      identity.close();
      owner.close();
      owner = new ThreadIdentityDatabase(root);
      identity = open();
    },
  };
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
  f.restart();
  assert.deepEqual(
    await f.read(["thread"]),
    [{ threadId: "thread", revision: 4, participants: ["bob", "alice"], creator: "alice" }],
    "committed rows survive a Host restart",
  );
});

test("a sender binding alone is not participation; repeated observations neither write nor notify", async (t) => {
  const f = await fixture(t);
  f.send("thread", "m1", "alice");
  const notified = f.notifications.length;
  const before = f.owner().database.prepare("SELECT total_changes() AS changes").get()?.changes;
  for (let index = 0; index < 5; index++) {
    f.metadata().observeNotification({
      method: "item/completed",
      params: { threadId: "thread", item: { type: "userMessage", clientId: "m1" } },
    });
  }
  assert.equal(
    f.owner().database.prepare("SELECT total_changes() AS changes").get()?.changes,
    before,
    "known messages skip storage",
  );
  assert.equal(f.notifications.length, notified);
  // Recorded but never accepted: no turn result or history item mentions it.
  const db = f.owner().database;
  db.prepare("INSERT INTO message_senders VALUES(?,?,?,?)").run(
    "other",
    "pending",
    JSON.stringify(employee("carol")),
    Date.now(),
  );
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

test("changes notify after commit under the core name and the compatibility alias", async (t) => {
  const f = await fixture(t);
  f.send("thread", "m1", "alice");
  assert.deepEqual(f.notifications, [
    { method: THREAD_PARTICIPANTS_CHANGED, params: { threadId: "thread", revision: 1 } },
    { method: LEGACY_THREAD_PARTICIPANTS_CHANGED, params: { threadId: "thread", revision: 1 } },
  ]);
  assert.deepEqual(
    await f.read(["thread"], LEGACY_THREAD_PARTICIPANTS_LIST),
    await f.read(["thread"]),
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

test("queries are bounded and validated; a closed service refuses reads", async (t) => {
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
  f.metadata().close();
  await assert.rejects(f.metadata().request(THREAD_PARTICIPANTS_LIST, { threadIds: ["a"] }), /closed/);
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

test("a failed write rolls back and leaves the committed projection readable", async (t) => {
  const f = await fixture(t);
  f.send("thread", "m1", "alice");
  const db = f.owner().database;
  db.exec(
    "CREATE TRIGGER reject_presence BEFORE INSERT ON ioa_message_presence BEGIN SELECT RAISE(ABORT, 'disk'); END",
  );
  const notified = f.notifications.length;
  assert.throws(() => f.send("thread", "m2", "bob"), /disk/);
  assert.equal(f.notifications.length, notified, "nothing is announced before commit");
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
  assert.deepEqual(
    (await f.read(["thread"]))[0]!.participants,
    ["alice", "bob"],
    "the message is retried on its next observation",
  );
});

test("the local Host state database carries the same published tables", async (t) => {
  const { OpenCraftHostStateDatabase } = await import("../../apps/opencraft-daemon/src/opencraft-host-state-database");
  const root = await mkdtemp(join(tmpdir(), "thread-participants-host-"));
  const owner = new OpenCraftHostStateDatabase(root);
  const identity = new ThreadIdentity(owner.database, {
    createMetadata: createThreadParticipantsMetadata(),
    readMessageIds: async () => [],
    notify: () => {},
  });
  t.after(async () => {
    identity.close();
    owner.close();
    await rm(root, { recursive: true, force: true });
  });
  identity.observeResult("thread/start", {}, { thread: { id: "local" } }, employee("alice"));
  identity.recordSubmission({ threadId: "local", clientUserMessageId: "m1" }, context("bob"));
  identity.observeResult("turn/start", { threadId: "local", clientUserMessageId: "m1" }, { turn: { id: "turn" } });
  assert.deepEqual(await identity.metadata!.request(THREAD_PARTICIPANTS_LIST, { threadIds: ["local"] }), {
    data: [{ threadId: "local", revision: 2, participants: ["bob"], creator: "alice" }],
    errors: [],
  });
});
