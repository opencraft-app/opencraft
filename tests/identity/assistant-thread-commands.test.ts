import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openServerDatabase } from "@opencraft/storage-node/server";
import {
  encodeConversationRef,
  parseConversationRef,
} from "@opencraft/appserver-protocol/collaboration";
import { parseThreadCommand } from "@opencraft/appserver-protocol/thread-command";
import { ActorStore } from "../../packages/access-control/src/actors";
import {
  Collaboration,
  type ConversationExecutionPort,
} from "../../packages/access-control/src/collaboration";
import { ThreadAccessStore } from "../../packages/access-control/src/thread-access";
import { ThreadOrchestrationBroker } from "../../packages/access-control/src/thread-orchestration-broker";
const prefix = "opencraft/personal-assistant/";
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "thread-assistant-")),
    storage = await openServerDatabase(dir),
    actors = new ActorStore(storage),
    access = new ThreadAccessStore(storage, actors);
  const human = (n: string) =>
    actors.resolveHuman({
      provider: "test",
      subject: n,
      displayName: n,
      expiresAt: Date.now() + 3600000,
    })!;
  const alice = human("alice"),
    bob = human("bob");
  let allow = true;
  const server = "server:test:codex",
    source = encodeConversationRef({ serverId: server, threadId: "source" });
  access.created(server, "source", alice, "private");
  let turn = "turn";
  const steers: any[] = [];
  const receipts = new Map();
  let inputs = 0,
    creates = 0,
    throwAfterCreate = false,
    held: Promise<void> | undefined,
    state = "completed";
  const native: ConversationExecutionPort = {
    serverId: server,
    hostId: "local-codex",
    hostForServer: () => "local-codex",
    serverForThread: () => server,
    async validate() {},
    async receipt(_b, id) {
      return receipts.get(id) ?? null;
    },
    async add(b, id, _text, admit) {
      if (!admit?.()) throw Error("Denied");
      inputs++;
      const r = {
        id,
        state: b.mode === "steer" ? "queued" : "delivered",
        targetTurnId: "turn-" + inputs,
      };
      receipts.set(id, r);
      return r;
    },
    async steer(binding, requestId, queueId, expectedTurnId) {
      if (state !== "active" || expectedTurnId !== turn) {
        receipts.set(requestId, { id: queueId, state: "discarded" } as any);
        throw Object.assign(Error("turn changed"), { code: -32600 });
      }
      if (
        !service.authorizeInput(
          binding.threadId,
          "actor-input:" + requestId,
          "steer",
          expectedTurnId,
          server,
        )
      )
        throw Error("Denied");
      steers.push({ requestId, queueId, expectedTurnId });
      receipts.set(requestId, {
        id: queueId,
        state: "delivered",
        targetTurnId: expectedTurnId,
      });
    },
    async cancel() {
      return true;
    },
    async readBounded() {
      return {
        entries: [{ role: "assistant", text: "result" }],
        nextCursor: null,
      };
    },
  };
  let service = new Collaboration(
    storage,
    actors,
    native,
    Date.now,
    () => true,
    undefined,
    (c, r) => allow && access.allows(r.serverId, r.threadId, c),
  );
  const allocated = new Map();
  const driver = {
    async prepare() {
      return {
        cwd: "/authorized",
        sandbox: "workspace-write",
        approvalPolicy: "never",
        orchestrationSourceThreadId: "source",
        orchestrationDriver: "codex",
      };
    },
    async create() {
      throw Error("must use root");
    },
    async createRoot(
      id: string,
      settings: Record<string, unknown>,
      admit: () => boolean,
    ) {
      assert.equal(settings.cwd, "/authorized");
      assert.equal(settings.orchestrationSourceThreadId, undefined);
      if (!admit()) throw Error("denied");
      if (!allocated.has(id)) {
        creates++;
        allocated.set(id, { threadId: "created-" + creates });
      }
      await held;
      if (throwAfterCreate) {
        throwAfterCreate = false;
        throw Error("lost reply");
      }
      return allocated.get(id);
    },
    async snapshot(threadId: string) {
      return {
        threadId,
        rootTurnId: "root",
        turnId: turn,
        state: state as "completed",
      };
    },
    async publishRoot(id: string) {
      const target = allocated.get(id);
      assert.ok(target);
      assert.equal(access.read(server, target.threadId).accessMode, "private");
      const policy = access.read(server, target.threadId);
      assert.equal(
        access.allows(
          server,
          target.threadId,
          policy.creatorActorId === alice.actorId ? alice : bob,
        ),
        true,
      );
      assert.equal(
        access.allows(
          server,
          target.threadId,
          policy.creatorActorId === alice.actorId ? bob : alice,
        ),
        false,
      );
      const database = new DatabaseSync(join(dir, "opencraft-server.sqlite"), {
        readOnly: true,
      });
      try {
        assert.equal(
          database
            .prepare(
              "SELECT creator_actor_id FROM thread_access WHERE thread_id=?",
            )
            .get(target.threadId)?.creator_actor_id,
          policy.creatorActorId,
        );
      } finally {
        database.close();
      }
    },
    async acknowledge() {
      return true;
    },
  };
  let commands = new ThreadOrchestrationBroker(service, driver);
  commands.enableAssistantThreads(access);
  await commands.initializeAssistantThreads();
  t.after(async () => {
    await commands.close();
    await service.close();
    access.close();
    actors.close();
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  });
  await service.personalAssistant(alice, prefix + "claim");
  await service.personalAssistant(bob, prefix + "claim");
  const credential = (await service.provisionPersonalAssistant(alice))
      .credential,
    bot = actors.authenticateSession(credential.token)!;
  const other = actors.authenticateSession(
    (await service.provisionPersonalAssistant(bob)).credential.token,
  )!;
  const call = (argv: string[], who = bot) =>
    service.personalAssistant(who, prefix + "threads/command", {
      argv,
      workId: "work-1",
    }) as Promise<any>;
  const grant = () =>
    service.personalAssistant(alice, prefix + "threads/profile/set", {
      id: "coding",
      reference: source,
      expectedRevision: 0,
    });
  return {
    dir,
    storage,
    actors,
    access,
    alice,
    bob,
    bot,
    other,
    server,
    source,
    call,
    grant,
    driver,
    get service() {
      return service;
    },
    get commands() {
      return commands;
    },
    steers,
    native,
    set turn(v: string) {
      turn = v;
    },
    get inputs() {
      return inputs;
    },
    get creates() {
      return creates;
    },
    set lost(v: boolean) {
      throwAfterCreate = v;
    },
    set held(v: Promise<void> | undefined) {
      held = v;
    },
    set state(v: string) {
      state = v;
    },
    deny() {
      allow = false;
    },
    async restart() {
      await commands.close();
      await service.close();
      service = new Collaboration(
        storage,
        actors,
        native,
        Date.now,
        () => true,
        undefined,
        (c, r) => allow && access.allows(r.serverId, r.threadId, c),
      );
      commands = new ThreadOrchestrationBroker(service, driver);
      commands.enableAssistantThreads(access);
  await commands.initializeAssistantThreads();
    },
  };
}
const start = [
  "thread",
  "start",
  "--profile",
  "coding",
  "--prompt",
  "Implement task",
  "--idempotency-key",
  "one",
];
test("argv preserves literal content and never expands shell expressions", () => {
  assert.equal(
    parseThreadCommand([
      "thread",
      "start",
      "--profile",
      "p",
      "--prompt",
      "$(touch /x); echo hi",
      "--idempotency-key",
      "k",
    ]).arguments.prompt,
    "$(touch /x); echo hi",
  );
  assert.throws(() =>
    parseThreadCommand([
      "thread",
      "start",
      "--cwd",
      "/etc",
      "--idempotency-key",
      "k",
    ]),
  );
  assert.throws(() => parseThreadCommand(["thread", "start", "--prompt", "x"]));
});
test("Human explicitly grants profile; Bot creates one private independent Thread and recovers receipts", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.call(["thread", "profiles"]), { profiles: [] });
  await assert.rejects(f.call(start), /profile_required/);
  await assert.rejects(
    f.service.personalAssistant(f.bot, prefix + "threads/profile/set", {
      id: "coding",
      reference: f.source,
      expectedRevision: 0,
    }),
    /denied/,
  );
  await assert.rejects(
    f.service.personalAssistant(f.bob, prefix + "threads/profile/set", {
      id: "coding",
      reference: f.source,
      expectedRevision: 0,
    }),
    /unavailable/,
  );
  await f.grant();
  const [a, b] = await Promise.all([f.call(start), f.call(start)]);
  assert.equal(a.operationId, b.operationId);
  assert.equal(a.state, "submitted");
  assert.equal(f.creates, 1);
  const r = parseConversationRef(a.reference)!;
  const relation = f.service.orchestration.relation(r.threadId)!;
  assert.equal(relation.ownerActorId, f.alice.actorId);
  assert.equal(relation.parentThreadId, null);
  assert.equal(relation.visibility, "visible");
  assert.equal(f.access.allows(r.serverId, r.threadId, f.bob), false);
  const origin = f.service.inputOrigin(
    r.threadId,
    "actor-input:" + a.requestId,
  )!;
  assert.equal(origin.kind, "agent");
  assert.equal(origin.authorActorId, f.bot.actorId);
  assert.equal(origin.delegatorActorId, f.alice.actorId);
  assert.equal(
    f.service.authorizeInput(
      r.threadId,
      "actor-input:" + a.requestId,
      "queue",
      undefined,
      r.serverId,
    ),
    true,
  );
  await assert.rejects(
    f.call([...start.slice(0, -1), "one", "--title", "changed"]),
    /key_reused/,
  );
  await assert.rejects(
    f.call(["thread", "output", a.reference], f.other),
    /denied/,
  );
  await f.restart();
  assert.equal((await f.call(start)).reference, a.reference);
  assert.equal(f.creates, 1);
  assert.equal(
    (await f.call(["thread", "list", "--owned"])).threads[0].reference,
    a.reference,
  );
  assert.equal(
    (await f.call(["thread", "output", a.reference])).history.entries[0].text,
    "result",
  );
  const tell = await f.call([
    "thread",
    "tell",
    a.reference,
    "--message",
    "More",
    "--idempotency-key",
    "two",
  ]);
  assert.equal(tell.state, "submitted");
  f.service.orchestration.directUserInput(r.threadId, "I take over");
  await assert.rejects(
    f.call([
      "thread",
      "tell",
      a.reference,
      "--message",
      "Again",
      "--idempotency-key",
      "three",
    ]),
    /user_control/,
  );
});
test("lost native creation response resumes the same operation; grant revoke fences queued input", async (t) => {
  const f = await fixture(t);
  await f.grant();
  f.lost = true;
  await assert.rejects(f.call(start), /lost reply/);
  await f.restart();
  const a = await f.call(start);
  assert.equal(f.creates, 1);
  await f.service.personalAssistant(
    f.alice,
    prefix + "threads/profile/revoke",
    { id: "coding", expectedRevision: 1 },
  );
  const r = parseConversationRef(a.reference)!;
  assert.equal(
    f.service.authorizeInput(
      r.threadId,
      "actor-input:" + a.requestId,
      "queue",
      undefined,
      r.serverId,
    ),
    false,
  );
  await assert.rejects(
    f.call([
      "thread",
      "tell",
      a.reference,
      "--message",
      "bad",
      "--idempotency-key",
      "after",
    ]),
    /revoked/,
  );
});
test("revocation during native allocation records identity without admitting a first input", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const hold = Promise.withResolvers<void>();
  f.held = hold.promise;
  const promise = f.call(start);
  void promise.catch(() => {});
  while (f.creates === 0) await new Promise((r) => setTimeout(r, 5));
  await f.service.personalAssistant(
    f.alice,
    prefix + "threads/profile/revoke",
    { id: "coding", expectedRevision: 1 },
  );
  hold.resolve();
  await assert.rejects(promise, /revoked/);
  const rows = (await f.call(["thread", "list", "--owned"])).threads;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].reference);
  assert.equal(rows[0].state, "accepted");
  assert.equal(f.inputs, 0);
});

