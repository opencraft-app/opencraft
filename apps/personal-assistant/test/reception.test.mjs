import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Runner, request } from "../src/runner.mjs";
import { loadProfile } from "../src/profile.mjs";
import { running, profileFor, until, completed, files, childRunner } from "./helpers.mjs";

const call = (profile, op, params = {}, id = crypto.randomUUID()) => request(profile, { op, params, id });

test("native 429 survives planning and settles once with the capacity message", async (t) => {
  const { nativeTurnFailure } = await import("../src/adapters/codex/turn-failure.mjs");
  const profile = profileFor(t);
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide() {
        throw nativeTurnFailure({
          status: "failed",
          error: {
            message: "private provider body",
            codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
          },
        });
      },
    },
  });
  t.after(() => runner.close());
  await call(profile, "say", { text: "hello" }, "limited");
  await until(async () => (await call(profile, "turn", { inputId: "limited" })).status === "blocked");
  const history = await call(profile, "conversation");
  const errors = history.messages.filter((message) => message.data.kind === "reception-error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /模型服务当前繁忙/);
  assert.doesNotMatch(JSON.stringify(history), /private provider body/);
  assert.equal(runner.reception.task, null);
  assert.deepEqual((await call(profile, "status")).reception, { queued: 0, running: 0 });
});
const settled = (profile, id) =>
  until(async () => {
    const turn = await call(profile, "turn", { inputId: id });
    if (turn.status === "blocked") throw new Error(turn.reply_text);
    return turn.status === "settled" && turn;
  });

test("ordinary chat remains a conversation and does not create a work item", async (t) => {
  const { profile } = await running(t);
  const receipt = await call(profile, "say", { text: "你好" }, "greeting");
  const turn = await settled(profile, "greeting");
  assert.equal(turn.work_id, null);
  const history = await call(profile, "conversation");
  assert.equal(history.conversationId, receipt.conversationId);
  assert.equal(history.messages.length, 2);
  assert.equal((await call(profile, "status")).works.length, 0);
  assert.equal((await call(profile, "say", { text: "你好" }, "greeting")).duplicate, true);
});

test("reception delegates real local reading and final result returns to the original conversation once", async (t) => {
  const inputId = "x".repeat(160);
  let profile = profileFor(t);
  const directory = join(profile.path, "materials");
  mkdirSync(directory);
  writeFileSync(join(directory, "project.md"), "项目事实：接待与执行分离。下周完成权限接口核对。");
  writeFileSync(join(profile.path, "profile.json"), JSON.stringify({ ...profile.config, workspace: directory }));
  profile = loadProfile(profile.path);
  const runner = await Runner.open(profile);
  t.after(() => runner.close());
  await call(profile, "say", { text: "整理项目资料，列出进展和待跟进项" }, inputId);
  const turn = await settled(profile, inputId),
    workId = turn.work_id;
  assert.ok(workId);
  const done = await completed(profile, workId),
    history = await call(profile, "conversation");
  assert.equal(history.works.length, 1);
  assert.equal(history.messages.filter((m) => m.data.kind === "result").length, 1);
  assert.equal(history.messages.find((m) => m.data.kind === "result").data.deliveryId, done.deliveries[0].id);
  const artifact = readFileSync(join(profile.path, "artifacts", files(profile, "artifacts")[0]), "utf8");
  assert.match(artifact, /项目事实/);
  assert.match(artifact, /project.md/);
  const delegation = JSON.parse(done.work.delegation_json);
  assert.equal(delegation.actor, profile.config.owner);
  assert.equal(delegation.resources.length, 1);
  assert.ok((await call(profile, "events")).some((e) => e.kind === "material.read"));
  await call(profile, "say", { text: "整理项目资料，列出进展和待跟进项" }, inputId);
  assert.equal((await call(profile, "conversation")).messages.filter((m) => m.data.kind === "result").length, 1);
});

test("reception stays available while a background worker is busy and handles scoped follow-up", async (t) => {
  const { profile } = await running(t, {
    fixtureDelayMs: 1000,
    concurrency: 1,
  });
  await call(profile, "say", { text: "整理一份项目笔记" }, "work-chat");
  const first = await settled(profile, "work-chat");
  await call(profile, "say", { text: "查进度" }, "progress");
  const progress = await settled(profile, "progress");
  assert.match(progress.reply_text, /running|queued/);
  await call(profile, "say", { text: "改成只整理本周进展" }, "amend-chat");
  const amendment = await settled(profile, "amend-chat");
  assert.equal(amendment.work_id, first.work_id);
  await call(profile, "say", { text: "取消" }, "cancel-chat");
  await settled(profile, "cancel-chat");
  await until(async () => (await call(profile, "status")).active === 0);
  assert.equal((await call(profile, "work", { workId: first.work_id })).work.status, "cancelled");
});

