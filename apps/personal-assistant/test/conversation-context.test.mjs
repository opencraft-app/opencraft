import { legacyCoordinationFixture } from "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Store } from "../src/store.mjs";
import { Runner, request } from "../src/runner.mjs";
import { Conversation } from "../src/domain/conversation.mjs";
import {
  CONTEXT_POLICY,
  emptyContext,
} from "../src/domain/conversation-context.mjs";
import { ConversationContextCoordinator } from "../src/runtime/conversation-context-coordinator.mjs";
import { ConversationContextModel } from "../src/adapters/models/conversation-context-model.mjs";
import {
  profileFor,
  until,
  childRunner,
  nativeEntries,
  completed,
  root,
} from "./helpers.mjs";

const exec = promisify(execFile);
function setup(t) {
  const profile = profileFor(t),
    store = new Store(profile);
  t.after(() => {
    if (store.uow.db.isOpen) store.close();
  });
  return {
    profile,
    store,
    app: store.app,
    service: store.app.conversationContext,
  };
}
function seed(app, n = 40, text = (i) => `historic ${i}`) {
  for (let i = 0; i < n; i++)
    app.history.append(
      app.history.main.id,
      `seed-${i}`,
      i % 2 ? "assistant" : "user",
      text(i),
    );
}
function turn(app, id = "current", text = "继续") {
  app.reception.accept(id, { text });
  return app.reception.turn(id);
}
function proposal(job, values = {}) {
  const input = JSON.parse(job.source_json),
    first = input.messages[0];
  return {
    ...emptyContext(),
    goals: [{ text: first.text.slice(0, 400), sourceIds: [first.id] }],
    ...values,
  };
}
function save(service, job, value = proposal(job)) {
  assert.ok(service.begin(job));
  assert.equal(service.commit(job, value).accepted, true);
}
const call = (p, op, params = {}, id = crypto.randomUUID()) =>
  request(p, { op, params, id });
const settled = (p, id) =>
  until(async () => {
    const t = await call(p, "turn", { inputId: id });
    if (t.status === "blocked") throw new Error(t.reply_text);
    return t.status === "settled" && t;
  });

test("rolling cited working context is injected without rewriting history, facts or work", (t) => {
  const { app, service, store } = setup(t);
  seed(app, 60, (i) =>
    i === 0 ? "目标是周五前交付设计；只分析，不部署" : `discussion ${i}`,
  );
  const current = turn(app);
  const before = store.db
    .prepare("SELECT * FROM conversation_message ORDER BY seq")
    .all();
  const a = service.capture(current);
  save(
    service,
    a,
    proposal(a, {
      constraints: [
        {
          text: "只分析，不部署",
          sourceIds: [JSON.parse(a.source_json).messages[0].id],
        },
      ],
    }),
  );
  const b = service.capture(current);
  assert.equal(b.parent_id, a.id);
  save(service, b, {
    ...emptyContext(),
    constraints: JSON.parse(
      store.app.conversationContext.repository.get(a.id).summary_json,
    ).constraints,
  });
  const input = app.reception.context(current);
  assert.equal(
    input.workingContext.summary.constraints[0].text,
    "只分析，不部署",
  );
  assert.equal(input.workingContext.summary.sources[0].role, "user");
  assert.ok(input.workingContext.gap.incomplete);
  assert.equal(input.messages.length, 20);
  assert.ok(input.messages.every((m) => m.id && Number.isInteger(m.seq)));
  assert.deepEqual(
    store.db.prepare("SELECT * FROM conversation_message ORDER BY seq").all(),
    before,
  );
  assert.deepEqual(app.memory.list(), []);
  assert.deepEqual(app.pendingWorks(), []);
});

