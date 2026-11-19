import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Runner, request } from "../src/runner.mjs";
import { Store } from "../src/store.mjs";
import { running, profileFor, until, completed, childRunner, nativeEntries, files } from "./helpers.mjs";

const call = (p, op, params = {}, id = crypto.randomUUID()) => request(p, { op, params, id });
const question = (p, workId) =>
  until(async () => {
    const detail = await call(p, "work", { workId });
    return detail.work.status === "waiting_input" && detail.interactions.find((i) => i.state === "pending");
  });
const idle = (p) => until(async () => (await call(p, "status")).active === 0);
const settled = (p, id) =>
  until(async () => {
    const turn = await call(p, "turn", { inputId: id });
    if (turn.status === "blocked") throw new Error(turn.reply_text);
    return turn.status === "settled" && turn;
  });

test("pending question releases the only slot; answer resumes the same native submission exactly once", async (t) => {
  const { profile, runner } = await running(t, { concurrency: 1 });
  const first = await call(profile, "submit", { text: "整理资料，先问我范围" });
  const q = await question(profile, first.workId);
  await idle(profile);
  assert.equal(runner.work.executor.activeSessionCount(), 0);
  const second = await call(profile, "submit", { text: "整理另一份笔记" });
  await completed(profile, second.workId);
  const binding = (await call(profile, "work", { workId: first.workId })).executions[0];
  const params = {
    interactionId: q.id,
    expectedRevision: 1,
    text: "只整理本周",
  };
  const accepted = await call(profile, "interaction.answer", params, "answer-once");
  assert.equal(accepted.state, "answered");
  assert.equal((await call(profile, "interaction.answer", params, "answer-once")).duplicate, true);
  await assert.rejects(
    call(profile, "interaction.answer", params, "another-answer"),
    /Interaction is answered|waiting/,
  );
  const done = await completed(profile, first.workId);
  assert.equal(done.executions.length, 1);
  assert.equal(done.executions[0].submission_id, binding.submission_id);
  assert.equal(done.executions[0].conversation_id, binding.conversation_id);
  assert.equal(done.work.revision, 1);
  assert.equal(done.results.length, 1);
  assert.equal(done.interactions.length, 1);
  const artifact = files(profile, "artifacts")
    .map((f) => readFileSync(join(profile.path, "artifacts", f), "utf8"))
    .find((s) => s.includes("用户补充"));
  assert.match(artifact, /只整理本周/);
  await runner.close();
  const entries = await nativeEntries(profile, first.workId);
  assert.equal(entries.filter((e) => e.kind === "superapp.work-input").length, 1);
});

test("restart preserves a question without reopening a waiting native harness", async (t) => {
  const profile = profileFor(t);
  const first = await childRunner(t, profile);
  const work = await call(profile, "submit", { text: "整理资料，先问我范围" });
  const q = await question(profile, work.workId);
  await idle(profile);
  await first.stop();
  const second = await childRunner(t, profile);
  assert.equal((await call(profile, "status")).active, 0);
  assert.equal((await call(profile, "interaction.list"))[0].id, q.id);
  await call(profile, "interaction.answer", {
    interactionId: q.id,
    expectedRevision: 1,
    text: "本周进展",
  });
  await completed(profile, work.workId);
  await second.stop();
  assert.equal((await nativeEntries(profile, work.workId)).filter((e) => e.kind === "superapp.work-input").length, 1);
});

for (const action of ["amend", "cancel"])
  test(`${action} retires the old question and rejects stale answers`, async (t) => {
    const { profile } = await running(t);
    const work = await call(profile, "submit", {
      text: "整理资料，先问我范围",
    });
    const q = await question(profile, work.workId);
    await idle(profile);
    await call(profile, action, {
      workId: work.workId,
      expectedRevision: 1,
      ...(action === "amend" ? { text: "整理新的完整目标" } : {}),
    });
    await assert.rejects(
      call(profile, "interaction.answer", {
        interactionId: q.id,
        expectedRevision: 1,
        text: "迟到的回答",
      }),
      /superseded|cancelled|revision/,
    );
    const detail =
      action === "amend" ? await completed(profile, work.workId) : await call(profile, "work", { workId: work.workId });
    assert.equal(detail.interactions[0].state, action === "amend" ? "superseded" : "cancelled");
    assert.equal(
      detail.results.some((r) => r.revision === 1),
      false,
    );
  });

test("rejecting a question blocks work; a revised goal can continue", async (t) => {
  const { profile } = await running(t);
  const work = await call(profile, "submit", { text: "整理资料，先问我范围" });
  const q = await question(profile, work.workId);
  await idle(profile);
  await call(profile, "interaction.reject", {
    interactionId: q.id,
    expectedRevision: 1,
  });
  const blocked = await call(profile, "work", { workId: work.workId });
  assert.equal(blocked.work.status, "blocked");
  assert.equal(blocked.results.length, 0);
  assert.equal(blocked.interactions[0].state, "rejected");
  await call(profile, "amend", {
    workId: work.workId,
    expectedRevision: 1,
    text: "整理已有资料即可",
  });
  await completed(profile, work.workId);
});