test("Human input admission fences queued assistant input before the native turn starts", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const a = await f.call(start),
    r = parseConversationRef(a.reference)!;
  f.service.authorizeExecution(
    f.alice,
    r.threadId,
    "human-takeover",
    [],
    r.serverId,
  );
  assert.equal(
    f.service.authorizeInput(
      r.threadId,
      "actor-input:" + a.requestId,
      "queue",
      undefined,
      r.serverId,
    ),
    false,
  );
  await assert.rejects(
    f.call([
      "thread",
      "tell",
      a.reference,
      "--message",
      "Late",
      "--idempotency-key",
      "late",
    ]),
    /user_control/,
  );
});
test("a missing command response after queue acceptance recovers its original receipt after takeover", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const original = f.service.communicate.bind(f.service);
  let fail = true;
  f.service.communicate = async (c, m, p) => {
    if (m === "assistant-thread/finish" && fail) {
      fail = false;
      throw Error("lost commit");
    }
    return original(c, m, p);
  };
  await assert.rejects(f.call(start), /lost commit/);
  const [{ reference }] = (await f.call(["thread", "list", "--owned"])).threads,
    r = parseConversationRef(reference)!;
  f.service.authorizeExecution(
    f.alice,
    r.threadId,
    "human-takeover",
    [],
    r.serverId,
  );
  await f.restart();
  const recovered = await f.call(start);
  assert.equal(recovered.state, "submitted");
  assert.equal(recovered.reference, reference);
  assert.equal(f.creates, 1);
});
test("source access revocation and profile changes deny future queued assistant input", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const a = await f.call(start),
    r = parseConversationRef(a.reference)!;
  f.deny();
  assert.equal(
    f.service.authorizeInput(
      r.threadId,
      "actor-input:" + a.requestId,
      "queue",
      undefined,
      r.serverId,
    ),
    false,
  );
  await assert.rejects(
    f.call(["thread", "output", a.reference]),
    /unavailable|denied/,
  );
});
test("bounded pagination and unambiguous parser arguments", async (t) => {
  for (const args of [
    ["thread", "toString"],
    ["thread", "list", "--owned", "--limit", "NaN"],
    ["thread", "list", "--owned", "--children"],
  ])
    assert.throws(() => parseThreadCommand(args));
  const f = await fixture(t);
  await f.grant();
  await f.call(start);
  await f.call([...start.slice(0, -1), "next"]);
  const first = await f.call(["thread", "list", "--owned", "--limit", "1"]);
  assert.equal(first.threads.length, 1);
  assert.ok(first.nextCursor);
  const second = await f.call([
    "thread",
    "list",
    "--owned",
    "--limit",
    "1",
    "--cursor",
    first.nextCursor,
  ]);
  assert.equal(second.threads.length, 1);
  assert.notEqual(first.threads[0].reference, second.threads[0].reference);
  assert.equal(second.nextCursor, null);
});