test("long Unicode messages are consumed in exact resumable segments without falsely advancing coverage", (t) => {
  const { app, service } = setup(t);
  const original = "开头🙂" + "ab🙂中".repeat(12000) + "最后约束：禁止上线";
  seed(app, 1, () => original);
  for (let i = 0; i < 20; i++)
    app.history.append(
      app.history.main.id,
      `tail${i}`,
      "assistant",
      `recent ${i}`,
    );
  const current = turn(app),
    pieces = [];
  for (let i = 0; i < 12; i++) {
    const job = service.capture(current);
    if (!job) break;
    const input = JSON.parse(job.source_json);
    assert.ok(input.messages.length <= CONTEXT_POLICY.batchMessages);
    assert.ok(
      input.messages.every(
        (m) => m.text.length <= CONTEXT_POLICY.segmentCharacters,
      ),
    );
    pieces.push(
      ...input.messages.filter((m) => m.seq === 1).map((m) => m.text),
    );
    save(service, job);
  }
  assert.equal(pieces.join(""), original);
  assert.equal(service.view(current).gap.messages, 0);
});

test("checkpoint and captured proposal input survive reopen; ready checkpoint is immutable and idempotent", (t) => {
  const { app, service, profile, store } = setup(t);
  seed(app);
  const current = turn(app);
  const job = service.capture(current);
  service.begin(job);
  store.close();
  const second = new Store(profile);
  t.after(() => second.close());
  const recovered = second.app.conversationContext.capture(current);
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.attempts, 1);
  assert.equal(recovered.source_json, job.source_json);
  save(second.app.conversationContext, recovered);
  const saved = second.db
    .prepare("SELECT summary_json FROM conversation_context WHERE id=?")
    .get(job.id).summary_json;
  assert.equal(
    second.app.conversationContext.commit(job, { evil: true }).duplicate,
    true,
  );
  assert.equal(
    second.db
      .prepare("SELECT summary_json FROM conversation_context WHERE id=?")
      .get(job.id).summary_json,
    saved,
  );
});

test("unknown citations, invented sections and oversized items cannot commit or advance the cursor", (t) => {
  const { app, service } = setup(t);
  seed(app);
  const job = service.capture(turn(app));
  service.begin(job);
  assert.throws(
    () =>
      service.commit(
        job,
        proposal(job, {
          goals: [{ text: "invented", sourceIds: ["foreign"] }],
        }),
      ),
    /citation/,
  );
  assert.throws(
    () => service.commit(job, { ...proposal(job), tools: ["shell"] }),
    /sections/,
  );
  assert.throws(
    () =>
      service.commit(
        job,
        proposal(job, {
          goals: [
            {
              text: "x".repeat(401),
              sourceIds: [JSON.parse(job.source_json).messages[0].id],
            },
          ],
        }),
      ),
    /context item/,
  );
  assert.equal(service.status().checkpointId, null);
  assert.equal(service.repository.get(job.id).state, "pending");
});

test("source changes and SQLite failures roll back checkpoint publication", (t) => {
  const { app, service, store } = setup(t);
  seed(app);
  const job = service.capture(turn(app));
  service.begin(job);
  const id = JSON.parse(job.source_json).messages[0].id;
  store.db
    .prepare("UPDATE conversation_message SET text='changed' WHERE id=?")
    .run(id);
  assert.throws(() => service.commit(job, proposal(job)), /source changed/);
  store.db
    .prepare("UPDATE conversation_message SET text='historic 0' WHERE id=?")
    .run(id);
  store.db.exec(
    "CREATE TEMP TRIGGER context_fail BEFORE UPDATE OF summary_json ON conversation_context BEGIN SELECT RAISE(ABORT,'injected context failure'); END",
  );
  assert.throws(
    () => service.commit(job, proposal(job)),
    /injected context failure/,
  );
  assert.equal(service.status().checkpointId, null);
  store.db.exec("DROP TRIGGER context_fail");
  assert.equal(service.commit(job, proposal(job)).accepted, true);
});

test("late concurrent candidates cannot replace a newer parent checkpoint", (t) => {
  const { app, service } = setup(t);
  seed(app, 30);
  const early = turn(app, "early");
  const first = service.capture(early);
  for (let i = 0; i < 40; i++)
    app.history.append(app.history.main.id, `later-${i}`, "user", `later ${i}`);
  const later = turn(app, "later");
  const second = service.capture(later);
  assert.notEqual(first.id, second.id);
  save(service, first);
  service.begin(second);
  assert.equal(service.commit(second, proposal(second)).accepted, false);
  assert.equal(service.repository.get(second.id).state, "superseded");
  assert.equal(service.status().checkpointId, first.id);
});

