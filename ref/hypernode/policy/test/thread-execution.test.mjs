import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { CredentialService, credentialIdentityFromAuth } from "../src/services/credential.ts";
import {
  ThreadExecutionJournal,
  ThreadExecutionService,
  ThreadExecutionTable,
} from "../src/services/thread-execution.js";
import { executionPresentationName, ThreadPresentationService } from "../src/services/thread-presentation.ts";
import { HYPERNODE_ROUTER_PROVIDER_ID } from "../src/services/model-router.ts";
import { createExecutionProfile } from "../src/services/execution-profile.ts";

function connection(username) {
  return { identity: { id: `user:${username}`, username } };
}

function credential(username, accountIdentity) {
  return { userId: `user:${username}`, username, accountIdentity };
}

function sqliteStorage() {
  const database = new DatabaseSync(":memory:");
  return {
    available: true,
    sql: {
      exec(statement, ...values) {
        if (values.length > 0 || /^\s*SELECT\b/i.test(statement)) {
          const rows = database.prepare(statement).all(...values);
          return { toArray: () => rows };
        }
        database.exec(statement);
        return { toArray: () => [] };
      },
    },
    transactionSync(callback) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = callback();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}

test("credential identity follows the ChatGPT account rather than the SSH user", () => {
  const auth = { auth_mode: "chatgpt", tokens: { account_id: "account-123" } };
  assert.deepEqual(credentialIdentityFromAuth(auth, { id: "user:alice" }), {
    accountIdentity: "chatgpt:account-123",
    authMode: "chatgpt",
  });
  assert.deepEqual(credentialIdentityFromAuth(auth, { id: "user:bob" }), {
    accountIdentity: "chatgpt:account-123",
    authMode: "chatgpt",
  });
});

test("a selected model provider does not hide the independently bound ChatGPT credential", (t) => {
  const previousIdentity = globalThis.hostIdentity;
  const previousGateway = globalThis.hostModelGateway;
  globalThis.hostIdentity = {
    readCodexAuth: () => new TextEncoder().encode(JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "account-123" },
    })),
  };
  globalThis.hostModelGateway = { credentialLoaded: () => true };
  t.after(() => {
    globalThis.hostIdentity = previousIdentity;
    globalThis.hostModelGateway = previousGateway;
  });

  const service = Object.create(CredentialService.prototype);
  service.ctx = {
    userDirectory: { find: () => ({ id: "user:alice", username: "alice" }) },
    modelGateway: { activeForUser: () => ({ providerId: "public-k3", visibility: "public" }) },
  };

  assert.equal(service.resolveUser("user:alice").accountIdentity, "model-provider:public:public-k3");
  assert.equal(service.resolveCodexUser("user:alice").accountIdentity, "chatgpt:account-123");
});

test("one transparent thread has one active account execution", () => {
  let sequence = 0;
  const table = new ThreadExecutionTable({ createId: () => `execution-${++sequence}` });
  const alice = connection("alice");
  const bob = connection("bob");
  const first = table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11, 1_000);
  assert.equal(first.acquired, true);
  const conflict = table.claim("thread-1", credential("bob", "chatgpt:b"), bob, 12, 2_000);
  assert.equal(conflict.acquired, false);
  assert.equal(conflict.execution.accountIdentity, "chatgpt:a");
  assert.deepEqual([...table.values()].map((item) => item.threadId), ["thread-1"]);
});

test("terminal completion releases immediately and stale completion cannot release a successor", () => {
  let sequence = 0;
  const table = new ThreadExecutionTable({ createId: () => `execution-${++sequence}` });
  const alice = connection("alice");
  const bob = connection("bob");
  table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11, 1_000);
  table.bindTurn("thread-1", alice, "turn-a");
  assert.equal(table.finish("thread-1", { connection: alice, turnId: "turn-a" })?.actorUsername, "alice");
  assert.equal(table.claim("thread-1", credential("bob", "chatgpt:b"), bob, 12, 2_000).acquired, true);
  table.bindTurn("thread-1", bob, "turn-b");
  assert.equal(table.finish("thread-1", { connection: alice, turnId: "turn-a" }), null);
  assert.equal(table.get("thread-1")?.actorUsername, "bob");
  assert.equal(table.get("thread-1")?.epoch, 2);
});