test("creation and its durable mutations do not execute SQL on the connection event loop", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const prepare = f.service.database.prepare,
    pump = f.service.pump;
  f.service.pump = async () => {};
  f.service.database.prepare = () => {
    throw Error("SQL on the network event loop");
  };
  try {
    const result = await f.call(start);
    assert.equal(result.state, "submitted");
  } finally {
    f.service.database.prepare = prepare;
    f.service.pump = pump;
  }
});

test("storage contention leaves connection timers responsive and commits the same request after unlock", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const lock = new DatabaseSync(f.service.database.location()!);
  lock.exec("BEGIN IMMEDIATE");
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5),
    pending = f.call(start);
  void pending.catch(() => {});
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(ticks >= 5);
    lock.exec("ROLLBACK");
    assert.equal((await pending).state, "submitted");
    assert.equal(f.creates, 1);
  } finally {
    clearInterval(timer);
    if (lock.isTransaction) lock.exec("ROLLBACK");
    lock.close();
  }
});

test("revoking the Bot during allocation retains Human ownership without sending input", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const hold = Promise.withResolvers<void>();
  f.held = hold.promise;
  const pending = f.call(start);
  void pending.catch(() => {});
  while (f.creates === 0) await new Promise((r) => setTimeout(r, 5));
  await f.service.personalAssistant(f.alice, prefix + "revoke");
  hold.resolve();
  await assert.rejects(pending);
  const row = f.service.database
    .prepare("SELECT reference FROM assistant_thread_operations")
    .get()!;
  const r = parseConversationRef(String(row.reference))!;
  assert.ok(r);
  assert.equal(f.inputs, 0);
  assert.equal(
    f.service.orchestration.relation(r.threadId)!.ownerActorId,
    f.alice.actorId,
  );
  assert.equal(f.access.allows(r.serverId, r.threadId, f.bob), false);
});
test("refresh retains valid admission while storage is pending and transient failure preserves queue custody", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const pump = f.service.pump.bind(f.service);
  f.service.pump = async () => {};
  const a = await f.call(start),
    r = parseConversationRef(a.reference)!,
    input = "actor-input:" + a.requestId;
  const grant = f.service.inputOrigin(r.threadId, input)!.assistantGrant!,
    communicate = f.service.communicate.bind(f.service),
    hold = Promise.withResolvers<void>();
  f.service.communicate = async (c, m, p) => {
    if (m === "assistant-thread/guard") await hold.promise;
    return communicate(c, m, p);
  };
  const refresh = f.commands.refreshInput(grant, r.threadId);
  assert.equal(
    f.service.authorizeInput(r.threadId, input, "queue", undefined, r.serverId),
    true,
  );
  hold.resolve();
  await refresh;
  f.service.communicate = async (c, m, p) => {
    if (m === "assistant-thread/guard")
      throw Error("Worker temporarily unavailable");
    return communicate(c, m, p);
  };
  await pump();
  assert.equal(f.inputs, 0);
  assert.equal(
    f.service.database
      .prepare("SELECT state FROM actor_execution_requests WHERE id=?")
      .get(a.requestId)!.state,
    "accepted",
  );
  f.service.communicate = communicate;
  await pump();
  assert.equal(f.inputs, 1);
});