test("old queued user and system report contexts do not read future summaries or messages", (t) => {
  const { app, service } = setup(t);
  const old = turn(app, "old", "早期请求");
  seed(app, 70, (i) => `FUTURE-SECRET-${i}`);
  const current = turn(app, "new");
  for (let i = 0; i < 3; i++) {
    const job = service.capture(current);
    if (job) save(service, job);
  }
  assert.ok(service.status().checkpointId);
  const input = app.reception.context(old);
  assert.equal(input.workingContext.checkpointId, null);
  assert.doesNotMatch(JSON.stringify(input.workingContext), /FUTURE-SECRET/);
  assert.equal(service.capture(old), null);
  const reportTurn = {
    ...old,
    source_json: JSON.stringify({
      historyAnchor: Conversation.messageId(app.history.main.id, "old", "user"),
    }),
  };
  assert.equal(service.view(reportTurn).checkpointId, null);
  assert.throws(
    () => service.view({ ...old, conversation_id: "foreign" }),
    /outside/,
  );
});

test("summary errors have bounded durable retries, preserve raw gap and allow explicit reset", async (t) => {
  const { app, service } = setup(t);
  seed(app);
  const current = turn(app);
  let now = 10000;
  service.now = () => now;
  const coordinator = new ConversationContextCoordinator(service, {
    async summarize() {
      throw new Error("bad model");
    },
  });
  for (let i = 0; i < 3; i++) {
    await coordinator.prepare(current, new AbortController().signal);
    now += 10000;
  }
  const status = service.status();
  assert.equal(status.pending.attempts, 3);
  assert.equal(status.pending.state, "failed");
  assert.equal(status.checkpointId, null);
  assert.ok(service.view(current).gap.messages > 0);
  assert.ok(service.view(current).gap.excerpts[0].id);
  assert.equal(service.capture(current), null);
  assert.equal(service.retry().reset, 1);
  assert.ok(service.capture(current));
});