test("authority epoch fences delayed messages even when a connection is reused", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution" });
  const alice = connection("alice");
  const first = table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11, 1_000).execution;
  table.bindTurn("thread-1", alice, "turn-a", first.epoch);
  table.finish("thread-1", { epoch: first.epoch, turnId: "turn-a" });
  const second = table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 12, 2_000).execution;
  table.bindTurn("thread-1", alice, "turn-b", second.epoch);
  assert.equal(table.finish("thread-1", { epoch: first.epoch, turnId: "turn-a" }), null);
  assert.equal(table.get("thread-1")?.turnId, "turn-b");
});

test("a restarted execution table advances beyond the durable artifact epoch", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution-after-restart" });
  table.seedEpoch("thread-1", 8);
  table.seedEpoch("thread-1", 3);

  const resumed = table.claim(
    "thread-1", credential("alice", "chatgpt:a"), connection("alice"), 12, 2_000,
  );

  assert.equal(resumed.acquired, true);
  assert.equal(resumed.execution.epoch, 9);
});

test("durable execution attempts fence an old process boot without pretending to resume it", (t) => {
  const storage = sqliteStorage();
  t.after(() => storage.close());
  let now = 1_000;
  const first = new ThreadExecutionJournal(storage, {
    bootId: "boot-a",
    now: () => now,
  });
  const execution = {
    executionId: "execution-a",
    threadId: "thread-1",
    epoch: 7,
    requestId: "request-a",
    turnId: null,
    actorUserId: "user:alice",
    actorUsername: "alice",
    accountIdentity: "provider:a",
    executionProfile: { engineKind: "dsh", fingerprint: "dsh-a" },
    startedAtMs: now,
  };
  first.claim(execution);
  execution.turnId = "outer-turn-a";
  execution.runtimeId = "runtime-a";
  first.update(execution, "dispatching");

  now = 2_000;
  const restarted = new ThreadExecutionJournal(storage, {
    bootId: "boot-b",
    now: () => now,
  });
  assert.deepEqual(restarted.loadEpochs(), [{ threadId: "thread-1", epoch: 7 }]);
  assert.deepEqual(restarted.fencePreviousBoot(), [{
    executionId: "execution-a",
    threadId: "thread-1",
    epoch: 7,
    turnId: "outer-turn-a",
    runtimeId: "runtime-a",
    previousState: "dispatching",
    state: "orphaned",
  }]);
  assert.deepEqual(restarted.fencePreviousBoot(), []);
  assert.deepEqual(restarted.recoverableOrphans(), [{
    executionId: "execution-a",
    threadId: "thread-1",
    epoch: 7,
    turnId: "outer-turn-a",
    runtimeId: "runtime-a",
    state: "orphaned",
  }]);
});

test("durable execution history distinguishes dispatch failures from native DSH starts", (t) => {
  const storage = sqliteStorage();
  t.after(() => storage.close());
  const journal = new ThreadExecutionJournal(storage, {
    bootId: "boot-a",
    now: () => 1_000,
  });
  const execution = {
    executionId: "execution-a",
    threadId: "thread-1",
    epoch: 1,
    requestId: "request-a",
    actorUserId: "user:alice",
    actorUsername: "alice",
    accountIdentity: "provider:a",
    executionProfile: { engineKind: "dsh", fingerprint: "dsh-a" },
    startedAtMs: 1_000,
  };

  assert.deepEqual(journal.nativeHistory("thread-1"), {
    available: true,
    attempts: 0,
    nativeStarts: 0,
  });
  journal.claim(execution);
  journal.terminal(execution, "failed", "worker startup failed");
  assert.deepEqual(journal.nativeHistory("thread-1"), {
    available: true,
    attempts: 1,
    nativeStarts: 0,
  });

  execution.nativeTurnId = "native-turn-1";
  journal.update(execution, "running");
  assert.deepEqual(journal.nativeHistory("thread-1"), {
    available: true,
    attempts: 1,
    nativeStarts: 1,
  });
});