test("one Human revoking task access does not invalidate another Human pending refresh or input", async (t) => {
  const f = await fixture(t);
  f.service.pump = async () => {};
  await f.grant();
  await f.call(start);
  f.access.created(f.server, "bob-source", f.bob, "private");
  await f.service.personalAssistant(f.bob, prefix + "threads/profile/set", {
    id: "coding",
    reference: encodeConversationRef({
      serverId: f.server,
      threadId: "bob-source",
    }),
    expectedRevision: 0,
  });
  const b = await f.call(start, f.other),
    r = parseConversationRef(b.reference)!,
    input = "actor-input:" + b.requestId;
  const grant = f.service.inputOrigin(r.threadId, input)!.assistantGrant!,
    communicate = f.service.communicate.bind(f.service),
    hold = Promise.withResolvers<void>();
  f.service.communicate = async (c, m, p) => {
    if (m === "assistant-thread/guard" && c.actorId === f.other.actorId)
      await hold.promise;
    return communicate(c, m, p);
  };
  const refresh = f.commands.refreshInput(grant, r.threadId);
  await f.service.personalAssistant(
    f.alice,
    prefix + "threads/profile/revoke",
    { id: "coding", expectedRevision: 1 },
  );
  assert.equal(
    f.service.authorizeInput(r.threadId, input, "queue", undefined, r.serverId),
    true,
  );
  hold.resolve();
  await refresh;
  assert.equal(
    f.service.authorizeInput(r.threadId, input, "queue", undefined, r.serverId),
    true,
  );
});

test("stopping delegated work requires the owned reference, current grant and exact turn", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const r = await f.call(start);
  let stopped = 0;
  (f.driver as any).interrupt = async (
    threadId: string,
    turnId: string,
    admit: () => boolean,
  ) => {
    assert.equal(threadId, parseConversationRef(r.reference)!.threadId);
    assert.equal(turnId, "turn");
    assert.equal(admit(), true);
    stopped++;
  };
  f.state = "active";
  const argv = [
    "thread",
    "stop",
    r.reference,
    "--expected-turn",
    "turn",
    "--idempotency-key",
    "stop-1",
  ];
  await assert.rejects(f.call(argv, f.other));
  await assert.rejects(
    f.call(argv.map((v) => (v === "turn" ? "wrong-turn" : v))),
    /task_turn_changed/u,
  );
  assert.equal(stopped, 0);
  assert.equal((await f.call(argv)).stopped, true);
  assert.equal(stopped, 1);
  f.deny();
  await assert.rejects(f.call(argv));
  assert.equal(stopped, 1);
});