test("summary deadline frees reception and ignores a late model result", async (t) => {
  const { app, service } = setup(t);
  seed(app);
  const current = turn(app);
  let release;
  const coordinator = new ConversationContextCoordinator(
    service,
    {
      summarize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
    { timeoutMs: 20 },
  );
  await coordinator.prepare(current, new AbortController().signal);
  assert.equal(service.status().checkpointId, null);
  release(emptyContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.status().checkpointId, null);
  app.reception.apply(current, { kind: "reply", text: "仍可接待" });
  assert.equal(app.reception.turn(current.id).status, "settled");
});

test("history.read returns cited originals with pagination and rejects future and foreign messages", (t) => {
  const { app, store } = setup(t);
  seed(app, 5, (i) => `旧原文-${i}-` + "字".repeat(3500));
  const old = turn(app, "anchor");
  const later = turn(app, "later");
  const session = app.receptionQueries.open(old);
  const first = store.db
    .prepare("SELECT id FROM conversation_message ORDER BY seq LIMIT 1")
    .get().id;
  const got = session.execute({
    kind: "query",
    name: "history.read",
    params: { messageId: first, offset: 1000, limit: 2000 },
  });
  assert.equal(got.response.data.text.length, 2000);
  assert.equal(got.response.data.nextOffset, 3000);
  assert.equal(
    session.execute({
      kind: "query",
      name: "history.read",
      params: {
        messageId: Conversation.messageId(
          app.history.main.id,
          later.id,
          "user",
        ),
      },
    }).response.ok,
    false,
  );
  assert.equal(
    session.execute({
      kind: "query",
      name: "history.read",
      params: { messageId: "foreign" },
    }).response.ok,
    false,
  );
  const before = store.db.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(
    session
      .execute({
        kind: "query",
        name: "history.search",
        params: { query: later.text },
      })
      .response.data.items.some(
        (m) =>
          m.id ===
          Conversation.messageId(app.history.main.id, later.id, "user"),
      ),
    false,
  );
  assert.equal(store.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("short conversations do not start an unnecessary summary request", async (t) => {
  const { app, service } = setup(t);
  seed(app, 26);
  const current = turn(app);
  let calls = 0;
  const coordinator = new ConversationContextCoordinator(service, {
    async summarize() {
      calls++;
      return emptyContext();
    },
  });
  await coordinator.prepare(current, new AbortController().signal);
  assert.equal(calls, 0);
  assert.equal(service.status().pending, null);
  assert.equal(service.view(current).gap.messages, 7);
});

test("aborted summary attempts persist without accepting late output; crash exhaustion can be reset", async (t) => {
  const { app, service } = setup(t);
  seed(app);
  const current = turn(app);
  const job = service.capture(current);
  const controller = new AbortController();
  const coordinator = new ConversationContextCoordinator(service, {
    async summarize() {
      controller.abort();
      return proposal(job);
    },
  });
  await assert.rejects(coordinator.prepare(current, controller.signal));
  assert.equal(service.repository.get(job.id).attempts, 1);
  assert.equal(service.status().checkpointId, null);
  service.begin(job);
  service.begin(job);
  assert.equal(service.capture(current), null);
  assert.equal(service.status().pending.state, "failed");
  assert.equal(service.retry().reset, 1);
});

test("new explicit corrections reach reception alongside the older summary without mutating it", (t) => {
  const { app, service } = setup(t);
  seed(app, 40, (i) => (i === 0 ? "约定周五交付" : `history ${i}`));
  const current = turn(app, "correction", "改为下周一交付，不再是周五");
  const job = service.capture(current);
  save(service, job);
  const before = service.repository.get(job.id).summary_json;
  const input = app.reception.context(current);
  assert.match(input.workingContext.summary.goals[0].text, /周五/);
  assert.match(input.text, /下周一/);
  assert.equal(input.messages.at(-1).text, input.text);
  assert.equal(service.repository.get(job.id).summary_json, before);
  const prompt = readFileSync(
    join(root, "src/adapters/models/reception-model.mjs"),
    "utf8",
  );
  assert.match(prompt, /Apply the latest explicit user correction/);
});

test("context model failure cannot block the actual reception socket", async (t) => {
  const profile = profileFor(t),
    seedStore = new Store(profile);
  seed(seedStore.app);
  seedStore.close();
  let observed;
  const runner = await Runner.open(profile, {
    contextModel: {
      async summarize() {
        throw new Error("summary unavailable");
      },
    },
    receptionModel: {
      async decide(input) {
        observed = input;
        return { kind: "reply", text: "继续接待" };
      },
    },
  });
  try {
    await call(profile, "say", { text: "你好" }, "not-blocked");
    await settled(profile, "not-blocked");
    assert.equal((await call(profile, "status")).healthError, null);
    assert.equal(observed.workingContext.checkpointId, null);
    assert.equal(observed.workingContext.gap.incomplete, true);
    assert.match(
      (await call(profile, "conversation.context")).pending.error,
      /summary unavailable/,
    );
  } finally {
    await runner.close();
  }
});

test("actual reception and Pi delegation receive the frozen cited working context", async (t) => {
  const profile = profileFor(t);
  const original = new Store(profile);
  seed(original.app);
  original.close();
  let observed;
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        if (input.source) return { kind: "deliver", text: "完成" };
        observed = input;
        return { kind: "delegate", goal: "整理本地笔记" };
      },
    },
  });
  t.after(() => runner.close());
  await call(profile, "say", { text: "继续整理" }, "delegate");
  const received = await settled(profile, "delegate");
  assert.ok(observed.workingContext.checkpointId);
  const work = await completed(profile, received.work_id);
  const snapshot = JSON.parse(work.executions[0].context_json);
  assert.deepEqual(snapshot.request.workingContext, observed.workingContext);
  const entries = await nativeEntries(profile, received.work_id);
  assert.match(
    JSON.stringify(entries),
    new RegExp(observed.workingContext.checkpointId),
  );
  const cli = await exec(
    process.execPath,
    ["bin/assistant.mjs", "context", "--profile", profile.path],
    { cwd: root },
  );
  assert.ok(JSON.parse(cli.stdout).result.checkpointId);
  assert.equal((await call(profile, "status")).healthError, null);
});

