import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Store } from "../src/store.mjs";
import { profileFor, running, until, root } from "./helpers.mjs";
import { emptyContext } from "../src/domain/conversation-context.mjs";
const exec = promisify(execFile);
function setup(t) {
  const profile = profileFor(t);
  let store = new Store(profile);
  t.after(() => store.close());
  return {
    get app() {
      return store.app;
    },
    reopen() {
      store.close();
      store = new Store(profile);
    },
  };
}
const call = (app, op, params = {}, id = crypto.randomUUID()) => app.dispatch({ op, params, id });
const fresh = (app, id) => call(app, "conversation.create", {}, id).conversationId;
const input = (app, conversationId, id, text = "hello") => {
  call(app, "say", { conversationId, text }, id);
  return app.reception.turn(id);
};
test("new conversation is durable, idempotent, scoped and does not reset memory or original default", (t) => {
  const s = setup(t),
    a = s.app,
    original = call(a, "conversation").conversationId;
  call(a, "memory.set", { key: "drink", value: "tea", expectedRevision: 0 }, "memory");
  const epoch = a.memory.epoch(),
    first = fresh(a, "first"),
    second = fresh(a, "second");
  assert.notEqual(first, second);
  assert.equal(fresh(a, "first"), first);
  assert.equal(call(a, "conversation.create", {}, "first").duplicate, true);
  assert.throws(() => call(a, "conversation.create", { actor: "foreign" }, "bad"), /no fields/);
  assert.throws(() => call(a, "say", { conversationId: "foreign", text: "x" }), /outside/);
  const t1 = input(a, first, "one", "first only"),
    t2 = input(a, second, "two", "second only");
  a.reception.apply(t2, { kind: "reply", text: "second answer" });
  a.reception.apply(t1, { kind: "reply", text: "first answer" });
  assert.equal(a.history.view({ conversationId: first }).messages.length, 2);
  assert.ok(!JSON.stringify(a.reception.context(t2)).includes("first only"));
  assert.match(JSON.stringify(a.reception.context(t2)), /tea/);
  assert.equal(a.history.view().messages.length, 0);
  assert.equal(a.memory.epoch(), epoch);
  const page = call(a, "conversation.list", { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.next);
  assert.equal(call(a, "conversation.list", { after: page.next }).items.length, 2);
  s.reopen();
  assert.equal(call(s.app, "conversation").conversationId, original);
  assert.equal(fresh(s.app, "first"), first);
  assert.equal(s.app.history.view({ conversationId: first }).messages.length, 2);
  assert.equal(s.app.memory.epoch(), epoch);
  assert.match(JSON.stringify(call(s.app, "memory.list")), /tea/);
});
test("queued work, late report, delivery and work history remain with their origin after new conversations", (t) => {
  const state = setup(t);
  let a = state.app;
  const origin = fresh(a, "origin");
  const t1 = input(a, origin, "work", "remember the original request");
  a.reception.apply(t1, {
    kind: "delegate",
    goal: "compare",
    completion: { output: "text" },
  });
  const work = a.workRecord(a.reception.turn(t1.id).work_id),
    other = fresh(a, "other");
  input(a, other, "other-input", "unrelated new task");
  assert.throws(
    () => call(a, "say", { text: "modify", conversationId: other, workId: work.id }, "bad-target"),
    /outside/,
  );
  assert.match(JSON.stringify(a.history.search({ query: "original" }, work.id)), /original request/);
  assert.throws(() => a.history.search({ query: "original", conversationId: other }, work.id), /grant/);
  state.reopen();
  a = state.app;
  assert.equal(a.executions.report(work, "finished original work").routed, true);
  const report = a.reception.pending().find((t) => t.source_json);
  assert.equal(report.conversation_id, origin);
  assert.ok(!JSON.stringify(a.reception.context(report)).includes("unrelated new task"));
  a.reception.apply(report, { kind: "deliver", text: "original result" });
  a.outcomes.accepted(a.outcomes.pending()[0]);
  assert.equal(a.history.view({ conversationId: origin }).messages.filter((m) => m.data.kind === "result").length, 1);
  assert.equal(a.history.view({ conversationId: other }).messages.filter((m) => m.role === "assistant").length, 0);
  assert.ok(a.messages.pending().some((m) => m.conversation_id === origin));
});
test("message replies, query checkpoints and summaries cannot cross conversation boundaries", (t) => {
  const { app: a } = setup(t),
    one = fresh(a, "one"),
    two = fresh(a, "two");
  for (let i = 0; i < 42; i++) a.history.append(one, `old-${i}`, i % 2 ? "assistant" : "user", `one-${i}`);
  const t1 = input(a, one, "anchor"),
    t2 = input(a, two, "new-anchor");
  const service = a.conversationContext,
    job = service.capture(t1);
  assert.ok(job);
  assert.equal(service.capture(t2), null);
  assert.ok(service.begin(job));
  service.commit(job, {
    ...emptyContext(),
    goals: [{ text: "one", sourceIds: [JSON.parse(job.source_json).messages[0].id] }],
  });
  assert.ok(call(a, "conversation.context", { conversationId: one }).checkpointId);
  assert.equal(call(a, "conversation.context", { conversationId: two }).checkpointId, null);
  const sent = call(a, "message.send", {
    conversationId: one,
    message: { type: "text", content: "one reply" },
  });
  assert.equal(call(a, "message.get", { conversationId: one, messageId: sent.messageId }).conversationId, one);
  assert.throws(
    () =>
      call(a, "message.get", {
        conversationId: two,
        messageId: sent.messageId,
      }),
    /Unknown/,
  );
  assert.throws(
    () =>
      call(a, "message.send", {
        conversationId: two,
        message: { type: "text", content: "cross", replyTo: sent.messageId },
      }),
    /outside/,
  );
  assert.equal(call(a, "messages.list", { conversationId: two }).items.length, 0);
});
test("goal creation and extension inherit original conversation rather than default main", (t) => {
  const { app: a } = setup(t),
    origin = fresh(a, "goal-origin");
  const result = call(
    a,
    "goal.create",
    {
      conversationId: origin,
      definition: {
        objective: "goal",
        criteria: ["done"],
        tasks: [
          {
            key: "a",
            text: "first",
            dependsOn: [],
            completion: { output: "text" },
          },
        ],
      },
    },
    "goal",
  );
  fresh(a, "unrelated");
  const _extended = call(
    a,
    "goal.extend",
    {
      goalId: result.id,
      expectedRevision: result.revision,
      tasks: [
        {
          key: "b",
          text: "next",
          dependsOn: ["a"],
          completion: { output: "text" },
        },
      ],
    },
    "extend",
  );
  assert.equal(a.history.view({ conversationId: origin }).works.length, 2);
  assert.equal(a.history.view().works.length, 0);
  for (const w of a.history.view({ conversationId: origin }).works)
    assert.equal(JSON.parse(a.executionLedger.get(w).request_json).original.conversationId, origin);
});
test("actual CLI and socket create separate conversations and keep default compatible", async (t) => {
  const { profile, call } = await running(t);
  const cli = async (...args) =>
    JSON.parse(
      (await exec(process.execPath, ["bin/assistant.mjs", ...args, "--profile", profile.path], { cwd: root })).stdout,
    ).result;
  const { conversationId } = await cli("conversation-new", "--id", "cli-new");
  const receipt = await cli("say", "--conversation", conversationId, "--text", "你好", "--id", "cli-hello");
  assert.equal(receipt.conversationId, conversationId);
  await until(async () => (await call("turn", { inputId: "cli-hello" })).status === "settled");
  assert.equal((await cli("conversation", "--conversation", conversationId)).messages.length, 2);
  assert.equal((await cli("conversation")).messages.length, 0);
  assert.equal((await cli("conversations")).items.length, 2);
});