test("native turn/start is the boundary that promotes dispatching authority to running", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution-native" });
  const alice = connection("alice");
  const execution = table.claim(
    "thread-1", credential("alice", "provider:a"), alice, "request-a", 1_000,
  ).execution;
  table.bindTurn("thread-1", alice, "outer-turn-a", execution.epoch);
  table.bindRuntime("thread-1", alice, "runtime-a", "thread-1", execution.epoch);
  assert.equal(table.get("thread-1").state, "dispatching");
  assert.equal(table.get("thread-1").nativeTurnId, undefined);

  assert.equal(
    table.markNativeStarted("thread-1", alice, "native-turn-9", execution.epoch)?.state,
    "running",
  );
  assert.equal(table.get("thread-1").nativeTurnId, "native-turn-9");
});

test("a late turn/start response cannot regress a native running attempt", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution-native" });
  const alice = connection("alice");
  const execution = table.claim(
    "thread-1", credential("alice", "provider:a"), alice, "request-a", 1_000,
  ).execution;

  table.markNativeStarted("thread-1", alice, "native-turn-9", execution.epoch);
  table.bindTurn("thread-1", alice, "outer-turn-a", execution.epoch);

  assert.equal(execution.state, "running");
  assert.equal(execution.turnId, "outer-turn-a");
  assert.equal(execution.nativeTurnId, "native-turn-9");
});

test("failed request can only abort the execution created by that request", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution-1" });
  const alice = connection("alice");
  table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11, 1_000);
  assert.equal(table.finish("thread-1", { connection: alice, requestId: 99 }), null);
  assert.equal(table.finish("thread-1", { connection: alice, requestId: 11 })?.executionId, "execution-1");
});

test("runtime authority belongs to an execution epoch and survives only as fencing evidence", () => {
  const table = new ThreadExecutionTable({ createId: () => "execution-1" });
  const alice = connection("alice");
  const execution = table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11).execution;
  assert.equal(table.bindRuntime("thread-1", alice, "runtime-a", "inner-1", execution.epoch)?.runtimeId, "runtime-a");
  assert.deepEqual(table.runtimeAuthority("thread-1"), {
    threadId: "thread-1",
    epoch: execution.epoch,
    runtimeId: "runtime-a",
    innerThreadId: "inner-1",
    accountIdentity: "chatgpt:a",
  });
  table.finish("thread-1", { epoch: execution.epoch });
  assert.equal(table.get("thread-1"), null);
  assert.equal(table.runtimeAuthority("thread-1")?.runtimeId, "runtime-a");
});

test("runtime failure releases only executions owned by that runtime", () => {
  let sequence = 0;
  const table = new ThreadExecutionTable({ createId: () => `execution-${++sequence}` });
  const alice = connection("alice");
  const bob = connection("bob");
  const first = table.claim("thread-1", credential("alice", "chatgpt:a"), alice, 11).execution;
  const second = table.claim("thread-2", credential("bob", "chatgpt:b"), bob, 12).execution;
  table.bindRuntime("thread-1", alice, "runtime-a", "inner-1", first.epoch);
  table.bindRuntime("thread-2", bob, "runtime-b", "inner-2", second.epoch);

  assert.deepEqual(table.finishRuntime("runtime-a").map((item) => item.threadId), ["thread-1"]);
  assert.equal(table.get("thread-1"), null);
  assert.equal(table.get("thread-2")?.runtimeId, "runtime-b");
  assert.equal(table.runtimeAuthority("thread-1")?.runtimeId, "runtime-a");
});

test("same-account contention is not presented as another user's account lock", () => {
  const service = Object.create(ThreadExecutionService.prototype);
  const execution = {
    threadId: "thread-1",
    turnId: "turn-1",
    accountIdentity: "chatgpt:a",
    actorUserId: "user:alice",
    actorUsername: "alice",
    startedAtMs: 1_000,
  };

  const selfConflict = service.conflict(execution, credential("alice", "chatgpt:a"));
  const peerConflict = service.conflict(execution, credential("bob", "chatgpt:b"));

  assert.equal(selfConflict.data.kind, "threadExecutionAlreadyActive");
  assert.equal(selfConflict.data.sameAccount, true);
  assert.equal(selfConflict.message.includes("alice"), false);
  assert.equal(peerConflict.data.kind, "threadExecutionAccountHeld");
  assert.equal(peerConflict.data.sameAccount, false);
  assert.match(peerConflict.message, /alice/);
});