test("all pending questions must be answered, and effects cannot run while waiting", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const work = store.work(store.submit("work", { text: "two questions" }).workId);
  store.started(work);
  const first = store.app.interactions.request(work, "q1", "哪个项目？");
  const second = store.app.interactions.request(work, "q2", "哪个时间范围？");
  assert.throws(() => store.app.executions.assertAction(work, "publish_note"), /pending information/);
  store.app.interactions.answer("a1", {
    interactionId: first.id,
    expectedRevision: 1,
    text: "项目A",
  });
  assert.equal(store.work(work.id).status, "waiting_input");
  store.app.interactions.answer("a2", {
    interactionId: second.id,
    expectedRevision: 1,
    text: "本周",
  });
  assert.equal(store.work(work.id).status, "queued");
});

test("a committed question survives a process exit before native suspension", async (t) => {
  const profile = profileFor(t);
  const first = await childRunner(t, profile, {
    LAB_TEST_CRASH_AT: "interaction-saved-before-suspend",
  });
  const work = await call(profile, "submit", { text: "整理资料，先问我范围" }, "question-crash");
  assert.equal((await first.exited).code, 86);
  const second = await childRunner(t, profile);
  const q = await question(profile, work.workId);
  await call(profile, "interaction.answer", {
    interactionId: q.id,
    expectedRevision: 1,
    text: "本周",
  });
  const done = await completed(profile, work.workId);
  assert.equal(done.interactions.length, 1);
  assert.equal(done.executions.length, 1);
  await second.stop();
  assert.equal((await nativeEntries(profile, work.workId)).filter((e) => e.kind === "superapp.work-input").length, 1);
});

test("main conversation receives the question and routes the user answer to its original work", async (t) => {
  const { profile } = await running(t);
  await call(profile, "say", { text: "整理项目资料，先问我范围" }, "work-turn");
  const turn = await settled(profile, "work-turn");
  const q = await question(profile, turn.work_id);
  const history = await call(profile, "conversation");
  assert.equal(history.messages.filter((m) => m.data.interactionId === q.id).length, 1);
  await call(profile, "say", { text: "回答：只整理本周" }, "answer-turn");
  const answer = await settled(profile, "answer-turn");
  assert.equal(answer.work_id, turn.work_id);
  const done = await completed(profile, turn.work_id);
  assert.equal(done.interactions[0].answer, "只整理本周");
  assert.equal((await call(profile, "status")).works.length, 1);
});

test("explicit memory can be set, corrected, forgotten and re-created through conversation without work items", async (t) => {
  const { profile } = await running(t);
  for (const [id, text, expected] of [
    ["one", "记住我在上海", "上海"],
    ["two", "记住我在深圳", "深圳"],
    ["three", "忘记城市", null],
    ["four", "记住我在北京", "北京"],
  ]) {
    await call(profile, "say", { text }, id);
    await settled(profile, id);
    const list = await call(profile, "memory.list");
    assert.equal(list[0]?.value ?? null, expected);
  }
  assert.equal((await call(profile, "memory.list"))[0].revision, 4);
  assert.equal((await call(profile, "status")).works.length, 0);
});

test("rejecting one of several questions retires the rest without inventing an answer", (t) => {
  const store = new Store(profileFor(t));
  t.after(() => store.close());
  const work = store.work(store.submit("work", { text: "questions" }).workId);
  store.started(work);
  const a = store.app.interactions.request(work, "a", "a?");
  const b = store.app.interactions.request(work, "b", "b?");
  store.app.interactions.reject("reject", {
    interactionId: a.id,
    expectedRevision: 1,
  });
  assert.equal(store.app.interactionLedger.get(b.id).state, "rejected");
  assert.equal(store.app.interactionLedger.get(b.id).answer, null);
  assert.throws(
    () =>
      store.app.interactions.answer("late", {
        interactionId: b.id,
        expectedRevision: 1,
        text: "too late",
      }),
    /rejected/,
  );
});

test("a reception proposal cannot answer a question from unlinked direct work", async (t) => {
  const profile = profileFor(t);
  let foreign;
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide() {
        return {
          kind: "answer",
          interactionId: foreign,
          expectedRevision: 1,
          text: "invented",
        };
      },
    },
  });
  t.after(() => runner.close());
  const work = await call(profile, "submit", { text: "整理资料，先问我范围" });
  foreign = (await question(profile, work.workId)).id;
  await call(profile, "say", { text: "an unrelated chat" }, "foreign");
  const turn = await until(async () => {
    const r = await call(profile, "turn", { inputId: "foreign" });
    return r.status === "blocked" && r;
  });
  assert.match(turn.reply_text, /outside this conversation/);
  assert.equal((await call(profile, "work", { workId: work.workId })).interactions[0].answer, null);
});

test("a stale memory proposal cannot overwrite a newer explicit change or emit a success reply", async (t) => {
  const profile = profileFor(t);
  let release, ready;
  const inputReady = new Promise((resolve) => (ready = resolve));
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide(input) {
        ready(input);
        return new Promise(
          (resolve) =>
            (release = () =>
              resolve({
                kind: "remember",
                key: "city",
                value: "stale",
                expectedRevision: 0,
              })),
        );
      },
    },
  });
  t.after(() => runner.close());
  await call(profile, "say", { text: "remember" }, "stale-memory");
  await inputReady;
  await call(profile, "memory.set", {
    key: "city",
    value: "深圳",
    expectedRevision: 0,
  });
  release();
  await until(async () => (await call(profile, "turn", { inputId: "stale-memory" })).status === "blocked");
  assert.equal((await call(profile, "memory.list"))[0].value, "深圳");
  assert.equal(
    (await call(profile, "conversation")).messages.some((m) => m.data.kind === "remember"),
    false,
  );
});