const liveTell = (
  reference: string,
  key: string,
  message = "supplement",
  expected = "turn",
) => [
  "thread",
  "tell",
  reference,
  "--delivery",
  "steer",
  "--expected-turn",
  expected,
  "--message",
  message,
  "--idempotency-key",
  key,
];
async function settledInput(f: any, id: string) {
  for (let n = 0; n < 40; n++) {
    await f.service.pump();
    const r = await f.call(["thread", "operation", "show", id]);
    if (["injected", "rejected", "unknown"].includes(r.input?.deliveryState))
      return r;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("Input did not settle");
}
test("live supplement uses the same running turn and durable native steer, not an idle queue or a new thread", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const supplement = await f.call(
    liveTell(task.reference, "steer-one", "先检查回归，不要发布"),
  );
  assert.equal(supplement.inputMode, "steer");
  assert.equal(supplement.expectedTurnId, "turn");
  assert.equal(supplement.delivery, "accepted");
  assert.equal(supplement.taskOutcome, "unknown");
  const operation = await settledInput(f, supplement.operationId);
  assert.equal(operation.input.mode, "steer");
  assert.equal(operation.input.deliveryState, "injected");
  assert.equal(operation.input.targetTurnId, "turn");
  assert.equal(f.creates, 1);
  assert.equal(f.steers.length, 1);
  assert.equal(f.steers[0].expectedTurnId, "turn");
  const ref = parseConversationRef(task.reference)!;
  assert.equal(
    f.service.authorizeInput(
      ref.threadId,
      "actor-input:" + supplement.requestId,
      "queue",
      undefined,
      ref.serverId,
    ),
    false,
  );
  const origin = f.service.inputOrigin(
    ref.threadId,
    "actor-input:" + supplement.requestId,
  )!;
  assert.equal(origin.authorActorId, f.bot.actorId);
  assert.equal(origin.delegatorActorId, f.alice.actorId);
  assert.equal(origin.kind, "agent");
  assert.equal(
    f.service.orchestration.relation(ref.threadId)?.hasDirectUserInput,
    false,
  );
  assert.equal(
    f.service.usageSubmission(
      ref.threadId,
      "actor-input:" + supplement.requestId,
    )?.mode,
    "steer",
  );
  f.state = "completed";
  await f.restart();
  const retry = await f.call(
    liveTell(task.reference, "steer-one", "先检查回归，不要发布"),
  );
  assert.equal(retry.operationId, supplement.operationId);
  assert.equal(retry.requestId, supplement.requestId);
  assert.equal(f.steers.length, 1);
  await assert.rejects(
    f.call(liveTell(task.reference, "steer-one", "changed")),
    /key_reused/,
  );
});
test("stale, idle, waiting, malformed and foreign live supplements fail without a queued fallback", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const before = f.inputs;
  await assert.rejects(
    f.call(liveTell(task.reference, "old-turn", "change", "old")),
    /turn_changed/,
  );
  for (const state of ["completed", "awaiting_interaction", "recovering"]) {
    f.state = state;
    await assert.rejects(
      f.call(liveTell(task.reference, "not-active-" + state)),
      /not_running/,
    );
  }
  f.state = "active";
  await assert.rejects(
    f.call(liveTell(task.reference, "foreign"), f.other),
    /denied/,
  );
  await assert.rejects(
    f.call([
      "thread",
      "tell",
      task.reference,
      "--delivery",
      "steer",
      "--message",
      "x",
      "--idempotency-key",
      "missing-turn",
    ]),
    /invalid|field/,
  );
  await assert.rejects(
    f.call([
      "thread",
      "tell",
      task.reference,
      "--delivery",
      "queue",
      "--expected-turn",
      "turn",
      "--message",
      "x",
      "--idempotency-key",
      "bad-queue",
    ]),
    /unexpected_turn/,
  );
  assert.equal(f.inputs, before);
  assert.equal(f.steers.length, 0);
});
test("separate supplements retain order, stop/takeover forbids steering, queue follow-up stays available", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const a = await f.call(liveTell(task.reference, "first", "first")),
    b = await f.call(liveTell(task.reference, "second", "second"));
  await settledInput(f, a.operationId);
  await settledInput(f, b.operationId);
  assert.deepEqual(
    f.steers.map((v: any) => v.requestId),
    [a.requestId, b.requestId],
  );
  f.state = "interrupted_by_user";
  await assert.rejects(
    f.call(liveTell(task.reference, "stopped")),
    /user_control/,
  );
  f.state = "completed";
  const queued = await f.call([
    "thread",
    "tell",
    task.reference,
    "--message",
    "later",
    "--idempotency-key",
    "queued-later",
  ]);
  assert.equal(queued.inputMode, "queue");
  f.service.orchestration.directUserInput(
    parseConversationRef(task.reference)!.threadId,
    "takeover",
  );
  f.state = "active";
  await assert.rejects(
    f.call(liveTell(task.reference, "takeover")),
    /user_control/,
  );
  assert.equal(f.creates, 1);
  assert.equal(f.steers.length, 2);
});
test("native turn change after preflight rejects the supplement instead of turning it into queued work", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const add = f.native.add.bind(f.native);
  f.native.add = async (...args) => {
    const receipt = await add(...args);
    if (args[0].mode === "steer") f.turn = "new-turn";
    return receipt;
  };
  const supplement = await f.call(liveTell(task.reference, "racing"));
  const operation = await settledInput(f, supplement.operationId);
  assert.equal(operation.input.mode, "steer");
  assert.equal(operation.input.deliveryState, "rejected");
  assert.equal(f.steers.length, 0);
  assert.equal(f.creates, 1);
});
test("revocation before native claim rejects an accepted supplement without injection", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const pump = f.service.pump.bind(f.service);
  f.service.pump = async () => {};
  const before = f.inputs,
    supplement = await f.call(liveTell(task.reference, "revoked-live"));
  await f.service.personalAssistant(
    f.alice,
    prefix + "threads/profile/revoke",
    { id: "coding", expectedRevision: 1 },
  );
  f.service.pump = pump;
  await pump();
  const row = f.service.database
    .prepare("SELECT mode,state FROM actor_execution_requests WHERE id=?")
    .get(supplement.requestId)!;
  assert.equal(row.mode, "steer");
  assert.equal(row.state, "rejected");
  assert.equal(f.steers.length, 0);
  assert.equal(f.inputs, before);
});
test("a lost injection acknowledgement recovers the existing receipt and never injects twice", async (t) => {
  const f = await fixture(t);
  await f.grant();
  const task = await f.call(start);
  await f.service.pump();
  f.state = "active";
  const steer = f.native.steer.bind(f.native);
  f.native.steer = async (...args) => {
    await steer(...args);
    throw Error("lost injected ACK");
  };
  const supplement = await f.call(liveTell(task.reference, "lost-injection"));
  await settledInput(f, supplement.operationId);
  assert.equal(f.steers.length, 1);
  await f.restart();
  const replay = await f.call(liveTell(task.reference, "lost-injection"));
  assert.equal(replay.requestId, supplement.requestId);
  const confirmed = await settledInput(f, supplement.operationId);
  assert.equal(confirmed.input.deliveryState, "injected");
  assert.equal(f.steers.length, 1);
});