test("a model proposal cannot target work that is absent from the conversation", async (t) => {
  const profile = profileFor(t);
  let foreign;
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide() {
        return { kind: "cancel", workId: foreign, expectedRevision: 1 };
      },
    },
  });
  t.after(() => runner.close());
  foreign = (await call(profile, "submit", { text: "direct unrelated work" })).workId;
  await call(profile, "say", { text: "stop something" }, "malicious");
  const turn = await until(async () => {
    const r = await call(profile, "turn", { inputId: "malicious" });
    return r.status === "blocked" && r;
  });
  assert.match(turn.reply_text, /outside this conversation/);
  assert.notEqual((await call(profile, "work", { workId: foreign })).work.status, "cancelled");
});

test("model-supplied grants are discarded and server-owned scope is persisted", async (t) => {
  const profile = profileFor(t);
  const runner = await Runner.open(profile, {
    receptionModel: {
      async decide() {
        return {
          kind: "delegate",
          goal: "make a local note",
          actor: "someone-else",
          tools: ["bash"],
          resources: [{ id: "all", binding: "/" }],
        };
      },
    },
  });
  t.after(() => runner.close());
  await call(profile, "say", { text: "do a task" }, "scope");
  const turn = await settled(profile, "scope");
  const work = (await call(profile, "work", { workId: turn.work_id })).work,
    scope = JSON.parse(work.delegation_json);
  assert.equal(scope.actor, profile.config.owner);
  assert.deepEqual(scope.resources, []);
  assert.deepEqual(scope.tools, [
    "work_context",
    "recall_memory",
    "read_memory_file",
    "list_memory_files",
    "search_history",
    "publish_note",
    "ask_user",
    "request_intervention",
    "list_skills",
    "load_skill",
  ]);
});

test("stale model amendment is rejected without silently replacing a newer user direction", async (t) => {
  const profile = profileFor(t, { fixtureDelayMs: 500 });
  let release, contextReady;
  const contextPromise = new Promise((resolve) => (contextReady = resolve));
  let calls = 0;
  const model = {
    async decide(input, signal) {
      if (calls++ === 0) return { kind: "delegate", goal: "first goal" };
      contextReady(input);
      return new Promise((resolve, reject) => {
        release = () =>
          resolve({
            kind: "amend",
            completion: { output: "text", requirements: [], checks: [] },
            workId: input.works[0].id,
            expectedRevision: input.works[0].revision,
            goal: "stale model goal",
          });
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    },
  };
  const runner = await Runner.open(profile, { receptionModel: model });
  t.after(() => runner.close());
  await call(profile, "say", { text: "first" }, "first");
  const first = await settled(profile, "first");
  await call(profile, "say", { text: "change" }, "change");
  await contextPromise;
  await call(profile, "amend", {
    workId: first.work_id,
    text: "newer explicit direction",
    expectedRevision: 1,
  });
  release();
  await until(async () => (await call(profile, "turn", { inputId: "change" })).status === "blocked");
  const work = (await call(profile, "work", { workId: first.work_id })).work;
  assert.equal(work.text, "newer explicit direction");
  assert.equal(work.revision, 2);
});

test("reception retries a pure proposal after process exit without duplicating work or messages", async (t) => {
  const profile = profileFor(t);
  const first = await childRunner(t, profile, {
    LAB_TEST_CRASH_AT: "reception-proposed-before-commit",
  });
  await call(profile, "say", { text: "整理一份本地笔记" }, "reception-crash");
  assert.equal((await first.exited).code, 86);
  const second = await childRunner(t, profile);
  const turn = await settled(profile, "reception-crash");
  await completed(profile, turn.work_id);
  assert.equal((await call(profile, "status")).works.length, 1);
  const history = await call(profile, "conversation");
  assert.equal(history.messages.filter((m) => m.role === "user").length, 1);
  assert.equal(history.messages.filter((m) => m.data.kind === "delegate").length, 1);
  await second.stop();
});