test("real model adapter sends the summarization protocol and records a distinct usage kind", async () => {
  let payload, observed;
  const catalog = {
    configured: {
      mode: "model",
      model: { provider: "test", modelId: "one" },
      models: {
        getModel: () => ({}),
        async completeSimple(model, context) {
          payload = context;
          return {
            stopReason: "stop",
            content: [{ type: "text", text: JSON.stringify(emptyContext()) }],
            usage: { input: 5, output: 4, totalTokens: 9 },
          };
        },
      },
    },
  };
  const model = new ConversationContextModel(catalog, {
    recordUsage: (u) => {
      observed = u;
    },
  });
  assert.deepEqual(
    await model.summarize(
      { previous: null, messages: [] },
      new AbortController().signal,
    ),
    emptyContext(),
  );
  assert.match(payload.systemPrompt, /WORKING CONTEXT/);
  assert.match(payload.systemPrompt, /not user agreement/);
  assert.equal(observed.kind, "context-summary");
});

test("schema15 upgrades without modifying canonical messages or inventing a summary", (t) => {
  const { app, store, profile } = setup(t);
  seed(app, 4);
  const raw = store.db.prepare("SELECT * FROM conversation_message").all();
  legacyCoordinationFixture(store.db);
  store.db.exec(
    "DROP TABLE IF EXISTS execution_native_receipt; ALTER TABLE execution DROP COLUMN harness; DROP TABLE user_message; ALTER TABLE delivery DROP COLUMN user_message_json; ALTER TABLE notification DROP COLUMN user_message_json; DROP TABLE conversation_context; PRAGMA user_version=15",
  );
  store.close();
  const second = new Store(profile);
  t.after(() => second.close());
  assert.equal(second.db.prepare("PRAGMA user_version").get().user_version, 22);
  assert.deepEqual(
    second.db.prepare("SELECT * FROM conversation_message").all(),
    raw,
  );
  assert.equal(second.app.conversationContext.status().checkpointId, null);
});

for (const point of [
  "context-proposed-before-commit",
  "context-saved-before-reception",
]) {
  test(`real process recovery at ${point} preserves raw history and settles input once`, async (t) => {
    const profile = profileFor(t);
    const seedStore = new Store(profile);
    seed(seedStore.app);
    seedStore.close();
    const first = await childRunner(t, profile, { LAB_TEST_CRASH_AT: point });
    await call(profile, "say", { text: "你好" }, "crash-input");
    assert.equal((await first.exited).code, 86);
    const second = await childRunner(t, profile);
    await settled(profile, "crash-input");
    const history = await call(profile, "conversation");
    assert.equal(
      history.messages.filter((m) => m.data.inputId === "crash-input").length,
      1,
    );
    assert.equal(
      history.messages.filter((m) => m.data.kind === "reply").length,
      1,
    );
    assert.ok((await call(profile, "conversation.context")).checkpointId);
    await second.stop();
  });
}

for (const failure of ["reject", "timeout"]) {
  test("best-effort summary " + failure + " keeps observed reception healthy", async (t) => {
    // The held reception must survive the status/context IPC assertions too.
    // Keep this above local filesystem/IPC latency; the timeout case still exercises a real deadline.
    const profile = profileFor(t, { runPolicy: { modelTimeoutMs: 2000 } });
    const store = new Store(profile);
    seed(store.app);
    store.close();
    let release, lateSummary;
    const held = new Promise(resolve => { release = resolve; });
    let entered = false;
    const runner = await Runner.open(profile, {
      contextModel: { summarize() {
        if (failure === "reject") return Promise.reject(Error("summary unavailable"));
        return new Promise(resolve => { lateSummary = resolve; });
      } },
      receptionModel: { async decide() {
        entered = true;
        await held;
        return {kind: "reply", text: "继续接待"};
      } },
    });
    try {
      await call(profile, "say", {text: "继续"}, "summary-health");
      await until(() => entered);
      // This is exactly when the Host/group observer used to close IPC.
      const status = await call(profile, "status");
      assert.equal(status.healthError, null);
      assert.equal(runner.stopping, false);
      assert.equal(status.receptionActive, true);
      assert.ok((await call(profile, "conversation.context")).pending.error);
      lateSummary?.(emptyContext());
      release();
      await settled(profile, "summary-health");
      assert.equal((await call(profile, "status")).healthError, null);
      assert.equal((await call(profile, "conversation.context")).checkpointId, null);
    } finally { release(); await runner.close(); }
  });
}