test('one Broker serves native execution CLI and assistant commands with the same execution/input owner', async t => {
  const f=await fixture(t);
  assert.ok(f.commands instanceof ThreadOrchestrationBroker);
  assert.throws(()=>f.commands.enableAssistantThreads(f.access),/already configured/);
  const second=new ThreadOrchestrationBroker(f.service,f.driver);
  assert.throws(()=>second.enableAssistantThreads(f.access),/already attached/);
  await second.close();
  await f.grant();
  const profiles=await f.call(['thread','profiles']);
  assert.equal(profiles.profiles.length,1);
  f.service.authorizeExecution(f.alice,'source','native-owner-input',[],f.server);
  f.service.executionStarted('source','native-owner-input','native-owner-turn');
  const output=await f.commands.cli({serverId:f.server,threadId:'source',execution:{inputId:'native-owner-input',turnId:'native-owner-turn'}},
    {command:'context',arguments:{}}) as any;
  assert.equal(output.reference,f.source);
  const created=await f.call([...start.slice(0,-1),'same-broker-root']);
  assert.ok(created.reference);
  assert.equal(f.creates,1);
  await f.commands.close();
  const {AssistantThreadCommands}=await import('../../packages/access-control/src/assistant-thread-commands');
  assert.equal(Object.hasOwn(AssistantThreadCommands.prototype,'command'),false);
  const legacy=new AssistantThreadCommands(f.service,f.driver,f.access);
  try{
    assert.ok(legacy instanceof ThreadOrchestrationBroker);await legacy.initialize();
    assert.equal((await f.call(['thread','profiles'])).profiles.length,1);
    await assert.rejects(legacy.invoke('source','native-owner-turn','unsupported-native','thread_spawn',{prompt:'not admitted'}),/orchestration_runtime_unavailable/);
  }finally{await legacy.close();}
});

test('native alias and steer share canonical exact-turn semantics without changing old command fingerprints', async t => {
  const {threadDeliveryIntent}=await import('../../packages/appserver-protocol/src/thread-command.mjs');
  assert.deepEqual(threadDeliveryIntent('native','turn'),threadDeliveryIntent('steer','turn'));
  assert.throws(()=>threadDeliveryIntent('interrupt','turn'),/unsupported_delivery/);
  assert.throws(()=>threadDeliveryIntent('steer'),/invalid_expected_turn/);
  assert.throws(()=>threadDeliveryIntent('queue','turn'),/unexpected_turn/);
  const f=await fixture(t);await f.grant();
  const created=await f.call([...start.slice(0,-1),'alias-root']);await f.service.pump();f.state='active';
  const args=['thread','tell',created.reference,'--message','Continue in the same Turn','--delivery','native','--expected-turn','turn','--idempotency-key','alias-steer'];
  const sent=await f.call(args);assert.equal(sent.inputMode,'steer');await settledInput(f,sent.operationId);
  const replay=await f.call(args);assert.equal(replay.operationId,sent.operationId);assert.equal(f.steers.length,1);
});