test("turn execution authority is claimed with the already-routed provider identity", () => {
  const service = Object.create(ThreadExecutionService.prototype);
  service.table = new ThreadExecutionTable({ createId: () => "execution-public" });
  service.listeners = new Set();
  const alice = connection("alice");
  const routed = credential("alice", "model-provider:public:public-a");
  const execution = service.claimRequest("thread-1", routed, alice, "request-1");
  assert.equal(execution.accountIdentity, "model-provider:public:public-a");
  assert.equal(service.table.get("thread-1"), execution);
});

test("one Turn freezes its execution profile and fences a mismatched Runtime", () => {
  const service = Object.create(ThreadExecutionService.prototype);
  service.table = new ThreadExecutionTable({ createId: () => "execution-k3" });
  service.listeners = new Set();
  const alice = connection("alice");
  const routed = credential("alice", "model-provider:public:public-k3");
  const selected = createExecutionProfile({
    providerId: "public-k3",
    model: "kimi-k3",
    credential: routed,
  });

  const execution = service.claimRequest("thread-1", routed, alice, "request-1", selected);
  assert.equal(execution.executionProfile, selected);
  assert.equal(
    service.bindRuntime("thread-1", alice, "runtime-openai", "inner", execution.epoch, "wrong"),
    null,
  );
  assert.equal(
    service.bindRuntime(
      "thread-1", alice, "runtime-k3", "inner", execution.epoch, selected.fingerprint,
    )?.runtimeId,
    "runtime-k3",
  );
});

test("a duplicate client request never dispatches a second Turn", () => {
  const service = Object.create(ThreadExecutionService.prototype);
  service.table = new ThreadExecutionTable({ createId: () => "execution-1" });
  service.listeners = new Set();
  const alice = connection("alice");
  const routed = credential("alice", "chatgpt:a");

  assert.ok(service.claimRequest("thread-1", routed, alice, "request-1"));
  assert.equal(service.claimRequest("thread-1", routed, alice, "request-1"), null);
  assert.equal(service.table.get("thread-1")?.executionId, "execution-1");
});

test("presentation distinguishes active lock from released recent actor", () => {
  const alice = connection("alice");
  const bob = connection("bob");
  const running = { phase: "running", actorUserId: "user:alice", actorUsername: "alice" };
  const completed = { ...running, phase: "completed" };
  assert.equal(executionPresentationName("☁️ 修复登录问题", running, alice), "🔒 我 · 修复登录问题");
  assert.equal(executionPresentationName("☁️ 修复登录问题", running, bob), "🔒 alice · 修复登录问题");
  assert.equal(executionPresentationName("☁️ 修复登录问题", completed, alice), "✅ 我 · 修复登录问题");
  assert.equal(executionPresentationName("☁️ 修复登录问题", null, bob), "☁️ 修复登录问题");
  assert.equal(
    executionPresentationName("☁️ ✅ 我 · ✅ alice · 修复登录问题", running, alice),
    "🔒 我 · 修复登录问题",
  );
});

test("one shared title projects self and peer labels to every connected tenant", () => {
  const sentByUser = new Map();
  const alice = {
    ...connection("alice"),
    initialized: true,
    socket: { send: (message) => sentByUser.set("alice", message) },
  };
  const bob = {
    ...connection("bob"),
    initialized: true,
    socket: { send: (message) => sentByUser.set("bob", message) },
  };
  const thread = { id: "thread-1", name: "☁️ Shared title", preview: "" };
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = {
    appServer: { connections: [alice, bob] },
    threadExecution: {
      table: {
        get: () => ({
          phase: "running",
          actorUserId: "user:alice",
          actorUsername: "alice",
        }),
      },
    },
    threadManager: { find: () => thread },
  };

  presentation.send(thread.id, 1_000);

  assert.equal(sentByUser.get("alice").params.threadName, "🔒 我 · Shared title");
  assert.equal(sentByUser.get("bob").params.threadName, "🔒 alice · Shared title");
});