test("operation show projects exact native completion and old Hosts remain explicitly unavailable",async t=>{
  const f=await fixture(t);await f.grant();const started=await f.call(start);await f.service.pump();
  const original=f.native.receipt.bind(f.native);
  const show=()=>f.call(["thread","operation","show",started.operationId]);
  const legacy=await show();
  assert.equal(legacy.input.taskOutcome,"unknown");assert.equal(legacy.input.completion.unavailable,true);assert.equal(legacy.input.completion.status,"unknown");
  f.driver.snapshot=async()=>{throw Error("operation completion must not read latest Thread state");};
  f.native.receipt=async(binding,id,options)=>{
    const row=await original(binding,id);
    assert.equal(options?.includeCompletion,true);
    return row ? {...row,completion:{version:1 as const,turnId:row.targetTurnId,status:"completed",text:"exact native result",truncated:false}} : null;
  };
  const completed=await show();
  assert.deepEqual(completed.input.completion,{version:1,turnId:completed.input.targetTurnId,status:"completed",text:"exact native result",truncated:false});
  await f.restart();assert.deepEqual((await show()).input.completion,completed.input.completion);
  f.native.receipt=async(binding,id)=>{const row=await original(binding,id);return row?{...row,completion:{version:1 as const,turnId:"foreign-turn",status:"completed",text:"wrong",truncated:false}}:null;};
  assert.equal((await show()).input.completion.unavailable,true);
});

for(const change of ["revoke","takeover"] as const) test(`operation result is fenced when ${change} occurs during its native read`,async t=>{
  const f=await fixture(t);await f.grant();const started=await f.call(start);await f.service.pump();
  const original=f.native.receipt.bind(f.native);
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),reading=new Promise<void>(r=>{entered=r;});
  f.native.receipt=async(binding,id,options)=>{
    if(options?.includeCompletion){entered();await held;}
    const row=await original(binding,id);
    return row && options?.includeCompletion ? {...row,completion:{version:1 as const,turnId:row.targetTurnId,status:"completed",text:"cached native terminal",truncated:false}} : row;
  };
  const output=f.call(["thread","operation","show",started.operationId]);
  const rejected=assert.rejects(output,/revoked|user_control/);
  await reading;
  if(change==="revoke") await f.service.personalAssistant(f.alice,prefix+"threads/profile/revoke",{id:"coding",expectedRevision:1});
  else f.service.orchestration.directUserInput(parseConversationRef(started.reference)!.threadId,"Human took over");
  release();await rejected;
});


test("a missing native receipt remains pending across restart and later completes the original operation", async t => {
  const f = await fixture(t);
  await f.grant();
  const started = await f.call(start);
  await f.service.pump();
  const original = f.native.receipt.bind(f.native);
  const show = () => f.call(["thread", "operation", "show", started.operationId]);
  f.native.receipt = async () => null;
  for (let i = 0; i < 2; i++) {
    const pending = await show();
    assert.equal(pending.operationId, started.operationId);
    assert.equal(pending.input.completion.status, "unknown");
    assert.equal(pending.input.completion.unavailable, undefined);
    assert.equal(pending.input.completion.text, "");
    if (i === 0) await f.restart();
  }
  f.native.receipt = async (binding, id) => {
    const row = await original(binding, id);
    return row ? { ...row, completion: {
      version: 1 as const, turnId: row.targetTurnId, status: "completed" as const,
      text: "RECOVERED ORIGINAL RESULT",
    } } : null;
  };
  const recovered = await show();
  assert.equal(recovered.operationId, started.operationId);
  assert.equal(recovered.input.completion.status, "completed");
  assert.equal(recovered.input.completion.text, "RECOVERED ORIGINAL RESULT");
  assert.equal(f.creates, 1);
  assert.equal(f.inputs, 1);
});


test("publication response loss after allocation resumes the same Thread and coalesces concurrent retries", async t => {
  const f = await fixture(t);
  await f.grant();
  const publish = f.driver.publishRoot.bind(f.driver);
  let loseReply = true;
  f.driver.publishRoot = async id => {
    await publish(id);
    if (loseReply) { loseReply = false; throw Error("lost publication reply"); }
  };
  await assert.rejects(f.call(start), /lost publication reply/);
  const [allocated] = (await f.call(["thread", "list", "--owned"])).threads;
  assert.ok(allocated.reference);
  assert.equal(allocated.state, "accepted");
  assert.equal(f.creates, 1);
  assert.equal(f.inputs, 0);
  await f.restart();
  const [first, second] = await Promise.all([f.call(start), f.call(start)]);
  assert.equal(first.operationId, allocated.operationId);
  assert.equal(second.operationId, first.operationId);
  assert.equal(first.reference, allocated.reference);
  assert.equal(second.requestId, first.requestId);
  assert.equal(first.state, "submitted");
  await f.service.pump();
  assert.equal(f.creates, 1);
  assert.equal(f.inputs, 1);
});

test("revocation during incomplete publication prevents first input while preserving the Human's allocated Thread", async t => {
  const f = await fixture(t);
  await f.grant();
  const publish = f.driver.publishRoot.bind(f.driver);
  f.driver.publishRoot = async id => { await publish(id); throw Error("lost publication reply"); };
  await assert.rejects(f.call(start), /lost publication reply/);
  const [allocated] = (await f.call(["thread", "list", "--owned"])).threads;
  const ref = parseConversationRef(allocated.reference)!;
  await f.service.personalAssistant(f.alice, prefix + "threads/profile/revoke", {id:"coding",expectedRevision:1});
  await f.restart();
  await assert.rejects(f.call(start), /revoked/);
  await f.service.pump();
  assert.equal(f.creates, 1);
  assert.equal(f.inputs, 0);
  assert.equal(f.access.read(ref.serverId, ref.threadId).accessMode, "private");
  assert.equal(f.access.allows(ref.serverId, ref.threadId, f.alice), true);
  assert.equal(f.access.allows(ref.serverId, ref.threadId, f.bob), false);
});


test("two Bots owned by the same Human isolate task keys, operation reads, writes and profile revocation", async t => {
  const f = await fixture(t);
  await f.grant();
  const created = await f.service.personalAssistant(f.alice, prefix + "bots/create", {
    name:"Second assistant",duties:"Local test role",environment:{kind:"local"},clientRequestId:"second-bot",
  }) as any;
  const provision = await f.service.provisionPersonalAssistant(f.alice, created.assistant.binding.botId);
  const second = f.actors.authenticateSession(provision.credential.token)!;
  await f.service.personalAssistant(f.alice, prefix + "threads/profile/set", {
    botId:created.assistant.binding.botId,id:"coding",reference:f.source,expectedRevision:0,
  });
  const firstTask = await f.call(start);
  const secondTask = await f.call(start, second);
  assert.notEqual(firstTask.operationId,secondTask.operationId);
  assert.notEqual(firstTask.reference,secondTask.reference);
  for (const [actor, foreign] of [[f.bot,secondTask],[second,firstTask]] as const) {
    await assert.rejects(f.call(["thread","operation","show",foreign.operationId],actor),/denied/);
    await assert.rejects(f.call(["thread","tell",foreign.reference,"--message","foreign task","--idempotency-key","foreign-write"],actor),/denied/);
  }
  await f.service.personalAssistant(f.alice,prefix+"threads/profile/revoke",{id:"coding",expectedRevision:1});
  await assert.rejects(f.call(["thread","operation","show",firstTask.operationId]),/revoked/);
  const own = await f.call(["thread","operation","show",secondTask.operationId],second);
  assert.equal(own.operationId,secondTask.operationId);
  const supplement = await f.call(["thread","tell",secondTask.reference,"--message","still authorized","--idempotency-key","second-supplement"],second);
  assert.equal(supplement.state,"submitted");
  assert.equal(f.creates,2);
});

test('finalization follows custody/publication; lost hydration reuses the allocated Thread after restart',async t=>{
 const f=await fixture(t);await f.grant();
 let attempts=0;
 (f.driver as any).finalizeRoot=async(id:string,threadId:string,settings:any,admit:()=>boolean)=>{
   attempts++;assert.equal(admit(),true);assert.equal(f.inputs,0);
   const owned=await f.call(['thread','list','--owned']);
   assert.equal(owned.threads.length,1);assert.equal(owned.threads[0].operationId,id);
   assert.equal(parseConversationRef(owned.threads[0].reference)!.threadId,threadId);
   assert.ok(settings.cwd);
   if(attempts===1)throw Error('hydration outcome unknown');
 };
 await assert.rejects(f.call(start),/hydration outcome unknown/);
 assert.equal(f.creates,1);assert.equal(f.inputs,0);
 await f.restart();
 const result=await f.call(start);await f.service.pump();
 assert.equal(result.state,'submitted');assert.equal(attempts,2);
 assert.equal(f.creates,1);assert.equal(f.inputs,1);
});

import {AppHostServer} from '../../packages/app-host-server/src/index';
import {ThreadAccessSession} from '../../packages/access-control/src/thread-access';
import {callConversationHost} from '../../scripts/conversation-execution.mjs';

test('actual internal create lane retains Human custody when Bot is revoked before native reply',async t=>{
 const f=await fixture(t);await f.grant();
 const create=f.driver.createRoot.bind(f.driver),listeners=new Set<(frame:string)=>void>();
 let operation='',settings:any,admit!:()=>boolean;
 const host=new AppHostServer({logicalClientRouting:true,physicalHostLifetime:'server',
  createRpcAccessSession:(_id,context,emit)=>new ThreadAccessSession(f.access,()=>f.server,context.actorContext,emit),
  createTransport:()=>({status:{state:'open' as const},connect:async()=>{},close:async()=>{},subscribeMessage(listener:(frame:string)=>void){listeners.add(listener);return()=>listeners.delete(listener);},subscribeStatus:()=>()=>{},
   async send(frame:string){const p=JSON.parse(frame);if(p.id===undefined)return;
    let result:any={};if(p.method==='opencraft/orchestration/create'){
      result=await create(operation,settings,admit);
      await f.service.personalAssistant(f.alice,prefix+'revoke');
    }
    for(const listener of listeners)listener(JSON.stringify({id:p.id,result,__opencraftClient:p.__opencraftClient}));}})});
 t.after(()=>host.close());
 f.driver.createRoot=async(id,params,canAdmit)=>{
  operation=id;settings=params;admit=canAdmit;
  return await callConversationHost(host,{hostId:'local-codex',threadId:''},id,'opencraft/orchestration/create',{operationId:id,settings:params},{sender:null,orchestrationOperationId:id,orchestrationCanAdmit:canAdmit}) as any;
 };
 await assert.rejects(f.call(start));
 const row=f.service.database.prepare('SELECT reference FROM assistant_thread_operations').get()!;
 const ref=parseConversationRef(String(row.reference));assert.ok(ref);
 assert.equal(f.creates,1);assert.equal(f.inputs,0);
 assert.equal(f.service.orchestration.relation(ref.threadId)!.ownerActorId,f.alice.actorId);
 assert.equal(f.access.allows(ref.serverId,ref.threadId,f.alice),true);
 assert.equal(f.access.allows(ref.serverId,ref.threadId,f.bob),false);
});