test("catalog refresh does not re-emit an unchanged presentation name", () => {
  const notifications = [];
  const alice = connection("alice");
  const thread = { id: "thread-1", name: "☁️ Shared title", preview: "" };
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = {
    appServer: { notifyAfter: (_connection, method, params) => notifications.push({ method, params }) },
    threadExecution: {
      table: { get: () => ({ phase: "running", actorUserId: "user:alice", actorUsername: "alice" }) },
    },
    threadManager: { find: () => thread },
  };

  presentation.queue(alice, thread.id, 1_000);
  presentation.queue(alice, thread.id, 1_001);

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].params.threadName, "🔒 我 · Shared title");
});

test("outbound projection decorates catalog responses independently for each tenant", () => {
  const alice = connection("alice");
  const bob = connection("bob");
  const thread = { id: "thread-1", name: "☁️ Shared title", status: { type: "active" } };
  const execution = { phase: "running", actorUserId: "user:alice", actorUsername: "alice" };
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = {
    threadExecution: { table: { get: () => execution } },
    threadManager: { find: () => thread },
  };
  const canonical = { id: "list", result: { data: [thread], nextCursor: null } };

  const forAlice = presentation.projectMessage(canonical, alice, 1_000);
  const forBob = presentation.projectMessage(canonical, bob, 1_000);

  assert.equal(forAlice.result.data[0].name, "🔒 我 · Shared title");
  assert.equal(forBob.result.data[0].name, "🔒 alice · Shared title");
  assert.equal(canonical.result.data[0].name, "☁️ Shared title", "canonical catalog state remains untouched");
});

test("outbound projection exposes one router without leaking concrete model providers", () => {
  const alice = connection("alice");
  const bob = connection("bob");
  const thread = {
    id: "thread-1",
    name: "☁️ Shared title",
    modelProvider: "alice-private-provider",
  };
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = {
    threadExecution: { table: { get: () => null } },
    threadManager: { find: () => thread },
    modelGateway: {
      visibleRecordsForUser: (userId) => userId === "user:alice"
        ? [{ providerId: "alice-private-provider" }]
        : [],
      activeForConnection: () => null,
    },
  };

  assert.equal(presentation.projectThread(thread, alice).modelProvider, HYPERNODE_ROUTER_PROVIDER_ID);
  assert.equal(presentation.projectThread(thread, bob).modelProvider, HYPERNODE_ROUTER_PROVIDER_ID);
  assert.equal(thread.modelProvider, "alice-private-provider", "canonical ownership remains intact");
});

test("resume and settings projections expose the router provider", () => {
  const alice = connection("alice");
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = { threadManager: { find: () => null } };

  const resume = presentation.projectMessage({
    id: "resume",
    result: { modelProvider: "private-a", model: "private-model" },
  }, alice);
  const settings = presentation.projectMessage({
    method: "thread/settings/updated",
    params: { threadId: "thread-1", threadSettings: { modelProvider: "public-a" } },
  }, alice);

  assert.equal(resume.result.modelProvider, HYPERNODE_ROUTER_PROVIDER_ID);
  assert.equal(settings.params.threadSettings.modelProvider, HYPERNODE_ROUTER_PROVIDER_ID);
});

test("canonical backend rename notifications cannot erase an active execution projection", () => {
  const bob = connection("bob");
  const thread = { id: "thread-1", name: "☁️ Shared title" };
  const presentation = Object.create(ThreadPresentationService.prototype);
  presentation.recent = new Map();
  presentation.ctx = {
    threadExecution: {
      table: { get: () => ({ phase: "running", actorUserId: "user:alice", actorUsername: "alice" }) },
    },
    threadManager: { find: () => thread },
  };

  const projected = presentation.projectMessage({
    method: "thread/name/updated",
    params: { threadId: thread.id, threadName: "☁️ Shared title" },
  }, bob, 1_000);

  assert.equal(projected.params.threadName, "🔒 alice · Shared title");
});
